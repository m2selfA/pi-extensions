import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantFailure,
  classifyAssistantFailure,
  decorateRetryableError,
  decorateUsageLimitError,
  retryableErrorMarkerPresent,
} from "./classifier.js";
import {
  hasAvailableFallback,
  modelReference,
  type RetryLimitRecovery,
  type RetryRouteState,
  registerRetryVirtualModel,
} from "./router.js";
import {
  loadRetrySettings,
  RETRY_VIRTUAL_MODEL,
  RETRY_VIRTUAL_PROVIDER,
  type RetrySettings,
  type RetrySettingsContext,
  type RetrySettingsState,
} from "./settings.js";

export type RetryPolicy = {
  enabled: boolean | undefined;
  errors: string[];
};

export type RetryOptions = {
  readRetryPolicy?: (ctx: RetrySettingsContext) => RetryPolicy;
  readSettings?: (ctx: RetrySettingsContext) => RetrySettingsState;
};

type MessageShape = AssistantFailure & {
  [key: string]: unknown;
  model?: unknown;
  provider?: unknown;
};

const STATUS_KEY = "retry";
const RETRY_STATUS = "retrying";
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const LIMIT_RECOVERY_MESSAGE_TYPE = "pi-retry-usage-limit-recovery";
const LIMIT_RECOVERY_MESSAGE =
  "The previous provider request reached its usage limit. Continue the pending response using the fallback model.";

export function readPiRetryPolicy(ctx: RetrySettingsContext, agentDir = getAgentDir()): RetryPolicy {
  try {
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const errors = settingsManager.drainErrors().map(({ scope, error }) => `${scope} settings: ${error.message}`);
    return { enabled: settingsManager.getRetrySettings().enabled, errors };
  } catch (error) {
    return { enabled: undefined, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export default function retry(pi: ExtensionAPI, options: RetryOptions = {}): void {
  const autoPrimaries = new WeakMap<object, string>();
  const pendingLimitRecoveries = new WeakMap<object, RetryLimitRecovery>();
  const routeStates = new WeakMap<object, RetryRouteState>();
  let settingsState: RetrySettingsState = {
    kind: "missing",
    path: "",
    settings: { enabled: true, autoRoute: false, fallbackModels: [] },
    errors: [],
  };
  let piRetryEnabled = true;
  let warnedPolicyDisabled = false;
  let warnedPolicyReadFailure = false;
  const warnedSettingsErrors = new Set<string>();

  const readSettings = options.readSettings ?? ((ctx: RetrySettingsContext) => loadRetrySettings(ctx));
  const readPolicy = options.readRetryPolicy ?? ((ctx: RetrySettingsContext) => readPiRetryPolicy(ctx));
  const effectiveSettings = (): RetrySettings => ({
    ...settingsState.settings,
    enabled: settingsState.settings.enabled && piRetryEnabled,
  });

  const notifySettings = (ctx: ExtensionContext): void => {
    for (const error of settingsState.errors) {
      if (warnedSettingsErrors.has(error)) continue;
      warnedSettingsErrors.add(error);
      if (ctx.hasUI) ctx.ui.notify(`pi-retry ignored invalid settings: ${error}`, "warning");
    }
  };

  const refresh = (ctx: ExtensionContext): void => {
    settingsState = readSettings(ctx);
    notifySettings(ctx);

    const policy = readPolicy(ctx);
    if (policy.errors.length > 0 && ctx.hasUI && !warnedPolicyReadFailure) {
      warnedPolicyReadFailure = true;
      ctx.ui.notify(
        `pi-retry could not read Pi retry settings; preserving the current policy. ${policy.errors.join("; ")}`,
        "warning",
      );
    }
    if (policy.errors.length === 0 && policy.enabled !== undefined) {
      piRetryEnabled = policy.enabled;
    }
    if (!piRetryEnabled && ctx.hasUI && !warnedPolicyDisabled) {
      warnedPolicyDisabled = true;
      ctx.ui.notify(
        'pi-retry requires Pi setting "retry.enabled": true; provider classification and fallback are inactive while it is disabled.',
        "warning",
      );
    }
  };

  pi.registerFlag(STALL_TIMEOUT_FLAG, {
    description: "Deprecated compatibility flag; ignored because Pi owns provider timeout and cancellation.",
    type: "string",
  });

  registerRetryVirtualModel(
    pi,
    effectiveSettings,
    autoPrimaries,
    (ctx, from, to, reason) => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(STATUS_KEY, RETRY_STATUS);
      ctx.ui.notify(`pi-retry switched from ${from} to fallback ${to}: ${reason}.`, "warning");
    },
    pendingLimitRecoveries,
    routeStates,
  );

  pi.on("session_start", async (_event, ctx) => {
    pendingLimitRecoveries.delete(ctx.sessionManager);
    routeStates.delete(ctx.sessionManager);
    refresh(ctx);
    if (
      !effectiveSettings().enabled ||
      !ctx.model ||
      ctx.model.api === "pi-virtual" ||
      ctx.model.provider === RETRY_VIRTUAL_PROVIDER ||
      !settingsState.settings.autoRoute
    )
      return;
    if (settingsState.settings.fallbackModels.length === 0) return;

    autoPrimaries.set(ctx.sessionManager, modelReference(ctx.model));
    const virtual = ctx.modelRegistry.find(RETRY_VIRTUAL_PROVIDER, RETRY_VIRTUAL_MODEL);
    if (!virtual) {
      if (ctx.hasUI) ctx.ui.notify("pi-retry could not register its virtual fallback model.", "warning");
      return;
    }
    try {
      const switched = await pi.setModel(virtual);
      if (!switched && ctx.hasUI) {
        ctx.ui.notify(`pi-retry could not activate ${RETRY_VIRTUAL_PROVIDER}/${RETRY_VIRTUAL_MODEL}.`, "warning");
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-retry could not activate ${RETRY_VIRTUAL_PROVIDER}/${RETRY_VIRTUAL_MODEL}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as unknown as MessageShape;
    if (message.role !== "assistant" || !effectiveSettings().enabled) return;

    const classification = classifyAssistantFailure(message, ctx.signal?.aborted ?? false);
    const originalErrorMessage =
      typeof message.errorMessage === "string" && message.errorMessage.length > 0
        ? message.errorMessage
        : "The provider returned a transient failure without details.";

    if (classification.kind === "usage-limit") {
      const failedModel = messageModelReference(message);
      const routeState = routeStates.get(ctx.sessionManager);
      const canSwitchImmediately =
        isRetryVirtualModel(ctx) &&
        failedModel !== undefined &&
        hasAvailableFallback(ctx, effectiveSettings(), failedModel, routeState?.tried ?? [failedModel]);

      if (canSwitchImmediately && failedModel) {
        pendingLimitRecoveries.set(ctx.sessionManager, {
          failedModel,
          reason: classification.reason,
          resetAt: classification.resetAt,
        });
        pi.sendMessage(
          {
            customType: LIMIT_RECOVERY_MESSAGE_TYPE,
            content: LIMIT_RECOVERY_MESSAGE,
            display: false,
            details: { resetAt: classification.resetAt },
          },
          { deliverAs: "followUp" },
        );
      }

      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, RETRY_STATUS);
        ctx.ui.notify(
          `pi-retry detected a provider usage limit${
            classification.resetAt ? `; reset at ${classification.resetAt}` : ""
          }; ${canSwitchImmediately ? "switching immediately" : "no authenticated fallback is available"}.`,
          "warning",
        );
      }

      return {
        message: {
          ...message,
          // Pi's low-level loop only consumes follow-ups before agent_end for non-error stops.
          stopReason: canSwitchImmediately ? "stop" : "error",
          errorMessage: decorateUsageLimitError(originalErrorMessage, classification.reason),
        } as typeof event.message,
      };
    }

    if (classification.kind !== "transient") return;
    if (retryableErrorMarkerPresent(originalErrorMessage) && message.stopReason === "error") return;

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, RETRY_STATUS);
    }

    return {
      message: {
        ...message,
        stopReason: "error",
        errorMessage: decorateRetryableError(originalErrorMessage, classification.reason),
      } as typeof event.message,
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    autoPrimaries.delete(ctx.sessionManager);
    pendingLimitRecoveries.delete(ctx.sessionManager);
    routeStates.delete(ctx.sessionManager);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

function isRetryVirtualModel(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === RETRY_VIRTUAL_PROVIDER && ctx.model.id === RETRY_VIRTUAL_MODEL;
}

function messageModelReference(message: MessageShape): string | undefined {
  return typeof message.provider === "string" && typeof message.model === "string"
    ? `${message.provider}/${message.model}`
    : undefined;
}
