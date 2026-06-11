import * as vscode from 'vscode';
import * as path from 'path';
import {
    CATEGORY_LABELS,
    SYMBOL_CATEGORIES,
    SymbolCategory,
    SymbolEntry,
    SymbolService
} from './symbols';

export type SymbolNode =
    | { kind: 'category'; category: SymbolCategory }
    | { kind: 'file'; category: SymbolCategory; file: string; entries: SymbolEntry[] }
    | { kind: 'symbol'; entry: SymbolEntry };

const NO_FILE = '(no source file)';

const CATEGORY_ICONS: Record<SymbolCategory, string> = {
    variables: 'symbol-variable',
    constants: 'symbol-constant',
    functions: 'symbol-function',
    types: 'symbol-structure'
};

/**
 * Symbol browser tree: Category -> Source file (module) -> Symbol.
 * Mirrors winIDEA's Symbol Browser window.
 */
export class SymbolTreeProvider implements vscode.TreeDataProvider<SymbolNode> {
    private readonly changeEmitter = new vscode.EventEmitter<SymbolNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly service: SymbolService) {
        service.onDidChange(() => this.changeEmitter.fire(undefined));
    }

    getTreeItem(node: SymbolNode): vscode.TreeItem {
        switch (node.kind) {
            case 'category':
                return this.categoryItem(node.category);
            case 'file':
                return this.fileItem(node);
            case 'symbol':
                return this.symbolItem(node.entry);
        }
    }

    /**
     * VS Code preserves expansion state per item id. While a filter is active
     * the ids are suffixed with it, so every filter change yields "new" nodes
     * that pick up the expanded-by-default state and reveal the matches.
     */
    private idSuffix(): string {
        return this.service.filter ? `?${this.service.filter}` : '';
    }

    private categoryItem(category: SymbolCategory): vscode.TreeItem {
        const count = this.service.getCategory(category).length;
        const filtered = !!this.service.filter;
        const item = new vscode.TreeItem(
            CATEGORY_LABELS[category],
            count === 0
                ? vscode.TreeItemCollapsibleState.None
                : filtered
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `cat:${category}${this.idSuffix()}`;
        item.description = this.service.isTruncated(category) ? `${count}+ (truncated)` : `${count}`;
        item.iconPath = new vscode.ThemeIcon(CATEGORY_ICONS[category]);
        item.contextValue = 'gdbSymbols.category';
        return item;
    }

    private fileItem(node: SymbolNode & { kind: 'file' }): vscode.TreeItem {
        const isReal = node.file !== NO_FILE;
        const base = isReal ? path.basename(node.file) : node.file;
        const item = new vscode.TreeItem(
            base,
            this.service.filter
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `file:${node.category}:${node.file}${this.idSuffix()}`;
        const dir = isReal ? path.dirname(node.file) : '';
        item.description = `${node.entries.length}${dir && dir !== '.' ? ` - ${dir}` : ''}`;
        item.iconPath = vscode.ThemeIcon.File;
        item.resourceUri = isReal ? vscode.Uri.file(node.file) : undefined;
        item.contextValue = 'gdbSymbols.file';
        item.tooltip = isReal ? node.file : 'Symbols without debug information';
        return item;
    }

    private symbolItem(entry: SymbolEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(CATEGORY_ICONS[entry.category]);
        item.description = entry.nonDebugging ? entry.address : entry.declaration;

        const lines = [entry.declaration];
        if (entry.file) {
            lines.push(`${entry.file}${entry.line ? `:${entry.line}` : ''}`);
        }
        if (entry.address) {
            lines.push(`address: ${entry.address}`);
        }
        lines.push(`category: ${CATEGORY_LABELS[entry.category]}`);
        item.tooltip = lines.join('\n');

        const locatable = !!entry.file;
        item.contextValue = locatable ? 'gdbSymbols.symbolWithLocation' : 'gdbSymbols.symbol';
        if (locatable) {
            item.command = {
                command: 'gdbSymbols.goTo',
                title: 'Go to Definition',
                arguments: [{ kind: 'symbol', entry } satisfies SymbolNode]
            };
        }
        return item;
    }

    getChildren(node?: SymbolNode): SymbolNode[] {
        if (!node) {
            if (!this.service.hasData) {
                return [];
            }
            return SYMBOL_CATEGORIES.map((category) => ({ kind: 'category', category }));
        }
        if (node.kind === 'category') {
            return this.groupByFile(node.category);
        }
        if (node.kind === 'file') {
            return node.entries.map((entry) => ({ kind: 'symbol', entry }));
        }
        return [];
    }

    private groupByFile(category: SymbolCategory): SymbolNode[] {
        const groups = new Map<string, SymbolEntry[]>();
        for (const entry of this.service.getCategory(category)) {
            const key = entry.file ?? NO_FILE;
            let list = groups.get(key);
            if (!list) {
                list = [];
                groups.set(key, list);
            }
            list.push(entry);
        }
        return [...groups.entries()]
            .sort(([a], [b]) => {
                if (a === NO_FILE) {
                    return 1;
                }
                if (b === NO_FILE) {
                    return -1;
                }
                return path.basename(a).localeCompare(path.basename(b));
            })
            .map(([file, entries]) => ({ kind: 'file', category, file, entries }));
    }
}
