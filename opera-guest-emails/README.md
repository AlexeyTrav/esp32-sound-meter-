# opera-guest-emails

Pulls guest emails out of OPERA Cloud for the post-stay survey pipeline.

It reuses an **already logged-in** OPERA Cloud browser session and opens
**Miscellaneous → Exports → General → `MANUAL_RHG_GUEST_STA` → View Exports →
`CND33YYYYMMDD.GSR` → Export Details**. From there it scrapes the pipe-delimited
rows shown on screen and writes one CSV per business date:

```
output/guest_emails_20260925.csv
last_name,first_name,email,arrival,departure
"Mcintosh","Julia",jmcintosh101@hotmail.com,2026-08-26,2026-09-25
```

The GSR file itself goes to a third-party SFTP and can't be downloaded, so the
tool reads the on-screen table instead. It does not send the surveys; it only
drops the CSV into the output folder.

---

## 1. Install

Requires Node.js 18.17+ (20 or 22 recommended).

```bash
cd /opt/opera-guest-emails          # wherever you put this folder
npm install
npx playwright install chromium     # one-time browser download (~150 MB)
cp config.example.json config.json  # then edit if needed
```

On Windows, use the same commands in PowerShell from the project folder.

## 2. First-run login (once, by a human, with MFA)

OPERA Cloud login uses phone MFA and **cannot be automated**. The tool never
types credentials and never stores them. You log in once in a real browser
window, and the session is saved in the `profile/` folder.

```bash
npm run login
```

1. A Chromium window opens on OPERA Cloud.
2. Log in normally and approve the MFA prompt on your phone.
3. Once the OPERA home screen loads, the tool prints `Logged in. Session saved…`
   and closes the window.

Then check that the saved session works without a window:

```bash
npm run check        # exit 0 = session OK, exit 2 = not logged in
```

> **Machine requirements:** `login` needs a visible desktop. Run it on the PC or
> server where the tool will live. On a Linux server with no screen, use VNC or
> `xvfb-run` plus a VNC viewer, or log in over remote desktop.

### Keeping the session alive

The OPERA session survives the night audit as long as it sees activity. There
are two ways to provide that:

| | **Daemon (recommended)** | **Cron / timers** |
|---|---|---|
| Command | `npm run daemon` | `run` daily + `keepalive --once` every 15 min |
| Browser | One browser kept open for the whole time | Started and closed each time |
| Session cookies | Never lost | Restored from `.profile.session.json` at each start |

If `npm run check` passes right after `login`, both options work. If it fails,
use the daemon. It never closes the browser, so session-only cookies can't be
lost.

## 3. Daily usage

```bash
npm start                               # yesterday (America/Edmonton), mode from config
node src/cli.js run --date 2026-09-25   # a specific business date
node src/cli.js run --mode generate     # run "Export Data" first, then scrape
node src/cli.js run --overwrite         # replace an existing CSV for that date
node src/cli.js run --headed            # watch it work
```

### Modes: `existing` / `generate` / `auto`

| mode | What it does |
|---|---|
| `existing` (default) | Scrapes an already-generated `CND33YYYYMMDD.GSR`. If there isn't one, exits with code 3. Changes nothing in OPERA. |
| `generate` | Runs **Export Data** for the business date, waits until the new file shows up in Generated Exports, then scrapes it. |
| `auto` | Uses an existing export if one is there, otherwise generates. |

> ⚠️ **Generating has a side effect.** OPERA also delivers each generated GSR
> file to the third-party SFTP. `generate` therefore sends one extra file every
> time it runs. The tool never submits Export Data twice in one run, even when
> it retries. Confirm with the SFTP owner (RHG) that extra files are fine before
> you switch to `generate` or `auto`.

When generating, the tool reads the date format from the value OPERA pre-fills
in the date field (for example `09-26-2026` → `MM-DD-YYYY`). It then enters the
business date in that format and refuses to submit unless the field shows
exactly that date afterwards. If the format can't be detected, it uses
`dateInputFallbackFormat`.

### Idempotency

If `output/guest_emails_YYYYMMDD.csv` already exists, the run logs "skipping"
and exits 0 without opening a browser. Use `--overwrite` (or `"overwrite": true`)
to replace the file. CSVs are written atomically (temp file, then rename), so
anything reading the folder never sees a half-written file.

## 4. Scheduling

Ready-made files are in [`deploy/`](deploy/). Change `/opt/opera-guest-emails`
to your install path.

### Option A: systemd daemon (recommended)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/opera-guest-emails-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opera-guest-emails-daemon
loginctl enable-linger "$USER"          # keep it running after you log out
journalctl --user -u opera-guest-emails-daemon -f
```

The daemon touches OPERA every `keepAliveMinutes` and runs the export once a
day at `dailyRunAt` (`America/Edmonton`). If a run fails, it tries again up to
`retries.attempts` times that day, 30 minutes apart. On session expiry it sends
a notification and exits with code 2. The unit does **not** restart on exit
code 2, so you don't get a flood of alerts. After you run `npm run login`, start
it again with `systemctl --user restart opera-guest-emails-daemon`.

### Option B: systemd timers

```bash
cp deploy/opera-guest-emails-{run,keepalive}.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opera-guest-emails-run.timer opera-guest-emails-keepalive.timer
```

### Option C: cron

See [`deploy/crontab.example`](deploy/crontab.example). Create the log folder
first with `mkdir -p logs`.

```cron
CRON_TZ=America/Edmonton
30 6 * * *    cd /opt/opera-guest-emails && node src/cli.js run >> logs/run.log 2>&1
*/15 * * * *  cd /opt/opera-guest-emails && node src/cli.js keepalive --once >> logs/keepalive.log 2>&1
```

Don't run the daemon and cron/timers together. A lock file makes sure only one
process uses the browser profile at a time. `run` waits up to
`timeouts.lockWaitMs` for the profile to be free. `keepalive --once` simply
skips if a run is in progress, because that run already keeps the session warm.

### Windows (Task Scheduler)

Create two tasks with the action `node.exe`, arguments `src\cli.js run` (daily
06:30) and `src\cli.js keepalive --once` (every 15 min), and set "Start in" to
the project folder. Or run one task at logon with `src\cli.js daemon`.

## 5. Notifications (Telegram stub)

Notifications fire on `session_expired`, `run_failed` and `export_not_found`.
They also fire on `run_succeeded` if `notify.onSuccess` is `true`. You can
configure either sink, or both:

```json
"notify": {
  "webhookUrl": "https://example.com/hook",
  "command": "./scripts/notify-telegram.sh",
  "onSuccess": false
}
```

- **webhookUrl** receives a POST with JSON
  `{event, message, property, host, time, date?, ...}`.
- **command** is run through the shell with the env vars `NOTIFY_EVENT`,
  `NOTIFY_MESSAGE` and `NOTIFY_JSON`.

To send to Telegram, use [`scripts/notify-telegram.sh`](scripts/notify-telegram.sh).
Create a bot with @BotFather, then put `TELEGRAM_BOT_TOKEN=…` and
`TELEGRAM_CHAT_ID=…` in `/opt/opera-guest-emails/.env`. The systemd units
already load that file; with cron, put the variables in the crontab. Keep
tokens out of `config.json` and out of git.

## 6. Exit codes

| code | meaning |
|---|---|
| 0 | CSV written, or it already existed and was skipped |
| 1 | Failure (see log and `debug/`) |
| 2 | **Session expired.** A human must run `npm run login` |
| 3 | No generated export for that date (mode `existing`) |
| 4 | Browser profile locked by another process |

## 7. Tuning to the live screens: `discover`

The tool finds everything by **visible text and ARIA roles** (plus DOM
structure relative to that text), never by Oracle's generated element IDs. If
an OPERA update renames something, run:

```bash
node src/cli.js discover --headed
```

It walks home → export list → Export Data dialog (it **cancels** the dialog and
never submits) → Generated Exports. For each step it saves a screenshot and
HTML, and writes a JSON report to `debug/` with the menu items, the export row
text, the date-dialog fields (label and pre-filled value) and the file names in
the list. Use that to adjust `menuPath`, `exportName`, `fileNamePattern` or the
date format.

How each step is found:

- **Menu:** each `menuPath` entry is matched as a menuitem, link, button, tree
  item or tab with that exact name, then as plain text. The tool hovers, then
  clicks.
- **Row "⋮" menu:** the tool starts from the cell showing the export name or
  file name and walks up to the nearest table row. There it tries buttons whose
  name, title or aria-label says actions/more/options, then icon-only buttons,
  until **View Exports** or **Export Data** appears.
- **Export Details:** the tool sets **Show** to its largest value (or "All").
  It then scrolls every scrollable table container, because ADF loads rows as
  you scroll, and clicks **Next** until it is disabled. It collects every row
  containing `CND33|`. If the table shows a total ("1 – 25 of 132"), the log
  reports whether the scraped row count matches it.
- **Waiting:** after each action the tool waits for ADF to finish its server
  round-trip (`AdfPage.PAGE.isSynchronizedWithServer()`).

## 8. Extraction rules

These are applied to each scraped row, in [`src/parser.js`](src/parser.js):

- Rows without `|` are ignored. Extra table cells in front of `CND33|` are
  dropped.
- `last_name` = field 2 and `first_name` = field 3 (counting from 0, splitting
  on `|`).
- **Email** is the first email-shaped value that is **not** directly followed
  by `@` and does not contain `echoice`. This skips internal OPERA user IDs
  like `user@domain.com@ECHOICE1`. The email is lowercased. Rows without a
  guest email are skipped.
- **Dates:** every `20YYMMDD` value in the row is found. The first is arrival
  and the second is departure, written as `YYYY-MM-DD`. The 8-digit NAME_ID
  never matches this pattern.
- Rows are de-duplicated by email; the first occurrence wins.

To reprocess text you copied by hand (a fallback when the browser flow breaks):

```bash
node src/cli.js parse rows.txt --date 2026-09-25     # -> output/guest_emails_20260925.csv
```

## 9. Configuration reference (`config.json`)

| key | default | notes |
|---|---|---|
| `baseUrl` | Medicine Hat Lodge OPERA Cloud URL | |
| `property` | `CND33` | Used in the file name and as the record prefix |
| `timezone` | `America/Edmonton` | Decides what "yesterday" and `dailyRunAt` mean |
| `outputDir` / `userDataDir` / `debugDir` | `./output`, `./profile`, `./debug` | Relative to the config file |
| `headless` | `true` | `--headed` / `--headless` override it |
| `mode` | `existing` | `existing` \| `generate` \| `auto` |
| `overwrite`, `saveRaw` | `false` | `saveRaw` also keeps the raw scraped rows in `debug/` |
| `exportName` | `MANUAL_RHG_GUEST_STA` | |
| `fileNamePattern` | `{PROPERTY}{YYYYMMDD}.GSR` | |
| `generatedRowPick` | `first` | Which row to use when several share the file name (`first` \| `last`) |
| `menuPath` | `["Miscellaneous","Exports","General"]` | |
| `dateInputFormat` | `auto` | Or a fixed pattern such as `DD-MM-YYYY` or `DD-MMM-YYYY` |
| `dateInputFallbackFormat` | `MM-DD-YYYY` | Used when `auto` can't detect the format |
| `keepAliveMinutes` | `15` | |
| `dailyRunAt` | `06:30` | Daemon only |
| `persistSessionCookies` | `true` | Keeps session cookies in `.profile.session.json` |
| `timeouts.*` | see example | `generationMs` = how long to wait for a new export to appear |
| `retries.attempts` / `delayMs` | `3` / `5000` | Per navigation step. Never applied to the Export Data submit |
| `notify.*` | empty | See section 5 |
| `browser.executablePath` / `channel` | empty | For example `"channel": "msedge"` to use installed Edge |

## 10. Security and privacy

- `profile/` and `.profile.session.json` together are a logged-in OPERA
  session. Treat them like a password: restrict the folder to the service
  account (`chmod 700`). They are git-ignored.
- `output/` and `debug/` contain guest PII: names, emails, addresses and phone
  numbers in raw rows and screenshots. They are git-ignored. Delete old debug
  files regularly, for example
  `find debug -mtime +14 -delete` from cron.
- The tool never enters credentials. When it lands on a login page, it stops
  with exit code 2.

## 11. Troubleshooting

| Symptom | What to do |
|---|---|
| Exit 2 every morning | The session expired overnight. Run `npm run login`. Switch to the daemon if you're on cron. |
| `Timed out waiting for "Miscellaneous"` | The menu label differs. Run `discover` and fix `menuPath`. |
| `Could not open the action menu item…` | Look at `debug/fail-*.png`. The "⋮" button may be named differently. Run `discover --headed` and watch. |
| `Table reports N row(s) but M were scraped` | Try `--headed` and check that Show / Next behave as expected. Also look at `debug/*.raw.txt`. |
| `Date field shows … after entering …` | Set `dateInputFormat` to the format OPERA displays. |
| Exit 4 | Another instance (daemon, run or keepalive) is using the profile. |

Every failure saves `debug/fail-<date>-<time>.{png,html,raw.txt,error.txt}`.
For more detailed logs, add `DEBUG=1`.

## 12. Development

```bash
npm test
```

This runs the unit tests (parser, dates, CSV) and an end-to-end Playwright test
against a local mock of the OPERA screens (`test/fixtures/mock-opera.html`):
menu, row "⋮" menu, Export Data dialog, Generated Exports, and a paginated
Export Details table. The e2e test uses the Playwright browser; set
`CHROMIUM_PATH` to point it at another Chromium.

```
src/
  cli.js       commands: run, login, check, keepalive, daemon, discover, parse
  runner.js    the per-date pipeline + debug dumps
  opera.js     OPERA screen navigation and scraping (text/role based)
  browser.js   persistent profile, session cookies, login-page detection
  ui.js        frame-aware "first visible match" helpers, ADF idle wait, retries
  parser.js    record → {last_name, first_name, email, arrival, departure}
  csv.js       CSV writer
  dates.js     business-date helpers (timezone-safe), date-format inference
  notify.js    webhook / command hook
  lock.js      single-user lock on the browser profile
```
