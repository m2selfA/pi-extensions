import process from "node:process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WISPTERM_OSC = 7748;
export const WISPTERM_APP = "pi";

export const WISPTERM_STATES = ["running", "waiting_approval", "needs_input", "halted", "failed", "done"] as const;

export type WispTermState = (typeof WISPTERM_STATES)[number];

export interface WispTermStatusOptions {
  write?: (marker: string) => void;
  isTerminal?: () => boolean;
}

interface ActiveSession {
  sessionManager: ExtensionContext["sessionManager"];
  tui: boolean;
}

interface PromptCounters {
  waitingApproval: number;
  needsInput: number;
}

const ST = "\u001b\\";

export function formatWispTermMarker(state: WispTermState, app = WISPTERM_APP): string {
  return `\u001b]${WISPTERM_OSC};wispterm-agent;state=${state};app=${app}${ST}`;
}

export function promptState(kind: unknown): "waiting_approval" | "needs_input" {
  const normalized = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  return /approval|approve|confirm|permission|authorize|allow|yesno/u.test(normalized)
    ? "waiting_approval"
    : "needs_input";
}

function defaultWriter(marker: string): void {
  process.stdout.write(marker);
}

function defaultIsTerminal(): boolean {
  return process.stdout.isTTY !== false;
}

function safeIsIdle(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return false;
  }
}

export function createWispTermStatusExtension(options: WispTermStatusOptions = {}): (pi: ExtensionAPI) => void {
  const write = options.write ?? defaultWriter;
  const isTerminal = options.isTerminal ?? defaultIsTerminal;

  return function wispTermStatus(pi: ExtensionAPI): void {
    let active: ActiveSession | undefined;
    let lastState: WispTermState | undefined;
    let pendingOutcome: "completed" | "aborted" | "error" | undefined;
    let prompts: PromptCounters = { waitingApproval: 0, needsInput: 0 };

    function owns(ctx: ExtensionContext): boolean {
      return active !== undefined && active.sessionManager === ctx.sessionManager;
    }

    function resetPrompts(): void {
      prompts = { waitingApproval: 0, needsInput: 0 };
    }

    function emit(state: WispTermState, force = false): void {
      if (!active?.tui || !isTerminal()) return;
      if (!force && lastState === state) return;
      lastState = state;
      try {
        write(formatWispTermMarker(state));
      } catch {
        // Status reporting must never interrupt the Pi session.
      }
    }

    function emitAfterPromptChange(ctx: ExtensionContext): void {
      if (prompts.waitingApproval > 0) {
        emit("waiting_approval");
      } else if (prompts.needsInput > 0) {
        emit("needs_input");
      } else {
        emit(safeIsIdle(ctx) ? "done" : "running");
      }
    }

    pi.on("session_start", (_event, ctx) => {
      resetPrompts();
      lastState = undefined;
      pendingOutcome = undefined;
      active = {
        sessionManager: ctx.sessionManager,
        tui: ctx.mode === "tui",
      };
      if (active.tui) emit(safeIsIdle(ctx) ? "done" : "running", true);
    });

    pi.on("agent_start", (_event, ctx) => {
      if (!owns(ctx)) return;
      pendingOutcome = undefined;
      emit("running");
    });

    pi.on("ui_prompt_start", (event, ctx) => {
      if (!owns(ctx)) return;
      if (promptState(event.kind) === "waiting_approval") prompts.waitingApproval += 1;
      else prompts.needsInput += 1;
      emitAfterPromptChange(ctx);
    });

    pi.on("ui_prompt_end", (event, ctx) => {
      if (!owns(ctx)) return;
      if (promptState(event.kind) === "waiting_approval") {
        prompts.waitingApproval = Math.max(0, prompts.waitingApproval - 1);
      } else {
        prompts.needsInput = Math.max(0, prompts.needsInput - 1);
      }
      emitAfterPromptChange(ctx);
    });

    pi.on("agent_before_settle", (event, ctx) => {
      if (!owns(ctx)) return;
      pendingOutcome = event.continue ? undefined : event.outcome;
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!owns(ctx)) return;
      if (prompts.waitingApproval > 0 || prompts.needsInput > 0) {
        emitAfterPromptChange(ctx);
        return;
      }
      const outcome = pendingOutcome;
      pendingOutcome = undefined;
      if (outcome === "error") emit("failed");
      else if (outcome === "aborted") emit("halted");
      else emit(safeIsIdle(ctx) ? "done" : "running");
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (!owns(ctx)) return;
      emit("halted", true);
      active = undefined;
      resetPrompts();
      lastState = undefined;
      pendingOutcome = undefined;
    });
  };
}

export default function wispTermStatus(pi: ExtensionAPI): void {
  createWispTermStatusExtension()(pi);
}
