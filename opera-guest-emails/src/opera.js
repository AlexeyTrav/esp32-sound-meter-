// OPERA Cloud screen navigation and scraping for the GSR export.
// Everything is located by visible text / ARIA role / DOM structure relative
// to that text — never by Oracle's generated element ids.

import { log } from './logger.js';
import { ExportNotFoundError } from './errors.js';
import { assertNotLoginPage } from './browser.js';
import { anyVisible, findVisible, clickText, waitForIdle, sleep } from './ui.js';
import { addDays, formatDate, inferDateFormat, todayInTz, ymd } from './dates.js';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function generatedFileName(cfg, date) {
  return cfg.fileNamePattern
    .replace('{PROPERTY}', cfg.property)
    .replace('{YYYYMMDD}', ymd(date));
}

// ---------------------------------------------------------------------------
// Menu: Miscellaneous -> Exports -> General
// ---------------------------------------------------------------------------

export async function goToGeneralExports(page, cfg) {
  log.step(`Menu: ${cfg.menuPath.join(' -> ')}`);
  await assertNotLoginPage(page);
  for (const item of cfg.menuPath) {
    await clickText(page, item, {
      roles: ['menuitem', 'link', 'button', 'treeitem', 'tab'],
      timeout: cfg.timeouts.elementMs,
    });
    await sleep(600);
  }
  await waitForIdle(page);
  await assertNotLoginPage(page);
  await findTextAcrossPages(page, cfg, new RegExp(`^\\s*${esc(cfg.exportName)}\\s*$`), {
    label: `export "${cfg.exportName}" in the export list`,
  });
  log.info(`Export list loaded; found "${cfg.exportName}"`);
}

// ---------------------------------------------------------------------------
// Row action ("three dots") menus
// ---------------------------------------------------------------------------

const ACTION_BUTTON_CANDIDATES = [
  (row) => row.getByRole('button', { name: /action|more|option|ellipsis|overflow|menu/i }),
  (row) => row.getByRole('link', { name: /action|more|option|ellipsis|overflow|menu/i }),
  (row) => row.getByRole('button', { name: /^\s*(\.\.\.|…|⋮|⋯)\s*$/ }),
  (row) =>
    row.locator(
      '[title*="action" i], [aria-label*="action" i], [title*="more" i], [aria-label*="more" i], [title*="option" i], [aria-label*="option" i]',
    ),
  (row) => row.locator('[aria-haspopup="true"], [aria-haspopup="menu"]'),
  // icon-only clickable (no visible text) — typical for the vertical-ellipsis button
  (row) => row.locator('button, a, [role="button"]').filter({ hasNotText: /\S/ }),
];

/** Nearest table-row ancestors of a text element, innermost first. */
function rowAncestors(textEl, depth = 6) {
  const out = [];
  for (let lvl = 1; lvl <= depth; lvl++) {
    out.push(textEl.locator(`xpath=ancestor::*[self::tr or @role="row"][${lvl}]`));
  }
  return out;
}

async function menuItemVisible(page, itemText, timeout) {
  // A RegExp is only matched against real menu entries, never free page text.
  const cands =
    itemText instanceof RegExp
      ? [(r) => r.getByRole('menuitem', { name: itemText }), (r) => r.getByRole('option', { name: itemText })]
      : [
          (r) => r.getByRole('menuitem', { name: itemText, exact: true }),
          (r) => r.getByRole('menuitem', { name: itemText }),
          (r) => r.getByRole('option', { name: itemText, exact: true }),
          (r) => r.getByText(itemText, { exact: true }),
        ];
  try {
    return await findVisible(page, cands, { timeout, label: `menu item "${itemText}"` });
  } catch {
    return null;
  }
}

/**
 * Open the row-action menu of the row containing `rowText` and click
 * `itemText` (a string or RegExp). Tries each plausible action button in the
 * innermost row first until the wanted item appears.
 */
export async function clickRowAction(page, cfg, rowText, itemText) {
  const textEl = await findVisible(page, [(r) => r.getByText(rowText, { exact: typeof rowText === 'string' })], {
    timeout: cfg.timeouts.elementMs,
    label: `row "${rowText}"`,
  });
  const tried = new Set();
  for (const row of rowAncestors(textEl)) {
    if (!(await row.count().catch(() => 0))) break;
    for (const cand of ACTION_BUTTON_CANDIDATES) {
      const btns = cand(row);
      const n = Math.min(await btns.count().catch(() => 0), 6);
      for (let i = 0; i < n; i++) {
        const btn = btns.nth(i);
        if (!(await btn.isVisible().catch(() => false))) continue;
        const key = await btn.evaluate((el) => {
          el.__ogeKey = el.__ogeKey || Math.random().toString(36).slice(2);
          return el.__ogeKey;
        });
        if (tried.has(key)) continue;
        tried.add(key);
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click().catch((e) => log.debug(`action button click failed: ${e.message.split("\n")[0]}`));
        const item = await menuItemVisible(page, itemText, 4000);
        if (item) {
          log.debug(`Row action menu opened for "${rowText}"`);
          await item.click();
          await waitForIdle(page);
          return;
        }
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
      }
    }
  }
  // Last resort: select the row, then look for the item / a toolbar "Actions" button anywhere.
  await textEl.click({ button: 'right' }).catch(() => {});
  let item = await menuItemVisible(page, itemText, 2000);
  if (!item) {
    await page.keyboard.press('Escape').catch(() => {});
    await textEl.click().catch(() => {});
    const toolbar = await anyVisible(page, [(r) => r.getByRole('button', { name: /^actions?$/i })]);
    if (toolbar) {
      await toolbar.click();
      item = await menuItemVisible(page, itemText, 4000);
    }
  }
  if (!item) throw new Error(`Could not open the action menu item "${itemText}" for row "${rowText}"`);
  await item.click();
  await waitForIdle(page);
}

// ---------------------------------------------------------------------------
// Tables: page size ("Show") and pagination
// ---------------------------------------------------------------------------

const SHOW_CANDIDATES = [
  (r) => r.getByLabel(/^\s*show\b/i),
  (r) => r.getByRole('combobox', { name: /show/i }),
  (r) => r.getByText(/^\s*show\s*:?\s*$/i).locator('xpath=following::select[1]'),
  (r) => r.getByText(/^\s*show\s*:?\s*$/i).locator('xpath=following::*[@role="combobox"][1]'),
];

function pickLargestOption(labels) {
  let best = null;
  let bestVal = -1;
  for (const [i, raw] of labels.entries()) {
    const t = String(raw).trim();
    if (/^all$/i.test(t)) return i;
    const n = Number(t.replace(/[^\d]/g, ''));
    if (t && Number.isFinite(n) && n > bestVal) {
      bestVal = n;
      best = i;
    }
  }
  return best;
}

/** Set the table's "Show" page-size control to its largest value, if present. */
export async function setMaxPageSize(page) {
  const ctl = await anyVisible(page, SHOW_CANDIDATES);
  if (!ctl) {
    log.info('No "Show" page-size control found; relying on scrolling/pagination');
    return false;
  }
  const tag = await ctl.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    const opts = await ctl.evaluate((el) => [...el.options].map((o) => ({ label: o.label || o.text, value: o.value })));
    const idx = pickLargestOption(opts.map((o) => o.label));
    if (idx == null) return false;
    await ctl.selectOption(opts[idx].value);
    log.info(`Page size set to "${opts[idx].label}"`);
  } else {
    await ctl.click();
    const options = await findVisible(page, [(r) => r.getByRole('option'), (r) => r.getByRole('menuitem')], {
      timeout: 5000,
      label: 'page-size options',
    }).catch(() => null);
    if (!options) return false;
    // Re-query all options in the same root as the first visible one.
    const list = page.getByRole('option');
    const labels = await list.allInnerTexts().catch(() => []);
    const idx = pickLargestOption(labels);
    if (idx == null) {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await list.nth(idx).click();
    log.info(`Page size set to "${labels[idx].trim()}"`);
  }
  await waitForIdle(page);
  return true;
}

const NEXT_CANDIDATES = [
  (r) => r.getByRole('button', { name: /^\s*next( page)?\s*$/i }),
  (r) => r.getByRole('link', { name: /^\s*next( page)?\s*$/i }),
  (r) => r.locator('[title="Next Page" i], [aria-label="Next Page" i], [title="Next" i], [aria-label="Next" i]'),
];

/** Click "Next page" if it exists and is enabled. */
export async function goToNextPage(page) {
  const next = await anyVisible(page, NEXT_CANDIDATES);
  if (!next) return false;
  const disabled = await next.evaluate(
    (el) =>
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      /\bdisabled\b/i.test(el.className || '') ||
      !!el.closest('[aria-disabled="true"], .p_AFDisabled, .oj-disabled'),
  );
  if (disabled) return false;
  await next.click();
  await waitForIdle(page);
  return true;
}

/**
 * Wait for `text` (RegExp) on the current list. If it does not show up, try the
 * "Search" button (ADF search panels often need it) and then later pages.
 */
async function findTextAcrossPages(page, cfg, textRe, { label, maxPages = 25 } = {}) {
  const cands = [(r) => r.getByText(textRe)];
  let el = await findVisible(page, cands, { timeout: Math.min(15000, cfg.timeouts.elementMs), label }).catch(() => null);
  if (el) return el;
  const search = await anyVisible(page, [(r) => r.getByRole('button', { name: /^\s*search\s*$/i })]);
  if (search) {
    log.info('Clicking "Search" to populate the list');
    await search.click();
    await waitForIdle(page);
    el = await findVisible(page, cands, { timeout: cfg.timeouts.elementMs, label }).catch(() => null);
    if (el) return el;
  }
  await setMaxPageSize(page).catch(() => false);
  for (let p = 0; p < maxPages; p++) {
    el = await anyVisible(page, cands);
    if (el) return el;
    if (!(await goToNextPage(page))) break;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Generated Exports list
// ---------------------------------------------------------------------------

export async function openViewExports(page, cfg) {
  await goToGeneralExports(page, cfg);
  log.step(`Row action: ${cfg.exportName} -> View Exports`);
  await clickRowAction(page, cfg, cfg.exportName, 'View Exports');
  await assertNotLoginPage(page);
  await findVisible(page, [(r) => r.getByText('Generated Exports', { exact: true }), (r) => r.getByText(/\.GSR\s*$/i)], {
    timeout: cfg.timeouts.elementMs,
    label: '"Generated Exports" list',
  });
  log.info('Generated Exports list loaded');
}

function fileNameRe(fileName) {
  return new RegExp(`^\\s*${esc(fileName)}\\s*$`, 'i');
}

/** Number of visible rows for this file name on the current Generated Exports page. */
export async function countGenerated(page, fileName) {
  let n = 0;
  for (const frame of page.frames()) {
    const loc = frame.getByText(fileNameRe(fileName));
    const c = await loc.count().catch(() => 0);
    for (let i = 0; i < c; i++) if (await loc.nth(i).isVisible().catch(() => false)) n++;
  }
  return n;
}

/** Locate the file-name cell, searching further pages if needed. */
async function findGeneratedRow(page, cfg, fileName) {
  try {
    return await findTextAcrossPages(page, cfg, fileNameRe(fileName), { label: `generated export ${fileName}` });
  } catch {
    throw new ExportNotFoundError(
      `No generated export "${fileName}" found in Generated Exports. ` +
        `Run with --mode generate (or auto) to create it, or check the date.`,
    );
  }
}

/**
 * Export Details is showing when a record row is visible, or (for an empty
 * export) when both the "Export Details" breadcrumb and "Export Data" section are.
 */
async function detailsOpened(page, cfg, timeout) {
  const deadline = Date.now() + timeout;
  const recordRe = new RegExp(`^\\s*${esc(cfg.property)}\\|`);
  do {
    if (await anyVisible(page, [(r) => r.getByText(recordRe), (r) => r.getByRole('row').filter({ hasText: `${cfg.property}|` })])) {
      return true;
    }
    const crumb = await anyVisible(page, [(r) => r.getByText('Export Details', { exact: true })]);
    const section = crumb && (await anyVisible(page, [(r) => r.getByText('Export Data', { exact: true })]));
    if (crumb && section) return true;
    await sleep(500);
  } while (Date.now() < deadline);
  return false;
}

/** From Generated Exports, open the row for `fileName` and land on Export Details. */
export async function openGeneratedExport(page, cfg, fileName) {
  log.step(`Opening generated export ${fileName}`);
  const cell = await findGeneratedRow(page, cfg, fileName);
  const total = await countGenerated(page, fileName);
  if (total > 1) log.warn(`${total} generated exports named ${fileName}; using the ${cfg.generatedRowPick || 'first'} one`);
  let target = cell;
  if (cfg.generatedRowPick === 'last' && total > 1) {
    const all = page.getByText(fileNameRe(fileName));
    target = all.nth((await all.count()) - 1);
  }

  const attempts = [
    ['click file name', async () => target.click()],
    ['row action menu', async () => {
      const rowText = fileNameRe(fileName);
      await clickRowAction(page, cfg, rowText, /detail|^\s*view\s*$|view export|open/i);
    }],
    ['double-click row', async () => target.dblclick()],
    ['select row + View button', async () => {
      await target.click();
      const btn = await anyVisible(page, [(r) => r.getByRole('button', { name: /^\s*(view|details|view details|open)\s*$/i })]);
      if (!btn) throw new Error('no View/Details button');
      await btn.click();
    }],
  ];
  for (const [how, act] of attempts) {
    try {
      await act();
      await waitForIdle(page);
      await assertNotLoginPage(page);
      if (await detailsOpened(page, cfg, 10000)) {
        log.info(`Export Details opened (${how})`);
        return;
      }
      log.debug(`"${how}" did not reach Export Details`);
    } catch (e) {
      if (e.retryable === false) throw e;
      log.debug(`"${how}" failed: ${e.message}`);
    }
  }
  throw new Error(`Could not open Export Details for ${fileName}`);
}

/** Poll the Generated Exports list until more than `baseline` rows for fileName exist. */
export async function waitForNewGenerated(page, cfg, fileName, baseline) {
  const deadline = Date.now() + cfg.timeouts.generationMs;
  log.step(`Waiting for ${fileName} to appear (currently ${baseline}, timeout ${cfg.timeouts.generationMs / 1000}s)`);
  while (Date.now() < deadline) {
    await openViewExports(page, cfg);
    await setMaxPageSize(page).catch(() => false);
    const n = await countGenerated(page, fileName);
    if (n > baseline) {
      log.info(`Generation finished: ${n} row(s) for ${fileName}`);
      return n;
    }
    await sleep(15000);
  }
  throw new Error(`Export ${fileName} did not appear within ${cfg.timeouts.generationMs / 1000}s after generation`);
}

// ---------------------------------------------------------------------------
// Export Data (fresh generation)
// ---------------------------------------------------------------------------

const DIALOG_CANDIDATES = [
  (r) => r.getByRole('dialog'),
  (r) => r.getByRole('alertdialog'),
  (r) => r.locator('.oj-dialog, [class*="AFPopup"], [class*="p_AFDialog"]'),
];

/** Describe visible form fields for discovery/logging (no values of password fields). */
export async function describeFields(root) {
  return root.evaluate((el) => {
    const labelOf = (f) => {
      const parts = [];
      if (f.getAttribute('aria-label')) parts.push(f.getAttribute('aria-label'));
      const lb = f.getAttribute('aria-labelledby');
      if (lb) for (const id of lb.split(/\s+/)) parts.push(document.getElementById(id)?.innerText || '');
      if (f.labels) for (const l of f.labels) parts.push(l.innerText);
      if (f.placeholder) parts.push(`placeholder=${f.placeholder}`);
      return parts.map((s) => s.trim()).filter(Boolean).join(' | ');
    };
    return [...el.querySelectorAll('input, select, textarea')]
      .filter((f) => f.offsetParent !== null && f.type !== 'hidden')
      .map((f) => ({
        tag: f.tagName.toLowerCase(),
        type: f.type || '',
        name: f.name || '',
        label: labelOf(f),
        value: f.type === 'password' ? '***' : f.value,
      }));
  });
}

const DATE_INPUT_CANDIDATES = [
  (r) => r.getByLabel(/EXP_FOR_DATE/i),
  (r) => r.getByLabel(/business\s*date/i),
  (r) => r.getByLabel(/for\s*date/i),
  (r) => r.getByLabel(/date/i),
  (r) => r.locator('input[placeholder*="YY" i], input[placeholder*="DD" i]'),
  (r) => r.locator('input[name*="date" i]'),
  (r) => r.locator('input[type="text"], input:not([type])'),
];

/** Open the Export Data dialog for the GSR export. Safe to retry (nothing is submitted). */
export async function openExportDataDialog(page, cfg) {
  await goToGeneralExports(page, cfg);
  log.step(`Row action: ${cfg.exportName} -> Export Data`);
  await clickRowAction(page, cfg, cfg.exportName, 'Export Data');
  await assertNotLoginPage(page);
  const dialog = await findVisible(page, DIALOG_CANDIDATES, { timeout: 15000, label: 'Export Data dialog' }).catch(
    () => null,
  );
  const root = dialog || page.locator('body');
  const fields = await describeFields(root);
  log.info(`Export Data form fields: ${JSON.stringify(fields)}`);
  return { root, fields };
}

/**
 * Fill the business date and submit. NOT retried by the caller: a second
 * submit would generate (and deliver to the SFTP) a second file.
 */
export async function submitExportData(page, cfg, root, date) {
  const input = await findVisible(root, DATE_INPUT_CANDIDATES, { timeout: 10000, label: 'business-date input' });
  const current = await input.inputValue().catch(() => '');
  let format = cfg.dateInputFormat;
  if (format === 'auto') {
    const today = todayInTz(cfg.timezone);
    const candidates = [date, ...Array.from({ length: 10 }, (_, i) => addDays(today, 1 - i))];
    format = inferDateFormat(current, candidates);
    if (format) log.info(`Date format inferred from pre-filled "${current}": ${format}`);
    else {
      format = cfg.dateInputFallbackFormat;
      log.warn(`Could not infer date format from "${current}"; using fallback ${format}`);
    }
  }
  const value = formatDate(date, format);
  log.step(`Setting business date: "${current}" -> "${value}"`);
  await input.click();
  await input.fill('');
  await input.fill(value);
  await input.press('Tab');
  await waitForIdle(page);
  const after = await input.inputValue().catch(() => '');
  if (after.trim().toLowerCase() !== value.toLowerCase()) {
    throw new Error(`Date field shows "${after}" after entering "${value}"; refusing to generate for the wrong date`);
  }

  const submit = await findVisible(
    root,
    [(r) => r.getByRole('button', { name: /^\s*(export|generate|ok|run|submit|process|save|start|export data)\s*$/i })],
    { timeout: 10000, label: 'dialog submit button' },
  );
  log.step(`Submitting Export Data ("${(await submit.innerText().catch(() => '')).trim()}")`);
  await submit.click();
  await waitForIdle(page);
  await assertNotLoginPage(page);

  const err = await anyVisible(page, [
    (r) => r.getByRole('alert'),
    (r) => r.getByRole('alertdialog'),
    (r) => r.getByText(/\b(error|invalid|failed)\b/i),
  ]);
  if (err) {
    const text = (await err.innerText().catch(() => '')).trim();
    if (/error|invalid|fail/i.test(text)) throw Object.assign(new Error(`OPERA reported: ${text}`), { retryable: false });
  }
  // Acknowledge any confirmation popup.
  const ok = await anyVisible(page, [(r) => r.getByRole('button', { name: /^\s*(ok|close|done)\s*$/i })]);
  if (ok) {
    await ok.click().catch(() => {});
    await waitForIdle(page);
  }
  log.info('Export Data submitted');
}

// ---------------------------------------------------------------------------
// Export Details scraping
// ---------------------------------------------------------------------------

/** Collect record-looking row texts from every frame. */
async function collectRecordTexts(page, prefix) {
  const all = [];
  for (const frame of page.frames()) {
    const texts = await frame
      .evaluate((prefix) => {
        const isRecord = (t) => t && (t.includes(`${prefix}|`) || (t.match(/\|/g) || []).length >= 10);
        const out = [];
        for (const r of document.querySelectorAll('tr, [role="row"]')) {
          if (r.querySelector('tr, [role="row"]')) continue; // leaf rows only (ADF nests layout tables)
          const t = r.innerText;
          if (isRecord(t)) out.push(t);
        }
        if (!out.length && document.body) {
          for (const line of document.body.innerText.split('\n')) if (isRecord(line)) out.push(line);
        }
        return out;
      }, prefix)
      .catch(() => []);
    all.push(...texts);
  }
  return all;
}

/** Scroll every scrollable container that holds table rows. Returns true if anything moved. */
async function scrollRowContainers(page) {
  let moved = false;
  for (const frame of page.frames()) {
    const m = await frame
      .evaluate(() => {
        const boxes = new Set();
        for (const r of document.querySelectorAll('tr, [role="row"]')) {
          for (let p = r.parentElement; p && p !== document.body; p = p.parentElement) {
            if (p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
              boxes.add(p);
              break;
            }
          }
        }
        let moved = false;
        for (const el of boxes) {
          const before = el.scrollTop;
          el.scrollTop = before + Math.max(200, el.clientHeight * 0.8);
          if (el.scrollTop !== before) moved = true;
        }
        const wy = window.scrollY;
        window.scrollBy(0, Math.max(200, window.innerHeight * 0.8));
        if (window.scrollY !== wy) moved = true;
        return moved;
      })
      .catch(() => false);
    moved = moved || m;
  }
  return moved;
}

/** Look for "1 - 25 of 132"-style totals to cross-check the scrape. */
async function readReportedTotal(page) {
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
    const m = /\b\d+\s*[-–]\s*\d+\s+of\s+(\d+)\b/i.exec(text) || /\btotal(?:\s+(?:rows|records))?\s*:?\s*(\d+)\b/i.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Scrape all record lines from Export Details: max page size, scroll through
 * virtualised rows, and follow pagination. Lines accumulate into `state.rawLines`
 * so they are available for the debug dump even if a later step fails.
 */
export async function scrapeExportDetails(page, cfg, state = {}) {
  log.step('Scraping Export Details');
  if (!(await detailsOpened(page, cfg, cfg.timeouts.elementMs))) {
    throw new Error('Export Details table did not render');
  }
  await setMaxPageSize(page);
  const seen = new Map();
  state.rawLines = [];
  const add = (texts) => {
    let added = 0;
    for (const t of texts) {
      const key = t.trim();
      if (key && !seen.has(key)) {
        seen.set(key, true);
        state.rawLines.push(key);
        added++;
      }
    }
    return added;
  };

  for (let pageNo = 1; pageNo <= 500; pageNo++) {
    let pageAdded = 0;
    let stable = 0;
    for (let i = 0; i < 2000 && stable < 3; i++) {
      const added = add(await collectRecordTexts(page, cfg.property));
      pageAdded += added;
      const moved = await scrollRowContainers(page);
      await waitForIdle(page, 10000, { network: false });
      stable = !moved && added === 0 ? stable + 1 : 0;
    }
    log.info(`Page ${pageNo}: +${pageAdded} row(s), ${seen.size} total`);
    if (pageNo > 1 && pageAdded === 0) break; // "Next" didn't change anything
    if (!(await goToNextPage(page))) break;
  }

  const reported = await readReportedTotal(page);
  if (reported != null && reported !== seen.size) {
    log.warn(`Table reports ${reported} row(s) but ${seen.size} were scraped`);
  } else if (reported != null) {
    log.info(`Row count matches the table total (${reported})`);
  }
  return state.rawLines;
}
