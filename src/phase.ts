/**
 * Phase attribution: WHICH part of your workflow spent the tokens.
 *
 * Two signals, in priority order:
 *
 * 1. Explicit workflow state. If the project runs the KILN method (a
 *    .kiln/ directory with issues.jsonl), an issue with status
 *    "in_progress" pins the session to phase "build" and labels it with
 *    the issue id. This costs one file read and is exact.
 *
 * 2. Observed writes. The extension watches which paths a session writes
 *    and matches them against config phaseRules (regexes on repo-relative
 *    paths). First matching rule wins for the whole session. This is how
 *    scout/plan/review sessions classify themselves without any state.
 *
 * Projects with neither signal land in "other", which is honest.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PhaseRule } from "./config.ts";

export function findProjectRoot(start: string): { root: string; kiln: boolean } {
  let dir = resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (existsSync(join(dir, ".kiln"))) return { root: dir, kiln: true };
    if (gitRoot === null && existsSync(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: gitRoot ?? resolve(start), kiln: false };
}

export function repoNameOf(root: string): string {
  return basename(root);
}

interface KilnIssue {
  id: string;
  status?: string;
}

export function inProgressIssue(root: string): KilnIssue | null {
  const path = join(root, ".kiln", "issues.jsonl");
  if (!existsSync(path)) return null;
  const merged = new Map<string, KilnIssue>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec?.id) merged.set(rec.id, rec);
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    return null;
  }
  for (const issue of merged.values()) {
    if (issue.status === "in_progress") return issue;
  }
  return null;
}

/** Tracks written paths for one session and resolves its phase. */
export class PhaseTracker {
  private writtenRel: string[] = [];

  // Written out rather than using parameter properties: Node runs .ts by
  // stripping types only, and parameter properties need real transformation.
  private root: string;
  private kiln: boolean;
  private rules: PhaseRule[];

  constructor(root: string, kiln: boolean, rules: PhaseRule[]) {
    this.root = root;
    this.kiln = kiln;
    this.rules = rules;
  }

  observeWrite(path: string, cwd: string): void {
    try {
      const abs = isAbsolute(path) ? path : resolve(cwd, path);
      const rel = relative(this.root, abs);
      if (!rel.startsWith("..")) this.writtenRel.push(rel);
    } catch {
      /* never let telemetry interfere with the session */
    }
  }

  /**
   * Explicit workflow state wins outright: an in-progress issue is exact,
   * not inferred. Otherwise the phase is whichever one the session wrote to
   * *most*, because a real session touches several areas and the first rule
   * that happens to match is not the same thing as the work that got done.
   * Each path counts once, under the first rule that matches it, so order
   * rules specific to general.
   */
  resolve(): { phase: string; label: string } {
    if (this.kiln) {
      const issue = inProgressIssue(this.root);
      if (issue) return { phase: "build", label: issue.id };
    }
    const compiled: { re: RegExp; phase: string }[] = [];
    for (const rule of this.rules) {
      try {
        compiled.push({ re: new RegExp(rule.match), phase: rule.phase });
      } catch {
        /* bad user regex, skip the rule */
      }
    }
    const tally = new Map<string, number>();
    for (const p of this.writtenRel) {
      const hit = compiled.find((c) => c.re.test(p));
      if (hit) tally.set(hit.phase, (tally.get(hit.phase) ?? 0) + 1);
    }
    if (!tally.size) return { phase: "other", label: "" };
    const [phase] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return { phase, label: "" };
  }
}
