import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type AssistantFailure, classifyAssistantFailure } from "./classifier.js";
import {
  RETRY_VIRTUAL_MODEL,
  RETRY_VIRTUAL_PROVIDER,
  type RetryFallbackModel,
  type RetrySettings,
  type RetryThinkingLevel,
} from "./settings.js";

export type RetryRouteState = {
  primary: string;
  active: string;
  activeThinkingLevel?: RetryThinkingLevel;
  tried: string[];
};

type RetryRouteContext = Pick<ExtensionContext, "sessionManager" | "modelRegistry">;
type PhysicalModel = NonNullable<ExtensionContext["model"]>;
type RetryRouteRequest = ModelRouteRequest<RetryRouteState>;
type FallbackNotice = (ctx: ExtensionContext, from: string, to: string, reason: string) => void;
type DefaultThinkingLevelReader = () => RetryThinkingLevel | undefined;

export function modelReference(model: PhysicalModel): string {
  return `${model.provider}/${model.id}`;
}

export function createRetryRoute(
  getSettings: () => RetrySettings,
  autoPrimaries: WeakMap<object, string>,
  onFallback?: FallbackNotice,
  getDefaultThinkingLevel: DefaultThinkingLevelReader = () => undefined,
): (request: RetryRouteRequest, ctx: ExtensionContext) => ModelRoute<RetryRouteState> {
  return (request, ctx) => {
    const settings = getSettings();
    const primary =
      request.state?.primary ??
      autoPrimaries.get(ctx.sessionManager) ??
      settings.primaryModel ??
      (request.previous ? modelReference(request.previous.model) : undefined) ??
      (request.failed ? modelReference(request.failed.model) : undefined);
    if (!primary) {
      throw new Error(
        `pi-retry/${RETRY_VIRTUAL_MODEL} needs a primaryModel in pi-retry.json or a physical model selected before routing.`,
      );
    }

    const state = request.state;
    const failed = request.failed;
    if (request.reason === "retry" && failed) {
      const failedRef = modelReference(failed.model);
      const failedThinkingLevel = failed.thinkingLevel ?? state?.activeThinkingLevel ?? request.thinkingLevel;
      const currentState: RetryRouteState = state ?? {
        primary,
        active: failedRef,
        activeThinkingLevel: failedThinkingLevel,
        tried: [failedRef],
      };
      const failure = classifyAssistantFailure(failed.message as AssistantFailure);
      const activeRef = currentState.active || failedRef;
      const currentModel = resolvePhysicalModel(ctx, activeRef) ?? resolvePhysicalModel(ctx, failedRef);

      if (failure.kind === "transient" && settings.enabled) {
        const next = orderFallbackModels(settings.fallbackModels, failed.model.id).find(
          (candidate) =>
            !currentState.tried.includes(candidate.model) && resolvePhysicalModel(ctx, candidate.model) !== undefined,
        );
        if (next) {
          const nextModel = resolvePhysicalModel(ctx, next.model);
          if (nextModel) {
            const nextThinkingLevel = resolveFallbackThinkingLevel(getDefaultThinkingLevel, next, failedThinkingLevel);
            onFallback?.(ctx, failedRef, next.model, failure.reason);
            return {
              model: nextModel,
              thinkingLevel: nextThinkingLevel,
              state: {
                primary: currentState.primary,
                active: next.model,
                activeThinkingLevel: nextThinkingLevel,
                tried: [...currentState.tried, next.model],
              },
            };
          }
        }
      }

      if (currentModel) {
        return {
          model: currentModel,
          thinkingLevel: currentState.activeThinkingLevel ?? failedThinkingLevel,
          state: {
            primary: currentState.primary,
            active: modelReference(currentModel),
            activeThinkingLevel: currentState.activeThinkingLevel ?? failedThinkingLevel,
            tried: currentState.tried,
          },
        };
      }
    }

    const activeRef =
      request.reason === "user"
        ? primary
        : (state?.active ?? (request.previous ? modelReference(request.previous.model) : primary));
    const model = resolvePhysicalModel(ctx, activeRef);
    if (!model) {
      throw new Error(`pi-retry could not find an authenticated physical model for ${activeRef}.`);
    }
    const thinkingLevel =
      request.reason === "user"
        ? request.thinkingLevel
        : (state?.activeThinkingLevel ?? request.previous?.thinkingLevel ?? request.thinkingLevel);

    return {
      model,
      thinkingLevel,
      state: {
        primary,
        active: modelReference(model),
        activeThinkingLevel: thinkingLevel,
        tried: request.reason === "user" ? [modelReference(model)] : (state?.tried ?? [modelReference(model)]),
      },
    };
  };
}

export function registerRetryVirtualModel(
  pi: ExtensionAPI,
  getSettings: () => RetrySettings,
  autoPrimaries: WeakMap<object, string>,
  onFallback?: FallbackNotice,
): void {
  const route = createRetryRoute(getSettings, autoPrimaries, onFallback, () => pi.getSettings().defaultThinkingLevel);
  pi.registerVirtualModel<RetryRouteState>({
    provider: RETRY_VIRTUAL_PROVIDER,
    id: RETRY_VIRTUAL_MODEL,
    name: "Retry fallback",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    route,
  });
}

function resolvePhysicalModel(ctx: RetryRouteContext, reference: string): PhysicalModel | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0) return undefined;
  const model = ctx.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1));
  if (!model || model.api === "pi-virtual") return undefined;
  return ctx.modelRegistry.getAvailable().some((candidate) => modelReference(candidate) === reference)
    ? model
    : undefined;
}

function orderFallbackModels(
  fallbackModels: readonly RetryFallbackModel[],
  failedModelId: string,
): RetryFallbackModel[] {
  const sameName: RetryFallbackModel[] = [];
  const otherName: RetryFallbackModel[] = [];
  for (const candidate of fallbackModels) {
    if (modelIdFromReference(candidate.model) === failedModelId) sameName.push(candidate);
    else otherName.push(candidate);
  }
  return [...sameName, ...otherName];
}

function resolveFallbackThinkingLevel(
  getDefaultThinkingLevel: DefaultThinkingLevelReader,
  candidate: RetryFallbackModel,
  failedThinkingLevel: RetryThinkingLevel,
): RetryThinkingLevel {
  return candidate.thinkingLevel ?? getDefaultThinkingLevel() ?? failedThinkingLevel;
}

function modelIdFromReference(reference: string): string | undefined {
  const separator = reference.indexOf("/");
  return separator <= 0 || separator === reference.length - 1 ? undefined : reference.slice(separator + 1);
}
