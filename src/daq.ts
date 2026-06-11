import * as vscode from 'vscode';
import { Poller } from './poller';

/** Sampling periods offered in the UI (daqIDEA style). 0 = as fast as possible. */
export const SAMPLING_PERIODS_MS = [0, 1, 10, 100, 1000] as const;

export interface DaqVariable {
    id: string;
    expression: string;
    enabled: boolean;
    color: string;
    /** Last raw value string reported by the debugger (for the data table / legend). */
    lastRaw: string;
    /** Last numeric value (chart), null if the value could not be parsed. */
    lastValue: number | null;
}

export interface DaqBatch {
    t: number[];
    /** Map of variable id -> appended values, aligned with t. */
    series: Record<string, (number | null)[]>;
}

export interface DaqSnapshot {
    recording: boolean;
    periodMs: number;
    maxSamples: number;
    variables: DaqVariable[];
    t: number[];
    series: Record<string, (number | null)[]>;
}

interface PersistedConfig {
    periodMs: number;
    variables: Array<{ expression: string; enabled: boolean; color: string }>;
}

const STORAGE_KEY = 'gdbDaq.config';

const PALETTE = [
    '#4fc1ff', '#f48771', '#89d185', '#e2c08d', '#c586c0',
    '#dcdcaa', '#569cd6', '#d16969', '#b5cea8', '#ce9178'
];

/** How often buffered samples are flushed to listeners (the webview). */
const FLUSH_MS = 100;

/**
 * Data acquisition engine: samples a set of expressions at a configurable
 * period (max / 1ms / 10ms / 100ms / 1s) and buffers the acquired values.
 *
 * Reads go through Poller.runReadOperation, so acquisition transparently works
 * both with GDB non-stop targets (direct evaluation) and plain all-stop
 * targets (pause -> read -> continue sampling cycles). The achievable rate is
 * limited by the debug adapter round-trip time; short periods effectively
 * mean "as fast as the target allows".
 */
export class DaqEngine implements vscode.Disposable {
    private vars: DaqVariable[] = [];
    private times: number[] = [];
    private readonly data = new Map<string, (number | null)[]>();

    private recording = false;
    private periodMs = 100;
    private nextId = 1;

    private pendingT: number[] = [];
    private pendingSeries = new Map<string, (number | null)[]>();
    private flushTimer?: ReturnType<typeof setInterval>;

    private readonly configEmitter = new vscode.EventEmitter<void>();
    /** Variable list, period or recording state changed. */
    readonly onDidChangeConfig = this.configEmitter.event;

    private readonly batchEmitter = new vscode.EventEmitter<DaqBatch>();
    /** New samples were acquired. */
    readonly onDidAppendSamples = this.batchEmitter.event;

    private readonly clearEmitter = new vscode.EventEmitter<void>();
    /** All acquired data was discarded. */
    readonly onDidClearData = this.clearEmitter.event;

    constructor(
        private readonly workspaceState: vscode.Memento,
        private readonly poller: Poller
    ) {
        const saved = workspaceState.get<PersistedConfig | undefined>(STORAGE_KEY);
        if (saved) {
            this.periodMs = saved.periodMs ?? 100;
            for (const v of saved.variables ?? []) {
                this.addVariableInternal(v.expression, v.enabled, v.color);
            }
        }
    }

    // ---- configuration -----------------------------------------------------

    get isRecording(): boolean {
        return this.recording;
    }

    get samplingPeriodMs(): number {
        return this.periodMs;
    }

    setSamplingPeriod(ms: number): void {
        this.periodMs = Math.max(0, ms);
        this.persist();
        this.configEmitter.fire();
    }

    get variables(): readonly DaqVariable[] {
        return this.vars;
    }

    addVariable(expression: string): DaqVariable | undefined {
        const expr = expression.trim();
        if (!expr || this.vars.some((v) => v.expression === expr)) {
            return undefined;
        }
        const variable = this.addVariableInternal(expr, true, this.nextColor());
        this.persist();
        this.configEmitter.fire();
        return variable;
    }

    private addVariableInternal(expression: string, enabled: boolean, color: string): DaqVariable {
        const variable: DaqVariable = {
            id: `v${this.nextId++}`,
            expression,
            enabled,
            color,
            lastRaw: '',
            lastValue: null
        };
        this.vars.push(variable);
        // Pad with nulls so the column stays aligned with already acquired samples.
        this.data.set(variable.id, new Array<number | null>(this.times.length).fill(null));
        return variable;
    }

    removeVariable(id: string): void {
        const idx = this.vars.findIndex((v) => v.id === id);
        if (idx >= 0) {
            this.vars.splice(idx, 1);
            this.data.delete(id);
            this.pendingSeries.delete(id);
            this.persist();
            this.configEmitter.fire();
        }
    }

    setVariableEnabled(id: string, enabled: boolean): void {
        const v = this.vars.find((x) => x.id === id);
        if (v && v.enabled !== enabled) {
            v.enabled = enabled;
            this.persist();
            this.configEmitter.fire();
        }
    }

    private nextColor(): string {
        const used = new Set(this.vars.map((v) => v.color));
        return PALETTE.find((c) => !used.has(c)) ?? PALETTE[this.vars.length % PALETTE.length];
    }

    private persist(): void {
        const cfg: PersistedConfig = {
            periodMs: this.periodMs,
            variables: this.vars.map((v) => ({
                expression: v.expression,
                enabled: v.enabled,
                color: v.color
            }))
        };
        void this.workspaceState.update(STORAGE_KEY, cfg);
    }

    private maxSamples(): number {
        const n = vscode.workspace.getConfiguration('gdbDaq').get<number>('maxSamples', 100000);
        return Math.max(1000, n);
    }

    // ---- configuration file import/export -----------------------------------

    exportConfig(): string {
        return JSON.stringify(
            {
                version: 1,
                samplingPeriodMs: this.periodMs,
                variables: this.vars.map((v) => ({
                    expression: v.expression,
                    enabled: v.enabled,
                    color: v.color
                }))
            },
            undefined,
            2
        );
    }

    importConfig(json: string): void {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed?.variables)) {
            throw new Error('not a valid DAQ configuration file');
        }
        this.stop();
        this.vars = [];
        this.data.clear();
        this.clearData();
        this.periodMs = typeof parsed.samplingPeriodMs === 'number' ? parsed.samplingPeriodMs : 100;
        for (const v of parsed.variables) {
            if (typeof v?.expression === 'string' && v.expression.trim()) {
                this.addVariableInternal(
                    v.expression.trim(),
                    v.enabled !== false,
                    typeof v.color === 'string' ? v.color : this.nextColor()
                );
            }
        }
        this.persist();
        this.configEmitter.fire();
    }

    // ---- data ----------------------------------------------------------------

    snapshot(): DaqSnapshot {
        const series: Record<string, (number | null)[]> = {};
        for (const v of this.vars) {
            series[v.id] = this.data.get(v.id) ?? [];
        }
        return {
            recording: this.recording,
            periodMs: this.periodMs,
            maxSamples: this.maxSamples(),
            variables: this.vars,
            t: this.times,
            series
        };
    }

    get sampleCount(): number {
        return this.times.length;
    }

    clearData(): void {
        this.times = [];
        for (const id of this.data.keys()) {
            this.data.set(id, []);
        }
        this.pendingT = [];
        this.pendingSeries.clear();
        for (const v of this.vars) {
            v.lastRaw = '';
            v.lastValue = null;
        }
        this.clearEmitter.fire();
    }

    // ---- acquisition -----------------------------------------------------------

    /** Starts a new acquisition. Discards previously acquired data. */
    start(): void {
        if (this.recording) {
            return;
        }
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('no active debug session');
        }
        if (!this.vars.some((v) => v.enabled)) {
            throw new Error('no enabled DAQ variables - add a variable first');
        }
        this.clearData();
        this.recording = true;
        this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
        void this.acquisitionLoop(session);
        this.configEmitter.fire();
    }

    stop(): void {
        if (!this.recording) {
            return;
        }
        this.recording = false;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flush();
        this.configEmitter.fire();
    }

    private async acquisitionLoop(session: vscode.DebugSession): Promise<void> {
        const startMs = Date.now();
        let n = 0;
        let consecutiveErrors = 0;

        while (this.recording) {
            if (vscode.debug.activeDebugSession?.id !== session.id) {
                break;
            }

            // Drift-corrected schedule: sample n is due at startMs + n * period.
            if (this.periodMs > 0) {
                const wait = startMs + n * this.periodMs - Date.now();
                if (wait > 0) {
                    await delay(wait);
                } else if (wait < -10 * this.periodMs) {
                    // Hopelessly behind (target slower than the period): re-anchor.
                    n = Math.floor((Date.now() - startMs) / this.periodMs);
                }
            }
            n++;
            if (!this.recording) {
                break;
            }

            const enabled = this.vars.filter((v) => v.enabled);
            if (enabled.length === 0) {
                await delay(100);
                continue;
            }

            try {
                const raws = await this.poller.runReadOperation(session, async (frameId) => {
                    const out: (string | undefined)[] = [];
                    for (const v of enabled) {
                        try {
                            const resp = await session.customRequest('evaluate', {
                                expression: v.expression,
                                frameId,
                                context: 'watch'
                            });
                            out.push(String(resp.result ?? ''));
                        } catch {
                            out.push(undefined);
                        }
                    }
                    return out;
                });
                consecutiveErrors = 0;
                this.appendSample((Date.now() - startMs) / 1000, enabled, raws);
            } catch {
                // Poller busy / pause failed / session shutting down: back off briefly.
                consecutiveErrors++;
                await delay(Math.min(50 * consecutiveErrors, 500));
            }
        }

        // Loop ended on its own (session gone): make sure state is consistent.
        this.stop();
    }

    private appendSample(t: number, sampled: DaqVariable[], raws: (string | undefined)[]): void {
        const byId = new Map<string, number | null>();
        sampled.forEach((v, i) => {
            const raw = raws[i];
            const num = raw === undefined ? null : parseNumericValue(raw);
            v.lastRaw = raw ?? 'n/a';
            v.lastValue = num;
            byId.set(v.id, num);
        });

        this.times.push(t);
        this.pendingT.push(t);
        for (const v of this.vars) {
            const value = byId.has(v.id) ? byId.get(v.id)! : null;
            this.data.get(v.id)?.push(value);
            let pending = this.pendingSeries.get(v.id);
            if (!pending) {
                pending = [];
                this.pendingSeries.set(v.id, pending);
            }
            pending.push(value);
        }

        // Ring-buffer behaviour: drop the oldest samples beyond the cap. The
        // webview applies the same cap, so both sides stay aligned.
        const max = this.maxSamples();
        if (this.times.length > max) {
            const drop = this.times.length - max;
            this.times.splice(0, drop);
            for (const [id, col] of this.data) {
                col.splice(0, drop);
                this.data.set(id, col);
            }
        }
    }

    private flush(): void {
        if (this.pendingT.length === 0) {
            return;
        }
        const series: Record<string, (number | null)[]> = {};
        for (const v of this.vars) {
            series[v.id] = this.pendingSeries.get(v.id) ?? [];
        }
        const batch: DaqBatch = { t: this.pendingT, series };
        this.pendingT = [];
        this.pendingSeries.clear();
        this.batchEmitter.fire(batch);
    }

    dispose(): void {
        this.stop();
        this.configEmitter.dispose();
        this.batchEmitter.dispose();
        this.clearEmitter.dispose();
    }
}

/**
 * Extracts a numeric value from a GDB value string for charting.
 * Handles plain numbers, floats, hex, booleans, chars ("65 'A'") and
 * pointers ("0x804a01c <buffer>"). Returns null for non-numeric values.
 */
export function parseNumericValue(raw: string): number | null {
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
    const m = s.match(/-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (!m) {
        return null;
    }
    const tok = m[0];
    const value = /0x/i.test(tok)
        ? (tok.startsWith('-') ? -parseInt(tok.slice(1), 16) : parseInt(tok, 16))
        : Number(tok);
    return Number.isFinite(value) ? value : null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
