import * as vscode from 'vscode';
import { LiveWatchModel, WatchNode } from './model';
import { LiveWatchTreeProvider } from './provider';
import { Poller } from './poller';
import { DebugSessionTracker } from './tracker';

export function activate(context: vscode.ExtensionContext): void {
    const model = new LiveWatchModel(context.workspaceState);
    const tracker = new DebugSessionTracker();
    const poller = new Poller(model, tracker);
    const provider = new LiveWatchTreeProvider(model);

    const treeView = vscode.window.createTreeView('gdbLiveWatch', {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: false
    });

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

    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(() => {
            if (autoStart()) {
                poller.start();
            }
            updateStatusBar();
        }),
        vscode.debug.onDidTerminateDebugSession((s) => {
            poller.forgetSession(s.id);
            if (!vscode.debug.activeDebugSession) {
                poller.stop();
                model.invalidate();
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

    context.subscriptions.push(treeView, statusBar, model, tracker, poller);
}

export function deactivate(): void {
    // All resources are disposed via context.subscriptions.
}
