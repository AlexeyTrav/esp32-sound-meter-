#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { EXIT } from './errors.js';
import { notify } from './notify.js';
import { acquireLock } from './lock.js';
import { launchBrowser, openApp, waitForAppOrLogin, saveSessionCookies, dismissSessionWarnings, redact } from './browser.js';
import { runExport, csvPathFor, saveDebug } from './runner.js';
import { parseDateArg, yesterdayInTz, todayInTz, timeInTz, iso, ymd } from './dates.js';
import { parseRecords } from './parser.js';
import { writeCsv } from './csv.js';
import { sleep, waitForIdle } from './ui.js';
import {
  goToGeneralExports,
  openExportDataDialog,
  openViewExports,
  generatedFileName,
} from './opera.js';

const USAGE = `Usage: opera-guest-emails <command> [options]

Commands:
  run          (default) Scrape the GSR export for a business date and write the CSV
  login        Open a visible browser so a human can log in with MFA; saves the session
  check        Verify the saved session is still logged in (exit 0 ok, 2 expired)
  keepalive    Keep the session warm: loop every --interval minutes, or --once (for cron)
  daemon       Long-running: keep-alive + daily run at --run-at (one browser, never closed)
  discover     Walk the screens, dump form fields/rows/screenshots to the debug folder
  parse FILE   Offline: parse a text file of pipe-delimited rows into the CSV

Options:
  --config PATH        Config file (default: ./config.json next to package.json)
  --date DATE          Business date YYYY-MM-DD or YYYYMMDD (default: yesterday, ${'<timezone>'})
  --mode MODE          existing | generate | auto
  --output-dir DIR     Where CSVs are written
  --headed/--headless  Show / hide the browser window
  --overwrite          Replace an existing CSV for the date (default: skip)
  --save-raw           Also keep the raw scraped rows in the debug folder
  --interval MIN       keepalive/daemon: minutes between keep-alive touches
  --once               keepalive: single touch then exit
  --run-at HH:MM       daemon: daily run time (in the configured timezone)
  --out FILE           parse: output CSV path
  -h, --help

Exit codes: 0 ok/skipped, 1 failure, 2 session expired, 3 export not found, 4 profile locked`;

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      date: { type: 'string' },
      mode: { type: 'string' },
      'output-dir': { type: 'string' },
      headed: { type: 'boolean' },
      headless: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'save-raw': { type: 'boolean' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      'run-at': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const overrides = {
    mode: values.mode,
    outputDir: values['output-dir'],
    overwrite: values.overwrite,
    saveRaw: values['save-raw'],
    headless: values.headed ? false : values.headless ? true : undefined,
    keepAliveMinutes: values.interval ? Number(values.interval) : undefined,
    dailyRunAt: values['run-at'],
  };
  return { command: positionals[0] || 'run', args: positionals.slice(1), values, overrides };
}

function targetDate(cfg, values) {
  return values.date ? parseDateArg(values.date) : yesterdayInTz(cfg.timezone);
}

/** Map an error to an exit code, notify, and log. */
async function handleFailure(cfg, e, context = {}) {
  const code = e.exitCode || EXIT.FAILURE;
  if (code === EXIT.SESSION_EXPIRED) {
    log.error(`${e.message}. A human must log in again: npm run login (headed, with MFA).`);
    await notify(cfg, 'session_expired', `OPERA Cloud session expired for ${cfg.property}. Run "npm run login" and complete MFA.`, context);
  } else if (code === EXIT.LOCKED) {
    log.error(e.message);
  } else {
    log.error(e.stack || e.message);
    await notify(cfg, code === EXIT.EXPORT_NOT_FOUND ? 'export_not_found' : 'run_failed', `Guest email export failed for ${cfg.property}: ${e.message}`, context);
  }
  return code;
}

/** Launch on the locked profile, run fn(context), always close + unlock. */
async function withBrowser(cfg, opts, fn) {
  const release = await acquireLock(cfg.lockFile, { waitMs: opts.lockWaitMs ?? cfg.timeouts.lockWaitMs });
  let context;
  try {
    context = await launchBrowser(cfg, { headless: opts.headless ?? cfg.headless });
    return await fn(context);
  } finally {
    if (context) await context.close().catch(() => {});
    await release();
  }
}

// ---------------------------------------------------------------------------

async function cmdRun(cfg, values) {
  const date = targetDate(cfg, values);
  const csvPath = csvPathFor(cfg, date);
  if (fs.existsSync(csvPath) && !cfg.overwrite) {
    log.info(`CSV already exists for ${iso(date)}: ${csvPath} — skipping (use --overwrite to replace)`);
    return EXIT.OK;
  }
  try {
    const res = await withBrowser(cfg, {}, (context) => runExport(context, cfg, date));
    if (cfg.notify.onSuccess) {
      await notify(cfg, 'run_succeeded', `Guest emails for ${iso(date)}: ${res.records.length} written to ${path.basename(res.csvPath)}`, {
        date: iso(date),
        count: res.records.length,
        csvPath: res.csvPath,
      });
    }
    return EXIT.OK;
  } catch (e) {
    return handleFailure(cfg, e, { date: iso(date) });
  }
}

async function cmdLogin(cfg) {
  try {
    return await withBrowser(cfg, { headless: false, lockWaitMs: 0 }, async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' });
      log.info('A browser window is open. Log in to OPERA Cloud (including the MFA prompt on your phone).');
      log.info(`Waiting up to ${Math.round(cfg.timeouts.loginWaitMs / 60000)} min for the OPERA Cloud home screen...`);
      const deadline = Date.now() + cfg.timeouts.loginWaitMs;
      let state;
      do {
        state = await waitForAppOrLogin(page, cfg, 5000);
        if (state === 'app') break;
        await sleep(3000);
      } while (Date.now() < deadline);
      if (state !== 'app') {
        log.error('Login was not completed in time.');
        return EXIT.SESSION_EXPIRED;
      }
      await waitForIdle(page);
      await saveSessionCookies(context, cfg);
      log.info(`Logged in. Session saved in ${cfg.userDataDir}. Closing in 5s...`);
      await sleep(5000);
      log.info('Next: run "npm run check" to confirm the saved session works headless.');
      return EXIT.OK;
    });
  } catch (e) {
    return handleFailure(cfg, e);
  }
}

async function cmdCheck(cfg) {
  try {
    return await withBrowser(cfg, {}, async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      await openApp(page, cfg);
      log.info('Session OK');
      return EXIT.OK;
    });
  } catch (e) {
    if (e.exitCode === EXIT.SESSION_EXPIRED) {
      log.error(e.message);
      return EXIT.SESSION_EXPIRED;
    }
    return handleFailure(cfg, e);
  }
}

/** One keep-alive touch: reload OPERA and confirm we are still inside the app. */
async function touch(page, cfg) {
  await openApp(page, cfg);
  await dismissSessionWarnings(page);
  log.info(`Keep-alive OK (${redact(page.url())})`);
}

/** Like touch(), but a transient failure (network blip) only logs; session expiry still throws. */
async function softTouch(page, cfg) {
  try {
    await touch(page, cfg);
  } catch (e) {
    if (e.exitCode === EXIT.SESSION_EXPIRED) throw e;
    log.warn(`Keep-alive touch failed (will retry next interval): ${e.message}`);
  }
}

async function cmdKeepalive(cfg, values) {
  if (values.once) {
    try {
      return await withBrowser(cfg, { lockWaitMs: 0 }, async (context) => {
        await touch(context.pages()[0] || (await context.newPage()), cfg);
        return EXIT.OK;
      });
    } catch (e) {
      if (e.exitCode === EXIT.LOCKED) {
        log.info('Profile is in use by another run; that run keeps the session warm. Skipping.');
        return EXIT.OK;
      }
      return handleFailure(cfg, e);
    }
  }
  try {
    return await withBrowser(cfg, { lockWaitMs: 0 }, async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      log.info(`Keep-alive loop every ${cfg.keepAliveMinutes} min (Ctrl+C to stop)`);
      await touch(page, cfg);
      for (;;) {
        await sleep(cfg.keepAliveMinutes * 60000);
        await softTouch(page, cfg);
      }
    });
  } catch (e) {
    return handleFailure(cfg, e);
  }
}

/**
 * One browser for the whole life of the process: keep-alive touches every
 * N minutes and the daily export at dailyRunAt. Survives session-only cookies
 * because the browser is never closed.
 */
async function cmdDaemon(cfg, values) {
  const maxAttemptsPerDay = cfg.retries.attempts;
  const retryGapMs = 30 * 60000;
  const runs = new Map(); // business date (YYYYMMDD) -> {attempts, last, done}
  try {
    return await withBrowser(cfg, { lockWaitMs: 0 }, async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      let stopping = false;
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (stopping = true));
      log.info(`Daemon started: keep-alive every ${cfg.keepAliveMinutes} min, daily run at ${cfg.dailyRunAt} ${cfg.timezone}`);
      await touch(page, cfg);
      let lastTouch = Date.now();
      while (!stopping) {
        const now = new Date();
        const date = values.date ? parseDateArg(values.date) : yesterdayInTz(cfg.timezone, now);
        const key = ymd(date);
        const r = runs.get(key) || { attempts: 0, last: 0, done: false };
        const due = timeInTz(cfg.timezone, now) >= cfg.dailyRunAt;
        if (due && !r.done && r.attempts < maxAttemptsPerDay && Date.now() - r.last >= retryGapMs) {
          const csvPath = csvPathFor(cfg, date);
          if (fs.existsSync(csvPath) && !cfg.overwrite) {
            log.info(`CSV for ${iso(date)} already exists; nothing to do today`);
            r.done = true;
          } else {
            r.attempts++;
            r.last = Date.now();
            try {
              const res = await runExport(context, cfg, date);
              r.done = true;
              if (cfg.notify.onSuccess) {
                await notify(cfg, 'run_succeeded', `Guest emails for ${iso(date)}: ${res.records.length} written`, {
                  date: iso(date),
                  count: res.records.length,
                  csvPath: res.csvPath,
                });
              }
            } catch (e) {
              if (e.exitCode === EXIT.SESSION_EXPIRED) throw e;
              await handleFailure(cfg, e, { date: iso(date), attempt: r.attempts });
            }
            lastTouch = Date.now();
          }
          runs.set(key, r);
        }
        if (Date.now() - lastTouch >= cfg.keepAliveMinutes * 60000) {
          await softTouch(page, cfg);
          lastTouch = Date.now();
        }
        await sleep(30000);
      }
      log.info('Daemon stopping');
      return EXIT.OK;
    });
  } catch (e) {
    return handleFailure(cfg, e);
  }
}

async function cmdDiscover(cfg, values) {
  const date = targetDate(cfg, values);
  const report = { at: new Date().toISOString(), property: cfg.property, steps: [] };
  const dump = async (page, name, extra = {}) => {
    await saveDebug(page, cfg, `discover-${name}`);
    const menuItems = await page.getByRole('menuitem').allInnerTexts().catch(() => []);
    report.steps.push({ name, url: redact(page.url()), menuItems, ...extra });
  };
  try {
    return await withBrowser(cfg, {}, async (context) => {
      const page = context.pages()[0] || (await context.newPage());
      await openApp(page, cfg);
      await dump(page, '1-home');

      await goToGeneralExports(page, cfg);
      const exportRows = await page.getByRole('row').filter({ hasText: cfg.exportName }).allInnerTexts().catch(() => []);
      await dump(page, '2-exports', { exportRows });

      const { fields } = await openExportDataDialog(page, cfg);
      await dump(page, '3-export-data-dialog', { fields });
      // Never submit here: cancel the dialog.
      const cancel = page.getByRole('button', { name: /^\s*(cancel|close)\s*$/i }).first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
      else await page.keyboard.press('Escape');
      await waitForIdle(page);

      await openViewExports(page, cfg);
      const rows = (await page.getByRole('row').allInnerTexts().catch(() => [])).slice(0, 30);
      await dump(page, '4-generated-exports', { expectedFileName: generatedFileName(cfg, date), rows });

      await fsp.mkdir(cfg.debugDir, { recursive: true });
      const out = path.join(cfg.debugDir, `discover-${Date.now()}.json`);
      await fsp.writeFile(out, JSON.stringify(report, null, 2));
      log.info(`Discovery report: ${out}`);
      return EXIT.OK;
    });
  } catch (e) {
    return handleFailure(cfg, e);
  }
}

async function cmdParse(cfg, values, args) {
  const file = args[0];
  if (!file) throw new Error('parse: missing input file');
  const date = targetDate(cfg, values);
  const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  const { records, stats } = parseRecords(lines, { recordPrefix: cfg.property });
  const out = values.out || csvPathFor(cfg, date);
  await writeCsv(out, records);
  log.info(`Parsed ${stats.lines} line(s) -> ${records.length} guest email(s) (${stats.duplicates} dup, ${stats.noEmail} no email). Wrote ${out}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return EXIT.FAILURE;
  }
  const { command, args, values, overrides } = parsed;
  if (values.help || command === 'help') {
    console.log(USAGE);
    return EXIT.OK;
  }
  const cfg = loadConfig(values.config, overrides);
  log.info(`opera-guest-emails ${command} (config: ${cfg.configFile || 'defaults'}, today ${iso(todayInTz(cfg.timezone))} ${cfg.timezone})`);
  switch (command) {
    case 'run': return cmdRun(cfg, values);
    case 'login': return cmdLogin(cfg);
    case 'check': return cmdCheck(cfg);
    case 'keepalive': return cmdKeepalive(cfg, values);
    case 'daemon': return cmdDaemon(cfg, values);
    case 'discover': return cmdDiscover(cfg, values);
    case 'parse': return cmdParse(cfg, values, args);
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return EXIT.FAILURE;
  }
}

main()
  .then((code) => process.exit(code ?? EXIT.OK))
  .catch((e) => {
    log.error(e.stack || e.message);
    process.exit(EXIT.FAILURE);
  });
