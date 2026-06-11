# GDB Live Watch

A VS Code extension that adds a **Live Watch (GDB)** panel to the Run & Debug sidebar. Unlike the built-in Watch panel, it keeps updating variable values **while the target is running** — including targets where GDB non-stop mode is **not** available (e.g. host applications running on VEOS).

It also includes a **Symbols (GDB)** browser — a winIDEA-style symbol table that lists all variables, functions, constants and types of the debugged target so you can jump to their source or add them to the Live Watch.

On top of that, a **DAQ Chart** panel (daqIDEA-style data acquisition) records variable values at a configurable sampling period and plots them live, with a data table, CSV/text export and savable variable configurations.

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

## Symbol browser

The **Symbols (GDB)** view (Run & Debug sidebar) browses the symbol table that GDB loaded from the target (e.g. `VECU.dll`), similar to winIDEA's Symbol Browser:

- **Categories** — *Variables*, *Constants* (`const` variables), *Functions* and *Types*, grouped by source file (module), with declaration and line info.
- **Loaded once, cached for the session** — the full table is read automatically when the debug session starts (via `info variables` / `info functions` / `info types`, using a sampling cycle if the target is running) and kept in memory. Use **Reload Symbols** (refresh icon) only if the symbol file changed.
- **Live filtering as you type** — the filter icon opens an input that narrows the symbol tree on every keystroke (plain substring or regular expression, matched locally against the cached table — no GDB round-trips). Matches auto-expand while a filter is active. Press *Enter* to keep the filter, *Esc* to restore the previous one.
- **Go to source** — click a symbol (or use the go-to icon) to open its declaration. Compile-time paths that don't exist locally are resolved by searching the workspace.
- **Add to Live Watch** — the eye icon (or context menu) adds the symbol to the Live Watch panel, like winIDEA's double-click-to-watch.

Symbol browser settings:

| Setting | Default | Description |
|---|---|---|
| `gdbSymbols.autoLoad` | `true` | Load the symbol table automatically when a session starts. |
| `gdbSymbols.maxSymbolsPerCategory` | `2000` | Cap per category; use the filter to narrow large tables. |
| `gdbSymbols.includeNonDebugging` | `false` | Also list symbols without debug info (stripped exports). |
| `gdbSymbols.fileScopedExpressions` | `false` | Add watch expressions as `'file.c'::symbol` to disambiguate statics (winIDEA-style file suffix). |

## DAQ Chart (data acquisition)

Open it with the chart icon in the **Live Watch (GDB)** view title or the **GDB DAQ: Open DAQ Chart** command. Variables can be added directly in the panel, or via *Add to DAQ Chart* in the context menu of Live Watch entries and Symbol browser entries.

- **Visualize acquired data** — every dot on the chart is one acquired sample. While the chart is left alone it auto-fits and always shows the maximum amount of the latest data; once you interact with it you are in manual mode:
  - mouse **wheel** zooms the time axis around the cursor,
  - **Shift/Ctrl + wheel** stretches the value axis,
  - **drag** pans, **double-click** (or the *Fit* button) returns to auto-follow.
  - Dense data is automatically decimated (min/max per pixel column) so the chart stays responsive with 100k+ samples.
- **Configurable sampling period** — `max`, `1 ms`, `10 ms`, `100 ms`, `1 s`. `max` acquires back-to-back as fast as the debug adapter allows. Short periods are an upper bound: the real achievable rate depends on the GDB round-trip (non-stop direct reads are fastest; pause→read→continue sampling is slower). The status bar in the panel shows the actually achieved rate.
- **Data table** — in the lower right corner; the first column is the sample time, every other column is one variable, every row is one acquired sample (newest on top) for reading precise values.
- **Export acquired data** — *Export…* writes all samples to a `.csv` (Excel-compatible) or tab-separated `.txt` file.
- **Variable configuration files** — *Save Config…* / *Load Config…* store the variable list and sampling period as JSON, so acquisition setups can be shared and reused. The current configuration is also persisted per workspace automatically.
- Acquisition keeps running even if the panel is closed; reopening it resyncs all buffered data.

| Setting | Default | Description |
|---|---|---|
| `gdbDaq.maxSamples` | `100000` | Ring buffer size per variable; oldest samples are discarded when full. |

Like the Live Watch, acquisition works both with GDB non-stop targets (zero intrusion) and plain all-stop targets via transparent pause→read→continue sampling cycles.

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
