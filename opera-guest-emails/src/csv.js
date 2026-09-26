import fs from 'node:fs/promises';
import path from 'node:path';

export const CSV_HEADER = ['last_name', 'first_name', 'email', 'arrival', 'departure'];

const quote = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

/** Name fields are always quoted; email/dates are regex-constrained and never need it. */
export function toCsv(records) {
  const out = [CSV_HEADER.join(',')];
  for (const r of records) {
    out.push([quote(r.last_name), quote(r.first_name), r.email, r.arrival, r.departure].join(','));
  }
  return out.join('\r\n') + '\r\n';
}

/** Write atomically (tmp + rename) so a consumer never picks up a half-written file. */
export async function writeCsv(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, toCsv(records), 'utf8');
  await fs.rename(tmp, filePath);
}
