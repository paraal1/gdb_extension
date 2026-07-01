import * as vscode from 'vscode';

/** Per-expression numeric display format (overrides the global hex toggle). */
export type ValueFormat = 'natural' | 'dec' | 'hex' | 'bin' | 'oct';

/** Optional display options applied to a root expression's value. */
export interface DisplayOptions {
    format?: ValueFormat;
    /** Linear scaling applied to the numeric value: shown = raw * scale + offset. */
    scale?: number;
    offset?: number;
    /** Unit label appended to the displayed value (e.g. "rpm", "V"). */
    unit?: string;
}

export interface WatchNode {
    /** Stable id (root index + member path) so the tree keeps expansion state across refreshes. */
    id: string;
    /** Display name: the expression for roots, the member name for children. */
    name: string;
    /** Expression for roots; evaluateName (if any) for children. Used for "Copy Expression". */
    expression: string;
    value: string;
    /** Raw value as reported by GDB before per-expression formatting is applied. */
    rawValue?: string;
    type?: string;
    variablesReference: number;
    changed: boolean;
    error: boolean;
    isRoot: boolean;
    parent?: WatchNode;
    children?: WatchNode[];
    /** Per-expression display options (roots only). */
    display?: DisplayOptions;
    /** Owning group (roots only). */
    group?: WatchGroup;
}

/** A named, collapsible folder of watch expressions. */
export interface WatchGroup {
    id: string;
    name: string;
    roots: WatchNode[];
}

/**
 * Synthetic trailing row rendered at the bottom of every group. It is not part
 * of the data model; it only provides a large, always-visible click target to
 * add a new expression without having to reach the group's title-bar button.
 */
export interface AddRow {
    readonly kind: 'add';
    readonly group: WatchGroup;
}

export type WatchTreeNode = WatchGroup | WatchNode | AddRow;

export function isGroup(node: WatchTreeNode): node is WatchGroup {
    return (node as WatchGroup).roots !== undefined && (node as WatchNode).isRoot === undefined;
}

export function isAddRow(node: WatchTreeNode): node is AddRow {
    return (node as AddRow).kind === 'add';
}

/** Persisted shape of one watch expression. */
interface PersistedExpression {
    expression: string;
    display?: DisplayOptions;
}

interface PersistedGroup {
    id: string;
    name: string;
    expressions: PersistedExpression[];
}

const STORAGE_KEY = 'gdbLiveWatch.expressions';
const GROUPS_KEY = 'gdbLiveWatch.groups';
const DEFAULT_GROUP_NAME = 'Watch';

/** Outcome of a {@link LiveWatchModel.refresh} pass. */
export interface RefreshResult {
    /** Number of root expressions that were evaluated. */
    total: number;
    /** How many of them evaluated without error. */
    succeeded: number;
}

/**
 * Holds the watch expressions and refreshes their values through the
 * Debug Adapter Protocol ('evaluate' + 'variables' requests).
 */
export class LiveWatchModel implements vscode.Disposable {
    private groups: WatchGroup[] = [];
    private nextGroupId = 0;
    /** Node ids the user has expanded; their children are re-fetched on every refresh. */
    readonly expandedIds = new Set<string>();

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly workspaceState: vscode.Memento) {
        const savedGroups = workspaceState.get<PersistedGroup[] | undefined>(GROUPS_KEY);
        if (savedGroups && savedGroups.length) {
            for (const g of savedGroups) {
                const group = this.makeGroup(g.name, g.id);
                g.expressions.forEach((e, i) =>
                    group.roots.push(this.makeRoot(e.expression, group, i, e.display))
                );
                this.groups.push(group);
            }
        } else {
            // Migrate the legacy flat expression list into a single default group.
            const legacy = workspaceState.get<string[]>(STORAGE_KEY, []);
            const group = this.makeGroup(DEFAULT_GROUP_NAME);
            legacy.forEach((expr, i) => group.roots.push(this.makeRoot(expr, group, i)));
            this.groups.push(group);
        }
    }

    private makeGroup(name: string, id?: string): WatchGroup {
        const gid = id ?? `grp${this.nextGroupId++}`;
        // Keep the counter ahead of any restored ids.
        const n = Number(/^grp(\d+)$/.exec(gid)?.[1]);
        if (Number.isFinite(n) && n >= this.nextGroupId) {
            this.nextGroupId = n + 1;
        }
        return { id: gid, name, roots: [] };
    }

    private makeRoot(
        expression: string,
        group: WatchGroup,
        index: number,
        display?: DisplayOptions
    ): WatchNode {
        return {
            id: `${group.id}#${index}`,
            name: expression,
            expression,
            value: 'not available',
            variablesReference: 0,
            changed: false,
            error: false,
            isRoot: true,
            group,
            display
        };
    }

    private reindex(group: WatchGroup): void {
        group.roots.forEach((r, i) => (r.id = `${group.id}#${i}`));
    }

    private persist(): void {
        const data: PersistedGroup[] = this.groups.map((g) => ({
            id: g.id,
            name: g.name,
            expressions: g.roots.map((r) => ({ expression: r.expression, display: r.display }))
        }));
        void this.workspaceState.update(GROUPS_KEY, data);
    }

    get groupList(): readonly WatchGroup[] {
        return this.groups;
    }

    /** All root expressions across every group (used by the poller). */
    get allRoots(): WatchNode[] {
        return this.groups.flatMap((g) => g.roots);
    }

    /** Backwards-compatible alias for the flat root list. */
    get expressions(): readonly WatchNode[] {
        return this.allRoots;
    }

    get isEmpty(): boolean {
        return this.groups.every((g) => g.roots.length === 0);
    }

    private defaultGroup(): WatchGroup {
        if (this.groups.length === 0) {
            this.groups.push(this.makeGroup(DEFAULT_GROUP_NAME));
        }
        return this.groups[0];
    }

    addGroup(name: string): WatchGroup {
        const group = this.makeGroup(name);
        this.groups.push(group);
        this.persist();
        this.changeEmitter.fire();
        return group;
    }

    renameGroup(group: WatchGroup, name: string): void {
        group.name = name;
        this.persist();
        this.changeEmitter.fire();
    }

    removeGroup(group: WatchGroup): void {
        const idx = this.groups.indexOf(group);
        if (idx >= 0) {
            this.groups.splice(idx, 1);
            this.persist();
            this.changeEmitter.fire();
        }
    }

    addExpression(expression: string, group?: WatchGroup): void {
        const target = group ?? this.defaultGroup();
        target.roots.push(this.makeRoot(expression, target, target.roots.length));
        this.persist();
        this.changeEmitter.fire();
    }

    editExpression(node: WatchNode, expression: string): void {
        node.name = expression;
        node.expression = expression;
        node.value = 'not available';
        node.rawValue = undefined;
        node.variablesReference = 0;
        node.changed = false;
        node.error = false;
        node.children = undefined;
        this.persist();
        this.changeEmitter.fire();
    }

    setDisplayOptions(node: WatchNode, display: DisplayOptions | undefined): void {
        if (!node.isRoot) {
            return;
        }
        node.display = display;
        if (node.rawValue !== undefined) {
            node.value = this.applyDisplay(node, node.rawValue);
        }
        this.persist();
        this.changeEmitter.fire();
    }

    moveExpressionToGroup(node: WatchNode, group: WatchGroup): void {
        if (!node.isRoot || !node.group || node.group === group) {
            return;
        }
        const from = node.group;
        const idx = from.roots.indexOf(node);
        if (idx >= 0) {
            from.roots.splice(idx, 1);
            this.reindex(from);
        }
        node.group = group;
        group.roots.push(node);
        this.reindex(group);
        this.persist();
        this.changeEmitter.fire();
    }

    /** Finds a group by its stable id. */
    findGroupById(id: string): WatchGroup | undefined {
        return this.groups.find((g) => g.id === id);
    }

    /**
     * Moves one or more root expressions into a target group (drag & drop).
     * If {@link before} is given (and lives in the target group) the nodes are
     * inserted just before it; otherwise they are appended to the end. Used to
     * reorder expressions within a group and to move them between groups.
     */
    moveRoots(nodes: readonly WatchNode[], target: WatchGroup, before?: WatchNode): void {
        const roots = nodes.filter((n) => n.isRoot && n.group);
        if (roots.length === 0) {
            return;
        }
        // Detach every dragged node from its current group first so insertion
        // indices are computed against the post-removal layout.
        for (const n of roots) {
            const g = n.group!;
            const i = g.roots.indexOf(n);
            if (i >= 0) {
                g.roots.splice(i, 1);
            }
        }
        let insertAt = target.roots.length;
        if (before && before.group === target) {
            const bi = target.roots.indexOf(before);
            if (bi >= 0) {
                insertAt = bi;
            }
        }
        for (const n of roots) {
            n.group = target;
        }
        target.roots.splice(insertAt, 0, ...roots);
        // Reindex everything: removals/insertions shift the stable ids.
        for (const g of this.groups) {
            this.reindex(g);
        }
        this.persist();
        this.changeEmitter.fire();
    }

    /**
     * Reorders a group (drag & drop). If {@link before} is given the group is
     * placed just before it; otherwise it is moved to the end of the list.
     */
    moveGroup(group: WatchGroup, before?: WatchGroup): void {
        const cur = this.groups.indexOf(group);
        if (cur < 0 || group === before) {
            return;
        }
        this.groups.splice(cur, 1);
        let insertAt = this.groups.length;
        if (before) {
            const bi = this.groups.indexOf(before);
            if (bi >= 0) {
                insertAt = bi;
            }
        }
        this.groups.splice(insertAt, 0, group);
        this.persist();
        this.changeEmitter.fire();
    }

    removeExpression(node: WatchNode): void {
        const group = node.group;
        if (!group) {
            return;
        }
        const idx = group.roots.indexOf(node);
        if (idx >= 0) {
            group.roots.splice(idx, 1);
            // Reassign stable ids so expansion state doesn't bleed between entries.
            this.reindex(group);
            this.persist();
            this.changeEmitter.fire();
        }
    }

    removeAll(): void {
        for (const g of this.groups) {
            g.roots = [];
        }
        this.persist();
        this.changeEmitter.fire();
    }

    /** Serializes the current watch list (groups + expressions) for sharing. */
    exportList(): string {
        return JSON.stringify(
            {
                version: 1,
                groups: this.groups.map((g) => ({
                    name: g.name,
                    expressions: g.roots.map((r) => ({ expression: r.expression, display: r.display }))
                }))
            },
            undefined,
            2
        );
    }

    /** Replaces the watch list from a previously exported file. */
    importList(json: string): void {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed?.groups)) {
            throw new Error('not a valid watch list file');
        }
        this.groups = [];
        for (const g of parsed.groups) {
            const group = this.makeGroup(typeof g?.name === 'string' ? g.name : DEFAULT_GROUP_NAME);
            for (const e of g?.expressions ?? []) {
                if (typeof e?.expression === 'string' && e.expression.trim()) {
                    group.roots.push(
                        this.makeRoot(e.expression.trim(), group, group.roots.length, e.display)
                    );
                }
            }
            this.groups.push(group);
        }
        if (this.groups.length === 0) {
            this.groups.push(this.makeGroup(DEFAULT_GROUP_NAME));
        }
        this.persist();
        this.changeEmitter.fire();
    }

    /** Marks all values stale (used when a session ends). */
    invalidate(): void {
        const visit = (node: WatchNode) => {
            node.value = 'not available';
            node.rawValue = undefined;
            node.variablesReference = 0;
            node.changed = false;
            node.error = false;
            node.children = undefined;
        };
        this.allRoots.forEach(visit);
        this.changeEmitter.fire();
    }

    private valueFormat(): { hex: boolean } | undefined {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('hexFormat', false)
            ? { hex: true }
            : undefined;
    }

    private globalHex(): boolean {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('hexFormat', false);
    }

    /**
     * Applies a root's per-expression display options (and the global hex
     * toggle as a default) to a raw GDB value. Only pure numeric values are
     * reformatted; structs/strings/pointers-with-symbols are left untouched.
     */
    private applyDisplay(node: WatchNode, raw: string): string {
        const d = node.display;
        const unit = d?.unit ? ` ${d.unit}` : '';
        const num = simpleNumeric(raw);
        if (num === null) {
            return raw;
        }

        if (d && (typeof d.scale === 'number' || typeof d.offset === 'number')) {
            const scaled = num * (d.scale ?? 1) + (d.offset ?? 0);
            return `${formatScaled(scaled)}${unit}`;
        }

        const format: ValueFormat = d?.format ?? (this.globalHex() ? 'hex' : 'natural');
        if (format === 'natural') {
            return `${raw}${unit}`;
        }
        if (format === 'dec') {
            return `${num}${unit}`;
        }
        if (!Number.isInteger(num)) {
            // Non-decimal bases only make sense for integers.
            return `${num}${unit}`;
        }
        const base = format === 'hex' ? 16 : format === 'oct' ? 8 : 2;
        const prefix = format === 'hex' ? '0x' : format === 'oct' ? '0o' : '0b';
        const sign = num < 0 ? '-' : '';
        return `${sign}${prefix}${Math.abs(num).toString(base)}${unit}`;
    }

    private maxChildren(): number {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<number>('maxChildren', 100);
    }

    /**
     * Re-evaluates all root expressions (and children of expanded nodes).
     * @param frameId top stack frame when the target is stopped; undefined while running
     *                (global/static expressions only in that case).
     * @returns how many root expressions were evaluated and how many succeeded.
     */
    async refresh(session: vscode.DebugSession, frameId: number | undefined): Promise<RefreshResult> {
        const roots = this.allRoots;
        let succeeded = 0;

        for (const root of roots) {
            const oldValue = root.error ? undefined : root.value;
            try {
                // Roots are evaluated naturally and formatted locally so the
                // per-expression format (hex/bin/scale/unit) can be applied.
                const resp = await session.customRequest('evaluate', {
                    expression: root.expression,
                    frameId,
                    context: 'watch'
                });
                const raw = String(resp.result ?? '');
                root.rawValue = raw;
                root.value = this.applyDisplay(root, raw);
                root.type = resp.type;
                root.variablesReference = resp.variablesReference ?? 0;
                root.changed = oldValue !== undefined && oldValue !== root.value;
                root.error = false;
                succeeded++;
            } catch (e: any) {
                root.value = shortError(e);
                root.rawValue = undefined;
                root.type = undefined;
                root.variablesReference = 0;
                root.changed = false;
                root.error = true;
                root.children = undefined;
            }
        }

        if (succeeded > 0) {
            for (const root of roots) {
                await this.refreshExpanded(session, root);
            }
        }
        this.changeEmitter.fire();
        return { total: roots.length, succeeded };
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
        for (const root of this.allRoots) {
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

/**
 * Parses a value string that is *entirely* a single number (decimal, hex,
 * float, or boolean). Returns null for anything else (structs, pointers with
 * symbol suffixes, chars, strings) so those values are shown verbatim.
 */
function simpleNumeric(raw: string): number | null {
    const s = raw.trim();
    if (!s) {
        return null;
    }
    if (/^true$/i.test(s)) {
        return 1;
    }
    if (/^false$/i.test(s)) {
        return 0;
    }
    if (/^-?0x[0-9a-fA-F]+$/.test(s)) {
        return s.startsWith('-') ? -parseInt(s.slice(1), 16) : parseInt(s, 16);
    }
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
        return Number(s);
    }
    return null;
}

function formatScaled(x: number): string {
    if (!isFinite(x)) {
        return String(x);
    }
    if (Number.isInteger(x) && Math.abs(x) < 1e15) {
        return String(x);
    }
    return String(parseFloat(x.toPrecision(9)));
}
