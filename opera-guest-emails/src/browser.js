import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { SessionExpiredError } from './errors.js';
import { log } from './logger.js';
import { waitForIdle, anyVisible, sleep } from './ui.js';

/**
 * Launch Chromium on the fixed profile folder. The human logs in once
 * (headful, with MFA) and later runs reuse the cookies stored there.
 */
export async function launchBrowser(cfg, { headless = cfg.headless } = {}) {
  await fs.mkdir(cfg.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless,
    executablePath: cfg.browser.executablePath || undefined,
    channel: cfg.browser.channel || undefined,
    slowMo: cfg.browser.slowMo || undefined,
    viewport: { width: 1600, height: 1000 },
    timezoneId: cfg.timezone,
    acceptDownloads: false,
  });
  context.setDefaultTimeout(cfg.timeouts.elementMs);
  context.setDefaultNavigationTimeout(cfg.timeouts.navigationMs);
  if (cfg.persistSessionCookies) await restoreSessionCookies(context, cfg);
  return context;
}

// Session cookies (no expiry) are dropped when Chromium closes, even with a
// persistent profile. We keep a copy and re-inject any that are missing on the
// next launch; the server decides whether the session is still alive.
async function restoreSessionCookies(context, cfg) {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(cfg.sessionStateFile, 'utf8'));
  } catch {
    return;
  }
  const have = new Set((await context.cookies()).map((c) => `${c.name}|${c.domain}|${c.path}`));
  const missing = (saved.cookies || [])
    .filter((c) => !have.has(`${c.name}|${c.domain}|${c.path}`))
    .map(({ expires, ...c }) => c); // no expires => session cookie
  if (missing.length) {
    await context.addCookies(missing);
    log.info(`Restored ${missing.length} session cookie(s) from ${cfg.sessionStateFile}`);
  }
}

export async function saveSessionCookies(context, cfg) {
  if (!cfg.persistSessionCookies) return;
  const cookies = (await context.cookies()).filter((c) => c.expires === -1);
  const tmp = `${cfg.sessionStateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tmp, cfg.sessionStateFile);
  log.debug(`Saved ${cookies.length} session cookie(s)`);
}

const LOGIN_URL_RE = /(\/login|signin|sign-in|\/sso\/|\/oauth2\/|\/oam\/|identity\.oraclecloud|idcs-|\/authorize|\/mfa)/i;

/** True if the page is an Oracle IDCS / SSO / OPERA login screen. */
export async function isLoginPage(page) {
  if (LOGIN_URL_RE.test(page.url())) return true;
  for (const frame of page.frames()) {
    const pw = frame.locator('input[type="password"]');
    if (await pw.first().isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertNotLoginPage(page) {
  if (await isLoginPage(page)) {
    throw new SessionExpiredError(`OPERA Cloud session expired: landed on login page (${redact(page.url())})`);
  }
}

/** Strip query strings (may carry tokens) before logging a URL. */
export function redact(url) {
  return String(url).split('?')[0];
}

// Visible texts that only exist once the OPERA Cloud shell has rendered.
const APP_READY = (cfg) => [cfg.menuPath[0], 'Front Desk', 'Bookings', 'Client Relations'];

/**
 * Wait until the OPERA shell is rendered or a login page shows up.
 * @returns {'app'|'login'|'unknown'}
 */
export async function waitForAppOrLogin(page, cfg, timeoutMs = cfg.timeouts.navigationMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoginPage(page)) return 'login';
    const ready = await anyVisible(
      page,
      APP_READY(cfg).map((t) => (root) => root.getByText(t, { exact: true })),
    );
    if (ready) return 'app';
    await sleep(1000);
  }
  return 'unknown';
}

/** Open OPERA Cloud and fail fast (SessionExpiredError) if the session is gone. */
export async function openApp(page, cfg) {
  log.step(`Opening OPERA Cloud ${redact(cfg.baseUrl)}`);
  await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForIdle(page);
  const state = await waitForAppOrLogin(page, cfg);
  if (state === 'login') await assertNotLoginPage(page);
  if (state === 'unknown') {
    throw new Error(`OPERA Cloud did not finish loading within ${cfg.timeouts.navigationMs}ms (${redact(page.url())})`);
  }
  await dismissSessionWarnings(page);
  await saveSessionCookies(page.context(), cfg);
  log.info('OPERA Cloud session is active');
}

/** Click through "your session is about to expire"-style prompts if one is showing. */
export async function dismissSessionWarnings(page) {
  for (const frame of page.frames()) {
    const warn = frame.getByText(/session (is about to|will) (expire|time ?out)/i).first();
    if (await warn.isVisible().catch(() => false)) {
      for (const name of ['Continue', 'Stay Logged In', 'Extend', 'Yes', 'OK']) {
        const btn = frame.getByRole('button', { name, exact: true }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          log.info(`Dismissed session-timeout warning via "${name}"`);
          return true;
        }
      }
    }
  }
  return false;
}
