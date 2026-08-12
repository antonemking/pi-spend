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
 *
 * flags: --since <7d|30d|YYYY-MM-DD>  --repo <name>  --json
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dbPath, loadConfig } from "../src/config.ts";
import { Store, type SpendEvent } from "../src/store.ts";
import { dashboard, sectionBy, budgetSection } from "../src/dashboard.ts";
import { load, grandTotal, tokensOf, dailySeries } from "../src/aggregate.ts";
import { fmtMoney, fmtTokens, sparkline } from "../src/charts.ts";

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
    const total = grandTotal(rows);
    const metric = total.cost > 0 ? "cost" : "tokens";
    const series = dailySeries(rows, n, metric as "cost" | "tokens");
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
  default:
    console.log(
      "usage: pi-spend [dashboard|models|phases|repos|runtimes|days|burn|log|db] " +
        "[--since 7d] [--repo name] [--json]",
    );
    process.exit(cmd === "help" ? 0 : 2);
}
