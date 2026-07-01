import * as vscode from 'vscode';
import * as path from 'path';
import { DisplayOptions, isAddRow, isGroup, LiveWatchModel, ValueFormat, WatchGroup, WatchNode } from './model';
import { LiveWatchDragAndDropController, LiveWatchTreeProvider } from './provider';
import { Poller } from './poller';
import { DebugSessionTracker } from './tracker';
import { SymbolEntry, SymbolService, watchExpressionFor } from './symbols';
import { SymbolNode, SymbolTreeProvider } from './symbolsProvider';
import { DaqEngine } from './daq';
import { DaqPanelManager } from './daqPanel';
import { attachToConfiguredProcess, configureAutoAttach } from './attach';
import { optimizeReleaseSymbols } from './indexer';

export function activate(context: vscode.ExtensionContext): void {
    const model = new LiveWatchModel(context.workspaceState);
    const tracker = new DebugSessionTracker();
    const poller = new Poller(model, tracker);
    const provider = new LiveWatchTreeProvider(model);
    const symbols = new SymbolService(
        tracker,
        poller,
        context.workspaceState,
        vscode.Uri.joinPath(context.globalStorageUri, 'symbol-cache')
    );
    const symbolsProvider = new SymbolTreeProvider(symbols);
    const daq = new DaqEngine(context.workspaceState, poller);
    const daqPanel = new DaqPanelManager(context, daq);

    // Output channel used to print human-readable diagnostics such as the list
    // of source files the symbols were loaded from.
    const output = vscode.window.createOutputChannel('GDB Symbols');
    context.subscriptions.push(output);

    const treeView = vscode.window.createTreeView('gdbLiveWatch', {
        treeDataProvider: provider,
        dragAndDropController: new LiveWatchDragAndDropController(model),
        showCollapseAll: true,
        canSelectMany: false
    });

    const symbolsView = vscode.window.createTreeView('gdbSymbols', {
        treeDataProvider: symbolsProvider,
        showCollapseAll: true,
        canSelectMany: true
    });

    const updateSymbolsUi = () => {
        symbolsView.message = symbols.loading
            ? 'Loading symbols from target...'
            : symbols.filter
                ? `Filter: ${symbols.filter}`
                : undefined;
        void vscode.commands.executeCommand('setContext', 'gdbSymbols.hasFilter', !!symbols.filter);
    };
    symbols.onDidChange(updateSymbolsUi);
    updateSymbolsUi();

    treeView.onDidExpandElement((e) => {
        if (!isGroup(e.element) && !isAddRow(e.element)) {
            model.expandedIds.add(e.element.id);
        }
    });
    treeView.onDidCollapseElement((e) => {
        if (!isGroup(e.element) && !isAddRow(e.element)) {
            model.expandedIds.delete(e.element.id);
        }
    });

    // ---- attach status bar ----------------------------------------------
    // Always-visible indicator of the overall connection state so the user can
    // see at a glance whether the debugger is attached — even when no session
    // is running yet. Clicking it starts the one-click attach.
    const attachStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 52);
    attachStatusBar.command = 'gdbLiveWatch.attachToProcess';

    // True while a one-click attach is in progress (between the user invoking
    // the attach command and a debug session actually starting).
    let attaching = false;

    const updateAttachStatusBar = () => {
        const session = vscode.debug.activeDebugSession;
        if (attaching && !session) {
            attachStatusBar.text = '$(sync~spin) GDB: Attaching';
            attachStatusBar.tooltip = 'GDB Live Watch: attaching to the target process...';
            attachStatusBar.backgroundColor = undefined;
        } else if (!session) {
            attachStatusBar.text = '$(debug-disconnect) GDB: Not Attached';
            attachStatusBar.tooltip = 'GDB Live Watch: not attached (click to attach)';
            attachStatusBar.backgroundColor = undefined;
        } else if (tracker.getState(session.id) === 'stopped') {
            attachStatusBar.text = '$(debug-pause) GDB: Stopped';
            attachStatusBar.tooltip = 'GDB Live Watch: attached — target stopped (breakpoint/step)';
            attachStatusBar.backgroundColor = undefined;
        } else {
            attachStatusBar.text = '$(debug-start) GDB: Running';
            attachStatusBar.tooltip = 'GDB Live Watch: attached — target running';
            attachStatusBar.backgroundColor = undefined;
        }
        attachStatusBar.show();
    };

    // ---- status bar ------------------------------------------------------
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'gdbLiveWatch.togglePolling';

    // Shows the executable currently being debugged/attached to. Its name
    // usually identifies which release/build is running, so it is surfaced
    // separately and stays visible for the whole session (independent of
    // whether live polling is on).
    const exeStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51);
    const executablePath = (session: vscode.DebugSession): string | undefined => {
        const cfg = session.configuration as { program?: string; executable?: string };
        return cfg.program ?? cfg.executable;
    };
    const updateExeStatusBar = () => {
        const session = vscode.debug.activeDebugSession;
        const binPath = session && executablePath(session);
        if (!binPath) {
            exeStatusBar.hide();
            return;
        }
        exeStatusBar.text = `$(file-binary) ${path.basename(binPath)}`;
        exeStatusBar.tooltip = `Debugging executable:\n${binPath}`;
        exeStatusBar.show();

        // Also surface the dSPACE model name (e.g. MB_ZC_Rear_vECU) taken from
        // the dSPACE .dll/.vap module loaded into the host process. This is the
        // real identity of what is being debugged in an attach setup, where the
        // executable itself is just the generic VEOS host runner.
        void symbols.getDspaceModelName(session).then((model) => {
            if (vscode.debug.activeDebugSession !== session) {
                return;
            }
            if (model) {
                exeStatusBar.text = `$(file-binary) ${path.basename(binPath)} $(chip) ${model}`;
                exeStatusBar.tooltip = `Debugging executable:\n${binPath}\n\ndSPACE model:\n${model}`;
            } else {
                exeStatusBar.text = `$(file-binary) ${path.basename(binPath)}`;
                exeStatusBar.tooltip = `Debugging executable:\n${binPath}`;
            }
            exeStatusBar.show();
        });
    };

    const updateStatusBar = () => {
        updateExeStatusBar();
        updateAttachStatusBar();
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            statusBar.hide();
            return;
        }
        if (!poller.polling) {
            statusBar.text = '$(pulse) Live Watch off';
            statusBar.tooltip = 'GDB Live Watch: polling stopped (click to start)';
            statusBar.backgroundColor = undefined;
            statusBar.show();
            return;
        }

        const stats = poller.getStats();
        const state = tracker.getState(session.id);
        const tip: string[] = [];
        let icon = '$(pulse)';
        let label: string;

        if (state === 'stopped') {
            icon = '$(debug-pause)';
            label = 'Live Watch (stopped)';
            tip.push('Target stopped (breakpoint/step) — values reflect the current frame.');
        } else if (poller.isRunningToBreakpoint(session.id)) {
            icon = '$(debug-continue)';
            label = 'Live Watch (running to breakpoint)';
            tip.push('You resumed the target with breakpoints set.');
            tip.push('Sampling pauses are suspended so the program can reach a breakpoint.');
            tip.push('Live sampling resumes automatically once a breakpoint is hit.');
        } else if (
            vscode.workspace.getConfiguration('gdbLiveWatch').get<string>('mode') === 'stoppedOnly'
        ) {
            icon = '$(shield)';
            label = 'Live Watch (safe)';
            tip.push('Safe mode: the running target is never paused.');
            tip.push('Values refresh when the target stops (breakpoint/step).');
        } else if (stats.mode === 'sampling' || poller.isSamplingFallback(session.id)) {
            label = 'Live Watch (sampling)';
            tip.push('Reading via pause → read → continue sampling cycles.');
            if (stats.lastPauseMs > 0) {
                tip.push(`Pause cost: ~${stats.lastPauseMs} ms per cycle (target halted).`);
            }
            if (stats.effectiveIntervalMs > stats.achievedIntervalMs && stats.effectiveIntervalMs > 0) {
                tip.push(`Adaptive back-off: interval stretched to ${stats.effectiveIntervalMs} ms.`);
            }
        } else {
            label = 'Live Watch (live)';
            tip.push('Reading directly while running (non-stop mode, zero intrusion).');
        }

        const eff = stats.effectiveIntervalMs || poller.getStats().achievedIntervalMs;
        const hz = stats.achievedIntervalMs > 0 ? 1000 / stats.achievedIntervalMs : 0;
        statusBar.text = `${icon} ${label} ${eff ? `${eff}ms` : ''}`.trim();
        if (hz > 0) {
            tip.push(`Achieved rate: ~${hz >= 10 ? hz.toFixed(0) : hz.toFixed(1)} Hz.`);
        }
        if (stats.lastTickMs > 0) {
            tip.push(`Last refresh: ${stats.lastTickMs} ms.`);
        }
        tip.push('Click to stop polling.');
        statusBar.tooltip = tip.join('\n');
        statusBar.backgroundColor =
            stats.mode === 'sampling' && stats.lastPauseMs > 200
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
        statusBar.show();
    };

    const setPollingContext = () =>
        void vscode.commands.executeCommand('setContext', 'gdbLiveWatch.polling', poller.polling);

    poller.onDidChangePolling(() => {
        setPollingContext();
        updateStatusBar();
    });
    poller.onDidChangeStats(() => updateStatusBar());
    tracker.onDidChangeState(() => updateStatusBar());
    setPollingContext();
    updateStatusBar();

    // ---- fatal sampling / adapter failures -------------------------------
    // The native-Windows GDB break-in race can crash the debug engine
    // ("Failed to find thread N for break event"). When that (or any other
    // unrecoverable sampling condition) is detected, stop all sampling so we
    // never pile more pauses onto a dying session, and tell the user how to
    // make overnight runs robust.
    let fatalNotified = false;
    const handleFatal = (message: string) => {
        poller.stop();
        daq.stop();
        if (fatalNotified) {
            return;
        }
        fatalNotified = true;
        void vscode.window
            .showErrorMessage(
                `GDB Live Watch: ${message} This is usually the native-Windows GDB pause/break-in race in the cppdbg debugger, not your program. ` +
                    'To make unattended test runs robust, switch the read mode to "stoppedOnly" (never pauses a running target), or enable GDB non-stop mode, or use a newer GDB.',
                'Open Settings',
                'Use Safe Mode'
            )
            .then((choice) => {
                if (choice === 'Open Settings') {
                    void vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'gdbLiveWatch.mode'
                    );
                } else if (choice === 'Use Safe Mode') {
                    void vscode.workspace
                        .getConfiguration('gdbLiveWatch')
                        .update('mode', 'stoppedOnly', vscode.ConfigurationTarget.Workspace);
                }
            });
    };
    tracker.onDidEncounterFatalError(() =>
        handleFatal('the debug engine reported a fatal break-state error and the session is stopping.')
    );
    poller.onDidEncounterFatal((e) => handleFatal(e.message));

    // ---- session lifecycle ----------------------------------------------
    const autoStart = () =>
        vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('autoStartPolling', true);

    // If a debug session is lost while DAQ acquisition is running, resume it
    // automatically when the next (re)connected session starts.
    let resumeDaqOnReconnect = false;

    // ---- automatic symbol loading -----------------------------------------
    // The symbol table can only be read once GDB is responsive, so the load is
    // triggered by the first run-state event of the session (entry stop or
    // first continue), with a timer as fallback for sessions that emit neither.
    const pendingSymbolLoad = new Set<string>();
    const symbolAutoLoad = () =>
        vscode.workspace.getConfiguration('gdbSymbols').get<boolean>('autoLoad', true);

    const autoLoadSymbols = (session: vscode.DebugSession) => {
        if (!pendingSymbolLoad.delete(session.id)) {
            return;
        }
        symbols.load(session).catch(() => {
            // Adapter not ready or unsupported; user can still load manually.
        });
    };

    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(() => {
            fatalNotified = false;
            attaching = false;
            if (autoStart()) {
                poller.start();
            }
            if (resumeDaqOnReconnect) {
                resumeDaqOnReconnect = false;
                // Give the adapter a moment to become responsive before sampling.
                setTimeout(() => {
                    if (vscode.debug.activeDebugSession && !daq.isRecording) {
                        try {
                            daq.start();
                        } catch {
                            // No enabled variables / not ready; leave it stopped.
                        }
                    }
                }, 1500);
            }
            updateStatusBar();
        }),
        vscode.debug.onDidStartDebugSession((session) => {
            if (!symbolAutoLoad()) {
                return;
            }
            pendingSymbolLoad.add(session.id);
            setTimeout(() => autoLoadSymbols(session), 3000);
        }),
        tracker.onDidChangeState((session) => autoLoadSymbols(session)),
        vscode.debug.onDidTerminateDebugSession((s) => {
            poller.forgetSession(s.id);
            symbols.forgetSession(s.id);
            pendingSymbolLoad.delete(s.id);
            if (!vscode.debug.activeDebugSession) {
                resumeDaqOnReconnect = daq.isRecording;
                poller.stop();
                model.invalidate();
                symbols.clear();
                daq.stop();
            }
            updateStatusBar();
        }),
        // The active session may still point at a dying session while
        // onDidTerminate runs, which left the status bar showing "Running"
        // after a disconnect. Refresh once VS Code actually clears/changes it.
        vscode.debug.onDidChangeActiveDebugSession(() => updateStatusBar()),
        // Immediate refresh whenever the target stops (breakpoint, step, ...).
        // This runs even when live polling is off: a stop is a safe moment to
        // read, and the native Watch window refreshes on every stop too, so the
        // values must not stay frozen just because the polling timer is idle.
        tracker.onDidChangeState((session) => {
            if (
                session === vscode.debug.activeDebugSession &&
                tracker.getState(session.id) === 'stopped'
            ) {
                void poller.tick();
            }
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gdbLiveWatch.pollingInterval')) {
                poller.restartIfPolling();
                updateStatusBar();
            }
            if (e.affectsConfiguration('gdbSymbols.maxSymbolsPerCategory')) {
                // View setting only affects the cached table's presentation.
                symbols.refreshView();
            }
            if (
                e.affectsConfiguration('gdbSymbols.sourcePathFilter') ||
                e.affectsConfiguration('gdbSymbols.sourcePathExclude') ||
                e.affectsConfiguration('gdbSymbols.scopeToDspaceModel')
            ) {
                // These settings only decide which already-fetched source files
                // are kept - GDB's `info variables`/`info functions` have no
                // file-scoping option, so they cannot make that query itself any
                // cheaper. Re-apply them to the cached raw listings (fast,
                // in-memory re-parse) instead of re-running the expensive query.
                symbols.reapplySourceFilters();
            }
            if (e.affectsConfiguration('gdbSymbols.includeNonDebugging')) {
                // The non-debugging section is now skipped at parse time, so a
                // change requires re-reading the symbol table from GDB/cache.
                const session = vscode.debug.activeDebugSession;
                if (session && symbols.hasData) {
                    symbols.load(session, { force: true }).catch(() => {
                        /* surfaced via the view's loading state */
                    });
                } else {
                    symbols.refreshView();
                }
            }
        })
    );

    // ---- commands ---------------------------------------------------------
    // Tracks the last clicked watch node so a quick second click on the same
    // node is recognised as a double-click (see gdbLiveWatch.nodeClicked).
    let lastClick: { id: string | undefined; time: number } = { id: undefined, time: 0 };

    const addExpression = async (initial?: string, group?: WatchGroup) => {
        const expression = await vscode.window.showInputBox({
            prompt: 'Expression to watch (evaluated by GDB)',
            placeHolder: 'e.g. myStruct.counter, *ptr, array[3], (int)flags & 0xFF',
            value: initial
        });
        if (expression?.trim()) {
            model.addExpression(expression.trim(), group);
            void poller.tick();
        }
    };

    const pickGroup = async (placeHolder: string): Promise<WatchGroup | undefined> => {
        const groups = model.groupList;
        if (groups.length <= 1) {
            return groups[0];
        }
        const picked = await vscode.window.showQuickPick(
            groups.map((g) => ({ label: g.name, description: `${g.roots.length} expressions`, group: g })),
            { placeHolder }
        );
        return picked?.group;
    };

    const updateDisplay = (node: WatchNode, patch: DisplayOptions) => {
        const next: DisplayOptions = { ...(node.display ?? {}), ...patch };
        for (const k of Object.keys(next) as (keyof DisplayOptions)[]) {
            if (next[k] === undefined || next[k] === '') {
                delete next[k];
            }
        }
        model.setDisplayOptions(node, Object.keys(next).length ? next : undefined);
        void poller.tick();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('gdbLiveWatch.addExpression', () => addExpression()),

        vscode.commands.registerCommand('gdbLiveWatch.addSelectionToLiveWatch', () => {
            const editor = vscode.window.activeTextEditor;
            const text = editor ? editor.document.getText(editor.selection).trim() : '';
            if (text) {
                model.addExpression(text);
                void poller.tick();
            } else {
                void addExpression();
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.editExpression', async (node: WatchNode) => {
            if (!node?.isRoot) {
                return;
            }
            const expression = await vscode.window.showInputBox({
                prompt: 'Edit watch expression',
                value: node.expression
            });
            if (expression?.trim()) {
                model.editExpression(node, expression.trim());
                void poller.tick();
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.removeExpression', (node: WatchNode) => {
            if (node?.isRoot) {
                model.removeExpression(node);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.removeAll', () => model.removeAll()),

        // ---- groups -------------------------------------------------------
        vscode.commands.registerCommand('gdbLiveWatch.addGroup', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'New watch group name',
                placeHolder: 'e.g. Motor control, ADC, Diagnostics'
            });
            if (name?.trim()) {
                model.addGroup(name.trim());
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.addExpressionToGroup', (group: WatchGroup) => {
            if (group && (group as WatchGroup).roots) {
                void addExpression(undefined, group);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.renameGroup', async (group: WatchGroup) => {
            if (!group || !(group as WatchGroup).roots) {
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: 'Rename watch group',
                value: group.name
            });
            if (name?.trim()) {
                model.renameGroup(group, name.trim());
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.removeGroup', async (group: WatchGroup) => {
            if (!group || !(group as WatchGroup).roots) {
                return;
            }
            if (group.roots.length > 0) {
                const ok = await vscode.window.showWarningMessage(
                    `Remove group '${group.name}' and its ${group.roots.length} expression(s)?`,
                    { modal: true },
                    'Remove'
                );
                if (ok !== 'Remove') {
                    return;
                }
            }
            model.removeGroup(group);
        }),

        vscode.commands.registerCommand('gdbLiveWatch.moveToGroup', async (node: WatchNode) => {
            if (!node?.isRoot) {
                return;
            }
            const group = await pickGroup('Move expression to group');
            if (group) {
                model.moveExpressionToGroup(node, group);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.saveWatchList', async () => {
            const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri;
            const uri = await vscode.window.showSaveDialog({
                title: 'Save watch list',
                defaultUri: defaultDir ? vscode.Uri.joinPath(defaultDir, 'watch-list.json') : undefined,
                filters: { 'Watch list (JSON)': ['json'] }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(model.exportList(), 'utf8'));
                void vscode.window.showInformationMessage(`GDB Live Watch: watch list saved to ${uri.fsPath}`);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.loadWatchList', async () => {
            const picked = await vscode.window.showOpenDialog({
                title: 'Load watch list',
                canSelectMany: false,
                filters: { 'Watch list (JSON)': ['json'] }
            });
            if (!picked?.length) {
                return;
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(picked[0]);
                model.importList(Buffer.from(bytes).toString('utf8'));
                void poller.tick();
            } catch (e: any) {
                void vscode.window.showErrorMessage(
                    `GDB Live Watch: failed to load watch list: ${String(e?.message ?? e).split('\n')[0]}`
                );
            }
        }),

        // ---- per-expression display format --------------------------------
        vscode.commands.registerCommand('gdbLiveWatch.setFormat', async (node: WatchNode) => {
            if (!node?.isRoot) {
                return;
            }
            const current = node.display?.format ?? 'natural';
            const items: Array<vscode.QuickPickItem & { value: ValueFormat }> = [
                { label: 'Natural', description: 'as reported by GDB', value: 'natural' },
                { label: 'Decimal', value: 'dec' },
                { label: 'Hexadecimal', description: '0x…', value: 'hex' },
                { label: 'Octal', description: '0o…', value: 'oct' },
                { label: 'Binary', description: '0b…', value: 'bin' }
            ];
            for (const it of items) {
                if (it.value === current) {
                    it.label = `$(check) ${it.label}`;
                }
            }
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `Display format for '${node.expression}'`
            });
            if (picked) {
                updateDisplay(node, { format: picked.value });
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.setScaleUnit', async (node: WatchNode) => {
            if (!node?.isRoot) {
                return;
            }
            const scaleStr = await vscode.window.showInputBox({
                prompt: 'Scale factor (shown = raw * scale + offset). Leave empty for none.',
                value: node.display?.scale !== undefined ? String(node.display.scale) : '',
                validateInput: (v) => (v.trim() === '' || isFinite(Number(v)) ? undefined : 'Enter a number')
            });
            if (scaleStr === undefined) {
                return;
            }
            const offsetStr = await vscode.window.showInputBox({
                prompt: 'Offset (shown = raw * scale + offset). Leave empty for none.',
                value: node.display?.offset !== undefined ? String(node.display.offset) : '',
                validateInput: (v) => (v.trim() === '' || isFinite(Number(v)) ? undefined : 'Enter a number')
            });
            if (offsetStr === undefined) {
                return;
            }
            const unit = await vscode.window.showInputBox({
                prompt: 'Unit label (appended to the value). Leave empty for none.',
                value: node.display?.unit ?? '',
                placeHolder: 'e.g. rpm, V, °C, ms'
            });
            if (unit === undefined) {
                return;
            }
            updateDisplay(node, {
                scale: scaleStr.trim() === '' ? undefined : Number(scaleStr),
                offset: offsetStr.trim() === '' ? undefined : Number(offsetStr),
                unit: unit.trim() === '' ? undefined : unit.trim()
            });
        }),

        vscode.commands.registerCommand('gdbLiveWatch.clearFormat', (node: WatchNode) => {
            if (node?.isRoot) {
                model.setDisplayOptions(node, undefined);
                void poller.tick();
            }
        }),

        // Emulates a double-click on a watch node: a second click on the same
        // node within DOUBLE_CLICK_MS opens the value editor; a single click
        // just selects it (default tree behaviour).
        vscode.commands.registerCommand('gdbLiveWatch.nodeClicked', (node: WatchNode) => {
            if (!node) {
                return;
            }
            const DOUBLE_CLICK_MS = 500;
            const now = Date.now();
            if (lastClick.id === node.id && now - lastClick.time <= DOUBLE_CLICK_MS) {
                lastClick = { id: undefined, time: 0 };
                void vscode.commands.executeCommand('gdbLiveWatch.setValue', node);
                return;
            }
            lastClick = { id: node.id, time: now };
        }),

        vscode.commands.registerCommand('gdbLiveWatch.setValue', async (node: WatchNode) => {
            const session = vscode.debug.activeDebugSession;
            if (!node) {
                return;
            }
            if (!session) {
                void vscode.window.showWarningMessage('GDB Live Watch: no active debug session.');
                return;
            }
            const target = node.expression || node.name;
            const value = await vscode.window.showInputBox({
                prompt: `New value for '${target}'`,
                value: node.error ? '' : node.value,
                placeHolder: 'e.g. 42, 0x1F, true, "text"'
            });
            if (value === undefined || value.trim() === '') {
                return;
            }
            try {
                await poller.setNodeValue(session, node.id, value.trim());
            } catch (e: any) {
                const msg = String(e?.message ?? e).split('\n')[0];
                void vscode.window.showErrorMessage(`GDB Live Watch: failed to set '${target}': ${msg}`);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.copyValue', (node: WatchNode) => {
            if (node) {
                void vscode.env.clipboard.writeText(node.value);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.copyExpression', (node: WatchNode) => {
            if (node) {
                void vscode.env.clipboard.writeText(node.expression || node.name);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.copyValueWithTimestamp', (node: WatchNode) => {
            if (node) {
                const ts = new Date().toISOString();
                void vscode.env.clipboard.writeText(`${ts}\t${node.expression || node.name}\t${node.value}`);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.copyAsTable', () => {
            const ts = new Date().toISOString();
            const lines = [`# GDB Live Watch snapshot ${ts}`, 'Group\tExpression\tValue\tType'];
            for (const group of model.groupList) {
                for (const root of group.roots) {
                    lines.push(`${group.name}\t${root.expression}\t${root.value}\t${root.type ?? ''}`);
                }
            }
            void vscode.env.clipboard.writeText(lines.join('\n'));
            void vscode.window.showInformationMessage('GDB Live Watch: snapshot copied to clipboard.');
        }),

        vscode.commands.registerCommand('gdbLiveWatch.refresh', () => poller.tick()),

        vscode.commands.registerCommand('gdbLiveWatch.startPolling', () => {
            if (!vscode.debug.activeDebugSession) {
                void vscode.window.showWarningMessage('GDB Live Watch: no active debug session.');
                return;
            }
            poller.start();
        }),

        vscode.commands.registerCommand('gdbLiveWatch.stopPolling', () => poller.stop()),

        vscode.commands.registerCommand('gdbLiveWatch.togglePolling', () => {
            if (poller.polling) {
                poller.stop();
            } else if (vscode.debug.activeDebugSession) {
                poller.start();
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.setPollingInterval', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Polling interval in milliseconds (minimum 100)',
                value: String(
                    vscode.workspace.getConfiguration('gdbLiveWatch').get<number>('pollingInterval', 1000)
                ),
                validateInput: (v) =>
                    /^\d+$/.test(v) && Number(v) >= 100 ? undefined : 'Enter a number >= 100'
            });
            if (value) {
                await vscode.workspace
                    .getConfiguration('gdbLiveWatch')
                    .update('pollingInterval', Number(value), vscode.ConfigurationTarget.Workspace);
            }
        }),

        vscode.commands.registerCommand('gdbLiveWatch.toggleHexFormat', async () => {
            const cfg = vscode.workspace.getConfiguration('gdbLiveWatch');
            await cfg.update(
                'hexFormat',
                !cfg.get<boolean>('hexFormat', false),
                vscode.ConfigurationTarget.Workspace
            );
            void poller.tick();
        }),

        // Command API for other extensions: evaluate/write expressions using
        // the same runtime-safe sampling logic as live polling.
        vscode.commands.registerCommand('gdbLiveWatch.readExpressionRealtime', async (arg: unknown) => {
            const expression = normalizeExpressionArg(arg);
            if (!expression) {
                throw new Error('Missing expression');
            }

            const session = vscode.debug.activeDebugSession;
            if (!session) {
                throw new Error('No active debug session');
            }

            const evaluation = await poller.runReadOperation(session, async (frameId) => {
                return session.customRequest('evaluate', {
                    expression,
                    frameId,
                    context: 'watch'
                });
            });

            return {
                expression,
                value: toCommandResultValue(evaluation?.result ?? evaluation?.value ?? evaluation?.message ?? ''),
                type: toCommandResultValue(evaluation?.type ?? ''),
                variablesReference: Number(evaluation?.variablesReference ?? 0)
            };
        }),

        vscode.commands.registerCommand('gdbLiveWatch.writeExpressionRealtime', async (arg: unknown) => {
            const payload = normalizeWriteArgs(arg);
            if (!payload.expression) {
                throw new Error('Missing expression');
            }
            const writeValue = payload.value;
            if (writeValue === undefined) {
                throw new Error('Missing value');
            }

            const session = vscode.debug.activeDebugSession;
            if (!session) {
                throw new Error('No active debug session');
            }

            const evaluation = await poller.runReadOperation(session, async (frameId) => {
                return session.customRequest('evaluate', {
                    expression: `${payload.expression} = ${formatEvaluateValue(writeValue)}`,
                    frameId,
                    context: 'repl'
                });
            });

            void poller.tick();

            return {
                expression: payload.expression,
                value: toCommandResultValue(evaluation?.result ?? evaluation?.value ?? writeValue)
            };
        })
    );

    // ---- symbol browser commands -------------------------------------------
    const loadSymbols = async (force: boolean) => {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            void vscode.window.showWarningMessage('GDB Symbols: no active debug session.');
            return;
        }
        try {
            await symbols.load(session, { force });
        } catch (e: any) {
            const msg = String(e?.message ?? e).split('\n')[0];
            void vscode.window.showErrorMessage(`GDB Symbols: failed to load symbols: ${msg}`);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('gdbSymbols.load', () => loadSymbols(true)),

        vscode.commands.registerCommand('gdbSymbols.search', async () => {
            // Live filter: every keystroke narrows any already-loaded table
            // immediately. Pressing Enter asks GDB for a filtered listing so the
            // expensive symbol query itself can shrink for selective names.
            const previous = symbols.filter;
            const input = vscode.window.createInputBox();
            input.title = 'Filter Symbols';
            input.prompt =
                'Type a symbol name filter. Press Enter to query GDB with the filter; closing the prompt keeps the local preview.';
            input.placeholder = 'e.g. Something, ^motor_, Adc.*Init, Rte_Read_R_FS2()';
            input.value = previous;

            let debounce: ReturnType<typeof setTimeout> | undefined;
            let accepted = false;
            const applyFilter = async (queryGdb: boolean) => {
                if (debounce) {
                    clearTimeout(debounce);
                    debounce = undefined;
                }
                const term = input.value.trim();
                symbols.rememberFilter(term);
                if (!queryGdb) {
                    symbols.filter = term;
                    return;
                }
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    symbols.filter = term;
                    return;
                }
                try {
                    if (term) {
                        await symbols.loadFiltered(session, term, { force: true });
                    } else {
                        await symbols.load(session, { force: false });
                        symbols.filter = '';
                    }
                } catch (e: any) {
                    symbols.filter = term;
                    const msg = String(e?.message ?? e).split('\n')[0];
                    void vscode.window.showErrorMessage(
                        `GDB Symbols: failed to query filtered symbols: ${msg}`
                    );
                }
            };
            input.onDidChangeValue((value) => {
                if (debounce) {
                    clearTimeout(debounce);
                }
                debounce = setTimeout(() => {
                    symbols.filter = value.trim();
                }, 120);
            });
            input.onDidAccept(() => {
                accepted = true;
                void applyFilter(true);
                input.hide();
            });
            input.onDidHide(() => {
                if (!accepted) {
                    void applyFilter(false);
                }
                input.dispose();
            });
            input.show();
        }),

        vscode.commands.registerCommand('gdbSymbols.clearFilter', () => {
            symbols.filter = '';
        }),

        vscode.commands.registerCommand(
            'gdbSymbols.addToLiveWatch',
            (node: SymbolNode, nodes?: SymbolNode[]) => {
                const entries = symbolEntriesOf(node, nodes);
                if (entries.length === 0) {
                    return;
                }
                for (const entry of entries) {
                    model.addExpression(watchExpressionFor(entry));
                }
                void poller.tick();
                // Bring the live watch panel into view, like winIDEA's double-click-to-watch.
                void vscode.commands.executeCommand('gdbLiveWatch.focus');
            }
        ),

        vscode.commands.registerCommand(
            'gdbSymbols.toggleFavorite',
            (node: SymbolNode, nodes?: SymbolNode[]) => {
                for (const entry of symbolEntriesOf(node, nodes)) {
                    symbols.toggleFavorite(entry.name);
                }
            }
        ),

        vscode.commands.registerCommand('gdbSymbols.filterHistory', async () => {
            const history = symbols.getFilterHistory();
            if (history.length === 0) {
                void vscode.window.showInformationMessage('GDB Symbols: no recent filters yet.');
                return;
            }
            const picked = await vscode.window.showQuickPick(history, {
                placeHolder: 'Recent symbol filters'
            });
            if (picked !== undefined) {
                symbols.rememberFilter(picked);
                symbols.filter = picked;
            }
        }),

        vscode.commands.registerCommand('gdbSymbols.goTo', async (node: SymbolNode) => {
            if (node?.kind !== 'symbol') {
                return;
            }
            await openSymbolLocation(node.entry);
        }),

        vscode.commands.registerCommand('gdbSymbols.copyName', (node: SymbolNode) => {
            if (node?.kind === 'symbol') {
                void vscode.env.clipboard.writeText(node.entry.name);
            }
        }),

        vscode.commands.registerCommand('gdbSymbols.optimizeRelease', () =>
            optimizeReleaseSymbols(symbols, output)
        ),

        vscode.commands.registerCommand('gdbSymbols.showSourceFiles', async () => {
            if (!symbols.hasData && vscode.debug.activeDebugSession) {
                await loadSymbols(false);
            }
            if (!symbols.hasData) {
                void vscode.window.showInformationMessage(
                    'GDB Symbols: no symbols loaded yet.'
                );
                return;
            }
            const summary = symbols.getSourceFileSummary();
            output.clear();

            // Where the debug info physically comes from: the main executable and
            // the loaded shared libraries / DLLs. This is what GDB reads the
            // source-file names and line numbers out of. Only available while a
            // session is live (needs the DAP 'modules' request).
            const session = vscode.debug.activeDebugSession;
            if (session) {
                const cfg = session.configuration as { program?: string; executable?: string };
                const binPath = cfg.program ?? cfg.executable;
                output.appendLine(
                    `Debugged executable: ${binPath ?? '(unknown)'}`
                );
                const modules = await symbols.getModules(session);
                if (modules.length > 0) {
                    output.appendLine('');
                    output.appendLine(`Loaded modules (${modules.length}):`);
                    for (const m of modules) {
                        const where = m.symbolFilePath ? ` [symbols: ${m.symbolFilePath}]` : '';
                        const status = m.symbolStatus ? ` — ${m.symbolStatus}` : '';
                        output.appendLine(`  ${m.path ?? m.name}${status}${where}`);
                    }
                } else {
                    output.appendLine(
                        '(the debug adapter did not report a module list)'
                    );
                }
                output.appendLine('');
            }

            output.appendLine(`Symbol source files (${summary.length}):`);
            output.appendLine('');
            let totalVars = 0;
            let totalFuncs = 0;
            for (const s of summary) {
                totalVars += s.variables;
                totalFuncs += s.functions;
                output.appendLine(
                    `  ${s.file}  —  ${s.variables} variables, ${s.functions} functions`
                );
            }
            output.appendLine('');
            output.appendLine(
                `Total: ${totalVars} variables, ${totalFuncs} functions across ${summary.length} files.`
            );
            const timing = symbols.lastLoad;
            if (timing) {
                const secs = (timing.durationMs / 1000).toFixed(3);
                const filterInfo = timing.filter
                    ? `, filtered by "${timing.filter}" (GDB regexp: ${timing.gdbRegexp})`
                    : '';
                const timingLabel = timing.filter ? 'Filtered GDB query time' : 'Full load time';
                output.appendLine(
                    `${timingLabel}: ${timing.durationMs} ms (${secs} s) for ${timing.entries} symbols` +
                        ` — source: ${timing.fromCache ? 'disk cache' : 'GDB query'}${filterInfo}.`
                );
            }
            const viewTiming = symbols.lastViewBuild;
            if (viewTiming) {
                const filterLabel = symbols.filter ? `filter "${symbols.filter}"` : 'no filter';
                output.appendLine(
                    `Filter time: ${viewTiming.durationMs} ms for ${viewTiming.visible} visible symbols` +
                        ` — ${filterLabel}.`
                );
            }
            output.show(true);
        })
    );

    // ---- source-path filter configuration -----------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('gdbSymbols.configureSourcePathFilter', async () => {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const current = cfg.get<string[]>('sourcePathFilter', []);
            const input = await vscode.window.showInputBox({
                title: 'Filter Symbols by Source Path',
                prompt:
                    'Only show symbols whose source file matches one of these patterns ' +
                    '(comma-separated; regex or substring). Leave empty to show all.',
                placeHolder: 'e.g. Z:\\Code, \\GeneratedCode, MB_ZC_Rear_vECU',
                value: current.join(', '),
                ignoreFocusOut: true
            });
            if (input === undefined) {
                return; // cancelled
            }
            const patterns = input
                .split(',')
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await cfg.update('sourcePathFilter', patterns, target);
            void vscode.window.showInformationMessage(
                patterns.length
                    ? `GDB Symbols: showing only symbols from ${patterns.length} source path pattern(s).`
                    : 'GDB Symbols: source-path filter cleared — showing all symbols.'
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gdbSymbols.configureSourcePathExclude', async () => {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const current = cfg.get<string[]>('sourcePathExclude', []);
            const input = await vscode.window.showInputBox({
                title: 'Exclude Symbols by Source Path',
                prompt:
                    'Hide symbols whose source file matches one of these patterns ' +
                    '(comma-separated; regex or substring). Leave empty to exclude nothing.',
                placeHolder: 'e.g. mingw, gcc, msys, buildroot',
                value: current.join(', '),
                ignoreFocusOut: true
            });
            if (input === undefined) {
                return; // cancelled
            }
            const patterns = input
                .split(',')
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await cfg.update('sourcePathExclude', patterns, target);
            void vscode.window.showInformationMessage(
                patterns.length
                    ? `GDB Symbols: excluding symbols from ${patterns.length} source path pattern(s).`
                    : 'GDB Symbols: source-path exclusions cleared.'
            );
        })
    );

    // ---- one-click GDB attach ------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('gdbLiveWatch.attachToProcess', async () => {
            attaching = true;
            updateStatusBar();
            try {
                await attachToConfiguredProcess();
            } finally {
                attaching = false;
                updateStatusBar();
            }
        }),
        vscode.commands.registerCommand('gdbLiveWatch.configure', () => configureAutoAttach())
    );

    // ---- DAQ chart commands --------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('gdbDaq.open', () => daqPanel.show()),

        vscode.commands.registerCommand('gdbDaq.addFromWatch', (node: WatchNode) => {
            const expr = node?.expression || node?.name;
            if (expr) {
                daq.addVariable(expr);
                daqPanel.show();
            }
        }),

        vscode.commands.registerCommand('gdbDaq.addFromSymbol', (node: SymbolNode, nodes?: SymbolNode[]) => {
            const entries = symbolEntriesOf(node, nodes);
            if (entries.length === 0) {
                return;
            }
            for (const entry of entries) {
                daq.addVariable(watchExpressionFor(entry));
            }
            daqPanel.show();
        })
    );

    context.subscriptions.push(
        treeView, symbolsView, statusBar, exeStatusBar, attachStatusBar, model, tracker, poller, symbols, daq, daqPanel
    );
}

/** Collects the symbol entries for a command invoked on one or many tree nodes. */
function symbolEntriesOf(node: SymbolNode, nodes?: SymbolNode[]): SymbolEntry[] {
    const list = nodes && nodes.length ? nodes : node ? [node] : [];
    const out: SymbolEntry[] = [];
    const seen = new Set<string>();
    for (const n of list) {
        if (n?.kind === 'symbol' && !seen.has(n.entry.name)) {
            seen.add(n.entry.name);
            out.push(n.entry);
        }
    }
    return out;
}

function toCommandResultValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined || value === null) {
        return '';
    }
    return String(value);
}

function normalizeExpressionArg(arg: unknown): string {
    if (typeof arg === 'string') {
        return arg.trim();
    }
    if (arg && typeof arg === 'object' && 'expression' in arg) {
        const expression = (arg as { expression?: unknown }).expression;
        return typeof expression === 'string' ? expression.trim() : '';
    }
    return '';
}

function normalizeWriteArgs(arg: unknown): { expression: string; value: string | undefined } {
    if (arg && typeof arg === 'object') {
        const payload = arg as { expression?: unknown; value?: unknown };
        const expression = typeof payload.expression === 'string' ? payload.expression.trim() : '';
        if (payload.value === undefined || payload.value === null) {
            return { expression, value: undefined };
        }
        return { expression, value: String(payload.value) };
    }
    return { expression: '', value: undefined };
}

function formatEvaluateValue(value: string): string {
    const text = value.trim();

    if (!text) {
        return '""';
    }

    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith('\'') && text.endsWith('\'')) ||
        /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text) ||
        /^(true|false|null|None)$/i.test(text) ||
        ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))
    ) {
        return text;
    }

    return JSON.stringify(text);
}

/**
 * Opens the source file of a symbol at its declaration line. GDB reports
 * compile-time paths, which may not exist on this machine; fall back to
 * searching the workspace for a file with the same name.
 */
async function openSymbolLocation(entry: SymbolEntry): Promise<void> {
    if (!entry.file) {
        return;
    }
    let uri: vscode.Uri | undefined;
    try {
        const candidate = vscode.Uri.file(entry.file);
        await vscode.workspace.fs.stat(candidate);
        uri = candidate;
    } catch {
        const base = path.basename(entry.file.replace(/\\/g, '/'));
        const found = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 5);
        uri = found[0];
    }
    if (!uri) {
        void vscode.window.showWarningMessage(`GDB Symbols: source file not found: ${entry.file}`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (entry.line && entry.line > 0) {
        const pos = new vscode.Position(entry.line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}

export function deactivate(): void {
    // All resources are disposed via context.subscriptions.
}
