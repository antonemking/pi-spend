/**
 * Dashboard composition, shared by the CLI and the in-pi /spend widget.
 */

import { barChart, colorFor, dim, fmtMoney, fmtTokens, gauge, heading, paint, sparkline, stackedBar } from "./charts.ts";
import type { SpendConfig } from "./config.ts";
import { hasSubscriptionFamily } from "./config.ts";
import { dailySeries, burndown, grandTotal, load, tokensOf, totalsBy, type Dimension, type Filters, type Totals } from "./aggregate.ts";
import { Store } from "./store.ts";

function sortByCostThenTokens(m: Map<string, Totals>): [string, Totals][] {
  return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost || tokensOf(b[1]) - tokensOf(a[1]));
}

function detailOf(t: Totals): string {
  return `${fmtMoney(t.cost)} ${dim("·")} ${fmtTokens(tokensOf(t))} tok`;
}

export function sectionBy(
  store: Store,
  cfg: SpendConfig,
  dim_: Dimension,
  title: string,
  f: Filters,
  limit = 10,
): string {
  const rows = load(store, f, cfg);
  const groups = sortByCostThenTokens(totalsBy(rows, dim_, cfg)).slice(0, limit);
  const anyCost = groups.some(([, t]) => t.cost > 0);
  return barChart(
    title,
    groups.map(([label, t], i) => ({
      label,
      value: anyCost ? t.cost : tokensOf(t),
      detail: detailOf(t),
      color: colorFor(i),
    })),
  );
}

export function budgetSection(store: Store, cfg: SpendConfig): string {
  const states = burndown(store, cfg);
  if (!states.length) return "";
  const lines = [paint("budgets", 250, true)];
  for (const s of states) {
    lines.push(gauge(`${s.family} ${dim(`(${s.period})`)}`, s.spent, s.budget));
  }
  return lines.join("\n");
}

export function dashboard(store: Store, cfg: SpendConfig, f: Filters, days = 30): string {
  const rows = load(store, f, cfg);
  const total = grandTotal(rows, cfg);
  const daily = dailySeries(rows, days, total.cost > 0 ? "cost" : "tokens", cfg);
  const spent = daily.values.reduce((s, v) => s + v, 0);

  // The stacked bar shows TOKEN share (volume): flat-rate workhorses would
  // vanish on a dollar scale. Dollar amounts live in the legend detail.
  const families = sortByCostThenTokens(totalsBy(rows, "family", cfg));
  const parts = families.map(([label, t], i) => ({
    label,
    value: tokensOf(t),
    detail: detailOf(t),
    color: colorFor(i),
  }));

  const out: string[] = [];
  out.push(heading(`pi-spend ${dim("·")} ${fmtMoney(total.cost)} ${dim("·")} ${fmtTokens(tokensOf(total))} tokens ${dim("·")} ${total.events} calls`));
  out.push("");
  out.push(stackedBar(`by family ${dim("(bar = token share)")}`, parts));
  out.push("");
  out.push(sectionBy(store, cfg, "phase", "by phase", f, 8));
  out.push("");
  out.push(sectionBy(store, cfg, "model", "by model", f, 8));
  out.push("");
  out.push(
    sparkline(
      `last ${days} days ${dim(total.cost > 0 ? "(cost)" : "(tokens)")}`,
      daily.values,
      total.cost > 0 ? fmtMoney(spent) : fmtTokens(spent),
    ),
  );
  const budgets = budgetSection(store, cfg);
  if (budgets) {
    out.push("");
    out.push(budgets);
  }
  if (hasSubscriptionFamily(cfg)) {
    out.push("");
    out.push(dim("  $0 rows are flat-rate, not free: their tokens are covered by a"));
    out.push(dim("  subscription, so volume is the number that matters there."));
  }
  return out.join("\n");
}

/**
 * Compact widget for pi's setWidget. Hard-capped at WIDGET_LINES: pi
 * truncates anything longer, so the cap lives here where the content is
 * chosen rather than being applied blindly at the edge.
 */
export const WIDGET_LINES = 9;

export function sessionWidget(
  store: Store,
  cfg: SpendConfig,
  sessionId: string,
): string[] {
  const mine = store.rows("runtime = ? AND session_id = ?", ["pi", sessionId]);
  const session = grandTotal(mine, cfg);
  const all = grandTotal(store.rows(), cfg);

  const out = [
    `pi-spend · this session ${fmtMoney(session.cost)} · ${fmtTokens(tokensOf(session))} tok · ${session.events} msgs`,
    dim(`  all runtimes ${fmtMoney(all.cost)} · ${fmtTokens(tokensOf(all))} tok`),
  ];

  const phases = sortByCostThenTokens(totalsBy(store.rows(), "phase", cfg)).slice(0, 3);
  if (phases.length) {
    out.push("");
    out.push(paint("top phases", 250, true));
    for (const [p, t] of phases) {
      out.push(`  ${p.padEnd(8)} ${fmtMoney(t.cost)} ${dim("·")} ${fmtTokens(tokensOf(t))}`);
    }
  }

  for (const b of burndown(store, cfg)) {
    if (out.length >= WIDGET_LINES) break;
    if (b.spent > 0) out.push(gauge(b.family, b.spent, b.budget, 12));
  }

  return out.slice(0, WIDGET_LINES);
}
