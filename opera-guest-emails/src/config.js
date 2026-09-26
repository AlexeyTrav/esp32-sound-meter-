import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  baseUrl:
    'https://mtcu9.oraclehospitality.us-ashburn-1.ocs.oraclecloud.com/ECHOICE1/operacloud/faces/opera-cloud-index/OperaCloud',
  property: 'CND33',
  timezone: 'America/Edmonton',

  outputDir: './output',
  userDataDir: './profile',
  debugDir: './debug',

  headless: true,
  // existing: scrape an already-generated export for the date (no side effects)
  // generate: always run "Export Data" first (NOTE: OPERA also delivers the file to the SFTP)
  // auto:     use an existing export if there is one, otherwise generate
  mode: 'existing',
  overwrite: false,
  saveRaw: false,

  exportName: 'MANUAL_RHG_GUEST_STA',
  fileNamePattern: '{PROPERTY}{YYYYMMDD}.GSR',
  // If several generated exports share the file name: "first" or "last" row in the list.
  generatedRowPick: 'first',
  menuPath: ['Miscellaneous', 'Exports', 'General'],

  // Date format the Export Data dialog expects. "auto" infers it from the
  // value OPERA pre-fills; falls back to dateInputFallbackFormat.
  dateInputFormat: 'auto',
  dateInputFallbackFormat: 'MM-DD-YYYY',

  keepAliveMinutes: 15,
  dailyRunAt: '06:30', // daemon mode, local time in `timezone`

  persistSessionCookies: true,

  timeouts: {
    navigationMs: 60000,
    elementMs: 30000,
    generationMs: 300000,
    lockWaitMs: 600000,
    loginWaitMs: 900000,
  },
  retries: {
    attempts: 3,
    delayMs: 5000,
  },
  notify: {
    webhookUrl: '',
    command: '',
    onSuccess: false,
  },
  browser: {
    executablePath: '',
    channel: '',
    slowMo: 0,
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * defaults <- config file <- CLI overrides. Relative paths resolve against the
 * config file's folder (or the project folder when no file is used), so cron
 * jobs behave the same regardless of their working directory.
 */
export function loadConfig(configPath, overrides = {}) {
  let fileCfg = {};
  let baseDir = PROJECT_DIR;
  const candidate = configPath || path.join(PROJECT_DIR, 'config.json');
  if (fs.existsSync(candidate)) {
    fileCfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    baseDir = path.dirname(path.resolve(candidate));
  } else if (configPath) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const cfg = deepMerge(deepMerge(DEFAULTS, fileCfg), overrides);
  for (const key of ['outputDir', 'userDataDir', 'debugDir']) {
    cfg[key] = path.resolve(baseDir, cfg[key]);
  }
  if (!['existing', 'generate', 'auto'].includes(cfg.mode)) {
    throw new Error(`Invalid mode "${cfg.mode}" (expected existing | generate | auto)`);
  }
  if (!/^\d{2}:\d{2}$/.test(cfg.dailyRunAt)) {
    throw new Error(`Invalid dailyRunAt "${cfg.dailyRunAt}" (expected HH:MM)`);
  }
  cfg.configFile = fs.existsSync(candidate) ? path.resolve(candidate) : null;
  cfg.lockFile = path.join(path.dirname(cfg.userDataDir), `.${path.basename(cfg.userDataDir)}.lock`);
  cfg.sessionStateFile = path.join(path.dirname(cfg.userDataDir), `.${path.basename(cfg.userDataDir)}.session.json`);
  return cfg;
}
