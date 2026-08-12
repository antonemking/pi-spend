/**
 * pi-spend configuration.
 *
 * Config lives at ~/.local/share/pi-spend/config.json (created with defaults
 * on first run, override dir with PI_SPEND_HOME). The database sits next to
 * it as spend.db (override the full path with PI_SPEND_DB).
 *
 * Families are roles in your model economy, not vendors. The defaults model
 * a three-role economy: a flat-rate workhorse, a per-token adversarial
 * reviewer, and a prepaid reserve. Rename or extend freely; families are
 * computed from `families` rules at read time, so editing the rules
 * re-buckets your entire history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FamilyRule {
  match: string; // case-insensitive regex tested against "provider/model"
  family: string;
  /**
   * How this family is paid for.
   *
   *   "api"          per-token billing; recorded cost is real money.
   *   "subscription" flat rate; token volume is tracked and cost is forced
   *                  to zero, because list-price arithmetic on tokens a
   *                  subscription already covers is a fictional number.
   *
   * Defaults to "api". Billing is applied at read time, so flipping a
   * family from subscription to api (a plan change, a move to credits)
   * re-values your whole history without re-capturing anything.
   */
  billing?: "api" | "subscription";
}

export interface Budget {
  amount: number; // USD
  period: "lifetime" | "monthly";
}

export interface PhaseRule {
  match: string; // regex tested against repo-relative written paths
  phase: string;
}

export interface SpendConfig {
  families: FamilyRule[];
  budgets: Record<string, Budget>;
  /**
   * Write-based phase detection: when a session writes a path matching
   * `match`, the session is tagged with `phase`. Defaults follow the KILN
   * method's conventions but are just path rules; adapt them to any
   * workflow, or delete them and everything lands in "other".
   */
  phaseRules: PhaseRule[];
  /** Show the live session total in pi's footer. */
  footer: boolean;
}

export const DEFAULT_CONFIG: SpendConfig = {
  families: [
    { match: "gpt-|codex", family: "workhorse", billing: "subscription" },
    { match: "kimi|k[23]", family: "adversary", billing: "api" },
    { match: "claude", family: "reserve", billing: "api" },
  ],
  budgets: {
    reserve: { amount: 50, period: "lifetime" },
    adversary: { amount: 25, period: "monthly" },
  },
  phaseRules: [
    { match: "^scout/", phase: "scout" },
    { match: "^plan\\.json$", phase: "plan" },
    { match: "^\\.kiln/reviews/", phase: "review" },
    { match: "^decisions/", phase: "decide" },
  ],
  footer: true,
};

export function spendHome(): string {
  return (
    process.env.PI_SPEND_HOME ?? join(homedir(), ".local", "share", "pi-spend")
  );
}

export function dbPath(): string {
  return process.env.PI_SPEND_DB ?? join(spendHome(), "spend.db");
}

/**
 * Per-repo overrides from `<root>/.pi-spend.json`.
 *
 * Phase rules are the part of this config that cannot be global: an Elixir
 * server with a Swift client divides its work nothing like a repo running a
 * gated method. A repo that defines `phaseRules` replaces the global set for
 * itself; everything else still comes from the user-level config.
 *
 * Rules are first-match-wins, so order them specific to general:
 * `^server/test/` must precede `^server/` or tests read as server work.
 */
export function loadRepoConfig(root: string, base: SpendConfig): SpendConfig {
  try {
    const path = join(root, ".pi-spend.json");
    if (!existsSync(path)) return base;
    const repo = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...base,
      ...(Array.isArray(repo.phaseRules) ? { phaseRules: repo.phaseRules } : {}),
    };
  } catch {
    return base;
  }
}

export function loadConfig(): SpendConfig {
  const home = spendHome();
  const path = join(home, "config.json");
  try {
    if (!existsSync(path)) {
      mkdirSync(home, { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      return structuredClone(DEFAULT_CONFIG);
    }
    const user = JSON.parse(readFileSync(path, "utf8"));
    return { ...structuredClone(DEFAULT_CONFIG), ...user };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function ruleFor(cfg: SpendConfig, provider: string, model: string): FamilyRule | null {
  const hay = `${provider}/${model}`;
  for (const rule of cfg.families) {
    try {
      if (new RegExp(rule.match, "i").test(hay)) return rule;
    } catch {
      /* bad user regex, skip the rule */
    }
  }
  return null;
}

export function familyOf(cfg: SpendConfig, provider: string, model: string): string {
  return ruleFor(cfg, provider, model)?.family ?? "other";
}

/** True when this model's cost should be suppressed as already-paid-for. */
export function isSubscription(cfg: SpendConfig, provider: string, model: string): boolean {
  return ruleFor(cfg, provider, model)?.billing === "subscription";
}

/** True when any family is flat-rate, so the UI can caveat token-only rows. */
export function hasSubscriptionFamily(cfg: SpendConfig): boolean {
  return cfg.families.some((r) => r.billing === "subscription");
}
