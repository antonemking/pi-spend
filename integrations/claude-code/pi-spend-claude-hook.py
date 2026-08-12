#!/usr/bin/env python3
"""
Claude Code -> pi-spend bridge. Stdlib only.

Runs as a Claude Code Stop hook: reads the hook payload from stdin, parses
the session transcript, and records every assistant message's token usage
into the shared pi-spend SQLite ledger. Idempotent: entries key on
(runtime, session_id, entry_id), so repeated Stop events never double-count.

Install: add to ~/.claude/settings.json

  {
    "hooks": {
      "Stop": [
        {"hooks": [{"type": "command",
                    "command": "python3 /path/to/pi-spend-claude-hook.py"}]}
      ]
    }
  }

Cost is computed from PRICES below (USD per million tokens, list prices as
of August 2026; verify against https://platform.claude.com/docs/en/pricing).
Cache writes are billed at the 5-minute-TTL rate (1.25x input) as an
approximation; 1-hour-TTL writes cost more. Override any entry via
~/.local/share/pi-spend/config.json under "claudePrices".
"""

import json
import os
import re
import sqlite3
import sys
from pathlib import Path

# (input, output, cache_read, cache_write_5m) per million tokens
PRICES = {
    r"fable|mythos": (10.0, 50.0, 1.0, 12.5),
    r"opus": (5.0, 25.0, 0.5, 6.25),
    r"sonnet": (3.0, 15.0, 0.3, 3.75),
    r"haiku": (1.0, 5.0, 0.1, 1.25),
}

ALWAYS_PHASES = [
    (r"(^|/)scout/", "scout"),
    (r"(^|/)plan\.json$", "plan"),
    (r"(^|/)\.kiln/reviews/", "review"),
    (r"(^|/)decisions/", "decide"),
]


def db_path():
    if os.environ.get("PI_SPEND_DB"):
        return Path(os.environ["PI_SPEND_DB"])
    home = Path(os.environ.get("PI_SPEND_HOME",
                Path.home() / ".local" / "share" / "pi-spend"))
    return home / "spend.db"


def load_prices():
    prices = dict(PRICES)
    cfg_path = Path(os.environ.get("PI_SPEND_HOME",
                    Path.home() / ".local" / "share" / "pi-spend")) / "config.json"
    try:
        user = json.loads(cfg_path.read_text()).get("claudePrices", {})
        for pattern, vals in user.items():
            if isinstance(vals, list) and len(vals) == 4:
                prices[pattern] = tuple(vals)
    except Exception:
        pass
    return prices


def cost_of(model, usage, prices):
    for pattern, (p_in, p_out, p_cr, p_cw) in prices.items():
        if re.search(pattern, model, re.I):
            return (usage.get("input_tokens", 0) * p_in
                    + usage.get("output_tokens", 0) * p_out
                    + usage.get("cache_read_input_tokens", 0) * p_cr
                    + usage.get("cache_creation_input_tokens", 0) * p_cw) / 1e6
    return 0.0


def kiln_phase(cwd):
    """Phase from KILN state if the project runs it: in-progress issue -> build."""
    d = Path(cwd or ".")
    for cand in [d, *d.parents]:
        issues = cand / ".kiln" / "issues.jsonl"
        if issues.is_file():
            merged = {}
            for line in issues.read_text().splitlines():
                try:
                    rec = json.loads(line)
                    merged[rec.get("id")] = rec
                except Exception:
                    continue
            for rec in merged.values():
                if rec.get("status") == "in_progress":
                    return "build", rec.get("id", "")
            return "other", ""
    return "other", ""


SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  runtime TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
  entry_id TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'other', label TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (runtime, session_id, entry_id)
);
"""


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    transcript = payload.get("transcript_path", "")
    session_id = payload.get("session_id", "")
    cwd = payload.get("cwd", "")
    if not transcript or not Path(transcript).is_file():
        sys.exit(0)

    prices = load_prices()
    phase, label = kiln_phase(cwd)
    repo = Path(cwd).name if cwd else ""

    rows = []
    for line in Path(transcript).read_text().splitlines():
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        usage = msg.get("usage") or {}
        if not usage:
            continue
        model = msg.get("model", "")
        rows.append((
            "claude",
            session_id or rec.get("sessionId", ""),
            rec.get("uuid", ""),
            rec.get("timestamp", ""),
            cwd, repo, phase, label,
            "anthropic", model,
            usage.get("input_tokens", 0),
            usage.get("output_tokens", 0),
            usage.get("cache_read_input_tokens", 0),
            usage.get("cache_creation_input_tokens", 0),
            cost_of(model, usage, prices),
        ))

    if not rows:
        sys.exit(0)

    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    try:
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR IGNORE INTO events (runtime, session_id, entry_id, at, "
            "cwd, repo, phase, label, provider, model, input, output, "
            "cache_read, cache_write, cost) VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.commit()
    finally:
        con.close()
    sys.exit(0)


if __name__ == "__main__":
    main()
