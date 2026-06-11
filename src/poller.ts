import * as vscode from 'vscode';
import { LiveWatchModel } from './model';
import { DebugSessionTracker } from './tracker';

const STOP_TIMEOUT_MS = 3000;

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
    private timer?: ReturnType<typeof setInterval>;
    private busy = false;
    /** Sessions where 'auto' mode has detected that direct evaluation does not work. */
    private readonly samplingSessions = new Set<string>();

    private readonly pollingEmitter = new vscode.EventEmitter<boolean>();
    readonly onDidChangePolling = this.pollingEmitter.event;

    constructor(
        private readonly model: LiveWatchModel,
        private readonly tracker: DebugSessionTracker
    ) {}

    get polling(): boolean {
        return this.timer !== undefined;
    }

    private get intervalMs(): number {
        const ms = vscode.workspace.getConfiguration('gdbLiveWatch').get<number>('pollingInterval', 1000);
        return Math.max(100, ms);
    }

    private get mode(): 'auto' | 'nonStop' | 'sample' {
        return vscode.workspace.getConfiguration('gdbLiveWatch').get<any>('mode', 'auto');
    }

    start(): void {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        this.pollingEmitter.fire(true);
        void this.tick();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            this.pollingEmitter.fire(false);
        }
    }

    /** Restart the timer with the current configured interval. */
    restartIfPolling(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = setInterval(() => void this.tick(), this.intervalMs);
        }
    }

    forgetSession(sessionId: string): void {
        this.samplingSessions.delete(sessionId);
    }

    /** One-shot refresh, also used by the manual Refresh command. */
    async tick(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session || this.busy || this.model.isEmpty) {
            return;
        }
        this.busy = true;
        try {
            const state = this.tracker.getState(session.id);
            if (state === 'stopped') {
                const frameId = await this.topFrameId(session);
                await this.model.refresh(session, frameId);
                return;
            }

            // Treat 'running' and 'unknown' as running.
            const mode = this.mode;
            let useSampling =
                mode === 'sample' || (mode === 'auto' && this.samplingSessions.has(session.id));

            if (!useSampling) {
                const ok = await this.model.refresh(session, undefined);
                if (ok) {
                    return;
                }
                if (mode === 'auto') {
                    this.samplingSessions.add(session.id);
                    useSampling = true;
                }
            }
            if (useSampling) {
                await this.withSampledStop(session, (frameId) => this.model.refresh(session, frameId));
            }
        } catch {
            // Session may have ended mid-tick; ignore.
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
        // Wait for any in-flight poll tick to finish.
        for (let i = 0; i < 60 && this.busy; i++) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (this.busy) {
            throw new Error('live watch is busy, try again');
        }
        this.busy = true;
        try {
            const state = this.tracker.getState(session.id);
            if (state === 'stopped') {
                await this.writeAndRefresh(session, nodeId, value, await this.topFrameId(session));
                return;
            }

            const mode = this.mode;
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

            let writeError: unknown;
            const done = await this.withSampledStop(session, async (frameId) => {
                try {
                    await this.writeAndRefresh(session, nodeId, value, frameId);
                } catch (e) {
                    writeError = e;
                }
            });
            if (writeError) {
                throw writeError;
            }
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
        const threadId = this.tracker.getThreadId(session.id) ?? (await this.firstThreadId(session));
        if (threadId === undefined) {
            return false;
        }

        this.tracker.expectPause(session.id);
        const stoppedPromise = this.tracker.waitForStop(session.id, STOP_TIMEOUT_MS);
        try {
            await session.customRequest('pause', { threadId });
        } catch {
            this.tracker.cancelExpectPause(session.id);
            return false;
        }

        const stopped = await stoppedPromise;
        if (!stopped) {
            this.tracker.cancelExpectPause(session.id);
            return false;
        }

        try {
            const frameId = await this.topFrameId(session);
            await fn(frameId);
        } finally {
            // Only resume if this stop was caused by our own pause. If a breakpoint
            // or exception hit in the meantime, leave the target stopped for the user.
            if (this.tracker.consumeAutoContinue(session.id)) {
                const tid = this.tracker.getThreadId(session.id) ?? threadId;
                try {
                    await session.customRequest('continue', { threadId: tid });
                } catch {
                    // Target may have been resumed/killed elsewhere.
                }
            }
        }
        return true;
    }

    private async firstThreadId(session: vscode.DebugSession): Promise<number | undefined> {
        try {
            const resp = await session.customRequest('threads');
            return resp.threads?.[0]?.id;
        } catch {
            return undefined;
        }
    }

    private async topFrameId(session: vscode.DebugSession): Promise<number | undefined> {
        const threadId = this.tracker.getThreadId(session.id) ?? (await this.firstThreadId(session));
        if (threadId === undefined) {
            return undefined;
        }
        try {
            const resp = await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1
            });
            return resp.stackFrames?.[0]?.id;
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this.stop();
        this.pollingEmitter.dispose();
    }
}
