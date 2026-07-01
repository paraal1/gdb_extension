import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { DebugSessionTracker } from './tracker';
import { Poller } from './poller';

export type SymbolCategory = 'variables' | 'constants' | 'functions' | 'types';

export const SYMBOL_CATEGORIES: SymbolCategory[] = ['variables', 'functions'];

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

/**
 * True when a path points inside a dSPACE toolchain folder (VEOS, etc.). Used to
 * single out the dSPACE model modules (the .dll/.vap that actually carry the
 * release-specific debug symbols) from the many system DLLs a host process loads.
 */
export function isDspacePath(p: string | undefined): boolean {
    return !!p && /[\\/]dspace[\\/]/i.test(p);
}

/**
 * Derives the dSPACE model name (e.g. "MB_ZC_Rear_vECU") from a set of loaded
 * modules by picking the dSPACE-folder module that carries the symbols. A `.dll`
 * under the dSPACE tree is preferred; a `.vap` is used as a fallback. Returns the
 * basename without extension, or undefined when no dSPACE module is present.
 */
export function dspaceModelName(
    modules: Array<{ name?: string; path?: string }>
): string | undefined {
    const dspace = modules.filter((m) => isDspacePath(m.path) || isDspacePath(m.name));
    const pick =
        dspace.find((m) => /\.dll$/i.test(m.path ?? m.name ?? '')) ??
        dspace.find((m) => /\.vap$/i.test(m.path ?? m.name ?? '')) ??
        dspace[0];
    const source = pick?.path ?? pick?.name;
    if (!source) {
        return undefined;
    }
    const base = source.split(/[\\/]/).pop() ?? source;
    return base.replace(/\.[^.]+$/, '');
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

export function parseSymbolListing(
    output: string,
    kind: ListingKind,
    options?: { skipNonDebugging?: boolean; fileFilter?: (file: string) => boolean }
): SymbolEntry[] {
    const entries: SymbolEntry[] = [];
    let currentFile: string | undefined;
    let currentFileIncluded = true;
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
            // Decide once per source file whether its symbols are kept, so the
            // (often huge) body of an excluded file is skipped cheaply line by
            // line instead of building entries we would discard later.
            currentFileIncluded = options?.fileFilter ? options.fileFilter(currentFile) : true;
            nonDebugging = false;
            continue;
        }
        if (/^Non-debugging symbols:/.test(line)) {
            // This section is always last in the listing. When the user does not
            // want non-debugging symbols, stop parsing here entirely instead of
            // scanning (and later discarding) potentially thousands of lines.
            // A source-path filter also excludes these (they have no file).
            if (options?.skipNonDebugging || options?.fileFilter) {
                break;
            }
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

        // Skip the entire body of a source file that the path filter excluded.
        if (!currentFileIncluded) {
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
        entries.push({ name, declaration: decl, category: kind, file: currentFile, line: lineNo });
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
 * Memo of content hashes for the binaries that make up the cache signature,
 * keyed by path and invalidated on any size/mtime change. Release binaries
 * (host exe + model DLLs with debug info) can be hundreds of MB, and the
 * signature is recomputed on every symbol load - without the memo each load
 * re-read and re-hashed all of them, which alone took seconds. The identity is
 * still a *content* hash (computed on first sight of the file), so a swapped
 * release is always detected; size+mtime only decide whether the previously
 * computed hash may be reused for the byte-identical file.
 */
const fileHashMemo = new Map<string, { size: number; mtimeMs: number; hash: string }>();

/**
 * SHA1 of a file's contents, streamed from disk (never buffers the whole
 * binary in memory) and memoized (see {@link fileHashMemo}). Throws when the
 * file cannot be read; callers decide their own fallback.
 */
async function hashFileContents(filePath: string): Promise<{ size: number; hash: string }> {
    const stat = await fs.promises.stat(filePath);
    const memo = fileHashMemo.get(filePath);
    if (memo && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs) {
        return { size: memo.size, hash: memo.hash };
    }
    const hash = await new Promise<string>((resolve, reject) => {
        const hasher = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hasher.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hasher.digest('hex')));
    });
    fileHashMemo.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
    return { size: stat.size, hash };
}

/** Single term matcher: regex if valid, case-insensitive substring otherwise. */
function makeTermMatcher(term: string): (name: string) => boolean {
    try {
        const re = new RegExp(term, 'i');
        return (name) => re.test(name);
    } catch {
        const needle = term.toLowerCase();
        return (name) => name.toLowerCase().includes(needle);
    }
}

/**
 * Builds a name matcher from the user filter: regex if valid, substring otherwise.
 *
 * A trailing call suffix is tolerated so a function can be located by pasting its
 * call/signature, e.g. "Rte_Read_R_FS2()" or "Rte_Read_R_FS2(void)" both match the
 * stored symbol name "Rte_Read_R_FS2". The original filter is still tried as well,
 * so deliberate regex groups like "(foo|bar)" keep working.
 */
function makeMatcher(filter: string): (name: string) => boolean {
    if (!filter) {
        return () => true;
    }
    const matchers = [makeTermMatcher(filter)];
    const stripped = filter.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped && stripped !== filter) {
        matchers.push(makeTermMatcher(stripped));
    }
    return (name) => matchers.some((m) => m(name));
}

function escapeGdbRegexLiteral(value: string): string {
    return value.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&');
}

/**
 * Builds the regexp passed to GDB's `info variables/functions REGEXP` form.
 * For plain symbol names and pasted declarations/calls, use a literal symbol
 * token so GDB can reduce the listing at the source. For explicit regex-looking
 * filters, keep the user's expression and let the local matcher apply the final
 * semantics after GDB has returned the narrower candidate set.
 */
function makeGdbNameRegexp(filter: string): string | undefined {
    const strippedCall = filter.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const candidate = strippedCall || filter.trim();
    if (!candidate || /[\r\n]/.test(candidate)) {
        return undefined;
    }

    const hasRegexMeta = /[\\.^$*+?()[\]{}|]/.test(candidate);
    if (hasRegexMeta) {
        try {
            new RegExp(candidate);
            return candidate;
        } catch {
            return escapeGdbRegexLiteral(candidate);
        }
    }

    const identifiers = candidate.match(/[A-Za-z_~][A-Za-z0-9_:~]*/g);
    const token = identifiers?.[identifiers.length - 1] ?? candidate;
    return escapeGdbRegexLiteral(token);
}

/**
 * Builds a matcher for the user's source-path filter (`gdbSymbols.sourcePathFilter`).
 * A symbol's source file passes when it matches any configured pattern; each
 * pattern is tried as a regular expression and, if that fails to compile, as a
 * case-insensitive substring. Path separators are normalised so a pattern using
 * "/" also matches Windows "\\" paths (and vice versa). Returns undefined when no
 * (non-empty) pattern is configured, meaning "no filtering".
 */
function makeSourcePathFilter(
    patterns: string[] | undefined
): ((file: string) => boolean) | undefined {
    const terms = (patterns ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
    if (terms.length === 0) {
        return undefined;
    }
    const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
    const matchers = terms.map((term) => {
        const normTerm = term.replace(/\\\\/g, '/').replace(/\\/g, '/');
        try {
            const re = new RegExp(normTerm, 'i');
            return (file: string) => re.test(norm(file));
        } catch {
            const needle = norm(normTerm);
            return (file: string) => norm(file).includes(needle);
        }
    });
    return (file) => matchers.some((m) => m(file));
}

/**
 * Combines the include (`sourcePathFilter`) and exclude (`sourcePathExclude`)
 * path patterns into a single per-file predicate: a source file is kept when it
 * matches an include pattern (or no include patterns are set) *and* matches no
 * exclude pattern. Returns undefined when neither list has any pattern, meaning
 * "no filtering".
 */
function makeSourceFileMatcher(
    include: string[] | undefined,
    exclude: string[] | undefined
): ((file: string) => boolean) | undefined {
    const inc = makeSourcePathFilter(include);
    const exc = makeSourcePathFilter(exclude);
    if (!inc && !exc) {
        return undefined;
    }
    return (file) => (!inc || inc(file)) && !(exc && exc(file));
}

/**
 * Builds the implicit "scope to the dSPACE model" predicate used when the user
 * has not configured an explicit include filter. A source file is considered
 * part of the model when it lives under a dSPACE toolchain tree, or when its
 * path contains the detected model name (e.g. "MB_ZC_Rear_vECU") — the same
 * module winIDEA would point its single symbol file at. Returns undefined when
 * there is nothing to scope by (no model name and, therefore, only the generic
 * dSPACE-tree heuristic, which is still returned as it is always meaningful).
 */
function makeModelScopeMatcher(modelName: string | undefined): (file: string) => boolean {
    const name = modelName?.trim().toLowerCase();
    return (file) => isDspacePath(file) || (!!name && file.toLowerCase().includes(name));
}

/**
 * Scans a raw `info variables`/`info functions` listing for the distinct
 * source files it mentions ("File X:" section headers), without parsing any
 * declarations. Used to cheaply check whether the dSPACE-model scope would
 * hide every symbol before committing to it at parse time.
 */
function collectListingFiles(text: string): string[] {
    const files: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = raw.match(/^File (.+):$/);
        if (m) {
            files.push(m[1]);
        }
    }
    return files;
}

/**
 * Loads the target's symbol table (variables, functions, constants, types)
 * through GDB console commands, similar to winIDEA's Symbol Browser.
 *
 * The raw GDB listings are fetched once per debug session and cached (in
 * memory and on disk) independent of any filter. The source-path include/
 * exclude settings and the automatic dSPACE-model scope are applied while
 * parsing those listings into `allEntries` (see `computeEffectiveFileFilter`),
 * so excluded files never end up held in memory or written to the symbol
 * cache; changing them re-parses the cached raw text (`reapplySourceFilters`)
 * instead of re-querying GDB. Name filters can also run a narrower GDB regexp
 * query through {@link loadFiltered}.
 */
const FAVORITES_KEY = 'gdbSymbols.favorites';
const FILTER_HISTORY_KEY = 'gdbSymbols.filterHistory';
const MAX_FILTER_HISTORY = 20;

/** Bumped whenever the on-disk cache format or the parser output changes. */
const SYMBOL_CACHE_VERSION = 5;

/** Persisted shape of a cached symbol table on disk: GDB's raw listing text. */
interface SymbolCacheFile {
    version: number;
    /** Identity of the binary the listings were fetched from. */
    signature: string;
    /** Raw `info variables` listing text, as returned by GDB. */
    vars: string;
    /** Raw `info functions` listing text, as returned by GDB. */
    funcs: string;
}

export interface SymbolLoadTiming {
    durationMs: number;
    fromCache: boolean;
    entries: number;
    /** Present when the last GDB query loaded only names matching this filter. */
    filter?: string;
    /** The regexp sent to GDB for a filtered query. */
    gdbRegexp?: string;
}

interface FilteredSymbolSet {
    sessionId: string;
    filter: string;
    gdbRegexp: string;
    entries: SymbolEntry[];
}

export class SymbolService implements vscode.Disposable {
    /**
     * Symbol table as parsed from GDB (sorted by name), already scoped by the
     * source-path filter / dSPACE model scope (see `computeEffectiveFileFilter`).
     */
    private allEntries: SymbolEntry[] = [];
    /** Candidate set loaded through `info variables/functions REGEXP` for the active filter. */
    private filteredEntries?: FilteredSymbolSet;
    /**
     * Raw `info variables` / `info functions` listing text from the last GDB
     * query (or disk-cache read), kept so the source-path filter / dSPACE model
     * scope can be re-applied by re-parsing instead of re-querying GDB.
     */
    private rawListings?: { sessionId: string; vars: string; funcs: string };
    /** Session the cached table belongs to. */
    private loadedSessionId?: string;
    /** Identity of the binary the in-memory table was parsed from. */
    private loadedSignature?: string;
    /**
     * Name of the loaded dSPACE model (e.g. "MB_ZC_Rear_vECU"), when one was
     * detected for the current session. Used to auto-scope the view to that
     * model's symbols (see `gdbSymbols.scopeToDspaceModel`).
     */
    private modelName?: string;
    /** Visible (filtered, capped) view, per category. */
    private readonly entries = new Map<SymbolCategory, SymbolEntry[]>();
    private readonly truncatedCategories = new Set<SymbolCategory>();
    /** Favorite entries (subset of the view), in favorite order. */
    private favoriteEntries: SymbolEntry[] = [];
    /** Console-command prefix known to work, cached per session. */
    private readonly prefixCache = new Map<string, string>();

    /** Names the user has starred as favorites (persisted). */
    private favorites: Set<string>;

    private _filter = '';
    loading = false;

    /**
     * Timing of the most recent symbol load that actually did work (GDB query or
     * disk-cache read), for performance comparison. `fromCache` distinguishes a
     * disk-cache hit from a full GDB round-trip. Undefined until the first load.
     */
    private _lastLoad?: SymbolLoadTiming;

    get lastLoad(): SymbolLoadTiming | undefined {
        return this._lastLoad;
    }

    /**
     * Timing of the most recent local view rebuild (filter / settings applied to
     * the already-loaded table). Unlike `lastLoad` this updates on every filter
     * change, so it reflects the cost of the *current* filter rather than the
     * one-time symbol load. `visible` is the number of symbols left after
     * filtering. Undefined until the first view is built.
     */
    private _lastViewBuild?: { durationMs: number; visible: number };

    get lastViewBuild(): { durationMs: number; visible: number } | undefined {
        return this._lastViewBuild;
    }

    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(
        private readonly tracker: DebugSessionTracker,
        private readonly poller: Poller,
        private readonly state: vscode.Memento,
        private readonly cacheDir?: vscode.Uri
    ) {
        this.favorites = new Set(state.get<string[]>(FAVORITES_KEY, []));
    }

    // ---- favorites ----------------------------------------------------------

    isFavorite(name: string): boolean {
        return this.favorites.has(name);
    }

    toggleFavorite(name: string): void {
        if (this.favorites.has(name)) {
            this.favorites.delete(name);
        } else {
            this.favorites.add(name);
        }
        void this.state.update(FAVORITES_KEY, [...this.favorites]);
        this.refreshView();
    }

    get hasFavorites(): boolean {
        return this.favoriteEntries.length > 0;
    }

    getFavorites(): readonly SymbolEntry[] {
        return this.favoriteEntries;
    }

    // ---- filter history -----------------------------------------------------

    getFilterHistory(): string[] {
        return this.state.get<string[]>(FILTER_HISTORY_KEY, []);
    }

    rememberFilter(filter: string): void {
        const term = filter.trim();
        if (!term) {
            return;
        }
        const history = this.getFilterHistory().filter((f) => f !== term);
        history.unshift(term);
        void this.state.update(FILTER_HISTORY_KEY, history.slice(0, MAX_FILTER_HISTORY));
    }

    /** Local filter (regex or substring) applied to the cached table - instant. */
    get filter(): string {
        return this._filter;
    }

    set filter(value: string) {
        if (this._filter !== value) {
            this._filter = value;
            if (!value || this.filteredEntries?.filter !== value) {
                this.filteredEntries = undefined;
            }
            this.refreshView();
        }
    }

    /** True once a symbol table has been loaded for some session. */
    get hasData(): boolean {
        return this.allEntries.length > 0 || this.filteredEntries !== undefined;
    }

    isLoadedFor(sessionId: string): boolean {
        return this.loadedSessionId === sessionId;
    }

    getCategory(category: SymbolCategory): readonly SymbolEntry[] {
        return this.entries.get(category) ?? [];
    }

    isTruncated(category: SymbolCategory): boolean {
        return this.truncatedCategories.has(category);
    }

    /**
     * Distinct source files (compilation units) that provide the loaded symbols,
     * with the number of variables and functions each contributes. Computed from
     * the currently loaded table - after the source-path filter / dSPACE model
     * scope, but before the name filter and the per-category cap - so it
     * reflects what was actually kept from GDB's response, not just the
     * currently visible (name-filtered/capped) view. Non-debugging symbols
     * (which have no source file) are grouped under a single "no source file"
     * bucket.
     */
    getSourceFileSummary(): Array<{
        file: string;
        variables: number;
        functions: number;
        total: number;
    }> {
        const counts = new Map<string, { variables: number; functions: number }>();
        for (const entry of this.activeEntries()) {
            const key = entry.file ?? '(no source file)';
            let rec = counts.get(key);
            if (!rec) {
                rec = { variables: 0, functions: 0 };
                counts.set(key, rec);
            }
            if (entry.category === 'functions') {
                rec.functions++;
            } else {
                rec.variables++;
            }
        }
        return [...counts.entries()]
            .map(([file, c]) => ({
                file,
                variables: c.variables,
                functions: c.functions,
                total: c.variables + c.functions
            }))
            .sort((a, b) => a.file.localeCompare(b.file));
    }

    /**
     * The modules (main executable + shared libraries / DLLs) the debug adapter
     * reports as loaded into the target, together with where their debug symbols
     * came from. This is what GDB actually reads the source-file names and line
     * numbers out of. Requires a live session; returns an empty list when the
     * adapter does not support the DAP 'modules' request.
     *
     * Only the dSPACE model modules (the .dll/.vap under the dSPACE toolchain
     * tree that carry the release-specific debug symbols) are returned — the many
     * volatile system DLLs a host process loads are filtered out so the symbol
     * source view reflects only the dSPACE model.
     */
    async getModules(session: vscode.DebugSession): Promise<
        Array<{ name: string; path?: string; symbolStatus?: string; symbolFilePath?: string }>
    > {
        try {
            const resp = await session.customRequest('modules', { startModule: 0, moduleCount: 0 });
            const modules = Array.isArray((resp as { modules?: unknown })?.modules)
                ? (resp as { modules: Array<Record<string, unknown>> }).modules
                : [];
            return modules
                .map((m) => ({
                    name: typeof m.name === 'string' ? m.name : String(m.id ?? ''),
                    path: typeof m.path === 'string' ? m.path : undefined,
                    symbolStatus: typeof m.symbolStatus === 'string' ? m.symbolStatus : undefined,
                    symbolFilePath:
                        typeof m.symbolFilePath === 'string' ? m.symbolFilePath : undefined
                }))
                .filter((m) => isDspacePath(m.path) || isDspacePath(m.name));
        } catch {
            return [];
        }
    }

    /**
     * The dSPACE model name (e.g. "MB_ZC_Rear_vECU") derived from the loaded
     * dSPACE module carrying the symbols, or undefined when none is present.
     */
    async getDspaceModelName(session: vscode.DebugSession): Promise<string | undefined> {
        return dspaceModelName(await this.getModules(session));
    }

    clear(): void {
        this.allEntries = [];
        this.filteredEntries = undefined;
        this.rawListings = undefined;
        this.loadedSessionId = undefined;
        this.loadedSignature = undefined;
        this.modelName = undefined;
        this.entries.clear();
        this.truncatedCategories.clear();
        this.changeEmitter.fire();
    }

    forgetSession(sessionId: string): void {
        this.prefixCache.delete(sessionId);
        if (this.filteredEntries?.sessionId === sessionId) {
            this.filteredEntries = undefined;
        }
        if (this.rawListings?.sessionId === sessionId) {
            this.rawListings = undefined;
        }
        if (this.loadedSessionId === sessionId) {
            this.loadedSessionId = undefined;
            this.loadedSignature = undefined;
            this.modelName = undefined;
        }
    }

    /**
     * Loads the complete symbol table. Skipped when the table is already cached
     * in memory for this session, unless `force` is set (explicit reload).
     *
     * On a cold load it first tries an on-disk cache keyed by the target binary's
     * identity (path + content hash + settings); a hit avoids talking to GDB
     * entirely. On a miss it queries GDB and writes the result back to disk.
     */
    async load(session: vscode.DebugSession, options?: { force?: boolean }): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;
        let started = false;
        const loadStart = Date.now();
        try {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);
            const signature = await this.binarySignature(session, includeNonDebugging);

            // Detect the dSPACE model backing this session so the view can be
            // auto-scoped to it (winIDEA-style single-file focus). Best-effort:
            // adapters without a 'modules' request simply leave it undefined.
            this.modelName = await this.getDspaceModelName(session).catch(() => undefined);

            // In-memory fast path: reuse the cached table only when it belongs to
            // this session *and* was parsed from the same binary. Comparing the
            // signature ensures a different release (a rebuilt or swapped binary,
            // even at the same path) is reloaded instead of being masked by the
            // previously cached symbols.
            if (
                !options?.force &&
                this.isLoadedFor(session.id) &&
                this.allEntries.length > 0 &&
                this.loadedSignature === signature
            ) {
                this.filteredEntries = undefined;
                this.rebuildView();
                this.changeEmitter.fire();
                return;
            }

            started = true;
            this.changeEmitter.fire();

            const skipNonDebugging = !includeNonDebugging;

            // Disk fast path: reuse the previously fetched raw listings for the
            // same binary. The cache stores GDB's raw text rather than parsed and
            // filtered entries, so a different source-path filter or dSPACE-scope
            // setting never invalidates it - only re-parsing (cheap) is needed.
            let listing = !options?.force && signature ? await this.readDiskCache(signature) : undefined;
            const fromCache = !!listing;

            if (!listing) {
                const [vars, funcs] = await this.poller.runReadOperation(session, async () => {
                    // Ask GDB to omit non-debugging (minimal) symbols with '-n' when
                    // the user does not want them. On a host process that loads many
                    // system DLLs those minimal symbols dominate the listing;
                    // dropping them at the source (rather than client-side after
                    // parsing) means GDB emits far less text and the DAP round-trip
                    // is correspondingly faster.
                    const v = await this.execInfoListing(session, 'info variables', skipNonDebugging);
                    const f = await this.execInfoListing(session, 'info functions', skipNonDebugging);
                    return [v, f];
                });
                listing = { vars, funcs };
            }

            this.rawListings = { sessionId: session.id, vars: listing.vars, funcs: listing.funcs };

            // Apply the source-path filter / dSPACE model scope while parsing, so
            // an excluded file's (often huge) body is skipped cheaply line by line
            // instead of building entries for it that would only be discarded
            // later. This is what keeps `allEntries` - and therefore sorting, the
            // in-memory/disk cache and every view rebuild - scoped to what the user
            // asked for, without paying for another GDB query when the filter
            // changes (see `reapplySourceFilters`).
            const fileFilter = this.computeEffectiveFileFilter(listing.vars, listing.funcs);
            this.allEntries = [
                ...parseSymbolListing(listing.vars, 'variables', { skipNonDebugging, fileFilter }),
                ...parseSymbolListing(listing.funcs, 'functions', { skipNonDebugging, fileFilter })
            ].sort((a, b) => a.name.localeCompare(b.name));
            this.filteredEntries = undefined;
            this.loadedSessionId = session.id;
            this.loadedSignature = signature;
            this.rebuildView();

            this._lastLoad = {
                durationMs: Date.now() - loadStart,
                fromCache,
                entries: this.allEntries.length
            };

            if (signature && !fromCache) {
                void this.writeDiskCache(signature, listing.vars, listing.funcs);
            }
        } finally {
            this.loading = false;
            if (started) {
                this.changeEmitter.fire();
            }
        }
    }

    /**
     * Loads only symbols whose names match the filter by using GDB's
     * `info variables/functions REGEXP` form. This is intentionally separate
     * from the full-table cache: a filtered query can be much cheaper for a
     * selective name, while clearing the filter returns to the complete table
     * if it has already been loaded.
     */
    async loadFiltered(
        session: vscode.DebugSession,
        filter: string,
        options?: { force?: boolean }
    ): Promise<void> {
        const term = filter.trim();
        if (!term) {
            this.filteredEntries = undefined;
            this.filter = '';
            await this.load(session, options);
            return;
        }

        const gdbRegexp = makeGdbNameRegexp(term);
        if (!gdbRegexp) {
            this.filter = term;
            return;
        }

        if (this.loading) {
            this.filter = term;
            return;
        }
        this.loading = true;
        let started = false;
        const loadStart = Date.now();
        try {
            const cfg = vscode.workspace.getConfiguration('gdbSymbols');
            const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);
            const skipNonDebugging = !includeNonDebugging;

            this.modelName = await this.getDspaceModelName(session).catch(() => undefined);

            started = true;
            this.changeEmitter.fire();

            const [vars, funcs] = await this.poller.runReadOperation(session, async () => {
                const v = await this.execInfoListing(
                    session,
                    'info variables',
                    skipNonDebugging,
                    gdbRegexp
                );
                const f = await this.execInfoListing(
                    session,
                    'info functions',
                    skipNonDebugging,
                    gdbRegexp
                );
                return [v, f];
            });

            const fileFilter = this.computeEffectiveFileFilter(vars, funcs);
            const entries = [
                ...parseSymbolListing(vars, 'variables', { skipNonDebugging, fileFilter }),
                ...parseSymbolListing(funcs, 'functions', { skipNonDebugging, fileFilter })
            ].sort((a, b) => a.name.localeCompare(b.name));

            this._filter = term;
            this.filteredEntries = {
                sessionId: session.id,
                filter: term,
                gdbRegexp,
                entries
            };
            this.rebuildView();
            this._lastLoad = {
                durationMs: Date.now() - loadStart,
                fromCache: false,
                entries: entries.length,
                filter: term,
                gdbRegexp
            };
        } finally {
            this.loading = false;
            if (started) {
                this.changeEmitter.fire();
            }
        }
    }

    // ---- on-disk symbol cache ----------------------------------------------

    /**
     * Builds a stable identity string for the binary being debugged, combining
     * its path, a hash of its contents, the identity of the loaded modules and
     * the settings that affect parsing. The content hash (not size/mtime) is
     * what distinguishes two releases, so a rebuilt or swapped binary is always
     * re-parsed. Returns undefined when no binary path is known (then caching is
     * disabled).
     *
     * The main `program` alone is not enough when attaching: in an attach setup
     * the `program` is often a generic *host* process (e.g. VeosVpuHost.exe) that
     * stays byte-for-byte identical across releases, while the release-specific
     * symbols live in a DLL/shared object loaded by that host. Hashing only the
     * host executable therefore made every release collide on the same signature
     * and reuse the first release's cached symbols. Folding in the loaded modules
     * (the DLLs that actually carry the debug symbols) makes each release map to
     * its own cache entry.
     */
    private async binarySignature(
        session: vscode.DebugSession,
        includeNonDebugging: boolean
    ): Promise<string | undefined> {
        if (!this.cacheDir) {
            return undefined;
        }
        const cfg = session.configuration as {
            program?: string;
            executable?: string;
            request?: string;
        };
        const binPath = cfg.program ?? cfg.executable;
        if (!binPath) {
            return undefined;
        }
        try {
            // Hash the actual binary contents rather than trusting size + mtime.
            // Two different releases can share the same size (firmware images are
            // often padded to a fixed flash layout) and the same mtime (preserved
            // on copy/extract, or coarse filesystem granularity), which made a new
            // release silently reuse the previous release's cached symbols. A
            // content hash is the only reliable way to tell two binaries apart.
            // (The hash itself is memoized, so unchanged binaries are read once.)
            const { size, hash: contentHash } = await hashFileContents(binPath);
            let modulesHash = await this.modulesSignature(session, binPath);

            // Attach without an identifiable symbol-bearing module: the attach
            // `program` is typically a generic *host* process (e.g. a VPU/host
            // runner) that stays byte-for-byte identical across releases, while
            // the release-specific symbols live in a DLL/.so loaded by that host.
            // If we could not fingerprint that module (adapter has no 'modules'
            // request, or its symbols were not reported as loaded yet), the
            // content hash above is the host's - identical for every release -
            // so two different releases would collapse onto the same signature
            // and the newer release would reuse the previous release's cached
            // symbols. The names line up across releases so this went unnoticed,
            // but the *line numbers* shifted, sending "Go to Definition" to the
            // wrong line.
            const isAttach = cfg.request === 'attach';
            if (isAttach && modulesHash === undefined) {
                // Right after attach the adapter often has not reported the
                // release DLL's symbols as loaded *yet* - giving up here
                // disabled the disk cache for the whole session and forced the
                // multi-second GDB query on every attach. Give the module list
                // a few seconds to settle before deciding.
                for (let i = 0; i < 12 && modulesHash === undefined; i++) {
                    await delay(500);
                    modulesHash = await this.modulesSignature(session, binPath);
                }
            }
            if (isAttach && modulesHash === undefined) {
                // Still nothing identifiable: disable caching so the symbol
                // table (and its line numbers) is always re-read from the live
                // target instead of being served from another release's stale
                // cache.
                return undefined;
            }

            return [
                `v${SYMBOL_CACHE_VERSION}`,
                binPath,
                size,
                contentHash,
                modulesHash ?? 'nomod',
                includeNonDebugging ? 'nd1' : 'nd0'
            ].join('|');
        } catch {
            // Binary not on the local filesystem (remote target etc.): skip cache.
            return undefined;
        }
    }

    /**
     * Identity of the loaded modules (shared libraries / DLLs) that carry the
     * debug symbols, queried through the DAP 'modules' request. Only modules
     * whose symbols are actually loaded are considered (the release DLLs); they
     * are content-hashed so a swapped release DLL changes the signature. Modules
     * without symbols are ignored on purpose: a live host process loads a large,
     * volatile set of them that would otherwise change the signature every run.
     * Returns undefined when the adapter does not support the request or reports
     * no symbol-bearing modules, in which case the caller falls back to the
     * program-only signature.
     */
    private async modulesSignature(
        session: vscode.DebugSession,
        programPath: string
    ): Promise<string | undefined> {
        let modules: Array<Record<string, unknown>>;
        try {
            const resp = await session.customRequest('modules', { startModule: 0, moduleCount: 0 });
            modules = Array.isArray((resp as { modules?: unknown })?.modules)
                ? ((resp as { modules: Array<Record<string, unknown>> }).modules)
                : [];
        } catch {
            return undefined;
        }
        if (modules.length === 0) {
            return undefined;
        }

        const parts: string[] = [];
        for (const m of modules) {
            const p = typeof m.path === 'string' ? m.path : typeof m.name === 'string' ? m.name : '';
            if (!p) {
                continue;
            }
            const symbolsLoaded =
                typeof m.symbolStatus === 'string' && /loaded/i.test(m.symbolStatus);
            // Only the symbol-bearing modules (the release DLLs) define the cache
            // identity. A live host process loads a large, *volatile* set of other
            // DLLs (system libraries, worker plug-ins) in a different order and
            // count on every run; folding those in made the signature change every
            // time and defeated the cache entirely. The main program is already
            // content-hashed by the caller, so skip it here.
            if (!symbolsLoaded || p === programPath) {
                continue;
            }
            try {
                const { size, hash } = await hashFileContents(p);
                parts.push(`${p}#${size}#${hash}`);
            } catch {
                // Not readable from disk (locked/remote): use cheap identity fields.
                parts.push(`${p}#${String(m.version ?? '')}#${String(m.dateTimeStamp ?? '')}`);
            }
        }

        if (parts.length === 0) {
            return undefined;
        }
        // Order-independent: the module list order from GDB is not guaranteed.
        parts.sort();
        return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
    }

    private cacheUriFor(signature: string): vscode.Uri | undefined {
        if (!this.cacheDir) {
            return undefined;
        }
        const hash = crypto.createHash('sha1').update(signature).digest('hex');
        return vscode.Uri.joinPath(this.cacheDir, `symbols-${hash}.json`);
    }

    private async readDiskCache(
        signature: string
    ): Promise<{ vars: string; funcs: string } | undefined> {
        const uri = this.cacheUriFor(signature);
        if (!uri) {
            return undefined;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as SymbolCacheFile;
            if (data.version !== SYMBOL_CACHE_VERSION || data.signature !== signature) {
                return undefined;
            }
            if (typeof data.vars !== 'string' || typeof data.funcs !== 'string') {
                return undefined;
            }
            return { vars: data.vars, funcs: data.funcs };
        } catch {
            return undefined;
        }
    }

    private async writeDiskCache(signature: string, vars: string, funcs: string): Promise<void> {
        const uri = this.cacheUriFor(signature);
        if (!uri) {
            return;
        }
        try {
            await vscode.workspace.fs.createDirectory(this.cacheDir!);
            const payload: SymbolCacheFile = { version: SYMBOL_CACHE_VERSION, signature, vars, funcs };
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload), 'utf8'));
        } catch {
            // Caching is best-effort; ignore write failures (read-only FS etc.).
        }
    }

    /** Recomputes the visible view from the cached table (filter/settings changed). */
    refreshView(): void {
        this.rebuildView();
        this.changeEmitter.fire();
    }

    /**
     * Combines the source-path include/exclude settings with the automatic
     * dSPACE-model scope into a single per-file predicate, applied while
     * parsing a raw GDB listing (see `load`, `loadFiltered`,
     * `reapplySourceFilters`). Doing this at parse time - rather than after the
     * whole table is already in memory - is what keeps `allEntries` scoped to
     * what the user asked for, so sorting, the in-memory/disk cache size and
     * every later view rebuild only ever deal with the relevant symbols.
     *
     * `varsText`/`funcsText` are scanned (cheaply, without full parsing) for the
     * set of files the listing actually contains, so the dSPACE-model scope
     * keeps the same safety net as before: if it would hide every debugging
     * symbol (e.g. the model's sources are not under a dSPACE tree and carry no
     * model-name marker), it is skipped so the view is never left empty by the
     * heuristic.
     */
    private computeEffectiveFileFilter(
        varsText: string,
        funcsText: string
    ): ((file: string) => boolean) | undefined {
        const cfg = vscode.workspace.getConfiguration('gdbSymbols');
        const includePatterns = cfg.get<string[]>('sourcePathFilter', []);
        const excludePatterns = cfg.get<string[]>('sourcePathExclude', []);
        const sourceFilter = makeSourceFileMatcher(includePatterns, excludePatterns);
        const hasExplicitInclude = includePatterns.some((p) => p.trim().length > 0);

        let modelScope: ((file: string) => boolean) | undefined;
        if (cfg.get<boolean>('scopeToDspaceModel', true) && !hasExplicitInclude) {
            const scope = makeModelScopeMatcher(this.modelName);
            const files = [...collectListingFiles(varsText), ...collectListingFiles(funcsText)];
            if (files.some((f) => scope(f))) {
                modelScope = scope;
            }
        }

        if (!sourceFilter && !modelScope) {
            return undefined;
        }
        return (file: string) =>
            (!sourceFilter || sourceFilter(file)) && (!modelScope || modelScope(file));
    }

    /**
     * Re-applies the source-path filter / dSPACE model scope to the last raw
     * GDB listings without re-querying GDB. Those settings only decide which
     * already-fetched source files are kept, not what GDB itself reports, so
     * changing them should never pay for another `info variables`/`info
     * functions` round-trip - that query is the actual multi-second cost, and
     * it is unaffected by these settings. Falls back to a plain view refresh
     * when no raw listing is cached yet.
     */
    reapplySourceFilters(): void {
        // A GDB-regexp-filtered candidate set (see `loadFiltered`) was parsed
        // from its own, separately scoped query and cannot be cheaply re-scoped
        // without re-querying GDB. Drop it so the view falls back to the
        // reparsed full table (still narrowed by the same name-filter text)
        // until the name filter is re-entered.
        this.filteredEntries = undefined;

        if (!this.rawListings || this.loading) {
            this.refreshView();
            return;
        }

        const { vars, funcs } = this.rawListings;
        const skipNonDebugging = !vscode.workspace
            .getConfiguration('gdbSymbols')
            .get<boolean>('includeNonDebugging', false);
        const fileFilter = this.computeEffectiveFileFilter(vars, funcs);
        this.allEntries = [
            ...parseSymbolListing(vars, 'variables', { skipNonDebugging, fileFilter }),
            ...parseSymbolListing(funcs, 'functions', { skipNonDebugging, fileFilter })
        ].sort((a, b) => a.name.localeCompare(b.name));
        this.rebuildView();
        this.changeEmitter.fire();
    }

    private activeEntries(): readonly SymbolEntry[] {
        if (this.filteredEntries && this.filteredEntries.filter === this._filter) {
            return this.filteredEntries.entries;
        }
        return this.allEntries;
    }

    private rebuildView(): void {
        const viewStart = Date.now();
        const sourceEntries = this.activeEntries();
        const cfg = vscode.workspace.getConfiguration('gdbSymbols');
        const max = Math.max(1, cfg.get<number>('maxSymbolsPerCategory', 2000));
        const includeNonDebugging = cfg.get<boolean>('includeNonDebugging', false);
        const matches = makeMatcher(this._filter);

        this.entries.clear();
        this.truncatedCategories.clear();
        this.favoriteEntries = [];
        for (const category of SYMBOL_CATEGORIES) {
            this.entries.set(category, []);
        }
        for (const entry of sourceEntries) {
            if (entry.nonDebugging && !includeNonDebugging) {
                continue;
            }
            if (this.favorites.has(entry.name)) {
                this.favoriteEntries.push(entry);
            }
            if (!matches(entry.name)) {
                continue;
            }
            const list = this.entries.get(entry.category)!;
            if (list.length >= max) {
                this.truncatedCategories.add(entry.category);
                continue;
            }
            list.push(entry);
        }

        let visible = 0;
        for (const list of this.entries.values()) {
            visible += list.length;
        }
        this._lastViewBuild = { durationMs: Date.now() - viewStart, visible };
    }

    /**
     * Runs an `info variables` / `info functions` listing, optionally passing the
     * GDB `-n` flag to omit non-debugging (minimal) symbols. `-n` was added in
     * GDB 8.1; on an older GDB the flagged command is rejected (no valid listing),
     * so we transparently fall back to the plain command. The non-debugging
     * symbols are then still filtered out client-side by the parser.
     */
    private async execInfoListing(
        session: vscode.DebugSession,
        command: string,
        skipNonDebugging: boolean,
        nameRegexp?: string
    ): Promise<string> {
        const regexpArg = nameRegexp ? ` ${nameRegexp}` : '';
        if (skipNonDebugging) {
            try {
                return await this.execConsole(session, `${command} -n${regexpArg}`);
            } catch {
                // Older GDB without the '-n' flag: fall back to the plain listing.
            }
        }
        return this.execConsole(session, `${command}${regexpArg}`);
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
                // Poll on a short interval and break as soon as the captured text
                // stops growing. For a started stream we require two consecutive
                // stable reads (cheap insurance against a pause between bursts);
                // for no output at all we give a brief grace period before giving
                // up on this prefix.
                const cfg = vscode.workspace.getConfiguration('gdbSymbols');
                const pollMs = Math.max(10, cfg.get<number>('settlePollMs', 50));
                const maxMs = Math.max(pollMs, cfg.get<number>('settleMaxMs', 3000));
                const maxIterations = Math.ceil(maxMs / pollMs);
                const graceIterations = Math.max(2, Math.ceil(150 / pollMs));
                let prevLen = -1;
                let stableReads = 0;
                for (let i = 0; i < maxIterations; i++) {
                    await delay(pollMs);
                    const len = capture.peek().length;
                    if (len === prevLen) {
                        if (len > 0) {
                            if (++stableReads >= 2) {
                                break;
                            }
                        } else if (i >= graceIterations) {
                            break;
                        }
                    } else {
                        stableReads = 0;
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
