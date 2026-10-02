import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { type AssistantFailure, classifyAssistantFailure } from "./classifier.js";
import { RETRY_VIRTUAL_MODEL, RETRY_VIRTUAL_PROVIDER, type RetrySettings } from "./settings.js";

export type RetryRouteState = {
  primary: string;
  active: string;
  tried: string[];
};

type RetryRouteContext = Pick<ExtensionContext, "sessionManager" | "modelRegistry">;
type PhysicalModel = NonNullable<ExtensionContext["model"]>;
type RetryRouteRequest = ModelRouteRequest<RetryRouteState>;
type FallbackNotice = (ctx: ExtensionContext, from: string, to: string, reason: string) => void;

export function modelReference(model: PhysicalModel): string {
  return `${model.provider}/${model.id}`;
}

export function createRetryRoute(
  getSettings: () => RetrySettings,
  autoPrimaries: WeakMap<object, string>,
  onFallback?: FallbackNotice,
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

    const candidates = unique([primary, ...settings.fallbackModels]);
    const state = request.state;
    const failed = request.failed;
    if (request.reason === "retry" && failed) {
      const failedRef = modelReference(failed.model);
      const currentState: RetryRouteState = state ?? {
        primary,
        active: failedRef,
        tried: [failedRef],
      };
      const failure = classifyAssistantFailure(failed.message as AssistantFailure);
      const activeRef = currentState.active || failedRef;
      const currentModel = resolvePhysicalModel(ctx, activeRef) ?? resolvePhysicalModel(ctx, failedRef);

      if (failure.kind === "transient" && settings.enabled) {
        const failedIndex = Math.max(candidates.indexOf(failedRef), candidates.indexOf(activeRef));
        const next = candidates
          .slice(failedIndex >= 0 ? failedIndex + 1 : 0)
          .find((candidate) => !currentState.tried.includes(candidate) && resolvePhysicalModel(ctx, candidate));
        if (next) {
          const nextModel = resolvePhysicalModel(ctx, next);
          if (nextModel) {
            onFallback?.(ctx, failedRef, next, failure.reason);
            return {
              model: nextModel,
              thinkingLevel: request.thinkingLevel,
              state: {
                primary: currentState.primary,
                active: next,
                tried: [...currentState.tried, next],
              },
            };
          }
        }
      }

      if (currentModel) {
        return {
          model: currentModel,
          thinkingLevel: request.thinkingLevel,
          state: {
            primary: currentState.primary,
            active: modelReference(currentModel),
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

    return {
      model,
      thinkingLevel: request.thinkingLevel,
      state: {
        primary,
        active: modelReference(model),
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
  const route = createRetryRoute(getSettings, autoPrimaries, onFallback);
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

function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
