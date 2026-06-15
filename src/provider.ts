import * as vscode from 'vscode';
import { isGroup, LiveWatchModel, WatchGroup, WatchNode, WatchTreeNode } from './model';

/** Unicode block characters for the inline value sparkline. */
const SPARK_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

export class LiveWatchTreeProvider implements vscode.TreeDataProvider<WatchTreeNode> {
    private readonly changeEmitter = new vscode.EventEmitter<WatchTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly model: LiveWatchModel) {
        model.onDidChange(() => this.changeEmitter.fire(undefined));
    }

    getTreeItem(node: WatchTreeNode): vscode.TreeItem {
        return isGroup(node) ? this.groupItem(node) : this.nodeItem(node);
    }

    private groupItem(group: WatchGroup): vscode.TreeItem {
        const item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = group.id;
        item.contextValue = 'gdbLiveWatch.group';
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = `${group.roots.length}`;
        return item;
    }

    private nodeItem(node: WatchNode): vscode.TreeItem {
        const expandable = node.variablesReference > 0;
        const state = !expandable
            ? vscode.TreeItemCollapsibleState.None
            : this.model.expandedIds.has(node.id)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;

        const item = new vscode.TreeItem(node.name, state);
        item.id = node.id;
        const spark = this.sparkline(node);
        item.description = spark ? `${node.value}  ${spark}` : node.value;
        item.contextValue = node.isRoot ? 'gdbLiveWatch.expression' : 'gdbLiveWatch.variable';

        const lines = [`${node.expression || node.name} = ${node.value}`];
        if (node.rawValue !== undefined && node.rawValue !== node.value) {
            lines.push(`raw: ${node.rawValue}`);
        }
        if (node.type) {
            lines.push(`type: ${node.type}`);
        }
        if (node.isRoot && node.display) {
            const d = node.display;
            const parts: string[] = [];
            if (d.format && d.format !== 'natural') { parts.push(d.format); }
            if (typeof d.scale === 'number') { parts.push(`scale ${d.scale}`); }
            if (typeof d.offset === 'number') { parts.push(`offset ${d.offset}`); }
            if (d.unit) { parts.push(`unit ${d.unit}`); }
            if (parts.length) { lines.push(`format: ${parts.join(', ')}`); }
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

    /** Compact unicode trend of the last few numeric samples (roots only). */
    private sparkline(node: WatchNode): string {
        if (!node.isRoot || node.error || !node.history || node.history.length < 2) {
            return '';
        }
        const enabled = vscode.workspace
            .getConfiguration('gdbLiveWatch')
            .get<boolean>('sparklines', true);
        if (!enabled) {
            return '';
        }
        const h = node.history;
        let min = Infinity;
        let max = -Infinity;
        for (const v of h) {
            if (v < min) { min = v; }
            if (v > max) { max = v; }
        }
        const span = max - min;
        return h
            .map((v) => {
                const idx = span > 0 ? Math.round(((v - min) / span) * (SPARK_CHARS.length - 1)) : 0;
                return SPARK_CHARS[idx];
            })
            .join('');
    }

    async getChildren(node?: WatchTreeNode): Promise<WatchTreeNode[]> {
        if (!node) {
            return [...this.model.groupList];
        }
        if (isGroup(node)) {
            return [...node.roots];
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

    getParent(node: WatchTreeNode): WatchTreeNode | undefined {
        if (isGroup(node)) {
            return undefined;
        }
        return node.parent ?? node.group;
    }
}
