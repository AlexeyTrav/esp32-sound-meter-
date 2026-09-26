// Pure extraction logic for GSR pipe-delimited records. No browser code here,
// so it can be unit-tested and reused by the offline `parse` command.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DATE_RE = /\b20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g;

/**
 * First guest email in a record line. Internal OPERA user IDs look like
 * user@domain.com@ECHOICE1 (double @), so a match followed by "@" is skipped,
 * as is anything containing "echoice".
 */
export function extractGuestEmail(line) {
  for (const m of line.matchAll(EMAIL_RE)) {
    const next = line.charAt(m.index + m[0].length);
    if (next === '@') continue;
    if (/echoice/i.test(m[0])) continue;
    return m[0].toLowerCase();
  }
  return null;
}

/** All 20YYMMDD dates in the line, formatted YYYY-MM-DD. NAME_ID never matches. */
export function extractDates(line) {
  return (line.match(DATE_RE) || []).map(
    (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
  );
}

/**
 * Normalise one scraped row: if the row text carries extra cells before the
 * record (row numbers, checkboxes), cut everything before "<PROPERTY>|".
 * A record never contains tabs/newlines, so anything after one is another cell.
 */
export function normaliseRecordLine(text, recordPrefix) {
  let s = String(text ?? '');
  if (recordPrefix) {
    const i = s.indexOf(`${recordPrefix}|`);
    if (i > 0) s = s.slice(i);
  }
  s = s.split(/[\t\r\n]/)[0];
  return s.trim();
}

/** Parse one record line. Returns null when it is not a record or has no guest email. */
export function parseRecordLine(line) {
  if (!line || !line.includes('|')) return null;
  const email = extractGuestEmail(line);
  if (!email) return null;
  const f = line.split('|');
  const dates = extractDates(line);
  return {
    last_name: (f[2] ?? '').trim(),
    first_name: (f[3] ?? '').trim(),
    email,
    arrival: dates[0] ?? '',
    departure: dates[1] ?? '',
  };
}

/**
 * Parse many lines, dedupe by email (first occurrence wins).
 * @returns {{records: object[], stats: {lines:number, records:number, noEmail:number, duplicates:number, notRecords:number}}}
 */
export function parseRecords(lines, { recordPrefix } = {}) {
  const byEmail = new Map();
  const stats = { lines: 0, records: 0, noEmail: 0, duplicates: 0, notRecords: 0 };
  for (const raw of lines) {
    const line = normaliseRecordLine(raw, recordPrefix);
    if (!line) continue;
    stats.lines++;
    if (!line.includes('|')) {
      stats.notRecords++;
      continue;
    }
    const rec = parseRecordLine(line);
    if (!rec) {
      stats.noEmail++;
      continue;
    }
    if (byEmail.has(rec.email)) {
      stats.duplicates++;
      continue;
    }
    byEmail.set(rec.email, rec);
  }
  const records = [...byEmail.values()];
  stats.records = records.length;
  return { records, stats };
}
