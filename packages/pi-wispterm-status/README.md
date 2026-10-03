# 📡 pi-wispterm-status — Pi Agent Status for WispTerm

[![npm](https://img.shields.io/npm/v/@narumitw/pi-wispterm-status)](https://www.npmjs.com/package/@narumitw/pi-wispterm-status) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Emit WispTerm's private OSC 7748 agent-state markers from the Pi Coding Agent lifecycle so WispTerm can show Pi as running, waiting for input, or finished in its tab and agent-status UI.

## ✨ Features

- Emits `running`, `waiting_approval`, `needs_input`, `done`, and `halted` markers.
- Uses Pi's public lifecycle events instead of terminal-output heuristics.
- Deduplicates repeated states and handles nested approval/input prompts.
- Emits only in TUI mode, avoiding JSON, print, and RPC protocol corruption.
- Keeps reporting best-effort: a terminal write failure never interrupts Pi.
- Does not start a service, socket, watcher, or child process.

## 📦 Install

Install persistently from npm after the package is published:

```bash
pi install npm:@narumitw/pi-wispterm-status
```

Try it without changing persistent package settings:

```bash
pi -e npm:@narumitw/pi-wispterm-status
```

Build and load a local checkout from this repository root:

```bash
npm --workspace @narumitw/pi-wispterm-status run build
pi --no-extensions -e ./packages/pi-wispterm-status
```

Pi extensions run with the same operating-system permissions as Pi. Review the source before loading this package.

## 🚀 Quick start

1. Build or install the extension.
2. Run Pi inside a WispTerm terminal tab.
3. Start an agent turn.
4. WispTerm receives markers such as:

```text
ESC ] 7748 ; wispterm-agent ; state=running ; app=pi ESC \\
```

WispTerm must recognize `App.pi` before these markers can appear in its native agent badge. Until the corresponding WispTerm change is available, the extension still emits the protocol marker but the current WispTerm detector ignores the unknown `app=pi` value.

## 🧭 How it works

The extension maps Pi lifecycle events to WispTerm states:

| Pi event | WispTerm state |
| --- | --- |
| `agent_start` | `running` |
| approval prompt | `waiting_approval` |
| input/select prompt | `needs_input` |
| `agent_before_settle` with final `error` | `failed` |
| `agent_before_settle` with final `aborted` | `halted` |
| `agent_settled` while idle | `done` |
| `session_shutdown` | `halted` |

`done` is the current WispTerm-compatible representation of a settled/idle Pi session. A future WispTerm protocol extension may add a distinct `idle` state.

## 🚧 Limitations

- Requires WispTerm support for `App.pi`; the current released detector may not recognize the marker yet. See [WispTerm issue #655](https://github.com/xuzhougeng/wispterm/issues/655).
- The extension reports the current Pi TUI session only. It does not discover unrelated Pi processes.
- State is sent through the current terminal's stdout as an OSC sequence. Non-TUI modes intentionally do not emit it.
- It does not provide Herdr-style cross-session aggregation or a presence database.

## 🔒 Security and privacy

The extension writes only a fixed OSC status marker to the active TUI terminal. It does not send network requests, read prompts, persist transcripts, or create background processes. The `app=pi` marker contains no prompt, model, path, or credential data.

## 🗂️ Package layout

```text
packages/pi-wispterm-status/
├── src/
│   ├── index.ts                 # Thin package entrypoint
│   └── wispterm-status.ts       # Lifecycle-to-OSC adapter
├── dist/                        # Generated runtime loaded by Pi
├── scripts/build-runtime.mjs    # Runtime builder
├── test/                        # Lifecycle and generated-entry tests
├── package.json
└── LICENSE
```

## 🔎 Keywords

Pi, WispTerm, OSC 7748, agent status, terminal tabs, coding agent, lifecycle.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
