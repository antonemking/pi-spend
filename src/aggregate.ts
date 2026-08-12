/**
 * Aggregations over the events table. All grouping happens in JS so the
 * family dimension (computed from config rules) behaves exactly like the
 * stored dimensions.
 */

import type { SpendConfig } from "./config.ts";
import { familyOf } from "./config.ts";
import { Store } from "./store.ts";

export interface Totals {
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  events: number;
}

export type Dimension = "model" | "family" | "phase" | "repo" | "runtime" | "day" | "label";

export interface Filters {
  sinceIso?: string;
  repo?: string;
  phase?: string;
  family?: string;
}

function emptyTotals(): Totals {
  return { cost: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, events: 0 };
}

function keyFor(dim: Dimension, row: Record<string, unknown>, cfg: SpendConfig): string {
  if (dim === "family") return familyOf(cfg, String(row.provider ?? ""), String(row.model ?? ""));
  if (dim === "day") return String(row.at ?? "").slice(0, 10);
  const v = String(row[dim] ?? "");
  return v || "(none)";
}

export function load(store: Store, f: Filters, cfg: SpendConfig): Record<string, unknown>[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.sinceIso) {
    where.push("at >= ?");
    params.push(f.sinceIso);
  }
  if (f.repo) {
    where.push("repo = ?");
    params.push(f.repo);
  }
  if (f.phase) {
    where.push("phase = ?");
    params.push(f.phase);
  }
  let rows = store.rows(where.length ? where.join(" AND ") : "1=1", params);
  if (f.family) {
    rows = rows.filter(
      (r) => familyOf(cfg, String(r.provider ?? ""), String(r.model ?? "")) === f.family,
    );
  }
  return rows;
}

export function totalsBy(
  rows: Record<string, unknown>[],
  dim: Dimension,
  cfg: SpendConfig,
): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const k = keyFor(dim, r, cfg);
    const t = out.get(k) ?? emptyTotals();
    t.cost += Number(r.cost ?? 0);
    t.input += Number(r.input ?? 0);
    t.output += Number(r.output ?? 0);
    t.cache_read += Number(r.cache_read ?? 0);
    t.cache_write += Number(r.cache_write ?? 0);
    t.events += 1;
    out.set(k, t);
  }
  return out;
}

export function grandTotal(rows: Record<string, unknown>[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    t.cost += Number(r.cost ?? 0);
    t.input += Number(r.input ?? 0);
    t.output += Number(r.output ?? 0);
    t.cache_read += Number(r.cache_read ?? 0);
    t.cache_write += Number(r.cache_write ?? 0);
    t.events += 1;
  }
  return t;
}

export function tokensOf(t: Totals): number {
  return t.input + t.output + t.cache_read + t.cache_write;
}

/** Series of daily cost (or tokens) for the last n days, oldest first. */
export function dailySeries(
  rows: Record<string, unknown>[],
  days: number,
  metric: "cost" | "tokens",
): { labels: string[]; values: number[] } {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = String(r.at ?? "").slice(0, 10);
    const v =
      metric === "cost"
        ? Number(r.cost ?? 0)
        : Number(r.input ?? 0) + Number(r.output ?? 0) +
          Number(r.cache_read ?? 0) + Number(r.cache_write ?? 0);
    byDay.set(day, (byDay.get(day) ?? 0) + v);
  }
  const labels: string[] = [];
  const values: number[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    labels.push(key);
    values.push(byDay.get(key) ?? 0);
  }
  return { labels, values };
}

/**
 * Budget state per family. Lifetime budgets count everything; monthly
 * budgets count the current UTC calendar month.
 */
export function burndown(
  store: Store,
  cfg: SpendConfig,
): { family: string; spent: number; budget: number; period: string }[] {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const out: { family: string; spent: number; budget: number; period: string }[] = [];
  for (const [family, b] of Object.entries(cfg.budgets)) {
    const rows = load(
      store,
      b.period === "monthly" ? { sinceIso: monthStart, family } : { family },
      cfg,
    );
    out.push({ family, spent: grandTotal(rows).cost, budget: b.amount, period: b.period });
  }
  return out;
}
