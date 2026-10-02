import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export const RETRY_SETTINGS_FILE = "pi-retry.json";
export const RETRY_VIRTUAL_PROVIDER = "pi-retry";
export const RETRY_VIRTUAL_MODEL = "auto";
export const MAX_MODEL_REFS = 16;
export const MAX_MODEL_REF_LENGTH = 512;

export type RetrySettings = {
  enabled: boolean;
  autoRoute: boolean;
  primaryModel?: string;
  fallbackModels: string[];
};

export type RetrySettingsState = {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: RetrySettings;
  errors: string[];
};

export type RetrySettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export const DEFAULT_RETRY_SETTINGS: Readonly<RetrySettings> = Object.freeze({
  enabled: true,
  autoRoute: false,
  fallbackModels: [],
});

type SettingsDocument = Record<string, unknown>;
type PartialRetrySettings = Partial<RetrySettings>;

export function retrySettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, RETRY_SETTINGS_FILE);
}

export function projectRetrySettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, RETRY_SETTINGS_FILE);
}

export function parseModelRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_MODEL_REF_LENGTH ||
    normalized !== value ||
    hasWhitespaceOrControl(normalized)
  ) {
    return undefined;
  }
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) {
    return undefined;
  }
  return normalized;
}

export function normalizeRetrySettings(value: unknown): RetrySettings | undefined {
  const partial = parsePartialRetrySettings(value);
  if (!partial) return undefined;
  return {
    enabled: partial.enabled ?? DEFAULT_RETRY_SETTINGS.enabled,
    autoRoute: partial.autoRoute ?? DEFAULT_RETRY_SETTINGS.autoRoute,
    ...(partial.primaryModel ? { primaryModel: partial.primaryModel } : {}),
    fallbackModels: partial.fallbackModels ?? [...DEFAULT_RETRY_SETTINGS.fallbackModels],
  };
}

export function loadRetrySettings(ctx: RetrySettingsContext, agentDir = getAgentDir()): RetrySettingsState {
  const userPath = retrySettingsPath(agentDir);
  const paths = [{ scope: "global", path: userPath }];
  if (ctx.isProjectTrusted()) {
    paths.push({ scope: "project", path: projectRetrySettingsPath(ctx.cwd) });
  }

  let merged: SettingsDocument = {};
  let found = false;
  const errors: string[] = [];

  for (const source of paths) {
    const result = readSettingsDocument(source.path);
    if (result.kind === "missing") continue;
    found = true;
    if (result.kind === "error") {
      errors.push(`${source.scope} settings: ${result.message}`);
      continue;
    }
    const partial = parsePartialRetrySettings(result.document);
    if (!partial) {
      errors.push(`${source.scope} settings: invalid settings shape`);
      continue;
    }
    merged = { ...merged, ...partial };
  }

  const normalized = normalizeRetrySettings(merged);
  if (!normalized) {
    errors.push("merged settings: invalid settings shape");
  }

  return {
    kind: errors.length > 0 ? (found ? "invalid" : "missing") : found ? "loaded" : "missing",
    path: userPath,
    settings: normalized ?? { ...DEFAULT_RETRY_SETTINGS, fallbackModels: [] },
    errors,
  };
}

function parsePartialRetrySettings(value: unknown): PartialRetrySettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: PartialRetrySettings = {};

  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") return undefined;
    result.enabled = value.enabled;
  }
  if (Object.hasOwn(value, "autoRoute")) {
    if (typeof value.autoRoute !== "boolean") return undefined;
    result.autoRoute = value.autoRoute;
  }
  if (Object.hasOwn(value, "primaryModel")) {
    const primaryModel = parseModelRef(value.primaryModel);
    if (!primaryModel) return undefined;
    result.primaryModel = primaryModel;
  }
  if (Object.hasOwn(value, "fallbackModels")) {
    if (!Array.isArray(value.fallbackModels) || value.fallbackModels.length > MAX_MODEL_REFS) return undefined;
    const fallbackModels: string[] = [];
    for (const entry of value.fallbackModels) {
      const model = parseModelRef(entry);
      if (!model) return undefined;
      if (!fallbackModels.includes(model)) fallbackModels.push(model);
    }
    result.fallbackModels = fallbackModels;
  }

  return result;
}

function readSettingsDocument(
  path: string,
): { kind: "missing" } | { kind: "error"; message: string } | { kind: "loaded"; document: SettingsDocument } {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: safeError(error) };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { kind: "error", message: "settings path is not a regular file" };
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "error", message: safeError(error) };
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed)
      ? { kind: "loaded", document: parsed }
      : { kind: "error", message: "settings document must be a JSON object" };
  } catch {
    return { kind: "error", message: "invalid JSON" };
  }
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });
}

function isRecord(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
