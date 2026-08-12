/**
 * Terminal chart rendering. No dependencies, ANSI 256 color, degrades to
 * plain text when NO_COLOR is set or stdout is not a TTY.
 */

const PALETTE = [39, 208, 170, 114, 203, 227, 75, 141, 216, 108];
const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function colorEnabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

export function paint(text: string, color: number, bold = false): string {
  if (!colorEnabled()) return text;
  const b = bold ? "1;" : "";
  return `\x1b[${b}38;5;${color}m${text}\x1b[0m`;
}

export function dim(text: string): string {
  return colorEnabled() ? `\x1b[2m${text}\x1b[0m` : text;
}

export function colorFor(index: number): number {
  return PALETTE[index % PALETTE.length];
}

export function fmtMoney(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 0.1) return `$${v.toFixed(2)}`;
  if (v === 0) return "$0";
  return `$${v.toFixed(3)}`;
}

export function fmtTokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function bar(value: number, max: number, width: number): string {
  if (max <= 0) return "";
  const cells = (value / max) * width;
  const full = Math.floor(cells);
  const rem = Math.round((cells - full) * 8);
  return "█".repeat(full) + (rem > 0 ? BLOCKS[rem] : "");
}

export interface BarRow {
  label: string;
  value: number;
  detail?: string;
  color?: number;
}

/** Horizontal bar chart with right-aligned values. */
export function barChart(title: string, rows: BarRow[], width = 34): string {
  if (!rows.length) return `${paint(title, 245)}\n  ${dim("(no data)")}`;
  const max = Math.max(...rows.map((r) => r.value));
  const lw = Math.min(22, Math.max(...rows.map((r) => r.label.length)));
  const lines = [paint(title, 250, true)];
  rows.forEach((r, i) => {
    const label = r.label.length > lw ? r.label.slice(0, lw - 1) + "…" : r.label.padEnd(lw);
    const b = bar(r.value, max, width);
    const painted = paint(b, r.color ?? colorFor(i));
    lines.push(`  ${label}  ${painted}${b ? " " : ""}${r.detail ?? ""}`);
  });
  return lines.join("\n");
}

/** One-line proportional stacked bar with legend. */
export function stackedBar(title: string, parts: BarRow[], width = 58): string {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const lines = [paint(title, 250, true)];
  if (total <= 0) {
    lines.push(`  ${dim("(no data)")}`);
    return lines.join("\n");
  }
  let barStr = "";
  const legend: string[] = [];
  parts.forEach((p, i) => {
    const cells = Math.max(p.value > 0 ? 1 : 0, Math.round((p.value / total) * width));
    const c = p.color ?? colorFor(i);
    barStr += paint("█".repeat(cells), c);
    if (p.value > 0) {
      legend.push(`${paint("■", c)} ${p.label} ${dim(p.detail ?? fmtMoney(p.value))}`);
    }
  });
  lines.push(`  ${barStr}`);
  lines.push(`  ${legend.join("   ")}`);
  return lines.join("\n");
}

/** Sparkline over a numeric series. */
export function sparkline(title: string, values: number[], detail = ""): string {
  if (!values.length) return `${paint(title, 250, true)}\n  ${dim("(no data)")}`;
  const max = Math.max(...values);
  const line = values
    .map((v) => {
      if (max <= 0) return SPARKS[0];
      const idx = Math.min(7, Math.ceil((v / max) * 7));
      return SPARKS[v > 0 ? Math.max(1, idx) : 0];
    })
    .join("");
  return `${paint(title, 250, true)}\n  ${paint(line, 45)}  ${dim(detail)}`;
}

/** Budget gauge: [██████░░░░░] $12.40 of $50, 25%. */
export function gauge(label: string, spent: number, budget: number, width = 26): string {
  const ratio = budget > 0 ? Math.min(1, spent / budget) : 0;
  const full = Math.round(ratio * width);
  const color = ratio < 0.5 ? 114 : ratio < 0.85 ? 214 : 203;
  const meter = paint("█".repeat(full), color) + dim("░".repeat(width - full));
  const pct = budget > 0 ? ` ${Math.round(ratio * 100)}%` : "";
  return `  ${label.padEnd(12)} ${meter} ${fmtMoney(spent)} of ${fmtMoney(budget)}${pct}`;
}

export function heading(text: string): string {
  return paint(text, 255, true) + "\n" + dim("─".repeat(Math.min(64, text.length + 46)));
}
