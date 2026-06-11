import * as vscode from 'vscode';
import { DebugSessionTracker } from './tracker';
import { Poller } from './poller';

export type SymbolCategory = 'variables' | 'constants' | 'functions' | 'types';

export const SYMBOL_CATEGORIES: SymbolCategory[] = ['variables', 'constants', 'functions', 'types'];

export const CATEGORY_LABELS: Record<SymbolCategory, string> = {
    variables: 'Variables',
    constants: 'Constants',
    functions: 'Functions',
    types: 'Types'
};

export interface SymbolEntry {
    name: string;
    /** Full declaration as printed by GDB, e.g. "static const int table[4];". */
    declaration: string;
    category: SymbolCategory;
    /** Source file (compilation unit) the symbol belongs to, if debug info is available. */
    file?: string;
    line?: number;
    /** Set for symbols from the "Non-debugging symbols:" section. */
    address?: string;
    nonDebugging?: boolean;
}

/** Expression to use when adding a symbol to the watch panel. */
export function watchExpressionFor(entry: SymbolEntry): string {
    const fileScoped = vscode.workspace
        .getConfiguration('gdbSymbols')
        .get<boolean>('fileScopedExpressions', false);
    if (fileScoped && entry.file && entry.category !== 'types') {
        // GDB file-scope operator: 'file.c'::symbol - disambiguates statics
        // with the same name in different compilation units.
        return `'${entry.file}'::${entry.name}`;
    }
    return entry.name;
}

// ---------------------------------------------------------------------------
// Parsing of GDB "info variables" / "info functions" / "info types" output
// ---------------------------------------------------------------------------

type ListingKind = 'variables' | 'functions' | 'types';

const LISTING_HEADER =
    /All defined |All (?:variables|functions|types) matching |^File .+:$|Non-debugging symbols:/m;

export function looksLikeListing(text: string): boolean {
    return LISTING_HEADER.test(text);
}

export function parseSymbolListing(output: string, kind: ListingKind): SymbolEntry[] {
    const entries: SymbolEntry[] = [];
    let currentFile: string | undefined;
    let nonDebugging = false;

    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) {
            continue;
        }
        if (/^All defined /.test(line) || /^All (variables|functions|types) matching /.test(line)) {
            continue;
        }
        const fileMatch = line.match(/^File (.+):$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            nonDebugging = false;
            continue;
        }
        if (/^Non-debugging symbols:/.test(line)) {
            nonDebugging = true;
            currentFile = undefined;
            continue;
        }
        if (nonDebugging) {
            const m = line.match(/^(0x[0-9a-fA-F]+)\s+(\S+)/);
            if (m) {
                entries.push({
                    name: m[2],
                    declaration: m[2],
                    category: kind === 'functions' ? 'functions' : 'variables',
                    address: m[1],
                    nonDebugging: true
                });
            }
            continue;
        }

        // Declaration line, optionally prefixed with "NN:" (GDB >= 8.1).
        let decl = line;
        let lineNo: number | undefined;
        const numbered = line.match(/^(\d+):\s*(.*)$/);
        if (numbered) {
            lineNo = Number(numbered[1]);
            decl = numbered[2];
        }
        decl = decl.trim();
        if (!decl || !decl.endsWith(';')) {
            continue;
        }

        const name = extractName(decl, kind);
        if (!name) {
            continue;
        }
        const category: SymbolCategory =
            kind === 'variables' && /\bconst\b/.test(decl) ? 'constants' : kind;
        entries.push({ name, declaration: decl, category, file: currentFile, line: lineNo });
    }
    return entries;
}

function extractName(decl: string, kind: ListingKind): string | undefined {
    const s = decl.replace(/;\s*$/, '').trim();
    if (kind === 'functions') {
        return extractFunctionName(s);
    }
    if (kind === 'types') {
        return extractTypeName(s);
    }
    return extractDeclaratorName(s);
}

/** Name of the declared object in a C variable declaration (heuristic). */
function extractDeclaratorName(decl: string): string | undefined {
    let s = decl.replace(/=[^=].*$/, '').trim();
    // Pointer-to-function / pointer-to-array declarator: int (*name)(...) or int (*name)[N]
    const pf = s.match(/\(\s*\*+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (pf) {
        return pf[1];
    }
    s = s.replace(/\[[^\]]*\]/g, '').trim();
    const m = s.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return m?.[1];
}

function extractFunctionName(decl: string): string | undefined {
    // Pointer-to-function variable listed under functions: void (*cb)(int)
    const pf = decl.match(/\(\s*\*+\s*([A-Za-z_][\w:]*)\s*\)\s*\(/);
    if (pf) {
        return pf[1];
    }
    // First (possibly qualified) identifier directly before a parameter list.
    const m = decl.match(/([A-Za-z_~][A-Za-z0-9_:~]*)\s*\(/);
    return m?.[1];
}

function extractTypeName(decl: string): string | undefined {
    if (decl.startsWith('typedef')) {
        return extractDeclaratorName(decl);
    }
    const tagged = decl.match(/^(?:struct|union|enum|class)\s+([A-Za-z_][A-Za-z0-9_:<>]*)$/);
    if (tagged) {
        return tagged[1];
    }
    return decl.match(/([A-Za-z_][A-Za-z0-9_:<>]*)\s*$/)?.[1];
}

// ---------------------------------------------------------------------------
// Symbol service
// ---------------------------------------------------------------------------

/** Console-command wrappers to try, per adapter (cppdbg uses '-exec', others vary). */
const COMMAND_PREFIXES = ['-exec ', '', '`'];

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Loads the target's symbol table (variables, functions, constants, types)
 * through GDB console commands, similar to winIDEA's Symbol Browser.
 */
export class SymbolService implements vscode.Disposable {
    private readonly entries = new Map<SymbolCategory, SymbolEntry[]>();
    private readonly truncatedCategories = new Set<SymbolCategory>();
    /** Console-command prefix known to work, cached per session. */
    private readonly prefixCache = new Map<string, string>();

    /** GDB regular expression used to restrict the listings. */
    filter = '';
    loading = false;

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(
        private readonly tracker: DebugSessionTracker,
        private readonly poller: Poller
    ) {}

    get isEmpty(): boolean {
        for (const list of this.entries.values()) {
            if (list.length > 0) {
                return false;
            }
        }
        return true;
    }

    get hasData(): boolean {
        return this.entries.size > 0;
    }

    getCategory(category: SymbolCategory): readonly SymbolEntry[] {
        return this.entries.get(category) ?? [];
    }

    isTruncated(category: SymbolCategory): boolean {
        return this.truncatedCategories.has(category);
    }

    clear(): void {
        this.entries.clear();
        this.truncatedCategories.clear();
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        this.prefixCache.delete(sessionId);
    }

    async load(session: vscode.DebugSession): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        this.changeEmitter.fire();
        try {
            const arg = this.filter ? ` ${this.filter}` : '';
            const [vars, funcs, types] = await this.poller.runReadOperation(session, async () => {
                const v = await this.execConsole(session, `info variables${arg}`);
                const f = await this.execConsole(session, `info functions${arg}`);
                const t = await this.execConsole(session, `info types${arg}`);
                return [v, f, t];
            });

            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const max = Math.max(1, cfg.get<number>('maxSymbolsPerCategory', 2000));
            const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);

            let all = [
                ...parseSymbolListing(vars, 'variables'),
                ...parseSymbolListing(funcs, 'functions'),
                ...parseSymbolListing(types, 'types')
            ];
            if (!includeNonDebugging) {
                all = all.filter((e) => !e.nonDebugging);
            }

            this.entries.clear();
            this.truncatedCategories.clear();
            for (const category of SYMBOL_CATEGORIES) {
                const list = all
                    .filter((e) => e.category === category)
                    .sort((a, b) => a.name.localeCompare(b.name));
                if (list.length > max) {
                    this.truncatedCategories.add(category);
                    list.length = max;
                }
                this.entries.set(category, list);
            }
        } finally {
            this.loading = false;
            this.changeEmitter.fire();
        }
    }

    /**
     * Runs a GDB console command through the adapter's REPL and returns its
     * textual output. The output may arrive either as the evaluate response
     * (cortex-debug style) or as DAP 'output' events (cppdbg style).
     */
    private async execConsole(session: vscode.DebugSession, command: string): Promise<string> {
        const cached = this.prefixCache.get(session.id);
        const candidates =
            cached !== undefined
                ? [cached, ...COMMAND_PREFIXES.filter((p) => p !== cached)]
                : [...COMMAND_PREFIXES];

        let lastError: unknown;
        for (const prefix of candidates) {
            const expression = prefix === '`' ? `\`${command}\`` : `${prefix}${command}`;
            const capture = this.tracker.startOutputCapture(session.id);
            let responseText = '';
            try {
                const resp = await session.customRequest('evaluate', {
                    expression,
                    context: 'repl'
                });
                responseText = String(resp?.result ?? '');
            } catch (e) {
                lastError = e;
                capture.stop();
                continue;
            }

            let captured: string;
            if (looksLikeListing(responseText)) {
                captured = capture.stop();
            } else {
                // Output events may trail the response; wait until they settle.
                let prevLen = -1;
                for (let i = 0; i < 20; i++) {
                    await delay(150);
                    const len = capture.peek().length;
                    if (len === prevLen && (len > 0 || i >= 2)) {
                        break;
                    }
                    prevLen = len;
                }
                captured = capture.stop();
            }

            const text = looksLikeListing(responseText)
                ? responseText
                : looksLikeListing(captured)
                    ? captured
                    : '';
            if (text) {
                this.prefixCache.set(session.id, prefix);
                return text;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`'${command}' returned no symbol listing (adapter not supported?)`);
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
