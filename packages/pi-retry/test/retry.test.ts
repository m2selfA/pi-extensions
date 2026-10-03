import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyAssistantFailure,
  decorateRetryableError,
  isPermanentProviderMessage,
  isTransientProviderMessage,
  RETRYABLE_ERROR_TAG,
} from "../src/classifier.js";
import retry from "../src/retry.js";
import { createRetryRoute, registerRetryVirtualModel } from "../src/router.js";
import {
  loadRetrySettings,
  normalizeRetrySettings,
  parseModelRef,
  projectRetrySettingsPath,
  RETRY_VIRTUAL_MODEL,
  RETRY_VIRTUAL_PROVIDER,
  retrySettingsPath,
} from "../src/settings.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retry settings", () => {
  test("accepts provider/model references whose model id contains a slash", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-5")).toBe("openrouter/anthropic/claude-sonnet-4-5");
    expect(parseModelRef("openai-codex/gpt-5.4")).toBe("openai-codex/gpt-5.4");
    expect(parseModelRef("openrouter/")).toBeUndefined();
    expect(parseModelRef("openrouter/model name")).toBeUndefined();
  });

  test("loads user settings and trusted project overrides without creating files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-retry-settings-"));
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "workspace");
      mkdirSync(cwd, { recursive: true });
      const ctx = { cwd, isProjectTrusted: () => true } as never;

      expect(loadRetrySettings(ctx, agentDir).kind).toBe("missing");
      expect(() => retrySettingsPath(agentDir)).not.toThrow();
      expect(() => projectRetrySettingsPath(cwd)).not.toThrow();

      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        retrySettingsPath(agentDir),
        JSON.stringify({ enabled: true, autoRoute: true, fallbackModels: ["openai-codex/gpt-5.4"] }),
      );
      mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
      writeFileSync(
        projectRetrySettingsPath(cwd),
        JSON.stringify({ fallbackModels: ["openrouter/anthropic/claude-sonnet-4-5"] }),
      );

      expect(loadRetrySettings(ctx, agentDir)).toMatchObject({
        kind: "loaded",
        errors: [],
        settings: {
          enabled: true,
          autoRoute: true,
          fallbackModels: [{ model: "openrouter/anthropic/claude-sonnet-4-5" }],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a malformed scope without replacing valid settings with defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-retry-settings-"));
    try {
      const agentDir = join(root, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(retrySettingsPath(agentDir), JSON.stringify({ autoRoute: true }));
      const ctx = { cwd: join(root, "workspace"), isProjectTrusted: () => false } as never;
      const state = loadRetrySettings(ctx, agentDir);
      expect(state.kind).toBe("loaded");
      expect(state.settings.autoRoute).toBe(true);

      writeFileSync(retrySettingsPath(agentDir), "{");
      const invalid = loadRetrySettings(ctx, agentDir);
      expect(invalid.kind).toBe("invalid");
      expect(invalid.settings.autoRoute).toBe(false);
      expect(invalid.errors).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid settings shapes", () => {
    expect(normalizeRetrySettings({ enabled: "yes" })).toBeUndefined();
    expect(normalizeRetrySettings({ fallbackModels: ["openai/model", " "] })).toBeUndefined();
    expect(
      normalizeRetrySettings({ fallbackModels: [{ model: "openai/model", thinkingLevel: "extreme" }] }),
    ).toBeUndefined();
    expect(normalizeRetrySettings({ fallbackModels: Array.from({ length: 17 }, (_, i) => `p/${i}`) })).toBeUndefined();
    expect(
      normalizeRetrySettings({
        fallbackModels: [
          "openrouter/anthropic/claude-sonnet-4-5",
          { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
        ],
      }),
    ).toMatchObject({
      fallbackModels: [
        { model: "openrouter/anthropic/claude-sonnet-4-5" },
        { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
      ],
    });
    expect(
      normalizeRetrySettings({
        fallbackModels: [
          "anthropic/claude-sonnet-4-5",
          { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
        ],
      }),
    ).toMatchObject({ fallbackModels: [{ model: "anthropic/claude-sonnet-4-5" }] });
  });
});

describe("provider failure classification", () => {
  test("classifies transient provider errors", () => {
    expect(isTransientProviderMessage("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransientProviderMessage("Unknown error (no error details in response)")).toBe(true);
    expect(isTransientProviderMessage("Codex error: You can retry your request")).toBe(true);
    expect(isTransientProviderMessage("stream ended before a terminal response event")).toBe(true);
    expect(
      classifyAssistantFailure({ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }),
    ).toMatchObject({
      kind: "transient",
    });
  });

  test("keeps permanent account and request failures out of retry", () => {
    expect(isPermanentProviderMessage("401 Unauthorized: invalid API key")).toBe(true);
    expect(isPermanentProviderMessage("context length exceeded")).toBe(true);
    expect(isTransientProviderMessage("429 quota exceeded; billing required")).toBe(false);
    expect(
      classifyAssistantFailure({ role: "assistant", stopReason: "error", errorMessage: "invalid request" }),
    ).toMatchObject({
      kind: "permanent",
    });
  });

  test("distinguishes provider aborts from user cancellation", () => {
    expect(
      classifyAssistantFailure({ role: "assistant", stopReason: "aborted", errorMessage: "request timeout" }),
    ).toMatchObject({
      kind: "transient",
    });
    expect(
      classifyAssistantFailure({ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }, true),
    ).toMatchObject({ kind: "user-abort" });
  });

  test("adds a stable marker exactly once", () => {
    const decorated = decorateRetryableError("HTTP 503", "the provider is unavailable");
    expect(decorated).toContain(RETRYABLE_ERROR_TAG);
    expect(decorateRetryableError(decorated, "another reason")).toBe(decorated);
  });
});

describe("fallback routing", () => {
  type TestModel = { provider: string; id: string; api: string };

  function model(provider: string, id: string, api = "openai-completions"): TestModel {
    return { provider, id, api };
  }

  test("switches candidates only after a classified retry and stays sticky for continuation", () => {
    const sessionManager = {};
    const models = [
      model("openai", "primary"),
      model("openrouter", "anthropic/fallback"),
      model("anthropic", "backup"),
    ];
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return models.find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return models;
        },
      },
      getSettings() {
        return {};
      },
    } as unknown as ExtensionContext;
    const autoPrimaries = new WeakMap<object, string>();
    autoPrimaries.set(sessionManager, "openai/primary");
    const notices: string[] = [];
    const route = createRetryRoute(
      () => ({
        enabled: true,
        autoRoute: true,
        fallbackModels: [{ model: "openrouter/anthropic/fallback" }, { model: "anthropic/backup" }],
      }),
      autoPrimaries,
      (_ctx, from, to) => notices.push(`${from}->${to}`),
    );
    const virtual = model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual");

    const first = route({ model: virtual, reason: "user", thinkingLevel: "medium", messages: [] } as never, ctx);
    expect(modelReferenceForTest(first.model)).toBe("openai/primary");

    const second = route(
      {
        model: virtual,
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: first.state,
        failed: {
          model: first.model,
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(second.model)).toBe("openrouter/anthropic/fallback");
    expect(notices).toEqual(["openai/primary->openrouter/anthropic/fallback"]);

    const third = route(
      {
        model: virtual,
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: second.state,
        failed: {
          model: second.model,
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(third.model)).toBe("anthropic/backup");
    expect(notices).toEqual([
      "openai/primary->openrouter/anthropic/fallback",
      "openrouter/anthropic/fallback->anthropic/backup",
    ]);

    const continuation = route(
      {
        model: virtual,
        reason: "continuation",
        thinkingLevel: "medium",
        messages: [],
        state: third.state,
        previous: { model: third.model, thinkingLevel: "medium" },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(continuation.model)).toBe("anthropic/backup");

    const exhausted = route(
      {
        model: virtual,
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: continuation.state,
        failed: {
          model: continuation.model,
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(exhausted.model)).toBe("anthropic/backup");
    expect(notices).toHaveLength(2);
  });

  test("prefers same-name fallbacks before other names and uses Pi default thinking", () => {
    const sessionManager = {};
    const models = [model("openai", "gpt"), model("same", "gpt"), model("other", "model")];
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return models.find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return models;
        },
      },
      getSettings() {
        return { defaultThinkingLevel: "low" };
      },
    } as unknown as ExtensionContext;
    const autoPrimaries = new WeakMap<object, string>();
    autoPrimaries.set(sessionManager, "openai/gpt");
    const route = createRetryRoute(
      () => ({
        enabled: true,
        autoRoute: true,
        fallbackModels: [{ model: "other/model", thinkingLevel: "high" }, { model: "same/gpt" }],
      }),
      autoPrimaries,
      undefined,
      () => "low",
    );
    const virtual = model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual");
    const first = route({ model: virtual, reason: "user", thinkingLevel: "medium", messages: [] } as never, ctx);
    const second = route(
      {
        model: virtual,
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: first.state,
        failed: {
          model: first.model,
          thinkingLevel: "medium",
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(second.model)).toBe("same/gpt");
    expect(second.thinkingLevel).toBe("low");

    const continuation = route(
      {
        model: virtual,
        reason: "continuation",
        thinkingLevel: "medium",
        messages: [],
        state: second.state,
        previous: { model: second.model, thinkingLevel: "low" },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(continuation.model)).toBe("same/gpt");
    expect(continuation.thinkingLevel).toBe("low");

    const third = route(
      {
        model: virtual,
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: continuation.state,
        failed: {
          model: continuation.model,
          thinkingLevel: "low",
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(third.model)).toBe("other/model");
    expect(third.thinkingLevel).toBe("high");
  });

  test("uses Pi default thinking from the registered virtual model route", () => {
    const sessionManager = {};
    const models = [model("openai", "primary"), model("anthropic", "fallback")];
    const autoPrimaries = new WeakMap<object, string>();
    autoPrimaries.set(sessionManager, "openai/primary");
    let definition:
      | { route: (request: unknown, ctx: ExtensionContext) => { model: TestModel; thinkingLevel: string } }
      | undefined;
    const pi = {
      getSettings() {
        return { defaultThinkingLevel: "high" };
      },
      registerVirtualModel(value: unknown) {
        definition = value as NonNullable<typeof definition>;
      },
    } as unknown as ExtensionAPI;
    registerRetryVirtualModel(
      pi,
      () => ({ enabled: true, autoRoute: true, fallbackModels: [{ model: "anthropic/fallback" }] }),
      autoPrimaries,
    );
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return models.find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return models;
        },
      },
    } as unknown as ExtensionContext;
    const result = definition?.route(
      {
        model: model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual"),
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: { primary: "openai/primary", active: "openai/primary", tried: ["openai/primary"] },
        failed: {
          model: models[0],
          thinkingLevel: "medium",
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      },
      ctx,
    );
    expect(result?.thinkingLevel).toBe("high");
  });

  test("inherits the failed model thinking level when no override or Pi default exists", () => {
    const sessionManager = {};
    const models = [model("openai", "primary"), model("anthropic", "fallback")];
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return models.find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return models;
        },
      },
      getSettings() {
        return {};
      },
    } as unknown as ExtensionContext;
    const route = createRetryRoute(
      () => ({ enabled: true, autoRoute: true, fallbackModels: [{ model: "anthropic/fallback" }] }),
      new WeakMap(),
    );
    const result = route(
      {
        model: model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual"),
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: { primary: "openai/primary", active: "openai/primary", tried: ["openai/primary"] },
        failed: {
          model: models[0],
          thinkingLevel: "xhigh",
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(result.model)).toBe("anthropic/fallback");
    expect(result.thinkingLevel).toBe("xhigh");
  });

  test("skips unavailable candidates without consuming a fallback slot", () => {
    const sessionManager = {};
    const models = [model("openai", "primary"), model("anthropic", "usable")];
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return models.find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return models;
        },
      },
      getSettings() {
        return {};
      },
    } as unknown as ExtensionContext;
    const route = createRetryRoute(
      () => ({
        enabled: true,
        autoRoute: true,
        fallbackModels: [{ model: "same/primary" }, { model: "anthropic/usable" }],
      }),
      new WeakMap(),
    );
    const result = route(
      {
        model: model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual"),
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: { primary: "openai/primary", active: "openai/primary", tried: ["openai/primary"] },
        failed: {
          model: models[0],
          thinkingLevel: "medium",
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(result.model)).toBe("anthropic/usable");
  });

  test("does not switch when Pi retry is disabled", () => {
    const sessionManager = {};
    const primary = model("openai", "primary");
    const fallback = model("anthropic", "fallback");
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return [primary, fallback].find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return [primary, fallback];
        },
      },
      getSettings() {
        return {};
      },
    } as unknown as ExtensionContext;
    const notices: string[] = [];
    const route = createRetryRoute(
      () => ({ enabled: false, autoRoute: true, fallbackModels: [{ model: "anthropic/fallback" }] }),
      new WeakMap(),
      (_ctx, from, to) => notices.push(`${from}->${to}`),
    );
    const result = route(
      {
        model: model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual"),
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: { primary: "openai/primary", active: "openai/primary", tried: ["openai/primary"] },
        failed: {
          model: primary,
          message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(result.model)).toBe("openai/primary");
    expect(notices).toEqual([]);
  });

  test("does not switch for a permanent failure", () => {
    const sessionManager = {};
    const primary = model("openai", "primary");
    const fallback = model("anthropic", "fallback");
    const ctx = {
      sessionManager,
      modelRegistry: {
        find(provider: string, id: string) {
          return [primary, fallback].find((candidate) => candidate.provider === provider && candidate.id === id);
        },
        getAvailable() {
          return [primary, fallback];
        },
      },
      getSettings() {
        return {};
      },
    } as unknown as ExtensionContext;
    const route = createRetryRoute(
      () => ({ enabled: true, autoRoute: false, fallbackModels: [{ model: "anthropic/fallback" }] }),
      new WeakMap(),
    );
    const result = route(
      {
        model: model(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL, "pi-virtual"),
        reason: "retry",
        thinkingLevel: "medium",
        messages: [],
        state: { primary: "openai/primary", active: "openai/primary", tried: ["openai/primary"] },
        failed: {
          model: primary,
          message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" },
        },
      } as never,
      ctx,
    );
    expect(modelReferenceForTest(result.model)).toBe("openai/primary");
  });
});

describe("extension lifecycle", () => {
  function setup(options: { signal?: AbortSignal } = {}) {
    type Handler = (...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler[]>();
    const pi = {
      registerFlag(_name: string, _config: unknown) {},
      registerVirtualModel(_definition: unknown) {},
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    retry(pi, {
      readSettings: () => ({
        kind: "missing",
        path: "",
        settings: { enabled: true, autoRoute: false, fallbackModels: [] },
        errors: [],
      }),
      readRetryPolicy: () => ({ enabled: true, errors: [] }),
    });
    const ctx = {
      hasUI: true,
      mode: "tui",
      signal: options.signal,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
      abort: vi.fn(),
      sessionManager: {},
    } as unknown as ExtensionContext;
    return { handlers, ctx };
  }

  test("normalizes provider errors into Pi retryable errors", () => {
    const { handlers, ctx } = setup();
    const handler = handlers.get("message_end")?.[0];
    expect(handler).toBeDefined();
    const result = handler?.(
      { message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 Service Unavailable" } },
      ctx,
    ) as { message: { stopReason: string; errorMessage: string } } | undefined;
    expect(result?.message.stopReason).toBe("error");
    expect(result?.message.errorMessage).toContain(RETRYABLE_ERROR_TAG);
  });

  test("leaves permanent provider errors untouched so the original error is preserved", () => {
    const { handlers, ctx } = setup();
    const result = handlers.get("message_end")?.[0]?.(
      { message: { role: "assistant", stopReason: "error", errorMessage: "context length exceeded" } },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  test("does not rewrite user cancellation or call ctx.abort", () => {
    const controller = new AbortController();
    controller.abort();
    const { handlers, ctx } = setup({ signal: controller.signal });
    const handler = handlers.get("message_end")?.[0];
    expect(
      handler?.({ message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" } }, ctx),
    ).toBeUndefined();
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  test("rewrites a provider-originated abort without using an extension watchdog", () => {
    const { handlers, ctx } = setup();
    const beforeRequest = handlers.get("before_provider_request")?.[0];
    beforeRequest?.({}, ctx);
    const result = handlers.get("message_end")?.[0]?.(
      { message: { role: "assistant", stopReason: "aborted", errorMessage: "upstream timeout" } },
      ctx,
    ) as { message: { stopReason: string; errorMessage: string } } | undefined;
    expect(result?.message.stopReason).toBe("error");
    expect(ctx.abort).not.toHaveBeenCalled();
  });
});

function modelReferenceForTest(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}
