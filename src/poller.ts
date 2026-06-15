import * as vscode from 'vscode';
import { LiveWatchModel } from './model';
import { DebugSessionTracker } from './tracker';

const STOP_TIMEOUT_MS = 3000;

/**
 * How long {@link Poller.claimBusy} waits for an in-flight tick before giving up.
 * A single sampling cycle can take up to STOP_TIMEOUT_MS just waiting for the
 * pause, plus the evaluate/variables round-trips of a refresh, so the budget
 * must exceed that worst case to avoid spurious "busy" failures.
 */
const CLAIM_BUSY_TIMEOUT_MS = STOP_TIMEOUT_MS + 5000;

/**
 * Maximum fraction of wall-clock time the target may be paused by sampling
 * cycles when adaptive polling backs off (keeps intrusion bounded).
 */
const MAX_SAMPLING_DUTY = 0.2;

/** Errors that mean GDB's selected thread is invalid and a read should be retried. */
const STALE_THREAD_PATTERNS = [
    /live selective thread/i,
    /no (?:selected )?thread/i,
    /no frame (?:is )?selected/i,
    /thread .*(?:has exited|no longer exists)/i
];

function isStaleThreadError(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e ?? '');
    return STALE_THREAD_PATTERNS.some((re) => re.test(msg));
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** How the watch values are currently being read. */
export type PollMode = 'idle' | 'stopped' | 'direct' | 'sampling';

/** Health metrics for the most recent polling activity. */
export interface PollStats {
    mode: PollMode;
    /** Wall-clock duration of the last refresh tick. */
    lastTickMs: number;
    /** Time the target was paused during the last sampling cycle (intrusion). */
    lastPauseMs: number;
    /** Measured interval between the last two ticks. */
    achievedIntervalMs: number;
    /** Timer delay currently in effect (after any adaptive back-off). */
    effectiveIntervalMs: number;
}

/**
 * Periodically refreshes the watch model.
 *
 * While the target is stopped, expressions are evaluated against the top
 * stack frame. While it is running:
 *  - 'nonStop' mode evaluates directly (GDB non-stop / async mode required),
 *  - 'sample' mode performs transparent pause -> read -> continue cycles
 *    (works in plain all-stop mode, e.g. VEOS host applications),
 *  - 'auto' tries direct evaluation first and permanently switches the session
 *    to sampling as soon as direct evaluation fails.
 */
export class Poller implements vscode.Disposable {
    private timer?: ReturnType<typeof setTimeout>;
    private active = false;
    private busy = false;
    /** Sessions where 'auto' mode has detected that direct evaluation does not work. */
    private readonly samplingSessions = new Set<string>();

    private lastPauseMs = 0;
    private lastTickStart = 0;
    private stats: PollStats = {
        mode: 'idle',
        lastTickMs: 0,
        lastPauseMs: 0,
        achievedIntervalMs: 0,
        effectiveIntervalMs: 0
    };

    private readonly pollingEmitter = new vscode.EventEmitter<boolean>();
    readonly onDidChangePolling = this.pollingEmitter.event;

    private readonly statsEmitter = new vscode.EventEmitter<PollStats>();
    /** Fires after every tick with up-to-date health metrics. */
    readonly onDidChangeStats = this.statsEmitter.event;

    private readonly fatalEmitter = new vscode.EventEmitter<{ session: vscode.DebugSession; message: string }>();
    /**
     * Fires when sampling hits an unrecoverable condition (e.g. the target
     * could not be resumed after a pause). Listeners should stop polling and
     * surface guidance to the user.
     */
    readonly onDidEncounterFatal = this.fatalEmitter.event;

    constructor(
        private readonly model: LiveWatchModel,
        private readonly tracker: DebugSessionTracker
    ) {}

    get polling(): boolean {
        return this.active;
    }

    getStats(): PollStats {
        return this.stats;
    }

    /** True if 'auto' mode has fallen back to pause/read/continue sampling. */
    isSamplingFallback(sessionId: string): boolean {
        return this.samplingSessions.has(sessionId);
    }

    private get intervalMs(): number {
        const ms = vscode.workspace.getConfiguration('gdbLiveWatch').get<number>('pollingInterval', 1000);
        return Math.max(100, ms);
    }

    private get adaptive(): boolean {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<boolean>('adaptivePolling', true);
    }

    private get mode(): 'auto' | 'nonStop' | 'sample' | 'stoppedOnly' {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<any>('mode', 'auto');
    }

    start(): void {
        if (this.active) {
            return;
        }
        this.active = true;
        this.pollingEmitter.fire(true);
        this.scheduleNext(0);
    }

    stop(): void {
        if (!this.active) {
            return;
        }
        this.active = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.stats = { ...this.stats, mode: 'idle' };
        this.statsEmitter.fire(this.stats);
        this.pollingEmitter.fire(false);
    }

    /** Restart the timer with the current configured interval. */
    restartIfPolling(): void {
        if (this.active) {
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.scheduleNext(this.intervalMs);
        }
    }

    /** Schedules the next tick, applying adaptive back-off. */
    private scheduleNext(delay: number): void {
        if (!this.active) {
            return;
        }
        this.timer = setTimeout(() => {
            void this.tick().finally(() => this.scheduleNext(this.computeDelay()));
        }, delay);
    }

    /**
     * Computes the delay before the next tick. When adaptive polling is on and
     * sampling is in use, the interval is stretched so the target spends at most
     * {@link MAX_SAMPLING_DUTY} of the time paused.
     */
    private computeDelay(): number {
        const base = this.intervalMs;
        if (!this.adaptive || this.stats.mode !== 'sampling' || this.lastPauseMs <= 0) {
            this.stats.effectiveIntervalMs = base;
            return base;
        }
        const minByDuty = Math.round(this.lastPauseMs / MAX_SAMPLING_DUTY);
        const delay = Math.max(base, minByDuty);
        this.stats.effectiveIntervalMs = delay;
        return delay;
    }

    forgetSession(sessionId: string): void {
        this.samplingSessions.delete(sessionId);
    }

    /** One-shot refresh, also used by the manual Refresh command. */
    async tick(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session || this.busy || this.model.isEmpty || this.tracker.isFatal(session.id)) {
            return;
        }
        this.busy = true;
        const tickStart = Date.now();
        const achieved = this.lastTickStart ? tickStart - this.lastTickStart : 0;
        this.lastTickStart = tickStart;
        this.lastPauseMs = 0;
        let pollMode: PollMode = 'direct';
        try {
            const state = this.tracker.getState(session.id);
            if (state === 'stopped') {
                pollMode = 'stopped';
                const frameId = await this.topFrameId(session);
                await this.model.refresh(session, frameId);
                return;
            }

            // Treat 'running' and 'unknown' as running.
            const mode = this.mode;

            // Safe mode: never pause a running target. Values simply hold their
            // last reading until the target stops naturally (breakpoint/step).
            if (mode === 'stoppedOnly') {
                pollMode = 'idle';
                return;
            }

            let useSampling =
                mode === 'sample' || (mode === 'auto' && this.samplingSessions.has(session.id));

            if (!useSampling) {
                const result = await this.model.refresh(session, undefined);
                // In 'auto' mode, fall back to sampling as soon as *any* watched
                // expression cannot be read directly (e.g. locals / stack values
                // while running), not only when every expression fails. In
                // 'nonStop' mode partial failures are expected, so leave it be.
                if (mode === 'auto' && result.succeeded < result.total) {
                    this.samplingSessions.add(session.id);
                    useSampling = true;
                } else {
                    pollMode = 'direct';
                    return;
                }
            }
            if (useSampling) {
                pollMode = 'sampling';
                await this.withSampledStop(session, (frameId) => this.model.refresh(session, frameId));
            }
        } catch {
            // Session may have ended mid-tick; ignore.
        } finally {
            this.busy = false;
            this.stats = {
                mode: pollMode,
                lastTickMs: Date.now() - tickStart,
                lastPauseMs: this.lastPauseMs,
                achievedIntervalMs: achieved,
                effectiveIntervalMs: this.stats.effectiveIntervalMs || this.intervalMs
            };
            this.statsEmitter.fire(this.stats);
        }
    }

    /** Wait for any in-flight poll tick to finish, then claim the busy flag. */
    private async claimBusy(): Promise<void> {
        const deadline = Date.now() + CLAIM_BUSY_TIMEOUT_MS;
        while (this.busy && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (this.busy) {
            throw new Error('live watch is busy, try again');
        }
        this.busy = true;
    }

    /**
     * Runs a read-only operation against the debug session, transparently
     * handling a running target the same way value polling does: try a direct
     * request first (non-stop / async mode), fall back to a transparent
     * pause -> read -> continue cycle. Throws on failure.
     *
     * The callback receives the top stack frame id when the target is (or has
     * been transparently) stopped, and undefined for direct evaluation while
     * running.
     */
    async runReadOperation<T>(
        session: vscode.DebugSession,
        fn: (frameId: number | undefined) => Promise<T>
    ): Promise<T> {
        await this.claimBusy();
        try {
            if (this.tracker.isFatal(session.id)) {
                throw new Error('the debug session is no longer responding');
            }
            const state = this.tracker.getState(session.id);
            if (state === 'stopped') {
                return await fn(await this.topFrameId(session));
            }

            const mode = this.mode;
            if (mode === 'stoppedOnly') {
                throw new Error('target is running (safe mode: stop the target to read this value)');
            }
            let useSampling =
                mode === 'sample' || (mode === 'auto' && this.samplingSessions.has(session.id));

            if (!useSampling) {
                try {
                    return await fn(undefined);
                } catch (e) {
                    if (mode !== 'auto') {
                        throw e;
                    }
                    this.samplingSessions.add(session.id);
                    useSampling = true;
                }
            }

            // Let the read throw through withSampledStop so readAtStop can recover
            // once from a stale selected thread; the sampling cycle still resumes
            // the target in its finally block even when the read fails.
            let result: T | undefined;
            const done = await this.withSampledStop(session, async (frameId) => {
                result = await fn(frameId);
            });
            if (!done) {
                throw new Error('could not pause the target');
            }
            return result as T;
        } finally {
            this.busy = false;
        }
    }

    /**
     * Writes a new value to the node with the given id, transparently handling
     * the running target (direct write in non-stop mode, or a pause -> write ->
     * continue cycle when sampling). Throws on failure so the caller can report it.
     */
    async setNodeValue(session: vscode.DebugSession, nodeId: string, value: string): Promise<void> {
        await this.claimBusy();
        try {
            if (this.tracker.isFatal(session.id)) {
                throw new Error('the debug session is no longer responding');
            }
            const state = this.tracker.getState(session.id);
            if (state === 'stopped') {
                await this.writeAndRefresh(session, nodeId, value, await this.topFrameId(session));
                return;
            }

            const mode = this.mode;
            if (mode === 'stoppedOnly') {
                throw new Error('target is running (safe mode: stop the target to write this value)');
            }
            let useSampling =
                mode === 'sample' || (mode === 'auto' && this.samplingSessions.has(session.id));

            if (!useSampling) {
                try {
                    await this.writeAndRefresh(session, nodeId, value, undefined);
                    return;
                } catch (e) {
                    if (mode !== 'auto') {
                        throw e;
                    }
                    this.samplingSessions.add(session.id);
                    useSampling = true;
                }
            }

            const done = await this.withSampledStop(session, async (frameId) => {
                await this.writeAndRefresh(session, nodeId, value, frameId);
            });
            if (!done) {
                throw new Error('could not pause the target to write the value');
            }
        } finally {
            this.busy = false;
        }
    }

    private async writeAndRefresh(
        session: vscode.DebugSession,
        nodeId: string,
        value: string,
        frameId: number | undefined
    ): Promise<void> {
        // Refresh first: variablesReferences (and child nodes) from a previous
        // stop are stale, especially right after a sampling pause.
        await this.model.refresh(session, frameId);
        const node = this.model.findById(nodeId);
        if (!node) {
            throw new Error('variable no longer exists');
        }
        await this.model.setValue(session, node, value, frameId);
        await this.model.refresh(session, frameId);
    }

    /**
     * Pause the target, run `fn` while it is stopped, then resume - a sampling
     * cycle. Returns false if the target could not be paused in time.
     */
    private async withSampledStop(
        session: vscode.DebugSession,
        fn: (frameId: number | undefined) => Promise<unknown>
    ): Promise<boolean> {
        const threadId = await this.resolveLiveThreadId(session);
        if (threadId === undefined) {
            return false;
        }

        // If the target is already stopped - either it was when we started, or a
        // real breakpoint/step landed while we resolved the thread - don't issue
        // a pause. Read at the current stop and leave the target stopped for the
        // user. This check must stay synchronous (no await) right before arming
        // expectPause, so no 'stopped' event can slip in between and leave the
        // flag dangling for a future stop to mis-consume.
        if (this.tracker.getState(session.id) === 'stopped') {
            await fn(await this.topFrameId(session));
            return true;
        }

        this.tracker.expectPause(session.id);
        const stop = this.tracker.waitForStop(session.id, STOP_TIMEOUT_MS);
        try {
            await session.customRequest('pause', { threadId });
        } catch {
            this.tracker.cancelExpectPause(session.id);
            stop.cancel();
            return false;
        }

        const stopped = await stop.promise;
        if (!stopped) {
            this.tracker.cancelExpectPause(session.id);
            return false;
        }
        // The pause may have stopped on (and immediately destroyed) a transient
        // break-in thread, which can leave the adapter in a fatal break state.
        if (this.tracker.isFatal(session.id)) {
            return false;
        }

        const pauseStart = Date.now();
        try {
            await this.readAtStop(session, fn);
        } finally {
            // Only resume if this stop was caused by our own pause. If a breakpoint
            // or exception hit in the meantime, leave the target stopped for the user.
            if (this.tracker.consumeAutoContinue(session.id)) {
                await this.resumeTarget(session, threadId);
                // Time the target was halted by our sampling cycle (intrusion).
                this.lastPauseMs = Date.now() - pauseStart;
            }
        }
        return true;
    }

    /**
     * Runs the read callback at the current stop, recovering once from a stale
     * selected thread (the "cannot execute this command without a live selective
     * thread" / "no frame selected" errors that occur when the thread GDB had
     * selected exited during the pause). The retry re-resolves a live thread and
     * recomputes the top frame.
     */
    private async readAtStop(
        session: vscode.DebugSession,
        fn: (frameId: number | undefined) => Promise<unknown>
    ): Promise<void> {
        const frameId = await this.topFrameId(session);
        try {
            await fn(frameId);
        } catch (e) {
            if (!isStaleThreadError(e)) {
                throw e;
            }
            // Drop the stale preferred thread and resolve a fresh one before retry.
            this.tracker.forgetThreadId(session.id);
            const retryFrame = await this.topFrameId(session);
            await fn(retryFrame);
        }
    }

    /**
     * Resumes the target after a sampling pause, with retries. Leaving a target
     * paused because a single 'continue' failed (e.g. the selected thread exited)
     * would silently freeze the program under test, so this is treated as
     * critical: it retries with a freshly resolved thread and a thread-less
     * fallback, and escalates if the target still will not resume.
     */
    private async resumeTarget(session: vscode.DebugSession, fallbackThreadId: number): Promise<void> {
        // A 'continue' request that resolves without throwing is the reliable
        // signal that the resume was accepted. (The run-state flips to 'running'
        // optimistically the moment the request is *sent*, so it can't be trusted
        // to tell a successful resume from a rejected one.)
        for (let attempt = 0; attempt < 4; attempt++) {
            if (this.tracker.isFatal(session.id) || vscode.debug.activeDebugSession?.id !== session.id) {
                return;
            }
            const tid = (await this.resolveLiveThreadId(session)) ?? fallbackThreadId;
            try {
                // First attempts target a concrete live thread (all-stop resumes
                // everything anyway); the last attempt omits the thread id, which
                // some adapters accept as "resume all" even when no thread is live.
                const args = attempt < 3 ? { threadId: tid } : {};
                await session.customRequest('continue', args);
                return;
            } catch {
                // Try again with a re-resolved thread, then a thread-less continue.
            }
            await delay(100);
        }

        if (!this.tracker.isFatal(session.id) && vscode.debug.activeDebugSession?.id === session.id) {
            this.fatalEmitter.fire({
                session,
                message:
                    'The target could not be resumed after a live-watch sampling pause and may be halted. ' +
                    'Live polling has been stopped to avoid interfering further.'
            });
        }
    }

    private async firstThreadId(session: vscode.DebugSession): Promise<number | undefined> {
        try {
            const preferred = this.tracker.getThreadId(session.id);
            if (preferred !== undefined) {
                const ok = await this.threadExists(session, preferred);
                if (ok) {
                    return preferred;
                }
            }
        } catch {
            // Fall through to probing the thread list.
        }
        try {
            const resp = await session.customRequest('threads');
            const ids = (resp.threads ?? [])
                .map((t: any) => t?.id)
                .filter((id: any): id is number => typeof id === 'number');
            if (ids.length === 0) {
                return undefined;
            }
            // Prefer the lowest-numbered thread: GDB's primary/main thread is the
            // most stable choice, whereas the highest ids are the short-lived
            // worker / break-in threads that the target keeps spawning.
            const id = Math.min(...ids);
            this.tracker.rememberThreadId(session.id, id);
            return id;
        } catch {
            return undefined;
        }
    }

    private async topFrameId(session: vscode.DebugSession): Promise<number | undefined> {
        const threadId = await this.resolveLiveThreadId(session);
        if (threadId === undefined) {
            return undefined;
        }
        try {
            const resp = await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1
            });
            this.tracker.rememberThreadId(session.id, threadId);
            return resp.stackFrames?.[0]?.id;
        } catch {
            return undefined;
        }
    }

    private async resolveLiveThreadId(session: vscode.DebugSession): Promise<number | undefined> {
        const preferred = this.tracker.getThreadId(session.id);
        if (preferred !== undefined && (await this.threadExists(session, preferred))) {
            return preferred;
        }
        return this.firstThreadId(session);
    }

    private async threadExists(session: vscode.DebugSession, threadId: number): Promise<boolean> {
        try {
            const resp = await session.customRequest('threads');
            const alive = Array.isArray(resp.threads) && resp.threads.some((t: any) => t?.id === threadId);
            if (!alive) {
                return false;
            }
            this.tracker.rememberThreadId(session.id, threadId);
            return true;
        } catch {
            return false;
        }
    }

    dispose(): void {
        this.stop();
        this.pollingEmitter.dispose();
        this.statsEmitter.dispose();
        this.fatalEmitter.dispose();
    }
}
