import * as vscode from 'vscode';
import * as path from 'path';
import { LiveWatchModel, WatchNode } from './model';
import { LiveWatchTreeProvider } from './provider';
import { Poller } from './poller';
import { DebugSessionTracker } from './tracker';
import { SymbolEntry, SymbolService, watchExpressionFor } from './symbols';
import { SymbolNode, SymbolTreeProvider } from './symbolsProvider';
import { DaqEngine } from './daq';
import { DaqPanelManager } from './daqPanel';

export function activate(context: vscode.ExtensionContext): void {
    const model = new LiveWatchModel(context.workspaceState);
    const tracker = new DebugSessionTracker();
    const poller = new Poller(model, tracker);
    const provider = new LiveWatchTreeProvider(model);
    const symbols = new SymbolService(tracker, poller);
    const symbolsProvider = new SymbolTreeProvider(symbols);
    const daq = new DaqEngine(context.workspaceState, poller);
    const daqPanel = new DaqPanelManager(context, daq);

    const treeView = vscode.window.createTreeView('gdbLiveWatch', {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: false
    });

    const symbolsView = vscode.window.createTreeView('gdbSymbols', {
        treeDataProvider: symbolsProvider,
        showCollapseAll: true,
        canSelectMany: false
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
        model.expandedIds.add(e.element.id);
    });
    treeView.onDidCollapseElement((e) => {
        model.expandedIds.delete(e.element.id);
    });

    // ---- status bar ------------------------------------------------------
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'gdbLiveWatch.togglePolling';
    const updateStatusBar = () => {
        if (!vscode.debug.activeDebugSession) {
            statusBar.hide();
            return;
        }
        const interval = vscode.workspace
            .getConfiguration('gdbLiveWatch')
            .get<number>('pollingInterval', 1000);
        statusBar.text = poller.polling ? `$(pulse) Live Watch ${interval}ms` : '$(pulse) Live Watch off';
        statusBar.tooltip = poller.polling
            ? 'GDB Live Watch: polling active (click to stop)'
            : 'GDB Live Watch: polling stopped (click to start)';
        statusBar.show();
    };

    const setPollingContext = () =>
        void vscode.commands.executeCommand('setContext', 'gdbLiveWatch.polling', poller.polling);

    poller.onDidChangePolling(() => {
        setPollingContext();
        updateStatusBar();
    });
    setPollingContext();
    updateStatusBar();

    // ---- session lifecycle ----------------------------------------------
    const autoStart = () =>
        vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('autoStartPolling', true);

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
            if (autoStart()) {
                poller.start();
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
                poller.stop();
                model.invalidate();
                symbols.clear();
                daq.stop();
            }
            updateStatusBar();
        }),
        // Immediate refresh whenever the target stops (breakpoint, step, ...).
        tracker.onDidChangeState((session) => {
            if (
                session === vscode.debug.activeDebugSession &&
                tracker.getState(session.id) === 'stopped' &&
                poller.polling
            ) {
                void poller.tick();
            }
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gdbLiveWatch.pollingInterval')) {
                poller.restartIfPolling();
                updateStatusBar();
            }
            if (
                e.affectsConfiguration('gdbSymbols.maxSymbolsPerCategory') ||
                e.affectsConfiguration('gdbSymbols.includeNonDebugging')
            ) {
                // View settings only affect the cached table's presentation.
                symbols.refreshView();
            }
        })
    );

    // ---- commands ---------------------------------------------------------
    const addExpression = async (initial?: string) => {
        const expression = await vscode.window.showInputBox({
            prompt: 'Expression to watch (evaluated by GDB)',
            placeHolder: 'e.g. myStruct.counter, *ptr, array[3], (int)flags & 0xFF',
            value: initial
        });
        if (expression?.trim()) {
            model.addExpression(expression.trim());
            void poller.tick();
        }
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
            // If nothing is cached yet (e.g. auto-load disabled), load once now.
            if (!symbols.hasData && vscode.debug.activeDebugSession) {
                await loadSymbols(false);
            }

            // Live filter: every keystroke narrows the symbol tree immediately.
            const previous = symbols.filter;
            const input = vscode.window.createInputBox();
            input.title = 'Filter Symbols (live)';
            input.prompt =
                'Type to filter symbol names as you type (substring or regular expression). Enter keeps the filter, Esc restores the previous one.';
            input.placeholder = 'e.g. Something, ^motor_, Adc.*Init';
            input.value = previous;

            let debounce: ReturnType<typeof setTimeout> | undefined;
            let accepted = false;
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
                if (debounce) {
                    clearTimeout(debounce);
                }
                symbols.filter = input.value.trim();
                input.hide();
            });
            input.onDidHide(() => {
                if (debounce) {
                    clearTimeout(debounce);
                }
                if (!accepted) {
                    symbols.filter = previous;
                }
                input.dispose();
            });
            input.show();
        }),

        vscode.commands.registerCommand('gdbSymbols.clearFilter', () => {
            symbols.filter = '';
        }),

        vscode.commands.registerCommand('gdbSymbols.addToLiveWatch', (node: SymbolNode) => {
            if (node?.kind !== 'symbol') {
                return;
            }
            model.addExpression(watchExpressionFor(node.entry));
            void poller.tick();
            // Bring the live watch panel into view, like winIDEA's double-click-to-watch.
            void vscode.commands.executeCommand('gdbLiveWatch.focus');
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
        })
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

        vscode.commands.registerCommand('gdbDaq.addFromSymbol', (node: SymbolNode) => {
            if (node?.kind === 'symbol') {
                daq.addVariable(watchExpressionFor(node.entry));
                daqPanel.show();
            }
        })
    );

    context.subscriptions.push(
        treeView, symbolsView, statusBar, model, tracker, poller, symbols, daq, daqPanel
    );
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
