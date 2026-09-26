import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGuestEmail, extractDates, parseRecordLine, parseRecords, normaliseRecordLine } from '../src/parser.js';
import { toCsv } from '../src/csv.js';

const SAMPLE =
  'CND33|37374097|Mcintosh|Julia||405-38 9 ST NE, Calgary, AB, CA, T2E 7X9|X|CA|jmcintosh101@hotmail.com|5872257357|Y|20260826|20260925|jdoe@company.com@ECHOICE1';

test('parses the verified sample row', () => {
  assert.deepEqual(parseRecordLine(SAMPLE), {
    last_name: 'Mcintosh',
    first_name: 'Julia',
    email: 'jmcintosh101@hotmail.com',
    arrival: '2026-08-26',
    departure: '2026-09-25',
  });
});

test('skips internal OPERA user ids (double @) and echoice matches', () => {
  assert.equal(extractGuestEmail('CND33|1|A|B|clerk@hotel.com@ECHOICE1|guest@Example.COM|'), 'guest@example.com');
  assert.equal(extractGuestEmail('CND33|1|A|B|someone@echoice.com|'), null);
  assert.equal(extractGuestEmail('CND33|1|A|B|clerk@hotel.com@ECHOICE1|'), null);
});

test('NAME_ID (8 digits) is never taken as a date', () => {
  assert.deepEqual(extractDates('CND33|37374097|X|Y|20260101|20260103'), ['2026-01-01', '2026-01-03']);
  assert.deepEqual(extractDates('CND33|20261399|20261301'), []);
  assert.deepEqual(extractDates('ab 120260101 20260101x'), []);
});

test('rows without a guest email are skipped; dedupe by email', () => {
  const { records, stats } = parseRecords(
    [
      SAMPLE,
      'CND33|2|NoMail|Guy||addr|CA|5551234|20260901|20260902',
      SAMPLE.replace('Julia', 'Jules'),
      'Export Data',
      '',
    ],
    { recordPrefix: 'CND33' },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].first_name, 'Julia');
  assert.equal(stats.noEmail, 1);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.notRecords, 1);
});

test('normalises row text with leading cells', () => {
  assert.equal(normaliseRecordLine(`1\t${SAMPLE}\tExtra`, 'CND33'), SAMPLE);
  assert.equal(normaliseRecordLine(`  ${SAMPLE}  `, 'CND33'), SAMPLE);
});

test('CSV quotes names and escapes quotes', () => {
  const csv = toCsv([{ last_name: 'O"Brien, Jr', first_name: 'Ann', email: 'a@b.co', arrival: '2026-09-01', departure: '2026-09-03' }]);
  assert.equal(csv, 'last_name,first_name,email,arrival,departure\r\n"O""Brien, Jr","Ann",a@b.co,2026-09-01,2026-09-03\r\n');
});
