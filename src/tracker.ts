import * as vscode from 'vscode';

export type RunState = 'running' | 'stopped' | 'unknown';

interface SessionInfo {
    state: RunState;
    threadId?: number;
    /** Set by the poller right before it sends a 'pause' request for sampling. */
    expectingPause: boolean;
    /** True if the last stop was caused by our sampling pause and is safe to auto-continue. */
    autoContinueOk: boolean;
    stopWaiters: Array<(stopped: boolean) => void>;
    /** Active captures of DAP 'output' events (used to read GDB console command output). */
    outputCaptures: Set<{ chunks: string[] }>;
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
            this.stateEmitter
        );
    }

    private info(sessionId: string): SessionInfo {
        let info = this.sessions.get(sessionId);
        if (!info) {
            info = {
                state: 'unknown',
                expectingPause: false,
                autoContinueOk: false,
                stopWaiters: [],
                outputCaptures: new Set()
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
                } else if (msg.event === 'stopped') {
                    info.state = 'stopped';
                    const stopReason = String(msg.body?.reason ?? '').toLowerCase();
                    const stoppedThreadId =
                        typeof msg.body?.threadId === 'number' ? (msg.body.threadId as number) : undefined;
                    // Keep a stable preferred thread: avoid replacing it with short-lived
                    // signal/trap helper threads while the target is running.
                    if (stoppedThreadId !== undefined && (info.threadId === undefined || isRealStopReason(stopReason))) {
                        info.threadId = stoppedThreadId;
                    }
                    if (info.expectingPause) {
                        info.expectingPause = false;
                        info.autoContinueOk = !isRealStopReason(stopReason);
                    } else {
                        info.autoContinueOk = false;
                    }
                    info.stopWaiters.splice(0).forEach((w) => w(true));
                    this.stateEmitter.fire(session);
                } else if (msg.event === 'continued') {
                    info.state = 'running';
                    this.stateEmitter.fire(session);
                }
            },
            onWillReceiveMessage: (msg: any) => {
                if (msg?.type === 'request' && RESUME_REQUESTS.has(msg.command)) {
                    info.state = 'running';
                    this.stateEmitter.fire(session);
                }
            }
        };
    }

    getState(sessionId: string): RunState {
        return this.sessions.get(sessionId)?.state ?? 'unknown';
    }

    getThreadId(sessionId: string): number | undefined {
        return this.sessions.get(sessionId)?.threadId;
    }

    /** Updates the preferred live thread for subsequent stack/evaluate requests. */
    rememberThreadId(sessionId: string, threadId: number): void {
        this.info(sessionId).threadId = threadId;
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
