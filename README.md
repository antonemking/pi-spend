# pi-spend

Phase-attributed spend telemetry for [pi](https://pi.dev). Not another token
counter: pi-spend knows **where in your workflow** the tokens went, meters
**every runtime in your stack** into one ledger, and burns budgets down by
the **role** each model plays.

```
pi-spend · $14.20 · 8.4M tokens · 312 calls
──────────────────────────────────────────────────────────
by family
  ████████████████████████████████████████████░░░░░░░░░░
  ■ workhorse $0 · 6.1M tok   ■ adversary $1.80 · 900k tok   ■ reserve $12.40 · 1.4M tok

by phase
  build     ████████████████████████████  $2.10 · 5.9M tok
  scout     ██████████                    $6.80 · 1.2M tok
  plan      ███████                       $4.90 · 800k tok
  review    ███                           $1.80 · 900k tok

last 30 days (cost)
  ▁▁▂▁▃▄▂▁▁▅▂▃▇▂▁▄▃▂▁▆▃▂▄▁▂▃█▄▂▃  $14.20

budgets
  reserve (lifetime)   ████████░░░░░░░░░░░░░░░░░░  $12.40 of $50 25%
  adversary (monthly)  ██░░░░░░░░░░░░░░░░░░░░░░░░  $1.80 of $25 7%
```

## Why this exists

There are good pi extensions that count tokens and cost
([pi-tracker](https://www.npmjs.com/package/pi-tracker),
[pi-agent-budget](https://www.npmjs.com/package/pi-agent-budget),
[pi-token-usage](https://www.npmjs.com/package/pi-token-usage), and more).
If you want a footer counter or per-model totals inside pi, use one of those.

pi-spend answers a different question: **what part of your process is
spending, and is that the part that should be?** It was built for a
software factory method (KILN) where scouting, planning, building, and
adversarial review are separate phases run by different models with
different billing. The generalization:

- **Phases, not just models.** Sessions self-classify from what they touch,
  via configurable path rules (wrote `scout/` means scouting, wrote
  `plan.json` means planning, an in-progress issue means building). Any
  workflow with file conventions can define its own phases.
- **One ledger for the whole economy.** pi captures itself via the
  extension; Claude Code reports through a Stop hook; any script can `INSERT`
  a row or pipe JSON to `pi-spend log`. Your flat-rate subscription, your
  per-token adversary, and your prepaid reserve land in the same table.
- **Budgets by role.** Models map to families (workhorse, adversary,
  reserve, or whatever you name) through regex rules, and each family can
  carry a lifetime or monthly budget with a burn-down gauge.

## Install

```bash
pi install npm:pi-spend
```

That gives you the capture extension, the `/spend` command inside pi, and
the `pi-spend` CLI. Node 24+ (the CLI and extension are TypeScript run
natively; no build step, in the spirit of the harness).

## Use

Inside pi:

- `/spend` toggles a compact live widget above the editor
- `/spend full` prints the full dashboard
- the footer shows a running session total (disable with `"footer": false`)

Anywhere:

```bash
pi-spend               # full dashboard
pi-spend phases        # where the tokens went
pi-spend burn          # budget gauges
pi-spend days 14       # daily sparkline
pi-spend models --since 7d --json
```

The CLI renders with unicode and ANSI color, degrades cleanly when piped,
and works over SSH. Bind it to a tmux or herdr popup for a one-keystroke
factory dashboard.

## Configure

`~/.local/share/pi-spend/config.json` (created with defaults on first run):

```jsonc
{
  // roles in your model economy; regex against "provider/model".
  // billing "subscription" tracks token volume and forces cost to zero,
  // because pricing subscription tokens at list rates invents money you
  // never spent. "api" (the default) records real per-token dollars.
  "families": [
    { "match": "gpt-|codex", "family": "workhorse", "billing": "subscription" },
    { "match": "kimi|k[23]", "family": "adversary", "billing": "api" },
    { "match": "claude", "family": "reserve", "billing": "api" }
  ],
  // USD budgets per family
  "budgets": {
    "reserve": { "amount": 50, "period": "lifetime" },
    "adversary": { "amount": 25, "period": "monthly" }
  },
  // write-based phase detection; regex against repo-relative written paths
  "phaseRules": [
    { "match": "^scout/", "phase": "scout" },
    { "match": "^plan\\.json$", "phase": "plan" },
    { "match": "^\\.kiln/reviews/", "phase": "review" },
    { "match": "^decisions/", "phase": "decide" }
  ],
  "footer": true
}
```

Families **and billing are computed at read time**, so editing the rules
re-buckets and re-values your entire history without re-capturing anything.
Move a model from a subscription onto metered credits and one word in this
file turns its past volume into priced spend.

That read-time billing switch is the difference between a real number and a
fictional one. A subscription covers its tokens; multiplying them by list
rates produces a figure that looks like money and isn't. pi-spend reports
those rows at zero and keeps the volume, which is the number that actually
governs context discipline.

## Other runtimes

The database is the contract: one SQLite table at
`~/.local/share/pi-spend/spend.db` (override with `PI_SPEND_DB`), primary
key `(runtime, session_id, entry_id)` so re-syncs never double-count.

- **Claude Code:** `integrations/claude-code/pi-spend-claude-hook.py` is a
  Stop hook that parses session transcripts and records usage with real
  dollar costs. See the comment header for install and pricing notes.
- **Anything else:** `pi-spend log --json '{"runtime":"script:my-tool",
  "model":"...","input":1200,"output":400,"cost":0.004,"phase":"review"}'`
  or write the row with any sqlite client.

## Schema

```sql
CREATE TABLE events (
  runtime TEXT, session_id TEXT, entry_id TEXT,   -- PK, idempotency
  at TEXT,                                        -- ISO 8601
  cwd TEXT, repo TEXT,
  phase TEXT, label TEXT,                         -- workflow attribution
  provider TEXT, model TEXT,
  input INT, output INT, cache_read INT, cache_write INT,
  cost REAL                                       -- USD; 0 for flat-rate
);
```

## License

MIT. Built by [Lorewood Labs](https://github.com/antonemking) as the
telemetry layer for the KILN software factory method, generalized for any
pi workflow.
