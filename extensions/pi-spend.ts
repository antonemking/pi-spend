/**
 * pi-spend: phase-attributed spend telemetry for pi.
 *
 * Captures every assistant message's token usage and cost into a local
 * SQLite ledger (~/.local/share/pi-spend/spend.db), tagged with the
 * project, the workflow phase that spent it, and the model. Other
 * runtimes (Claude Code hooks, review scripts) write to the same ledger,
 * so the dashboard shows your whole model economy, not one harness.
 *
 * In-session:
 *   /spend        toggle the mini dashboard widget (pi caps widgets at ten
 *                 lines, so this is a summary by construction)
 *   /spend full   one-line totals plus a pointer to the CLI
 *   footer        live session total (config: footer)
 *
 * Anywhere:
 *   pi-spend      full dashboard CLI (also good in tmux/herdr popups)
 *
 * Capture is idempotent: entries key on (runtime, session id, entry id),
 * so re-syncs and session resumes never double-count. Telemetry must
 * never break a session; every handler fails open.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadRepoConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { sessionWidget, WIDGET_LINES } from "../src/dashboard.ts";
import { fmtMoney, fmtTokens } from "../src/charts.ts";
import { findProjectRoot, PhaseTracker, repoNameOf } from "../src/phase.ts";
import { grandTotal, tokensOf } from "../src/aggregate.ts";

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "str_replace"]);

/**
 * Call a pi UI method without ever being able to take the session down.
 *
 * Several ctx.ui methods return promises. A synchronous try/catch does not
 * catch their rejections, so a bad call escapes as an unhandled rejection
 * and pi exits on uncaughtException. Telemetry must never be able to do
 * that: await the result inside the guard and swallow whatever comes back.
 */
async function safeUi(ctx: any, method: string, ...args: unknown[]): Promise<void> {
  try {
    const fn = ctx?.ui?.[method];
    if (typeof fn !== "function") return;
    await Promise.resolve(fn.call(ctx.ui, ...args));
  } catch {
    /* a telemetry extension has no business interrupting a session */
  }
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  let store: Store | null = null;
  let tracker: PhaseTracker | null = null;
  let root = "";
  let repo = "";
  let widgetOn = false;

  function getStore(): Store {
    if (!store) store = new Store();
    return store;
  }

  function initProject(cwd: string): void {
    const found = findProjectRoot(cwd);
    root = found.root;
    repo = repoNameOf(found.root);
    // A repo may define its own phase rules; its shape is not the global one.
    cfg = loadRepoConfig(found.root, loadConfig());
    tracker = new PhaseTracker(found.root, found.kiln, cfg.phaseRules);
  }

  /** Walk session entries and record any assistant usage not yet stored. */
  function sync(ctx: any): { cost: number; tokens: number } {
    const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "");
    if (!sessionId) return { cost: 0, tokens: 0 };
    const { phase, label } = tracker?.resolve() ?? { phase: "other", label: "" };
    const s = getStore();
    const entries: any[] = ctx.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries) {
      const msg = entry?.message ?? entry;
      const usage = msg?.usage ?? entry?.usage;
      if (!usage || !entry?.id) continue;
      const role = msg?.role ?? entry?.type;
      if (role && role !== "assistant" && role !== "assistantMessage") continue;
      s.record({
        runtime: "pi",
        session_id: sessionId,
        entry_id: String(entry.id),
        at: String(entry.timestamp ?? new Date().toISOString()),
        cwd: String(ctx.cwd ?? ""),
        repo,
        phase,
        label,
        provider: String(msg?.provider ?? msg?.api ?? ""),
        model: String(msg?.model ?? ""),
        input: Number(usage.input ?? 0),
        output: Number(usage.output ?? 0),
        cache_read: Number(usage.cacheRead ?? 0),
        cache_write: Number(usage.cacheWrite ?? 0),
        cost: Number(usage?.cost?.total ?? 0),
      });
    }
    const all = s.rows("runtime = ? AND session_id = ?", ["pi", sessionId]);
    const t = grandTotal(all, cfg);
    return { cost: t.cost, tokens: tokensOf(t) };
  }

  async function refreshUi(ctx: any, totals: { cost: number; tokens: number }): Promise<void> {
    if (cfg.footer) {
      await safeUi(ctx, "setStatus", "pi-spend",
        `${fmtMoney(totals.cost)} · ${fmtTokens(totals.tokens)}`);
    }
    if (widgetOn) {
      const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "");
      const lines = sessionWidget(getStore(), cfg, sessionId).slice(0, WIDGET_LINES);
      await safeUi(ctx, "setWidget", "pi-spend", lines);
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      initProject(String(ctx.cwd ?? process.cwd()));
      await refreshUi(ctx, sync(ctx));
    } catch {
      /* fail open */
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      if (!tracker) initProject(String(ctx.cwd ?? process.cwd()));
      const name = String(event?.toolName ?? "");
      if (!WRITE_TOOLS.has(name)) return;
      const p = event?.input?.path ?? event?.input?.file_path ?? event?.input?.filePath;
      if (typeof p === "string" && p) tracker?.observeWrite(p, String(ctx.cwd ?? ""));
    } catch {
      /* observer only, never blocks */
    }
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    try {
      await refreshUi(ctx, sync(ctx));
    } catch {
      /* fail open */
    }
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    try {
      sync(ctx);
      store?.close();
      store = null;
    } catch {
      /* fail open */
    }
  });

  pi.registerCommand("spend", {
    description: "Spend telemetry: /spend toggles the widget, /spend full shows totals",
    handler: async (args: string, ctx: any) => {
      try {
        const arg = (args ?? "").trim();

        if (arg === "full") {
          // pi truncates widgets at ten lines and ctx.ui.custom wants a
          // component factory, so the full dashboard belongs in a terminal,
          // not in here. Summarise and point at the CLI.
          const rows = getStore().rows();
          const t = grandTotal(rows, cfg);
          await safeUi(ctx, "notify",
            `pi-spend: ${fmtMoney(t.cost)} · ${fmtTokens(tokensOf(t))} tokens · ${t.events} calls. ` +
            `Run "pi-spend" in a shell for the full dashboard.`, "info");
          return;
        }

        widgetOn = !widgetOn;
        if (widgetOn) {
          await refreshUi(ctx, sync(ctx));
          await safeUi(ctx, "notify", "pi-spend widget on. /spend to hide.", "info");
        } else {
          await safeUi(ctx, "setWidget", "pi-spend", undefined);
          await safeUi(ctx, "notify", "pi-spend widget off.", "info");
        }
      } catch (e: any) {
        await safeUi(ctx, "notify", `pi-spend: ${e?.message ?? e}`, "error");
      }
    },
  });
}
