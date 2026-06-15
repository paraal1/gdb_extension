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

export type TriggerEdge = 'rising' | 'falling' | 'both';
export type TriggerMode = 'single' | 'normal' | 'auto';

/**
 * Scope-style trigger configuration. When enabled, acquisition keeps a rolling
 * pre-trigger buffer and only "commits" a capture window once the source
 * variable crosses {@link level} in the configured {@link edge} direction.
 */
export interface DaqTrigger {
    enabled: boolean;
    /** Variable id whose value is tested against the level. */
    sourceId: string;
    edge: TriggerEdge;
    level: number;
    mode: TriggerMode;
    /** Fraction (0..1) of the capture window kept *before* the trigger. */
    preTriggerFraction: number;
    /** Total samples per capture window (pre + post). */
    windowSamples: number;
}

export type TriggerState = 'idle' | 'armed' | 'triggered';

export interface DaqSnapshot {
    recording: boolean;
    periodMs: number;
    maxSamples: number;
    variables: DaqVariable[];
    t: number[];
    series: Record<string, (number | null)[]>;
    trigger: DaqTrigger;
    triggerState: TriggerState;
    triggerTime: number | null;
}

interface PersistedConfig {
    periodMs: number;
    variables: Array<{ expression: string; enabled: boolean; color: string }>;
    trigger?: DaqTrigger;
}

const DEFAULT_TRIGGER: DaqTrigger = {
    enabled: false,
    sourceId: '',
    edge: 'rising',
    level: 0,
    mode: 'normal',
    preTriggerFraction: 0.25,
    windowSamples: 2000
};

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

    private trigger: DaqTrigger = { ...DEFAULT_TRIGGER };
    private triggerState: TriggerState = 'idle';
    private triggerTime: number | null = null;
    private prevTriggerSource: number | null = null;
    private postTriggerRemaining = 0;
    private armedSamples = 0;

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
            if (saved.trigger) {
                this.trigger = { ...DEFAULT_TRIGGER, ...saved.trigger };
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

    get triggerConfig(): DaqTrigger {
        return this.trigger;
    }

    /** Updates the trigger configuration. Re-arms if recording is in progress. */
    setTrigger(trigger: Partial<DaqTrigger>): void {
        this.trigger = { ...this.trigger, ...trigger };
        this.trigger.windowSamples = Math.max(2, Math.floor(this.trigger.windowSamples) || 2);
        this.trigger.preTriggerFraction = Math.min(0.95, Math.max(0, this.trigger.preTriggerFraction));
        if (this.recording) {
            // Re-arm so the new condition takes effect on the running capture.
            this.armTrigger();
        }
        this.persist();
        this.configEmitter.fire();
    }

    private armTrigger(): void {
        this.triggerState = this.trigger.enabled ? 'armed' : 'idle';
        this.triggerTime = null;
        this.prevTriggerSource = null;
        this.postTriggerRemaining = 0;
        this.armedSamples = 0;
    }

    private preTriggerSamples(): number {
        return Math.max(0, Math.floor(this.trigger.windowSamples * this.trigger.preTriggerFraction));
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
            if (this.trigger.sourceId === id) {
                this.trigger = { ...this.trigger, sourceId: '' };
            }
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
            })),
            trigger: this.trigger
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
                })),
                trigger: this.trigger
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
        this.nextId = 1;
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
        // Variable ids are assigned deterministically (v1, v2, ...) in the same
        // order on every load, so a stored trigger sourceId stays valid.
        this.trigger = parsed.trigger
            ? { ...DEFAULT_TRIGGER, ...parsed.trigger }
            : { ...DEFAULT_TRIGGER };
        this.armTrigger();
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
            series,
            trigger: this.trigger,
            triggerState: this.triggerState,
            triggerTime: this.triggerTime
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
        this.armTrigger();
        this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
        void this.acquisitionLoop(session);
        this.configEmitter.fire();
    }

    stop(): void {
        if (!this.recording) {
            return;
        }
        this.recording = false;
        this.triggerState = 'idle';
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

        this.applyCapAndTrigger(t, byId.get(this.trigger.sourceId) ?? null);
    }

    /**
     * Applies the ring-buffer cap and, when a trigger is configured, runs the
     * scope-style state machine (armed -> triggered -> capture complete).
     */
    private applyCapAndTrigger(t: number, source: number | null): void {
        if (!this.trigger.enabled) {
            this.capTo(this.maxSamples());
            return;
        }

        const pre = this.preTriggerSamples();

        if (this.triggerState === 'armed') {
            this.armedSamples++;
            const fired = this.crossedLevel(this.prevTriggerSource, source);
            // 'auto' mode self-triggers once a full window has elapsed with no event.
            const autoFire = this.trigger.mode === 'auto' && this.armedSamples >= this.trigger.windowSamples;
            if (source !== null) {
                this.prevTriggerSource = source;
            }
            if (fired || autoFire) {
                this.triggerState = 'triggered';
                this.triggerTime = t;
                this.postTriggerRemaining = this.trigger.windowSamples - pre;
                this.capTo(this.trigger.windowSamples);
                this.configEmitter.fire();
            } else {
                // Keep only the rolling pre-trigger buffer while waiting.
                this.capTo(Math.max(1, pre));
            }
            return;
        }

        if (this.triggerState === 'triggered') {
            this.capTo(this.trigger.windowSamples);
            if (this.postTriggerRemaining > 0) {
                this.postTriggerRemaining--;
            }
            if (this.postTriggerRemaining <= 0) {
                if (this.trigger.mode === 'single') {
                    this.stop();
                } else {
                    // normal / auto: re-arm for the next capture.
                    this.clearData();
                    this.triggerState = 'armed';
                    this.triggerTime = null;
                    this.prevTriggerSource = null;
                    this.armedSamples = 0;
                    this.configEmitter.fire();
                }
            }
            return;
        }

        this.capTo(this.maxSamples());
    }

    private crossedLevel(prev: number | null, cur: number | null): boolean {
        if (prev === null || cur === null) {
            return false;
        }
        const level = this.trigger.level;
        const rising = prev < level && cur >= level;
        const falling = prev > level && cur <= level;
        if (this.trigger.edge === 'rising') {
            return rising;
        }
        if (this.trigger.edge === 'falling') {
            return falling;
        }
        return rising || falling;
    }

    /** Ring-buffer behaviour: drop oldest samples beyond `max`. */
    private capTo(max: number): void {
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
