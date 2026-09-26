"""
Step 1: pull guest emails from the OPERA Cloud "Export Details" screen that is
already open in your Chrome window, and save them to a CSV.

The script does NOT log in and does NOT click through menus. You open the
screen yourself (Miscellaneous -> Exports -> General -> MANUAL_RHG_GUEST_STA ->
View Exports -> the file -> Export Details), then run:

    python extract_emails.py

Chrome must have been started with start_chrome.bat (remote debugging on port
9222) so the script can read the page. Fallbacks without that:

    python extract_emails.py --clipboard      # after Ctrl+A, Ctrl+C on the page
    python extract_emails.py --file rows.txt  # text you pasted into a file
"""

import argparse
import csv
import re
import sys
import time
from datetime import datetime
from pathlib import Path

PROPERTY = "CND33"
HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "output"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
DATE_RE = re.compile(r"\b20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b")
FILE_DATE_RE = re.compile(PROPERTY + r"(20\d{6})\.GSR", re.I)


# ---------------------------------------------------------------- parsing ---

def guest_email(line):
    """First email not followed by '@' (skips OPERA user ids like x@y.com@ECHOICE1)."""
    for m in EMAIL_RE.finditer(line):
        if line[m.end():m.end() + 1] == "@":
            continue
        if "echoice" in m.group(0).lower():
            continue
        return m.group(0).lower()
    return None


def parse_line(line):
    # Drop extra table cells before the record (row numbers etc.).
    i = line.find(PROPERTY + "|")
    if i > 0:
        line = line[i:]
    line = re.split(r"[\t\r\n]", line)[0].strip()
    if "|" not in line:
        return None
    email = guest_email(line)
    if not email:
        return None
    f = line.split("|")
    dates = [f"{d[:4]}-{d[4:6]}-{d[6:]}" for d in DATE_RE.findall(line)]
    return {
        "last_name": f[2].strip() if len(f) > 2 else "",
        "first_name": f[3].strip() if len(f) > 3 else "",
        "email": email,
        "arrival": dates[0] if dates else "",
        "departure": dates[1] if len(dates) > 1 else "",
    }


def parse_lines(lines):
    """Returns (records deduped by email, number of record-looking lines)."""
    by_email = {}
    n = 0
    for raw in lines:
        if "|" not in raw:
            continue
        n += 1
        rec = parse_line(raw)
        if rec and rec["email"] not in by_email:
            by_email[rec["email"]] = rec
    return list(by_email.values()), n


# ------------------------------------------------------- reading the page ---

COLLECT_JS = """(prefix) => {
  const isRec = t => t && (t.includes(prefix + '|') || (t.match(/\\|/g) || []).length >= 10);
  const out = [];
  for (const r of document.querySelectorAll('tr, [role="row"]')) {
    if (r.querySelector('tr, [role="row"]')) continue;   // leaf rows only
    if (isRec(r.innerText)) out.push(r.innerText);
  }
  if (!out.length && document.body)
    for (const l of document.body.innerText.split('\\n')) if (isRec(l)) out.push(l);
  return out;
}"""

SCROLL_JS = """() => {
  const boxes = new Set();
  for (const r of document.querySelectorAll('tr, [role="row"]'))
    for (let p = r.parentElement; p && p !== document.body; p = p.parentElement)
      if (p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) { boxes.add(p); break; }
  let moved = false;
  for (const b of boxes) { const s = b.scrollTop; b.scrollTop = s + Math.max(200, b.clientHeight * 0.8); if (b.scrollTop !== s) moved = true; }
  const y = window.scrollY; window.scrollBy(0, Math.max(200, window.innerHeight * 0.8)); if (window.scrollY !== y) moved = true;
  return moved;
}"""


def collect(page):
    rows = []
    for frame in page.frames:
        try:
            rows += frame.evaluate(COLLECT_JS, PROPERTY)
        except Exception:
            pass
    return rows


def scroll(page):
    moved = False
    for frame in page.frames:
        try:
            moved = frame.evaluate(SCROLL_JS) or moved
        except Exception:
            pass
    return moved


def click_next(page):
    """Click an enabled 'Next' pager button, if there is one."""
    for frame in page.frames:
        for loc in (
            frame.get_by_role("button", name=re.compile(r"^\s*next( page)?\s*$", re.I)),
            frame.get_by_role("link", name=re.compile(r"^\s*next( page)?\s*$", re.I)),
            frame.locator('[title="Next Page" i], [aria-label="Next Page" i]'),
        ):
            try:
                if loc.count() and loc.first.is_visible() and loc.first.is_enabled() \
                        and loc.first.get_attribute("aria-disabled") != "true":
                    loc.first.click()
                    time.sleep(2)
                    return True
            except Exception:
                pass
    return False


def read_from_chrome(port):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(f"http://localhost:{port}")
        except Exception:
            sys.exit(
                f"Could not reach Chrome on port {port}.\n"
                "Start Chrome with start_chrome.bat, log in to OPERA in that window,\n"
                "or use --clipboard instead."
            )
        pages = [pg for ctx in browser.contexts for pg in ctx.pages]
        page = next((pg for pg in pages if collect(pg)), None)
        if page is None:
            sys.exit(
                "No open tab shows GSR rows (" + PROPERTY + "|...).\n"
                "Open Export Details for the file in OPERA and run again."
            )
        print(f"Reading tab: {page.title()}")

        seen = {}
        for page_no in range(1, 200):
            before = len(seen)
            idle = 0
            while idle < 3:  # scroll until nothing new loads
                new = 0
                for r in collect(page):
                    key = r.strip()
                    if key and key not in seen:
                        seen[key] = True
                        new += 1
                idle = idle + 1 if (not scroll(page) and new == 0) else 0
                time.sleep(0.4)
            print(f"  page {page_no}: {len(seen) - before} rows")
            if page_no > 1 and len(seen) == before:
                break
            if not click_next(page):
                break

        m = FILE_DATE_RE.search(" ".join(fr.evaluate("document.body.innerText") for fr in page.frames[:1]))
        # Leaving the `with` block only disconnects; your Chrome stays open.
        return list(seen), (m.group(1) if m else None)


def read_clipboard():
    import tkinter
    root = tkinter.Tk()
    root.withdraw()
    try:
        text = root.clipboard_get()
    finally:
        root.destroy()
    return text.splitlines()


# ------------------------------------------------------------------ main ---

def write_csv(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["last_name", "first_name", "email", "arrival", "departure"])
        for r in records:
            w.writerow([r["last_name"], r["first_name"], r["email"], r["arrival"], r["departure"]])


def main():
    ap = argparse.ArgumentParser(description="Step 1: guest emails from OPERA Export Details -> CSV")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--clipboard", action="store_true", help="read text copied with Ctrl+A, Ctrl+C")
    src.add_argument("--file", help="read rows from a text file")
    ap.add_argument("--port", type=int, default=9222, help="Chrome remote-debugging port")
    ap.add_argument("--out", help="output CSV path")
    args = ap.parse_args()

    file_date = None
    if args.file:
        lines = Path(args.file).read_text(encoding="utf-8", errors="replace").splitlines()
    elif args.clipboard:
        lines = read_clipboard()
    else:
        lines, file_date = read_from_chrome(args.port)

    text = "\n".join(lines)
    if not file_date:
        m = FILE_DATE_RE.search(text)
        file_date = m.group(1) if m else None

    records, n = parse_lines(lines)
    if n == 0:
        sys.exit("No GSR rows found. Is Export Details open (and everything copied)?")

    stamp = file_date or datetime.now().strftime("%Y%m%d_%H%M")
    out = Path(args.out) if args.out else OUTPUT_DIR / f"guest_emails_{stamp}.csv"
    write_csv(out, records)
    print(f"\nRows read: {n}  |  guests with email: {len(records)}  |  without email: {n - len(records)} (incl. duplicates)")
    print(f"Saved: {out}")


if __name__ == "__main__":
    main()
