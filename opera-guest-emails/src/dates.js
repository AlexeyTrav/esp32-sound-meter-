// Calendar-date helpers. A "date" here is a plain {y, m, d} object (no time,
// no timezone) so business dates never drift across UTC boundaries.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayInTz(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/** Current wall-clock "HH:MM" in the given zone. */
export function timeInTz(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

export function addDays(date, n) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function yesterdayInTz(timeZone, now = new Date()) {
  return addDays(todayInTz(timeZone, now), -1);
}

/** Accepts YYYY-MM-DD or YYYYMMDD; throws on anything else or on impossible dates. */
export function parseDateArg(s) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Invalid date "${s}" (expected YYYY-MM-DD or YYYYMMDD)`);
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const check = addDays(date, 0);
  if (check.y !== date.y || check.m !== date.m || check.d !== date.d) {
    throw new Error(`Invalid calendar date "${s}"`);
  }
  return date;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Tokens: YYYY, YY, MMM (Jan), MM, DD. Everything else is literal. */
export function formatDate(date, pattern) {
  return pattern.replace(/YYYY|YY|MMM|MM|DD/g, (tok) => {
    switch (tok) {
      case 'YYYY': return pad(date.y, 4);
      case 'YY': return pad(date.y % 100);
      case 'MMM': return MONTHS[date.m - 1];
      case 'MM': return pad(date.m);
      case 'DD': return pad(date.d);
      default: return tok;
    }
  });
}

export const ymd = (date) => formatDate(date, 'YYYYMMDD');
export const iso = (date) => formatDate(date, 'YYYY-MM-DD');

export const KNOWN_INPUT_FORMATS = [
  'MM-DD-YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD',
  'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY/MM/DD',
  'DD.MM.YYYY', 'DD-MMM-YYYY', 'DD-MMM-YY', 'MMM DD, YYYY',
  'MM-DD-YY', 'DD-MM-YY', 'MM/DD/YY', 'DD/MM/YY',
];

/**
 * OPERA pre-fills date inputs with a date we can predict (the business date,
 * i.e. today or yesterday). Find the format that renders one of the candidate
 * dates exactly as the field shows it. Returns null if nothing matches.
 */
export function inferDateFormat(value, candidateDates, formats = KNOWN_INPUT_FORMATS) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const date of candidateDates) {
    for (const f of formats) {
      if (formatDate(date, f).toLowerCase() === v) return f;
    }
  }
  return null;
}
