import * as vscode from 'vscode';

export interface WatchNode {
    /** Stable id (root index + member path) so the tree keeps expansion state across refreshes. */
    id: string;
    /** Display name: the expression for roots, the member name for children. */
    name: string;
    /** Expression for roots; evaluateName (if any) for children. Used for "Copy Expression". */
    expression: string;
    value: string;
    type?: string;
    variablesReference: number;
    changed: boolean;
    error: boolean;
    isRoot: boolean;
    parent?: WatchNode;
    children?: WatchNode[];
}

const STORAGE_KEY = 'gdbLiveWatch.expressions';

/**
 * Holds the watch expressions and refreshes their values through the
 * Debug Adapter Protocol ('evaluate' + 'variables' requests).
 */
export class LiveWatchModel implements vscode.Disposable {
    private roots: WatchNode[] = [];
    /** Node ids the user has expanded; their children are re-fetched on every refresh. */
    readonly expandedIds = new Set<string>();

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly workspaceState: vscode.Memento) {
        const saved = workspaceState.get<string[]>(STORAGE_KEY, []);
        saved.forEach((expr, i) => this.roots.push(this.makeRoot(expr, i)));
    }

    private makeRoot(expression: string, index: number): WatchNode {
        return {
            id: `root#${index}`,
            name: expression,
            expression,
            value: 'not available',
            variablesReference: 0,
            changed: false,
            error: false,
            isRoot: true
        };
    }

    private persist(): void {
        void this.workspaceState.update(STORAGE_KEY, this.roots.map((r) => r.expression));
    }

    get expressions(): readonly WatchNode[] {
        return this.roots;
    }

    get isEmpty(): boolean {
        return this.roots.length === 0;
    }

    addExpression(expression: string): void {
        this.roots.push(this.makeRoot(expression, this.roots.length));
        this.persist();
        this.changeEmitter.fire();
    }

    editExpression(node: WatchNode, expression: string): void {
        node.name = expression;
        node.expression = expression;
        node.value = 'not available';
        node.variablesReference = 0;
        node.changed = false;
        node.error = false;
        node.children = undefined;
        this.persist();
        this.changeEmitter.fire();
    }

    removeExpression(node: WatchNode): void {
        const idx = this.roots.indexOf(node);
        if (idx >= 0) {
            this.roots.splice(idx, 1);
            // Reassign stable ids so expansion state doesn't bleed between entries.
            this.roots.forEach((r, i) => (r.id = `root#${i}`));
            this.persist();
            this.changeEmitter.fire();
        }
    }

    removeAll(): void {
        this.roots = [];
        this.persist();
        this.changeEmitter.fire();
    }

    /** Marks all values stale (used when a session ends). */
    invalidate(): void {
        const visit = (node: WatchNode) => {
            node.value = 'not available';
            node.variablesReference = 0;
            node.changed = false;
            node.error = false;
            node.children = undefined;
        };
        this.roots.forEach(visit);
        this.changeEmitter.fire();
    }

    private valueFormat(): { hex: boolean } | undefined {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('hexFormat', false)
            ? { hex: true }
            : undefined;
    }

    private maxChildren(): number {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<number>('maxChildren', 100);
    }

    /**
     * Re-evaluates all root expressions (and children of expanded nodes).
     * @param frameId top stack frame when the target is stopped; undefined while running
     *                (global/static expressions only in that case).
     * @returns true if at least one expression evaluated successfully.
     */
    async refresh(session: vscode.DebugSession, frameId: number | undefined): Promise<boolean> {
        const format = this.valueFormat();
        let anySuccess = false;

        for (const root of this.roots) {
            const oldValue = root.error ? undefined : root.value;
            try {
                const resp = await session.customRequest('evaluate', {
                    expression: root.expression,
                    frameId,
                    context: 'watch',
                    format
                });
                root.value = String(resp.result ?? '');
                root.type = resp.type;
                root.variablesReference = resp.variablesReference ?? 0;
                root.changed = oldValue !== undefined && oldValue !== root.value;
                root.error = false;
                anySuccess = true;
            } catch (e: any) {
                root.value = shortError(e);
                root.type = undefined;
                root.variablesReference = 0;
                root.changed = false;
                root.error = true;
                root.children = undefined;
            }
        }

        if (anySuccess) {
            for (const root of this.roots) {
                await this.refreshExpanded(session, root);
            }
        }
        this.changeEmitter.fire();
        return anySuccess;
    }

    private async refreshExpanded(session: vscode.DebugSession, node: WatchNode): Promise<void> {
        if (!this.expandedIds.has(node.id) || node.variablesReference <= 0) {
            if (!this.expandedIds.has(node.id)) {
                node.children = undefined;
            }
            return;
        }
        await this.loadChildren(session, node);
        for (const child of node.children ?? []) {
            await this.refreshExpanded(session, child);
        }
    }

    /** Finds a node by its stable id anywhere in the tree (roots and loaded children). */
    findById(id: string): WatchNode | undefined {
        const visit = (n: WatchNode): WatchNode | undefined => {
            if (n.id === id) {
                return n;
            }
            for (const c of n.children ?? []) {
                const found = visit(c);
                if (found) {
                    return found;
                }
            }
            return undefined;
        };
        for (const root of this.roots) {
            const found = visit(root);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Writes a new value to a variable. Tries, in order:
     *  1. DAP 'setExpression' on the node's expression / evaluateName,
     *  2. a GDB assignment evaluated through the console ("expr = value"),
     *  3. DAP 'setVariable' on the parent container (for children without an evaluateName).
     * Throws if the variable cannot be modified.
     */
    async setValue(
        session: vscode.DebugSession,
        node: WatchNode,
        value: string,
        frameId: number | undefined
    ): Promise<void> {
        const format = this.valueFormat();
        const expr = node.expression;
        let result: { value?: string; variablesReference?: number } | undefined;

        if (expr) {
            try {
                result = await session.customRequest('setExpression', {
                    expression: expr,
                    value,
                    frameId,
                    format
                });
            } catch {
                // Adapter does not support setExpression (or rejected it):
                // let GDB perform the assignment as a plain expression.
                const r = await session.customRequest('evaluate', {
                    expression: `${expr} = ${value}`,
                    frameId,
                    context: 'repl',
                    format
                });
                result = { value: r.result, variablesReference: r.variablesReference };
            }
        } else if (node.parent && node.parent.variablesReference > 0) {
            result = await session.customRequest('setVariable', {
                variablesReference: node.parent.variablesReference,
                name: node.name,
                value,
                format
            });
        } else {
            throw new Error('This variable cannot be modified');
        }

        if (result?.value !== undefined) {
            node.value = String(result.value);
            node.changed = true;
            node.error = false;
            this.changeEmitter.fire();
        }
    }

    /** Fetches (or re-fetches) the children of a node via the 'variables' request. */
    async loadChildren(session: vscode.DebugSession, node: WatchNode): Promise<WatchNode[]> {
        if (node.variablesReference <= 0) {
            node.children = [];
            return node.children;
        }
        const oldByName = new Map<string, string>();
        for (const c of node.children ?? []) {
            if (!c.error) {
                oldByName.set(c.name, c.value);
            }
        }
        try {
            const resp = await session.customRequest('variables', {
                variablesReference: node.variablesReference,
                format: this.valueFormat()
            });
            const vars: any[] = (resp.variables ?? []).slice(0, this.maxChildren());
            node.children = vars.map((v) => {
                const old = oldByName.get(String(v.name));
                const value = String(v.value ?? '');
                return {
                    id: `${node.id}/${v.name}`,
                    name: String(v.name),
                    expression: v.evaluateName ?? '',
                    value,
                    type: v.type,
                    variablesReference: v.variablesReference ?? 0,
                    changed: old !== undefined && old !== value,
                    error: false,
                    isRoot: false,
                    parent: node
                };
            });
        } catch {
            node.children = [];
        }
        return node.children;
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}

function shortError(e: any): string {
    const msg = String(e?.message ?? e ?? 'evaluation failed');
    // GDB/MI errors can be long and multi-line; keep the first line.
    return msg.split('\n')[0].trim();
}
