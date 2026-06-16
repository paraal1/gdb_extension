import * as vscode from 'vscode';

export type RunState = 'running' | 'stopped' | 'unknown';

interface SessionInfo {
    state: RunState;
    threadId?: number;
    /** Set by the poller right before it sends a 'pause' request for sampling. */
    expectingPause: boolean;
    /** True if the last stop was caused by our sampling pause and is safe to auto-continue. */
    autoContinueOk: boolean;
    /**
     * True while the user has resumed the target (Continue/Step) and it has not
     * yet reached a real stop. While set, the sampler must not pause the target,
     * so the program can run unhindered to a breakpoint instead of being caught
     * at a random PC.
     */
    freeRunning: boolean;
    /**
     * >0 while the poller is issuing its own sampling 'continue'. Those resumes
     * must not be mistaken for a user-initiated run (which would arm freeRunning).
     */
    samplerResumeDepth: number;
    stopWaiters: Array<(stopped: boolean) => void>;
    /** Active captures of DAP 'output' events (used to read GDB console command output). */
    outputCaptures: Set<{ chunks: string[] }>;
    /** True once the adapter reported a fatal break-state error (session is dying). */
    fatal: boolean;
}

export interface OutputCapture {
    /** Current captured text without ending the capture. */
    peek(): string;
    /** Stops capturing and returns everything captured so far. */
    stop(): string;
}

/** Stop reasons that mean "something real happened" - never auto-continue past these. */
const REAL_STOP_REASONS = ['breakpoint', 'exception', 'step', 'entry', 'assert', 'watchpoint'];

function isRealStopReason(reason: string): boolean {
    return REAL_STOP_REASONS.some((r) => reason.includes(r));
}

/**
 * Adapter (MIEngine / cppdbg) messages that mean the debug engine itself has
 * failed and the session is about to be torn down. The most important one on
 * native Windows GDB is the break-in race: a sampling 'pause' makes Windows
 * inject a transient break-in thread (ntdll!DbgBreakPoint) that GDB stops on
 * and that then exits immediately, so MIEngine "Fail[s] to find thread N for
 * break event" and stops debugging. We can't intercept that inside MIEngine,
 * but detecting it lets us stop issuing further pauses and tell the user how to
 * avoid it.
 */
const FATAL_ADAPTER_PATTERNS = [
    /failed to find thread\s+\d+\s+for break event/i,
    /error while trying to enter break state/i
];

function isFatalAdapterMessage(text: string): boolean {
    return FATAL_ADAPTER_PATTERNS.some((re) => re.test(text));
}

const RESUME_REQUESTS = new Set([
    'continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto', 'restart'
]);

/**
 * Tracks the run state (running/stopped) of every debug session by observing
 * the DAP message stream via a DebugAdapterTracker.
 */
export class DebugSessionTracker implements vscode.Disposable {
    private readonly sessions = new Map<string, SessionInfo>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly stateEmitter = new vscode.EventEmitter<vscode.DebugSession>();
    readonly onDidChangeState = this.stateEmitter.event;

    private readonly fatalEmitter = new vscode.EventEmitter<vscode.DebugSession>();
    /**
     * Fires when the underlying debug engine reports a fatal break-state error
     * (e.g. the native-Windows break-in thread race). The session is dying;
     * listeners should stop sampling immediately and surface guidance.
     */
    readonly onDidEncounterFatalError = this.fatalEmitter.event;

    constructor() {
        this.disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker: (session) => this.createTracker(session)
            }),
            vscode.debug.onDidTerminateDebugSession((s) => {
                const info = this.sessions.get(s.id);
                if (info) {
                    info.stopWaiters.forEach((w) => w(false));
                    this.sessions.delete(s.id);
                }
            }),
            this.stateEmitter,
            this.fatalEmitter
        );
    }

    private info(sessionId: string): SessionInfo {
        let info = this.sessions.get(sessionId);
        if (!info) {
            info = {
                state: 'unknown',
                expectingPause: false,
                autoContinueOk: false,
                freeRunning: false,
                samplerResumeDepth: 0,
                stopWaiters: [],
                outputCaptures: new Set(),
                fatal: false
            };
            this.sessions.set(sessionId, info);
        }
        return info;
    }

    private createTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        const info = this.info(session.id);
        return {
            onDidSendMessage: (msg: any) => {
                if (msg?.type !== 'event') {
                    return;
                }
                if (msg.event === 'output' && typeof msg.body?.output === 'string') {
                    info.outputCaptures.forEach((c) => c.chunks.push(msg.body.output));
                    if (!info.fatal && isFatalAdapterMessage(msg.body.output)) {
                        info.fatal = true;
                        // Wake any sampling cycle waiting on a stop so it stops promptly.
                        info.stopWaiters.splice(0).forEach((w) => w(false));
                        this.fatalEmitter.fire(session);
                    }
                } else if (msg.event === 'stopped') {
                    info.state = 'stopped';
                    // Any stop ends a user free-run: either a real breakpoint was
                    // reached (the goal) or the target halted for some other reason.
                    info.freeRunning = false;
                    const stopReason = String(msg.body?.reason ?? '').toLowerCase();
                    const real = isRealStopReason(stopReason);
                    const stoppedThreadId =
                        typeof msg.body?.threadId === 'number' ? (msg.body.threadId as number) : undefined;
                    // Adopt the stopped thread as the preferred one only for *real*
                    // stops (breakpoint / step / exception / entry). A sampling pause
                    // on Windows stops on a transient break-in thread that exits
                    // immediately; latching onto it would poison every later stack /
                    // evaluate request ("cannot execute this command without a live
                    // selective thread"). For sampling stops we let the poller resolve
                    // a live thread from the current thread list instead.
                    if (stoppedThreadId !== undefined && real) {
                        info.threadId = stoppedThreadId;
                    }
                    if (info.expectingPause) {
                        info.expectingPause = false;
                        info.autoContinueOk = !real;
                    } else {
                        info.autoContinueOk = false;
                    }
                    info.stopWaiters.splice(0).forEach((w) => w(true));
                    this.stateEmitter.fire(session);
                } else if (msg.event === 'continued') {
                    info.state = 'running';
                    this.stateEmitter.fire(session);
                } else if (msg.event === 'thread' && msg.body?.reason === 'exited') {
                    // The target churns worker threads; if our preferred thread just
                    // exited, forget it so the next read re-resolves a live one.
                    const exitedId =
                        typeof msg.body?.threadId === 'number' ? (msg.body.threadId as number) : undefined;
                    if (exitedId !== undefined && info.threadId === exitedId) {
                        info.threadId = undefined;
                    }
                }
            },
            onWillReceiveMessage: (msg: any) => {
                if (msg?.type === 'request' && RESUME_REQUESTS.has(msg.command)) {
                    info.state = 'running';
                    // A resume the poller did not issue itself is a user-initiated
                    // run (Continue/Step/Restart). Arm free-running so the sampler
                    // backs off and lets the target reach a breakpoint.
                    if (info.samplerResumeDepth === 0) {
                        info.freeRunning = true;
                    }
                    this.stateEmitter.fire(session);
                }
            }
        };
    }

    getState(sessionId: string): RunState {
        return this.sessions.get(sessionId)?.state ?? 'unknown';
    }

    /** True once the adapter reported a fatal break-state error for this session. */
    isFatal(sessionId: string): boolean {
        return this.sessions.get(sessionId)?.fatal ?? false;
    }

    getThreadId(sessionId: string): number | undefined {
        return this.sessions.get(sessionId)?.threadId;
    }

    /** Updates the preferred live thread for subsequent stack/evaluate requests. */
    rememberThreadId(sessionId: string, threadId: number): void {
        this.info(sessionId).threadId = threadId;
    }

    /** Drops the preferred thread so the next read re-resolves a live one. */
    forgetThreadId(sessionId: string): void {
        const info = this.sessions.get(sessionId);
        if (info) {
            info.threadId = undefined;
        }
    }

    /**
     * True while the user resumed the target and it has not yet hit a real stop
     * (breakpoint/step/exception). The poller uses this to suspend sampling
     * pauses so a user "Continue" reaches its breakpoint instead of being caught
     * by a sampling pause at an unrelated location.
     */
    isFreeRunning(sessionId: string): boolean {
        return this.sessions.get(sessionId)?.freeRunning ?? false;
    }

    /** Bracket a 'continue' the poller issues itself so it is not seen as a user run. */
    beginSamplerResume(sessionId: string): void {
        this.info(sessionId).samplerResumeDepth++;
    }

    endSamplerResume(sessionId: string): void {
        const info = this.sessions.get(sessionId);
        if (info && info.samplerResumeDepth > 0) {
            info.samplerResumeDepth--;
        }
    }

    /** Arm the "next pause stop is ours" flag before sending a sampling pause. */
    expectPause(sessionId: string): void {
        this.info(sessionId).expectingPause = true;
    }

    cancelExpectPause(sessionId: string): void {
        const info = this.sessions.get(sessionId);
        if (info) {
            info.expectingPause = false;
        }
    }

    /** Returns (and consumes) whether the last stop may be auto-continued by the sampler. */
    consumeAutoContinue(sessionId: string): boolean {
        const info = this.sessions.get(sessionId);
        if (!info) {
            return false;
        }
        const ok = info.autoContinueOk;
        info.autoContinueOk = false;
        return ok;
    }

    /**
     * Starts capturing DAP 'output' events for a session. Used to collect the
     * console output of GDB commands (e.g. 'info variables'), which some
     * adapters report as output events instead of the evaluate response.
     */
    startOutputCapture(sessionId: string): OutputCapture {
        const info = this.info(sessionId);
        const capture = { chunks: [] as string[] };
        info.outputCaptures.add(capture);
        return {
            peek: () => capture.chunks.join(''),
            stop: () => {
                info.outputCaptures.delete(capture);
                return capture.chunks.join('');
            }
        };
    }

    /**
     * Waits for the session to report a 'stopped' event.
     *
     * Returns a handle whose `promise` resolves to true on a stop, or false on
     * timeout/termination. Call `cancel()` to abandon the wait early (e.g. when
     * the triggering 'pause' request failed); this removes the registered waiter
     * and clears its timer so nothing lingers.
     */
    waitForStop(sessionId: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
        const info = this.info(sessionId);
        if (info.state === 'stopped') {
            return { promise: Promise.resolve(true), cancel: () => {} };
        }

        let settle!: (stopped: boolean) => void;
        let timer: ReturnType<typeof setTimeout>;
        const remove = (waiter: (stopped: boolean) => void) => {
            const idx = info.stopWaiters.indexOf(waiter);
            if (idx >= 0) {
                info.stopWaiters.splice(idx, 1);
            }
        };

        const promise = new Promise<boolean>((resolve) => {
            const waiter = (stopped: boolean) => {
                clearTimeout(timer);
                resolve(stopped);
            };
            settle = (stopped: boolean) => {
                clearTimeout(timer);
                remove(waiter);
                resolve(stopped);
            };
            timer = setTimeout(() => {
                remove(waiter);
                resolve(false);
            }, timeoutMs);
            info.stopWaiters.push(waiter);
        });

        return { promise, cancel: () => settle(false) };
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.sessions.clear();
    }
}
