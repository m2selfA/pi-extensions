export const RETRYABLE_ERROR_TAG = "[pi-retry]";
export const RETRYABLE_ERROR_HINT = "provider returned error";
export const USAGE_LIMIT_ERROR_TAG = "[pi-retry-usage-limit]";

export type AssistantFailure = {
  role?: string;
  stopReason?: string;
  errorMessage?: unknown;
};

export type FailureClassification =
  | { kind: "transient"; reason: string }
  | { kind: "usage-limit"; reason: string; resetAt?: string }
  | { kind: "permanent"; reason: string }
  | { kind: "user-abort"; reason: string }
  | { kind: "none" };

const UNKNOWN_NO_DETAILS_RE = /unknown error\s*\(no error details in response\)/iu;
const CODEX_RETRY_RE =
  /codex error:[\s\S]*(?:you can retry your request|websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection)/iu;
const RATE_LIMIT_ERROR_RE = /\brate[_\s-]*limit[_\s-]*error\b/iu;
const USAGE_LIMIT_CODE_RE =
  /(?:\b(?:go.?usage.?limit.?error|free.?usage.?limit.?error|monthly usage limit reached|usage[_\s-]*(?:limit|cap)[_\s-]*(?:reached|exceeded|error)|subscription_sharing_usage_limit_exceeded)\b)/iu;
const USAGE_LIMIT_MARKER_RE =
  /(?:\b(?:usage\s+(?:limit|cap|ceiling|allowance)|usage[_-](?:limit|cap))\b|使用上限|使用限额|用量上限|额度上限|已达到[\s\S]{0,24}(?:上限|限额|额度))/iu;
const RESET_TIMESTAMP_RE =
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/u;
const TRANSIENT_TEXT_RE =
  /(?:\b(?:currently experiencing high demand|overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|timeout|timed? out|deadline exceeded|temporarily unavailable|upstream|bad gateway|gateway timeout|try again|retry-after|connection.?error|connection reset|connection refused|connection lost|connection closed|other side closed|network error|fetch failed|getaddrinfo|enotfound|eai_again|upstream.?connect|reset before headers|socket hang up|socket connection was closed|econnreset|econnrefused|enetwork|websocket.?closed|websocket.?error|websocket|terminated|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|resourceexhausted|subscription_sharing_(?:usage|user)_unavailable)\b|\b(?:429|500|502|503|504|520|524|529)\b)/iu;
const PERMANENT_TEXT_RE =
  /(?:\b(?:gousagelimiterror|freeusageLimitError|monthly usage limit reached|available balance|insufficient[_ ]quota|out of budget|subscription_sharing_usage_limit_exceeded|unauthorized|forbidden|invalid api key|authentication failed|invalid request|bad request|unsupported model|model not found|context length|context window|prompt too long|maximum allowed input|insufficient (?:quota|credits?)|billing|payment required|credit balance|quota exceeded|content policy)\b)/iu;
const USER_ABORT_RE =
  /^(?:request was )?aborted(?: by (?:the )?user)?$|\b(?:aborted|cancelled|canceled) by (?:the )?user\b|^retry cancelled$/iu;

export function classifyAssistantFailure(message: AssistantFailure, signalAborted = false): FailureClassification {
  if (message.role !== undefined && message.role !== "assistant") return { kind: "none" };
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";

  if (message.stopReason === "aborted") {
    if (signalAborted || USER_ABORT_RE.test(errorMessage.trim())) {
      return { kind: "user-abort", reason: "the request was cancelled by the user or host" };
    }
    const usageLimit = getUsageLimitDetails(errorMessage);
    if (usageLimit) return usageLimitClassification(usageLimit.resetAt);
    if (isTransientProviderMessage(errorMessage)) {
      return { kind: "transient", reason: "the provider aborted a transient request" };
    }
    return { kind: "none" };
  }

  if (message.stopReason !== "error") return { kind: "none" };
  if (!errorMessage) return { kind: "none" };
  const usageLimit = getUsageLimitDetails(errorMessage);
  if (usageLimit) return usageLimitClassification(usageLimit.resetAt);
  if (isPermanentProviderMessage(errorMessage)) {
    return { kind: "permanent", reason: "the provider reported a non-retryable request or account failure" };
  }
  if (isTransientProviderMessage(errorMessage)) {
    return { kind: "transient", reason: "the provider reported a transient transport or service failure" };
  }
  return { kind: "none" };
}

export function isUsageLimitProviderMessage(errorMessage: string): boolean {
  return getUsageLimitDetails(errorMessage) !== undefined;
}

export function extractUsageLimitResetAt(errorMessage: string): string | undefined {
  return RESET_TIMESTAMP_RE.exec(errorMessage)?.[0];
}

export function isTransientProviderMessage(errorMessage: string): boolean {
  if (!errorMessage || isUsageLimitProviderMessage(errorMessage) || isPermanentProviderMessage(errorMessage))
    return false;
  return (
    UNKNOWN_NO_DETAILS_RE.test(errorMessage) ||
    CODEX_RETRY_RE.test(errorMessage) ||
    TRANSIENT_TEXT_RE.test(errorMessage)
  );
}

export function isPermanentProviderMessage(errorMessage: string): boolean {
  return isUsageLimitProviderMessage(errorMessage) || PERMANENT_TEXT_RE.test(errorMessage);
}

export function decorateRetryableError(errorMessage: string, reason: string): string {
  if (errorMessage.includes(RETRYABLE_ERROR_TAG)) return errorMessage;
  return `${errorMessage}\n\n${RETRYABLE_ERROR_TAG} ${RETRYABLE_ERROR_HINT}; ${reason}.`;
}

export function decorateUsageLimitError(errorMessage: string, reason: string): string {
  if (errorMessage.includes(USAGE_LIMIT_ERROR_TAG)) return errorMessage;
  // Pi's retry classifier treats this phrase as terminal, preventing a no-fallback usage cap from entering backoff.
  return `${errorMessage}\n\n${USAGE_LIMIT_ERROR_TAG} ${reason}; quota exceeded.`;
}

export function retryableErrorMarkerPresent(errorMessage: string): boolean {
  return errorMessage.includes(RETRYABLE_ERROR_TAG) && errorMessage.includes(RETRYABLE_ERROR_HINT);
}

type UsageLimitDetails = { resetAt?: string };

function getUsageLimitDetails(errorMessage: string): UsageLimitDetails | undefined {
  if (!errorMessage) return undefined;
  const resetAt = extractUsageLimitResetAt(errorMessage);
  if (USAGE_LIMIT_CODE_RE.test(errorMessage)) return { resetAt };
  if (RATE_LIMIT_ERROR_RE.test(errorMessage) && (USAGE_LIMIT_MARKER_RE.test(errorMessage) || resetAt)) {
    return { resetAt };
  }
  return undefined;
}

function usageLimitClassification(resetAt: string | undefined): FailureClassification {
  return resetAt
    ? {
        kind: "usage-limit",
        reason: `the provider usage limit was reached and resets at ${resetAt}`,
        resetAt,
      }
    : { kind: "usage-limit", reason: "the provider usage limit was reached" };
}
