// End-to-end flow against a local mock of the OPERA screens (no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { launchBrowser } from '../src/browser.js';
import { runExport } from '../src/runner.js';
import { SessionExpiredError, ExportNotFoundError } from '../src/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = await fs.readFile(path.join(here, 'fixtures/mock-opera.html'), 'utf8');
const LOGIN = '<html><body><h1>Sign In</h1><input type="password"></body></html>';

let tmp;
let context;

function makeCfg(overrides) {
  return loadConfig(undefined, {
    baseUrl: 'https://opera.test/OperaCloud',
    outputDir: path.join(tmp, 'out'),
    userDataDir: path.join(tmp, 'profile'),
    debugDir: path.join(tmp, 'debug'),
    headless: true,
    persistSessionCookies: false,
    timeouts: { navigationMs: 15000, elementMs: 8000, generationMs: 30000 },
    retries: { attempts: 2, delayMs: 200 },
    browser: { executablePath: process.env.CHROMIUM_PATH || '' },
    ...overrides,
  });
}

async function serve(html) {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.route('https://opera.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
}

// The mock reads pre-existing generated exports from the query string.
const at = (query) => ({ baseUrl: `https://opera.test/OperaCloud?${query}` });

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oge-'));
  context = await launchBrowser(makeCfg(), { headless: true });
});
after(async () => {
  await context?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const date = { y: 2026, m: 9, d: 25 };

test('existing mode: scrapes all pages and writes the CSV', async () => {
  await serve(MOCK);
  const cfg = makeCfg({ mode: 'existing', ...at('have=20260924,20260925') });
  const res = await runExport(context, cfg, date);
  // 23 rows, every 5th without email => 19 emails; duplicate row is deduped
  assert.equal(res.records.length, 19);
  assert.equal(res.rawCount, 24);
  const csv = await fs.readFile(res.csvPath, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines[0], 'last_name,first_name,email,arrival,departure');
  assert.equal(lines[1], '"Last0","First0",guest0@example.com,2026-09-23,2026-09-25');
  assert.ok(!csv.includes('echoice'));
  assert.equal(path.basename(res.csvPath), 'guest_emails_20260925.csv');
});

test('generate mode: fills the dialog date, submits once, waits, scrapes', async () => {
  await serve(MOCK);
  const cfg = makeCfg({ mode: 'generate', ...at('have=20260924') });
  const res = await runExport(context, cfg, { y: 2026, m: 9, d: 20 });
  assert.equal(res.records.length, 19);
  assert.equal(res.records[0].departure, '2026-09-20');
});

test('existing mode with no export for the date => ExportNotFoundError', async () => {
  await serve(MOCK);
  const cfg = makeCfg({ mode: 'existing', retries: { attempts: 1, delayMs: 0 }, ...at('have=20260101') });
  await assert.rejects(runExport(context, cfg, { y: 2026, m: 8, d: 1 }), ExportNotFoundError);
});

test('login page => SessionExpiredError without retries', async () => {
  await serve(LOGIN);
  const cfg = makeCfg();
  await assert.rejects(runExport(context, cfg, date), SessionExpiredError);
  const dbg = await fs.readdir(cfg.debugDir);
  assert.ok(dbg.some((f) => f.endsWith('.png')), 'debug screenshot saved');
});

test('follows pagination when rows exceed the largest page size', async () => {
  await serve(MOCK);
  const cfg = makeCfg({ mode: 'existing', overwrite: true, ...at('have=20260925&rows=60') });
  const res = await runExport(context, cfg, date);
  assert.equal(res.rawCount, 61); // 60 + duplicate
  assert.equal(res.records.length, 48); // every 5th row has no email
});
