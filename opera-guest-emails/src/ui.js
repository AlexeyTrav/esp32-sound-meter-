// Generic, ID-free element location helpers for Oracle ADF/JET pages.
// A "candidate" is a function (frameOrPage) => Locator; we try each candidate
// in every frame and take the first *visible* match. Oracle's generated ids
// change between releases, so nothing here uses them.

import { log } from './logger.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_MATCHES_CHECKED = 25;

/**
 * Wait for ADF to finish its partial-page round-trips, then let the DOM settle.
 * `network: false` skips the networkidle wait (ADF may poll, making it slow).
 */
export async function waitForIdle(page, timeoutMs = 20000, { network = true } = {}) {
  await page
    .waitForFunction(
      () => {
        try {
          const adf = window.AdfPage && window.AdfPage.PAGE;
          if (adf && typeof adf.isSynchronizedWithServer === 'function' && !adf.isSynchronizedWithServer()) {
            return false;
          }
        } catch {
          /* not an ADF page */
        }
        return document.readyState === 'complete';
      },
      null,
      { timeout: timeoutMs, polling: 250 },
    )
    .catch(() => log.debug('waitForIdle: ADF sync wait timed out'));
  if (network) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await sleep(network ? 400 : 250);
}

/** Search roots: every frame of a Page, or an explicit Locator / list of Locators. */
function rootsOf(scope) {
  if (typeof scope.frames === 'function') return scope.frames();
  return Array.isArray(scope) ? scope : [scope];
}

/** Single pass: first visible element over all roots × candidates, or null. */
export async function anyVisible(scope, candidates) {
  for (const frame of rootsOf(scope)) {
    for (const cand of candidates) {
      let loc;
      try {
        loc = cand(frame);
      } catch {
        continue;
      }
      const n = Math.min(await loc.count().catch(() => 0), MAX_MATCHES_CHECKED);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
  }
  return null;
}

/** Poll until a candidate is visible; throws with `label` on timeout. */
export async function findVisible(scope, candidates, { timeout = 30000, label = 'element' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const el = await anyVisible(scope, candidates);
    if (el) return el;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
    await sleep(500);
  }
}

const CLICKABLE_ROLES = ['menuitem', 'link', 'button', 'tab', 'treeitem', 'option'];

/** Candidates matching a visible label: accessible roles first, then plain text. */
export function byText(text, { roles = CLICKABLE_ROLES, exact = true } = {}) {
  return [
    ...roles.map((role) => (root) => root.getByRole(role, { name: text, exact })),
    (root) => root.getByText(text, { exact }),
    (root) => root.locator(`[title="${String(text).replace(/"/g, '\\"')}"]`),
  ];
}

/** Hover then click the first visible element with this text. */
export async function clickText(scope, text, opts = {}) {
  const el = await findVisible(scope, byText(text, opts), { timeout: opts.timeout, label: `"${text}"` });
  await el.hover().catch(() => {});
  await el.click();
  log.debug(`Clicked "${text}"`);
  return el;
}

/**
 * Retry an async step. `recover` runs between attempts (e.g. press Escape,
 * reload). Errors flagged `retryable === false` are rethrown immediately.
 */
export async function withRetry(label, fn, { attempts = 3, delayMs = 5000, recover } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (e && e.retryable === false) throw e;
      if (i < attempts) {
        log.warn(`${label}: attempt ${i}/${attempts} failed: ${e.message}. Retrying in ${delayMs}ms`);
        await sleep(delayMs);
        if (recover) {
          try {
            await recover(e);
          } catch (re) {
            if (re && re.retryable === false) throw re;
            log.warn(`${label}: recovery failed: ${re.message}`);
          }
        }
      }
    }
  }
  lastErr.message = `${label} failed after ${attempts} attempt(s): ${lastErr.message}`;
  throw lastErr;
}
