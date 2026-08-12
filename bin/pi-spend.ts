#!/usr/bin/env node
/**
 * pi-spend CLI: the dashboard, outside pi. Works in any terminal, which
 * makes it a good target for tmux popups, herdr keybindings, and cron.
 *
 *   pi-spend                 full dashboard
 *   pi-spend models          spend by model
 *   pi-spend phases          spend by workflow phase
 *   pi-spend repos           spend by repo
 *   pi-spend runtimes        spend by runtime (pi, claude, scripts)
 *   pi-spend days [n]        daily series (default 30)
 *   pi-spend burn            budget burn-down
 *   pi-spend log --json '{}' record an event from another runtime
 *   pi-spend db              print the database path
 *   pi-spend demo            render sample data in a throwaway db
 *
 * flags: --since <7d|30d|YYYY-MM-DD>  --repo <name>  --json
 */

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, dbPath, loadConfig } from "../src/config.ts";
import { Store, type SpendEvent } from "../src/store.ts";
import { dashboard, sectionBy, budgetSection } from "../src/dashboard.ts";
import { load, grandTotal, tokensOf, dailySeries } from "../src/aggregate.ts";
import { dim, fmtMoney, fmtTokens, sparkline } from "../src/charts.ts";

function parseSince(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const rel = v.match(/^(\d+)d$/);
  if (rel) {
    return new Date(Date.now() - Number(rel[1]) * 86_400_000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  console.error(`pi-spend: cannot parse --since ${v} (use 7d, 30d, or YYYY-MM-DD)`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    flags[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  } else {
    positional.push(a);
  }
}

const cmd = positional[0] ?? "dashboard";
const cfg = loadConfig();
const filters = { sinceIso: parseSince(flags.since), repo: flags.repo };

function jsonOut(rows: unknown): void {
  console.log(JSON.stringify(rows, null, 2));
}

switch (cmd) {
  case "dashboard": {
    const store = new Store();
    console.log("\n" + dashboard(store, cfg, filters, Number(flags.days ?? 30)) + "\n");
    store.close();
    break;
  }
  case "models":
  case "phases":
  case "repos":
  case "runtimes": {
    const dim = { models: "model", phases: "phase", repos: "repo", runtimes: "runtime" }[cmd]!;
    const store = new Store();
    if (flags.json) {
      jsonOut(load(store, filters, cfg));
    } else {
      console.log("\n" + sectionBy(store, cfg, dim as any, `by ${dim}`, filters, 15) + "\n");
    }
    store.close();
    break;
  }
  case "days": {
    const n = Number(positional[1] ?? 30);
    const store = new Store();
    const rows = load(store, filters, cfg);
    const total = grandTotal(rows, cfg);
    const metric = total.cost > 0 ? "cost" : "tokens";
    const series = dailySeries(rows, n, metric as "cost" | "tokens", cfg);
    if (flags.json) {
      jsonOut(series);
    } else {
      const sum = series.values.reduce((s, v) => s + v, 0);
      console.log(
        "\n" +
          sparkline(
            `last ${n} days (${metric})`,
            series.values,
            metric === "cost" ? fmtMoney(sum) : fmtTokens(sum),
          ) +
          "\n",
      );
    }
    store.close();
    break;
  }
  case "burn": {
    const store = new Store();
    console.log("\n" + budgetSection(store, cfg) + "\n");
    store.close();
    break;
  }
  case "log": {
    const raw = flags.json === "true" || !flags.json
      ? readFileSync(0, "utf8")
      : flags.json;
    let e: Partial<SpendEvent>;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      console.error(`pi-spend log: invalid JSON (${err})`);
      process.exit(2);
    }
    if (!e.runtime) {
      console.error("pi-spend log: 'runtime' is required");
      process.exit(2);
    }
    const store = new Store();
    const inserted = store.record({
      runtime: e.runtime,
      session_id: e.session_id ?? "",
      entry_id: e.entry_id ?? randomUUID(),
      at: e.at ?? new Date().toISOString(),
      cwd: e.cwd,
      repo: e.repo,
      phase: e.phase,
      label: e.label,
      provider: e.provider,
      model: e.model,
      input: e.input,
      output: e.output,
      cache_read: e.cache_read,
      cache_write: e.cache_write,
      cost: e.cost,
    });
    store.close();
    console.log(inserted ? "recorded" : "duplicate, ignored");
    break;
  }
  case "db":
    console.log(dbPath());
    break;
  case "demo": {
    // Sample data in a throwaway database, so the charts can be judged
    // before any real capture is wired up. Your own ledger is untouched.
    const tmp = join(tmpdir(), `pi-spend-demo-${process.pid}.db`);
    const store = new Store(tmp);
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    let n = 0;
    const add = (
      d: number, runtime: string, provider: string, model: string,
      phase: string, label: string, inp: number, out: number, cr: number, cost: number,
    ) => store.record({
      runtime, session_id: `demo-${d}`, entry_id: `demo-${n++}`, at: day(d),
      repo: "acme-api", phase, label, provider, model,
      input: inp, output: out, cache_read: cr, cost,
    });

    for (let d = 13; d >= 0; d--) {
      const busy = d % 7 !== 0 && d % 7 !== 6;
      if (!busy) continue;
      // workhorse grinds the build phase all day, flat rate
      for (let i = 0; i < 4 + (d % 3); i++) {
        add(d, "pi", "openai", "gpt-5.6", "build", `I-${1000 + d}`,
            38_000 + i * 5000, 5200 + i * 800, 96_000, 0);
      }
      // adversary reviews each close, cents apiece
      add(d, "script:review", "fireworks", "kimi-k3", "review", `I-${1000 + d}`,
          31_000, 1700, 0, 0.021);
      // reserve: scouting and decomposition, the judgment-dense gates
      if (d % 3 === 0) {
        add(d, "claude", "anthropic", "claude-sonnet-5", "scout", `L-00${d}`,
            42_000, 7800, 180_000, 0.31);
      }
      if (d % 5 === 0) {
        add(d, "claude", "anthropic", "claude-opus-5", "plan", `L-00${d}`,
            28_000, 11_000, 210_000, 0.52);
      }
      // ...and a rescue in the build phase, which is the smell this tool exists to surface
      if (d === 3 || d === 8) {
        add(d, "claude", "anthropic", "claude-opus-5", "build", `I-${1000 + d}`,
            51_000, 14_000, 240_000, 0.74);
      }
    }

    // Canned illustration: render against shipped defaults, not local config,
    // so the demo looks the same for everyone evaluating the package.
    console.log("\n" + dashboard(store, DEFAULT_CONFIG, {}, 14) + "\n");
    console.log(
      dim("  demo data in a throwaway db, your ledger is untouched.\n" +
          "  note the reserve showing up under `build`: that is the pattern\n" +
          "  this tool exists to make visible.\n"),
    );
    store.close();
    try { unlinkSync(tmp); } catch { /* best effort */ }
    break;
  }
  default:
    console.log(
      "usage: pi-spend [dashboard|models|phases|repos|runtimes|days|burn|demo|log|db] " +
        "[--since 7d] [--repo name] [--json]",
    );
    process.exit(cmd === "help" ? 0 : 2);
}
