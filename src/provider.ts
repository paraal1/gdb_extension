import * as vscode from 'vscode';
import { LiveWatchModel, WatchNode } from './model';

export class LiveWatchTreeProvider implements vscode.TreeDataProvider<WatchNode> {
    private readonly changeEmitter = new vscode.EventEmitter<WatchNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly model: LiveWatchModel) {
        model.onDidChange(() => this.changeEmitter.fire(undefined));
    }

    getTreeItem(node: WatchNode): vscode.TreeItem {
        const expandable = node.variablesReference > 0;
        const state = !expandable
            ? vscode.TreeItemCollapsibleState.None
            : this.model.expandedIds.has(node.id)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;

        const item = new vscode.TreeItem(node.name, state);
        item.id = node.id;
        item.description = node.value;
        item.contextValue = node.isRoot ? 'gdbLiveWatch.expression' : 'gdbLiveWatch.variable';

        const lines = [`${node.expression || node.name} = ${node.value}`];
        if (node.type) {
            lines.push(`type: ${node.type}`);
        }
        item.tooltip = lines.join('\n');

        if (node.error) {
            item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        } else if (node.changed) {
            item.iconPath = new vscode.ThemeIcon(
                'circle-filled',
                new vscode.ThemeColor('charts.yellow')
            );
        } else {
            item.iconPath = new vscode.ThemeIcon('symbol-variable');
        }
        return item;
    }

    async getChildren(node?: WatchNode): Promise<WatchNode[]> {
        if (!node) {
            return [...this.model.expressions];
        }
        if (node.children) {
            return node.children;
        }
        // First expansion of a node: fetch its children on demand.
        const session = vscode.debug.activeDebugSession;
        if (!session || node.variablesReference <= 0) {
            return [];
        }
        return this.model.loadChildren(session, node);
    }

    getParent(node: WatchNode): WatchNode | undefined {
        return node.parent;
    }
}
