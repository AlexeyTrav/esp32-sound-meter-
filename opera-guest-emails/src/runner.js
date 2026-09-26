import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';
import { openApp, isLoginPage, saveSessionCookies } from './browser.js';
import { SessionExpiredError } from './errors.js';
import { withRetry } from './ui.js';
import { ymd } from './dates.js';
import { parseRecords } from './parser.js';
import { writeCsv } from './csv.js';
import {
  generatedFileName,
  openViewExports,
  countGenerated,
  setMaxPageSize,
  openExportDataDialog,
  submitExportData,
  waitForNewGenerated,
  openGeneratedExport,
  scrapeExportDetails,
} from './opera.js';

export function csvPathFor(cfg, date) {
  return path.join(cfg.outputDir, `guest_emails_${ymd(date)}.csv`);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Screenshot + HTML + raw scraped lines + error text, for post-mortem. Contains guest PII. */
export async function saveDebug(page, cfg, label, { error, rawLines } = {}) {
  try {
    await fs.mkdir(cfg.debugDir, { recursive: true });
    const base = path.join(cfg.debugDir, `${label}-${stamp()}`);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch((e) => log.warn(`Screenshot failed: ${e.message}`));
      await fs.writeFile(`${base}.html`, await page.content().catch(() => ''), { mode: 0o600 });
    }
    if (rawLines?.length) await fs.writeFile(`${base}.raw.txt`, rawLines.join('\n') + '\n', { mode: 0o600 });
    if (error) await fs.writeFile(`${base}.error.txt`, `${error.stack || error}\n`);
    log.info(`Debug artifacts saved: ${base}.*`);
  } catch (e) {
    log.warn(`Could not save debug artifacts: ${e.message}`);
  }
}

/**
 * Full pipeline for one business date, on a fresh tab in `context`:
 * open app -> (optionally) Export Data -> View Exports -> Export Details ->
 * scrape -> parse -> CSV.
 */
export async function runExport(context, cfg, date) {
  const fileName = generatedFileName(cfg, date);
  const csvPath = csvPathFor(cfg, date);
  const state = { rawLines: [] };
  const page = await context.newPage();
  const retry = {
    attempts: cfg.retries.attempts,
    delayMs: cfg.retries.delayMs,
    recover: async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      if (await isLoginPage(page)) throw new SessionExpiredError();
      await openApp(page, cfg);
    },
  };

  log.info(`=== Run: property ${cfg.property}, business date ${ymd(date)}, mode ${cfg.mode}, file ${fileName} ===`);
  try {
    await withRetry('Open OPERA Cloud', () => openApp(page, cfg), { ...retry, recover: undefined });

    if (cfg.mode === 'generate' || cfg.mode === 'auto') {
      const baseline = await withRetry(
        'Count existing generated exports',
        async () => {
          await openViewExports(page, cfg);
          await setMaxPageSize(page).catch(() => false);
          return countGenerated(page, fileName);
        },
        retry,
      );
      log.info(`Existing generated exports named ${fileName}: ${baseline}`);
      if (cfg.mode === 'auto' && baseline > 0) {
        log.info('Mode auto: an export already exists, not generating a new one');
      } else {
        const { root } = await withRetry('Open Export Data dialog', () => openExportDataDialog(page, cfg), retry);
        // Deliberately not retried: a double submit would generate twice.
        await submitExportData(page, cfg, root, date);
        await waitForNewGenerated(page, cfg, fileName, baseline);
      }
    }

    const lines = await withRetry(
      'Open and scrape Export Details',
      async () => {
        await openViewExports(page, cfg);
        await openGeneratedExport(page, cfg, fileName);
        return scrapeExportDetails(page, cfg, state);
      },
      retry,
    );
    log.info(`Scraped ${lines.length} raw row(s)`);
    if (!lines.length) throw new Error('Export Details returned 0 rows; refusing to write an empty CSV');

    const { records, stats } = parseRecords(lines, { recordPrefix: cfg.property });
    log.info(
      `Parsed: ${stats.lines} line(s), ${stats.records} unique guest email(s), ` +
        `${stats.noEmail} without guest email, ${stats.duplicates} duplicate email(s), ${stats.notRecords} non-record line(s)`,
    );
    if (!records.length) log.warn('No guest emails found for this date; writing header-only CSV');

    await writeCsv(csvPath, records);
    log.info(`CSV written: ${csvPath} (${records.length} row(s))`);
    if (cfg.saveRaw) await saveDebug(null, cfg, `raw-${ymd(date)}`, { rawLines: lines });
    await saveSessionCookies(context, cfg).catch(() => {});
    return { csvPath, fileName, records, stats, rawCount: lines.length };
  } catch (e) {
    await saveDebug(page, cfg, `fail-${ymd(date)}`, { error: e, rawLines: state.rawLines });
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}
