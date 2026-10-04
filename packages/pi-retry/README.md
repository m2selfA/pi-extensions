# 🔁 pi-retry — Resilient Provider Retries and Explicit Fallbacks

[![npm](https://img.shields.io/npm/v/@narumitw/pi-retry)](https://www.npmjs.com/package/@narumitw/pi-retry) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-retry` classifies transient provider failures so Pi can use its native retry loop, routes failed requests through an explicitly configured, ordered fallback model chain, and recognizes explicit provider usage caps that should switch immediately.

The extension does not call `ctx.abort()` for provider stalls. Pi's provider timeout and retry settings remain the cancellation and backoff authority, so a provider-originated abort is not confused with a user pressing Escape or Ctrl+C.

## ✨ Features

- Recognizes transient transport, timeout, overload, rate-limit, gateway, Codex websocket, and empty-detail provider failures.
- Detects structured provider usage caps, surfaces an available reset timestamp, and immediately switches a virtual route to the next authenticated fallback.
- Converts provider-originated `stopReason: "aborted"` responses to retryable errors only when the current request signal was not already aborted.
- Preserves user and host cancellation, authentication failures, invalid requests, context overflow, and generic billing/quota failures as terminal conditions.
- Registers `pi-retry/auto`, a Pi virtual model that switches to the next authenticated fallback on a classified retry.
- Optionally wraps the physical model selected at session start, so existing model selection remains the primary route.
- Keeps fallback state sticky for tool continuations and resets it for the next user turn.
- Leaves ordinary retry attempts, exponential backoff, provider timeouts, and the retry budget to Pi's built-in settings.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-retry
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-retry
```

Try the active package from this repository:

```bash
pi -e ./packages/pi-retry
```

Pi extensions execute with the permissions of the Pi process. Review the package before installing it from an untrusted source.

## 🚀 Quick start

Create `<getAgentDir()>/pi-retry.json` (normally `~/.pi/agent/pi-retry.json`):

```json
{
  "autoRoute": true,
  "fallbackModels": [
    {
      "model": "openrouter/anthropic/claude-sonnet-4-5",
      "thinkingLevel": "medium"
    },
    {
      "model": "anthropic/claude-sonnet-4-5"
    }
  ]
}
```

Start Pi with your normal primary model. With `autoRoute: true`, pi-retry wraps that selected physical model as the primary and uses the listed models after a classified transient failure reaches Pi's retry path or an explicit usage-limit response is detected. String entries remain supported for fallback models without a per-model thinking override:

```bash
pi -e npm:@narumitw/pi-retry --model openai-codex/gpt-5.4
```

The fallback model must already be available and authenticated in Pi. Keep Pi's native retry policy enabled:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

## 🧭 How it works

Pi first finishes the provider request and classifies the assistant response. A transient result is annotated with a retryable provider marker, allowing Pi's own retry loop to remove the failed response and call `agent.continue()`. When the selected model is `pi-retry/auto`, its route receives the failed physical model and chooses the next configured, authenticated candidate. Successful tool follow-ups stay on the fallback until the next user turn.

An explicit usage-limit response must include a structured `rate_limit_error` plus a usage-cap marker or reset timestamp. pi-retry preserves the original diagnostic, shows the reset time when available, and queues a hidden follow-up so the virtual route can switch before Pi's native retry backoff. A plain `429` remains a normal transient rate limit and keeps Pi's native retry behavior.

When switching after a transient failure, pi-retry first scans the configured chain for candidates with the same model ID as the failed physical model, preserving their configured order. Only when no usable same-ID candidate remains does it scan different model IDs in chain order. Unavailable or unauthenticated candidates are skipped without consuming a fallback slot.

A fallback entry's explicit `thinkingLevel` wins. Without one, pi-retry uses Pi's configured `defaultThinkingLevel` when present; if Pi has no configured default, it inherits the failed request's thinking level. Pi clamps the returned level to the selected model's capabilities. This level remains sticky for tool continuations on that fallback.

No fallback is attempted for user cancellation, authentication or permission failures, malformed requests, context overflow, generic billing, or generic quota errors. Explicit structured usage-limit responses are the exception when `pi-retry/auto` has an authenticated fallback. If every fallback has failed, Pi's normal retry budget continues to govern whether the current model is retried again or the turn ends.

The old `--retry-stall-timeout-ms` flag remains accepted as a deprecated no-op for command-line compatibility. `PI_RETRY_STALL_TIMEOUT_MS` is likewise ignored; use Pi's native `retry.provider.timeoutMs` instead.

```json
{
  "retry": {
    "provider": {
      "timeoutMs": 300000
    }
  }
}
```

## ⚙️ Settings

The extension reads user settings from `<getAgentDir()>/pi-retry.json`. When the project is trusted, `<project>/.pi/pi-retry.json` overrides recognized user fields. Reads are side-effect free; edit the files manually and start a new session or run `/reload` to reload them.

Supported fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable provider classification and fallback routing. |
| `autoRoute` | `false` | Wrap the physical model selected at session start when at least one fallback is configured. |
| `primaryModel` | unset | Physical `provider/model` used when `pi-retry/auto` is selected directly. |
| `fallbackModels` | `[]` | Ordered physical model candidates. Each entry is either a `provider/model` string or `{ "model": "provider/model", "thinkingLevel": "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" }`; at most 16 unique references are accepted. |

For fully explicit selection, set a primary model and select the virtual model:

```json
{
  "primaryModel": "openai-codex/gpt-5.4",
  "fallbackModels": [
    {
      "model": "openrouter/anthropic/claude-sonnet-4-5",
      "thinkingLevel": "high"
    },
    "anthropic/claude-sonnet-4-5"
  ]
}
```

```bash
pi -e npm:@narumitw/pi-retry --provider pi-retry --model auto
```

The extension does not copy API keys, alter Pi authentication, or silently invent fallback providers. A missing or unauthenticated model fails with an actionable route error instead of being substituted by an arbitrary available model.

## 🚧 Limitations

- Fallback requires `pi-retry/auto` or `autoRoute: true`; loading the extension alone does not change the selected model.
- Immediate usage-limit switching requires a physical fallback that is already authenticated and available in the current virtual route.
- Fallback candidates must be physical chat models already known and authenticated by Pi. The extension does not register providers or create credentials.
- The legacy `--retry-stall-timeout-ms` flag and `PI_RETRY_STALL_TIMEOUT_MS` environment variable are accepted/ignored for compatibility; they never trigger extension-owned aborts.
- Live provider behavior, account entitlements, and model compatibility remain external dependencies. No claim of cross-provider prompt or tool equivalence is made.

## 🗂️ Package layout

```text
packages/pi-retry/
├── src/
│   ├── index.ts       # Thin Pi entrypoint
│   ├── retry.ts       # Lifecycle hooks and provider-error normalization
│   ├── classifier.ts  # Conservative transient/permanent/cancelled classifier
│   ├── router.ts      # Pi virtual-model fallback route
│   └── settings.ts    # User/project settings and model-reference validation
├── test/              # Deterministic classifier, settings, routing, and lifecycle tests
├── package.json
├── tsconfig.json
└── LICENSE
```

## 🔎 Keywords

Pi extension, provider retry, model fallback, virtual model, transient API failure, timeout recovery, Codex websocket, model routing, AI provider reliability.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
