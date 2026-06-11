# GDB Live Watch

A VS Code extension that adds a **Live Watch (GDB)** panel to the Run & Debug sidebar. Unlike the built-in Watch panel, it keeps updating variable values **while the target is running** — including targets where GDB non-stop mode is **not** available (e.g. host applications running on VEOS).

> Why a separate panel? VS Code's built-in Watch view cannot be extended or modified by extensions, so this extension re-implements the watch functionality in its own view and adds live polling on top.

## Features

- **Live polling while running** — values refresh on a configurable interval (default 1000 ms).
- **Works without non-stop mode** — when GDB cannot evaluate while the target runs, the extension transparently performs *sampling cycles*: pause → read all expressions → continue. Pauses are typically only a few milliseconds.
- **Auto mode** — tries direct (non-stop) evaluation first and automatically falls back to sampling if the adapter/target rejects it.
- **Familiar watch functionality** — add / edit / remove / remove-all expressions, expand structs, arrays and pointers, copy value / copy expression, hex display toggle, change highlighting (yellow dot when a value changed since the last poll), error display for invalid expressions.
- **Set Value** — write a new value to any expression or expanded struct/array member (right-click → *Set Value*, or the pencil icon on members). Works while the target is running too: in non-stop mode the value is written directly; otherwise the extension performs a single pause → write → continue cycle.
- **Adapter agnostic** — talks plain DAP to the active debug session, so it works with `cppdbg` (ms-vscode.cpptools), `cortex-debug`, and other GDB-based debug adapters.
- **Persistent expressions** — watch expressions are stored per workspace and survive restarts.

## Usage

1. Start your GDB debug session as usual (e.g. a `cppdbg` *attach* or *launch* configuration targeting your VEOS host application via `gdbserver`/remote GDB).
2. Open the **Live Watch (GDB)** view in the Run & Debug sidebar.
3. Add expressions with the **+** button (or right-click a selection in the editor → *Add Selection to Live Watch*).
4. Polling starts automatically with the session (configurable). Use the play/pause button in the view title or the status bar item to toggle it.

While the target is **running**, expressions must be resolvable without a stack frame (globals, statics, absolute addresses like `*(int*)0x20000000`). During sampling cycles and while stopped, locals of the interrupted frame work too.

## How polling-while-running works

| Mode (`gdbLiveWatch.mode`) | Behavior |
|---|---|
| `auto` (default) | Try direct evaluation on the running target; if it fails, permanently switch this session to sampling. |
| `nonStop` | Always evaluate directly. Requires GDB non-stop / async mode. |
| `sample` | Always use pause → read → continue cycles. Use this when non-stop is not supported (typical for VEOS host debugging). |

Sampling details:

- The pause request is sent through the debug adapter (DAP), so it works with any GDB adapter without extra configuration.
- If a **breakpoint, exception or step** happens to hit while a sampling pause is in flight, the extension detects it and leaves the target stopped — it never "swallows" a real stop.
- The target is only resumed if the stop was caused by the sampler's own pause.

> Tip: sampling makes the debugger briefly enter the "stopped" state, which by default moves editor focus. Set `"debug.focusEditorOnBreak": false` in your settings to avoid flicker.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gdbLiveWatch.pollingInterval` | `1000` | Refresh interval in ms (min 100). |
| `gdbLiveWatch.mode` | `auto` | `auto` / `nonStop` / `sample` (see above). |
| `gdbLiveWatch.autoStartPolling` | `true` | Start polling automatically when a debug session starts. |
| `gdbLiveWatch.maxChildren` | `100` | Max children shown when expanding a variable. |
| `gdbLiveWatch.hexFormat` | `false` | Display values in hexadecimal. |

## VEOS notes

- Debug the VEOS host application with a standard `cppdbg` configuration (`"MIMode": "gdb"`, remote attach to the VEOS gdbserver or local attach to the host process).
- VEOS host debugging usually runs GDB in all-stop mode, so set `"gdbLiveWatch.mode": "sample"` (or leave `auto` — it will fall back by itself after the first failed direct read).
- Keep the polling interval reasonable (≥ 500 ms) if your model is timing-sensitive: each sampling cycle briefly halts the virtual ECU.
- If you can enable non-stop mode, add to your launch config:

```json
"setupCommands": [
    { "text": "set pagination off" },
    { "text": "set non-stop on" }
]
```

With non-stop active, `auto` mode reads variables with zero intrusion (no pauses at all).

## Building / running from source

```bash
npm install
npm run compile
```

Then press `F5` in VS Code (launch config "Run Extension") to start an Extension Development Host, or package it with `npx vsce package` and install the resulting `.vsix`.

## Limitations

- Sampling briefly halts the target; it is minimally intrusive but not zero-intrusion (that requires non-stop mode or a debug probe with background memory access).
- While running (non-stop direct reads/writes), only expressions that don't need a stack frame can be evaluated (globals/statics/addresses) — this is a GDB limitation, not an extension one.
