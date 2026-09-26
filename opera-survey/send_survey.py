"""
Step 2: email the post-stay survey to the guests in a CSV from step 1.

    python send_survey.py                 # preview only, nothing is sent
    python send_survey.py --send          # send (asks for confirmation first)
    python send_survey.py --send --csv output/guest_emails_20260925.csv

Safety:
  * default is a dry run (preview);
  * only guests whose departure date is today or earlier (they have checked out);
  * every sent email is recorded in sent_log.csv, so re-running never
    emails the same guest for the same stay twice;
  * addresses in unsubscribe.txt (one per line) are always skipped.
Settings are in config.ini, and the email text is in templates/.
"""

import argparse
import configparser
import csv
import getpass
import os
import smtplib
import ssl
import sys
import time
from datetime import date, datetime
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "output"
SENT_LOG = HERE / "sent_log.csv"
UNSUBSCRIBE = HERE / "unsubscribe.txt"


class SafeDict(dict):
    def __missing__(self, key):
        return ""


def load_config():
    path = HERE / "config.ini"
    if not path.exists():
        sys.exit("config.ini not found. Copy config.example.ini to config.ini and fill it in.")
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read(path, encoding="utf-8")
    return cfg


def latest_csv():
    files = sorted(OUTPUT_DIR.glob("guest_emails_*.csv"), key=lambda p: p.stat().st_mtime)
    if not files:
        sys.exit("No CSV in output/. Run extract_emails.py first.")
    return files[-1]


def read_guests(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def already_sent():
    if not SENT_LOG.exists():
        return set()
    with open(SENT_LOG, newline="", encoding="utf-8") as fh:
        return {(r["email"].lower(), r["departure"]) for r in csv.DictReader(fh)}


def unsubscribed():
    if not UNSUBSCRIBE.exists():
        return set()
    return {l.strip().lower() for l in UNSUBSCRIBE.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.startswith("#")}


def log_sent(guest):
    new = not SENT_LOG.exists()
    with open(SENT_LOG, "a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["sent_at", "email", "last_name", "first_name", "arrival", "departure"])
        w.writerow([datetime.now().isoformat(timespec="seconds"), guest["email"], guest["last_name"],
                    guest["first_name"], guest["arrival"], guest["departure"]])


def build_message(cfg, guest):
    s = cfg["email"]
    fields = SafeDict(guest)
    fields["first_name"] = (guest.get("first_name") or "").strip().title() or "Guest"
    fields["last_name"] = (guest.get("last_name") or "").strip().title()
    fields.update({k: v for k, v in cfg["hotel"].items()})
    url_fields = SafeDict({k: quote(str(v), safe="") for k, v in fields.items()})
    fields["survey_link"] = s["survey_link"].format_map(url_fields)

    text = (HERE / "templates" / "survey_email.txt").read_text(encoding="utf-8").format_map(fields)
    html_path = HERE / "templates" / "survey_email.html"

    msg = EmailMessage()
    msg["Subject"] = s["subject"].format_map(fields)
    msg["From"] = formataddr((s["from_name"], s["from_address"]))
    msg["To"] = guest["email"]
    if s.get("reply_to"):
        msg["Reply-To"] = s["reply_to"]
    msg["Message-ID"] = make_msgid(domain=s["from_address"].split("@")[-1])
    msg.set_content(text)
    if html_path.exists():
        msg.add_alternative(html_path.read_text(encoding="utf-8").format_map(fields), subtype="html")
    return msg


def smtp_connect(cfg):
    s = cfg["smtp"]
    password = os.environ.get("SMTP_PASSWORD") or getpass.getpass(f"SMTP password for {s['user']}: ")
    host, port = s["host"], int(s.get("port", "587"))
    ctx = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
        server.starttls(context=ctx)
    server.login(s["user"], password)
    return server


def main():
    ap = argparse.ArgumentParser(description="Step 2: send the post-stay survey")
    ap.add_argument("--csv", help="CSV from step 1 (default: newest in output/)")
    ap.add_argument("--send", action="store_true", help="actually send (default: preview only)")
    ap.add_argument("--departed-on", help="only guests who departed on this date (YYYY-MM-DD)")
    ap.add_argument("--test-to", help="send ONE sample email to this address instead of guests")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation question")
    args = ap.parse_args()

    cfg = load_config()
    csv_path = Path(args.csv) if args.csv else latest_csv()
    guests = read_guests(csv_path)
    today = date.today().isoformat()
    sent, unsub = already_sent(), unsubscribed()

    todo, skipped = [], {"not departed yet": 0, "already sent": 0, "unsubscribed": 0, "other date": 0}
    for g in guests:
        dep = g.get("departure", "")
        if args.departed_on and dep != args.departed_on:
            skipped["other date"] += 1
        elif dep and dep > today:
            skipped["not departed yet"] += 1
        elif (g["email"].lower(), dep) in sent:
            skipped["already sent"] += 1
        elif g["email"].lower() in unsub:
            skipped["unsubscribed"] += 1
        else:
            todo.append(g)

    print(f"CSV: {csv_path.name}  |  guests: {len(guests)}  |  to send: {len(todo)}")
    for k, v in skipped.items():
        if v:
            print(f"  skipped ({k}): {v}")

    if args.test_to:
        sample = dict(todo[0] if todo else guests[0])
        sample["email"] = args.test_to
        server = smtp_connect(cfg)
        server.send_message(build_message(cfg, sample))
        server.quit()
        print(f"Test email sent to {args.test_to}")
        return

    if not todo:
        print("Nothing to send.")
        return

    preview = build_message(cfg, todo[0])
    print("\n--- preview (first email) ---")
    print(f"To: {preview['To']}\nSubject: {preview['Subject']}\n")
    print(preview.get_body(("plain",)).get_content())
    print("--- recipients ---")
    for g in todo:
        print(f"  {g['email']:<40} {g['first_name']} {g['last_name']}  ({g['arrival']} -> {g['departure']})")

    if not args.send:
        print("\nPreview only. Run with --send to send these emails.")
        return
    if not args.yes and input(f"\nSend {len(todo)} email(s)? Type yes: ").strip().lower() != "yes":
        print("Cancelled.")
        return

    delay = float(cfg["smtp"].get("delay_seconds", "2"))
    server = smtp_connect(cfg)
    ok = failed = 0
    try:
        for i, g in enumerate(todo, 1):
            try:
                server.send_message(build_message(cfg, g))
                log_sent(g)
                ok += 1
                print(f"[{i}/{len(todo)}] sent  {g['email']}")
            except smtplib.SMTPServerDisconnected:
                server = smtp_connect(cfg)
                server.send_message(build_message(cfg, g))
                log_sent(g)
                ok += 1
                print(f"[{i}/{len(todo)}] sent  {g['email']} (after reconnect)")
            except Exception as e:  # bad address etc. -- keep going
                failed += 1
                print(f"[{i}/{len(todo)}] FAILED {g['email']}: {e}")
            time.sleep(delay)
    finally:
        try:
            server.quit()
        except Exception:
            pass
    print(f"\nDone: {ok} sent, {failed} failed. Log: {SENT_LOG.name}")


if __name__ == "__main__":
    main()
