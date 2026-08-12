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

  constructor(
    private root: string,
    private kiln: boolean,
    private rules: PhaseRule[],
  ) {}

  observeWrite(path: string, cwd: string): void {
    try {
      const abs = isAbsolute(path) ? path : resolve(cwd, path);
      const rel = relative(this.root, abs);
      if (!rel.startsWith("..")) this.writtenRel.push(rel);
    } catch {
      /* never let telemetry interfere with the session */
    }
  }

  resolve(): { phase: string; label: string } {
    if (this.kiln) {
      const issue = inProgressIssue(this.root);
      if (issue) return { phase: "build", label: issue.id };
    }
    for (const rule of this.rules) {
      let re: RegExp;
      try {
        re = new RegExp(rule.match);
      } catch {
        continue;
      }
      if (this.writtenRel.some((p) => re.test(p))) {
        return { phase: rule.phase, label: "" };
      }
    }
    return { phase: "other", label: "" };
  }
}
