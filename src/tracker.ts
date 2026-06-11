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
}

/** Stop reasons that mean "something real happened" - never auto-continue past these. */
const REAL_STOP_REASONS = ['breakpoint', 'exception', 'step', 'entry', 'assert', 'watchpoint'];

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
            info = { state: 'unknown', expectingPause: false, autoContinueOk: false, stopWaiters: [] };
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
                if (msg.event === 'stopped') {
                    info.state = 'stopped';
                    if (typeof msg.body?.threadId === 'number') {
                        info.threadId = msg.body.threadId;
                    }
                    if (info.expectingPause) {
                        info.expectingPause = false;
                        const reason = String(msg.body?.reason ?? '').toLowerCase();
                        info.autoContinueOk = !REAL_STOP_REASONS.some((r) => reason.includes(r));
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

    /** Resolves true when the session reports a 'stopped' event, false on timeout/termination. */
    waitForStop(sessionId: string, timeoutMs: number): Promise<boolean> {
        const info = this.info(sessionId);
        if (info.state === 'stopped') {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                const idx = info.stopWaiters.indexOf(waiter);
                if (idx >= 0) {
                    info.stopWaiters.splice(idx, 1);
                }
                resolve(false);
            }, timeoutMs);
            const waiter = (stopped: boolean) => {
                clearTimeout(timer);
                resolve(stopped);
            };
            info.stopWaiters.push(waiter);
        });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.sessions.clear();
    }
}
