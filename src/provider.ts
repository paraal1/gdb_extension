import * as vscode from 'vscode';
import { AddRow, isAddRow, isGroup, LiveWatchModel, WatchGroup, WatchNode, WatchTreeNode } from './model';

export class LiveWatchTreeProvider implements vscode.TreeDataProvider<WatchTreeNode> {
    private readonly changeEmitter = new vscode.EventEmitter<WatchTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly model: LiveWatchModel) {
        model.onDidChange(() => this.changeEmitter.fire(undefined));
    }

    getTreeItem(node: WatchTreeNode): vscode.TreeItem {
        if (isAddRow(node)) {
            return this.addRowItem(node);
        }
        return isGroup(node) ? this.groupItem(node) : this.nodeItem(node);
    }

    private addRowItem(node: AddRow): vscode.TreeItem {
        const item = new vscode.TreeItem('Add expression\u2026', vscode.TreeItemCollapsibleState.None);
        item.id = `${node.group.id}::add`;
        item.iconPath = new vscode.ThemeIcon('add');
        item.contextValue = 'gdbLiveWatch.addRow';
        item.tooltip = `Add a new expression to ${node.group.name}`;
        item.command = {
            command: 'gdbLiveWatch.addExpressionToGroup',
            title: 'Add Expression',
            arguments: [node.group]
        };
        return item;
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
        item.description = node.value;
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

        // A single click only selects the item; the handler below detects a
        // second click on the same node (double click) and opens the value
        // editor. TreeView has no native double-click event, so we emulate it.
        item.command = {
            command: 'gdbLiveWatch.nodeClicked',
            title: 'Edit value',
            arguments: [node]
        };
        return item;
    }

    async getChildren(node?: WatchTreeNode): Promise<WatchTreeNode[]> {
        if (!node) {
            return [...this.model.groupList];
        }
        if (isGroup(node)) {
            // Trailing synthetic row gives a click target to add an expression
            // at the bottom of the group, where the eye is after scanning it.
            return [...node.roots, { kind: 'add', group: node } satisfies AddRow];
        }
        if (isAddRow(node)) {
            return [];
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
        if (isAddRow(node)) {
            return node.group;
        }
        return node.parent ?? node.group;
    }
}

/** MIME type used to carry dragged live-watch items within the tree. */
const LIVE_WATCH_MIME = 'application/vnd.code.tree.gdblivewatch';

/**
 * Enables drag & drop in the Live Watch tree: reorder root expressions up/down
 * within a group, drag them into another group, and reorder the groups
 * themselves. Struct/array children are not draggable (they mirror live data).
 */
export class LiveWatchDragAndDropController
    implements vscode.TreeDragAndDropController<WatchTreeNode>
{
    readonly dragMimeTypes = [LIVE_WATCH_MIME];
    readonly dropMimeTypes = [LIVE_WATCH_MIME];

    constructor(private readonly model: LiveWatchModel) {}

    handleDrag(
        source: readonly WatchTreeNode[],
        dataTransfer: vscode.DataTransfer
    ): void {
        // Only root expressions and groups can be moved; carry stable ids so
        // the drop handler can resolve the live model objects.
        const ids = source
            .filter((n): n is WatchGroup | WatchNode => isGroup(n) || (!isAddRow(n) && n.isRoot))
            .map((n) => n.id);
        if (ids.length === 0) {
            return;
        }
        dataTransfer.set(LIVE_WATCH_MIME, new vscode.DataTransferItem(ids));
    }

    handleDrop(
        target: WatchTreeNode | undefined,
        dataTransfer: vscode.DataTransfer
    ): void {
        const item = dataTransfer.get(LIVE_WATCH_MIME);
        if (!item) {
            return;
        }
        const ids: string[] = Array.isArray(item.value) ? item.value : [];
        const groups: WatchGroup[] = [];
        const roots: WatchNode[] = [];
        for (const id of ids) {
            const g = this.model.findGroupById(id);
            if (g) {
                groups.push(g);
                continue;
            }
            const n = this.model.findById(id);
            if (n?.isRoot) {
                roots.push(n);
            }
        }

        // Reordering groups takes precedence when a group is being dragged.
        if (groups.length > 0) {
            const beforeGroup = target
                ? isGroup(target)
                    ? target
                    : target.group
                : undefined;
            for (const g of groups) {
                this.model.moveGroup(g, beforeGroup);
            }
            return;
        }

        if (roots.length === 0) {
            return;
        }

        let targetGroup: WatchGroup | undefined;
        let before: WatchNode | undefined;
        if (!target) {
            const list = this.model.groupList;
            targetGroup = list[list.length - 1];
        } else if (isGroup(target)) {
            targetGroup = target;
        } else if (isAddRow(target)) {
            targetGroup = target.group;
        } else {
            const root = rootAncestor(target);
            targetGroup = root?.group;
            before = root;
        }

        if (targetGroup) {
            this.model.moveRoots(roots, targetGroup, before);
        }
    }
}

/** Walks up from any node to its owning root expression. */
function rootAncestor(node: WatchNode): WatchNode | undefined {
    let n: WatchNode | undefined = node;
    while (n && !n.isRoot) {
        n = n.parent;
    }
    return n ?? undefined;
}
