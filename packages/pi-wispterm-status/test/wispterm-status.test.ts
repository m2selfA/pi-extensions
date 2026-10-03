import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  createWispTermStatusExtension,
  formatWispTermMarker,
  promptState,
  type WispTermState,
} from "../src/wispterm-status.js";

async function emit(
  mock: ReturnType<typeof createMockPi>,
  name: string,
  event: Record<string, unknown>,
  ctx: unknown,
): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

function stateOf(marker: string): WispTermState {
  const match = marker.match(/state=([^;]+)/u);
  assert.ok(match?.[1]);
  return match[1] as WispTermState;
}

function sessionContext(options: { idle: () => boolean; mode?: string; sessionId: string }) {
  return createMockContext({
    mode: options.mode ?? "tui",
    hasUI: options.mode === undefined || options.mode === "tui",
    isIdle: options.idle,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getBranch: () => [],
    },
  });
}

test("formats a WispTerm OSC 7748 marker for Pi", () => {
  assert.equal(formatWispTermMarker("running"), "\u001b]7748;wispterm-agent;state=running;app=pi\u001b\\");
});

test("classifies approval and input prompts separately", () => {
  assert.equal(promptState("confirm"), "waiting_approval");
  assert.equal(promptState("permission"), "waiting_approval");
  assert.equal(promptState("input"), "needs_input");
  assert.equal(promptState("select"), "needs_input");
});

test("reports lifecycle transitions and suppresses duplicate states", async () => {
  const markers: string[] = [];
  const mock = createMockPi();
  let idle = true;
  const started = sessionContext({ idle: () => idle, sessionId: "first" });
  createWispTermStatusExtension({ write: (marker) => markers.push(marker), isTerminal: () => true })(mock.pi);

  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  assert.deepEqual(markers.map(stateOf), ["done"]);

  idle = false;
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  assert.deepEqual(markers.map(stateOf), ["done", "running"]);

  idle = true;
  await emit(mock, "agent_settled", {}, started.ctx);
  assert.deepEqual(markers.map(stateOf), ["done", "running", "done"]);
});

test("maps final error and abort outcomes without marking retry continuations as failures", async () => {
  const markers: string[] = [];
  const mock = createMockPi();
  const started = sessionContext({ idle: () => false, sessionId: "outcome-session" });
  createWispTermStatusExtension({ write: (marker) => markers.push(marker), isTerminal: () => true })(mock.pi);

  await emit(mock, "session_start", {}, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "agent_before_settle", { continue: true, outcome: "error" }, started.ctx);
  await emit(mock, "agent_before_settle", { continue: false, outcome: "error" }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "agent_before_settle", { continue: false, outcome: "aborted" }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);

  assert.deepEqual(markers.map(stateOf), ["running", "failed", "running", "halted"]);
});

test("keeps the highest-priority nested prompt state until every prompt ends", async () => {
  const markers: string[] = [];
  const mock = createMockPi();
  let idle = false;
  const started = sessionContext({ idle: () => idle, sessionId: "prompt-session" });
  createWispTermStatusExtension({ write: (marker) => markers.push(marker), isTerminal: () => true })(mock.pi);

  await emit(mock, "session_start", {}, started.ctx);
  await emit(mock, "ui_prompt_start", { kind: "confirm" }, started.ctx);
  await emit(mock, "ui_prompt_start", { kind: "input" }, started.ctx);
  await emit(mock, "ui_prompt_end", { kind: "confirm" }, started.ctx);
  assert.deepEqual(markers.map(stateOf), ["running", "waiting_approval", "needs_input"]);

  idle = true;
  await emit(mock, "ui_prompt_end", { kind: "input" }, started.ctx);
  assert.deepEqual(markers.map(stateOf), ["running", "waiting_approval", "needs_input", "done"]);
});

test("does not emit terminal control sequences outside TUI mode", async () => {
  const markers: string[] = [];
  const mock = createMockPi();
  const started = sessionContext({ idle: () => true, mode: "rpc", sessionId: "rpc-session" });
  createWispTermStatusExtension({ write: (marker) => markers.push(marker), isTerminal: () => true })(mock.pi);

  await emit(mock, "session_start", {}, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  await emit(mock, "session_shutdown", {}, started.ctx);
  assert.deepEqual(markers, []);
});

test("ignores a replaced session's shutdown", async () => {
  const markers: string[] = [];
  const mock = createMockPi();
  const first = sessionContext({ idle: () => true, sessionId: "first" });
  const second = sessionContext({ idle: () => true, sessionId: "second" });
  createWispTermStatusExtension({ write: (marker) => markers.push(marker), isTerminal: () => true })(mock.pi);

  await emit(mock, "session_start", {}, first.ctx);
  await emit(mock, "session_start", {}, second.ctx);
  await emit(mock, "session_shutdown", { reason: "reload" }, first.ctx);
  assert.deepEqual(markers.map(stateOf), ["done", "done"]);

  await emit(mock, "session_shutdown", { reason: "quit" }, second.ctx);
  assert.deepEqual(markers.map(stateOf), ["done", "done", "halted"]);
});

test("swallows terminal writer failures", async () => {
  const mock = createMockPi();
  const started = sessionContext({ idle: () => true, sessionId: "writer-failure" });
  createWispTermStatusExtension({
    write: () => {
      throw new Error("terminal unavailable");
    },
    isTerminal: () => true,
  })(mock.pi);

  await emit(mock, "session_start", {}, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "session_shutdown", {}, started.ctx);
});
