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

export type RetryLimitRecovery = {
  failedModel: string;
  reason: string;
  resetAt?: string;
};

type PhysicalModel = NonNullable<ExtensionContext["model"]>;
type RetryRouteRequest = ModelRouteRequest<RetryRouteState>;
type FallbackNotice = (ctx: ExtensionContext, from: string, to: string, reason: string) => void;
type DefaultThinkingLevelReader = () => RetryThinkingLevel | undefined;
type RetryLimitRecoveryMap = WeakMap<object, RetryLimitRecovery>;
type RetryRouteStateMap = WeakMap<object, RetryRouteState>;

export function modelReference(model: PhysicalModel): string {
  return `${model.provider}/${model.id}`;
}

export function createRetryRoute(
  getSettings: () => RetrySettings,
  autoPrimaries: WeakMap<object, string>,
  onFallback?: FallbackNotice,
  getDefaultThinkingLevel: DefaultThinkingLevelReader = () => undefined,
  pendingLimitRecoveries: RetryLimitRecoveryMap = new WeakMap(),
  routeStates: RetryRouteStateMap = new WeakMap(),
): (request: RetryRouteRequest, ctx: ExtensionContext) => ModelRoute<RetryRouteState> {
  return (request, ctx) => {
    const settings = getSettings();
    const state = request.state ?? routeStates.get(ctx.sessionManager);
    const pendingLimitRecovery = pendingLimitRecoveries.get(ctx.sessionManager);
    const primary =
      state?.primary ??
      autoPrimaries.get(ctx.sessionManager) ??
      settings.primaryModel ??
      (request.previous ? modelReference(request.previous.model) : undefined) ??
      (request.failed ? modelReference(request.failed.model) : undefined) ??
      pendingLimitRecovery?.failedModel;
    if (!primary) {
      throw new Error(
        `pi-retry/${RETRY_VIRTUAL_MODEL} needs a primaryModel in pi-retry.json or a physical model selected before routing.`,
      );
    }

    const remember = (result: ModelRoute<RetryRouteState>): ModelRoute<RetryRouteState> => {
      if (result.state) routeStates.set(ctx.sessionManager, result.state);
      return result;
    };

    if (pendingLimitRecovery) {
      pendingLimitRecoveries.delete(ctx.sessionManager);
      if (!settings.enabled) {
        throw new Error(
          `pi-retry could not switch after a provider usage limit on ${pendingLimitRecovery.failedModel}.`,
        );
      }

      const currentState: RetryRouteState = state ?? {
        primary,
        active: pendingLimitRecovery.failedModel,
        activeThinkingLevel: request.thinkingLevel,
        tried: [pendingLimitRecovery.failedModel],
      };
      const failedThinkingLevel = currentState.activeThinkingLevel ?? request.thinkingLevel;
      const next = findNextFallback(ctx, settings.fallbackModels, pendingLimitRecovery.failedModel, currentState.tried);
      if (!next) {
        throw new Error(
          `pi-retry could not switch after a provider usage limit on ${pendingLimitRecovery.failedModel}; no authenticated fallback remains.`,
        );
      }

      const nextModel = resolvePhysicalModel(ctx, next.model);
      if (!nextModel) {
        throw new Error(`pi-retry could not find an authenticated physical model for ${next.model}.`);
      }
      const nextThinkingLevel = resolveFallbackThinkingLevel(getDefaultThinkingLevel, next, failedThinkingLevel);
      onFallback?.(ctx, pendingLimitRecovery.failedModel, next.model, pendingLimitRecovery.reason);
      return remember({
        model: nextModel,
        thinkingLevel: nextThinkingLevel,
        state: {
          primary: currentState.primary,
          active: next.model,
          activeThinkingLevel: nextThinkingLevel,
          tried: [...currentState.tried, next.model],
        },
      });
    }

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

      if ((failure.kind === "transient" || failure.kind === "usage-limit") && settings.enabled) {
        const next = findNextFallback(ctx, settings.fallbackModels, failedRef, currentState.tried);
        if (next) {
          const nextModel = resolvePhysicalModel(ctx, next.model);
          if (nextModel) {
            const nextThinkingLevel = resolveFallbackThinkingLevel(getDefaultThinkingLevel, next, failedThinkingLevel);
            onFallback?.(ctx, failedRef, next.model, failure.reason);
            return remember({
              model: nextModel,
              thinkingLevel: nextThinkingLevel,
              state: {
                primary: currentState.primary,
                active: next.model,
                activeThinkingLevel: nextThinkingLevel,
                tried: [...currentState.tried, next.model],
              },
            });
          }
        }
      }

      if (currentModel) {
        return remember({
          model: currentModel,
          thinkingLevel: currentState.activeThinkingLevel ?? failedThinkingLevel,
          state: {
            primary: currentState.primary,
            active: modelReference(currentModel),
            activeThinkingLevel: currentState.activeThinkingLevel ?? failedThinkingLevel,
            tried: currentState.tried,
          },
        });
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

    return remember({
      model,
      thinkingLevel,
      state: {
        primary,
        active: modelReference(model),
        activeThinkingLevel: thinkingLevel,
        tried: request.reason === "user" ? [modelReference(model)] : (state?.tried ?? [modelReference(model)]),
      },
    });
  };
}

export function registerRetryVirtualModel(
  pi: ExtensionAPI,
  getSettings: () => RetrySettings,
  autoPrimaries: WeakMap<object, string>,
  onFallback?: FallbackNotice,
  pendingLimitRecoveries: RetryLimitRecoveryMap = new WeakMap(),
  routeStates: RetryRouteStateMap = new WeakMap(),
): void {
  const route = createRetryRoute(
    getSettings,
    autoPrimaries,
    onFallback,
    () => pi.getSettings().defaultThinkingLevel,
    pendingLimitRecoveries,
    routeStates,
  );
  pi.registerVirtualModel<RetryRouteState>({
    provider: RETRY_VIRTUAL_PROVIDER,
    id: RETRY_VIRTUAL_MODEL,
    name: "Retry fallback",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    route,
  });
}

export function hasAvailableFallback(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  settings: RetrySettings,
  failedModel: string,
  tried: readonly string[] = [],
): boolean {
  return findNextFallback(ctx, settings.fallbackModels, failedModel, tried) !== undefined;
}

function resolvePhysicalModel(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  reference: string,
): PhysicalModel | undefined {
  const separator = reference.indexOf("/");
  if (separator <= 0) return undefined;
  const model = ctx.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1));
  if (!model || model.api === "pi-virtual") return undefined;
  // getAvailable() is a startup/auth snapshot and can lag a provider refresh. Pi's own virtual
  // resolver uses configured-auth as the final gate, so accept the same state here when the model
  // is registered but temporarily absent from that snapshot.
  if (ctx.modelRegistry.getAvailable().some((candidate) => modelReference(candidate) === reference)) return model;
  return ctx.modelRegistry.hasConfiguredAuth?.(model) ? model : undefined;
}

function findNextFallback(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  fallbackModels: readonly RetryFallbackModel[],
  failedModel: string,
  tried: readonly string[],
): RetryFallbackModel | undefined {
  const failedModelId = modelIdFromReference(failedModel);
  return orderFallbackModels(fallbackModels, failedModelId).find(
    (candidate) => !tried.includes(candidate.model) && resolvePhysicalModel(ctx, candidate.model) !== undefined,
  );
}

function orderFallbackModels(
  fallbackModels: readonly RetryFallbackModel[],
  failedModelId: string | undefined,
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
