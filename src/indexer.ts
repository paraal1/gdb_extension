import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SymbolService } from './symbols';

const execFileAsync = promisify(execFile);

/**
 * Bakes a GDB symbol index (`.gdb_index` section) into release binaries, the
 * equivalent of GDB's `gdb-add-index` script (which is not shipped on
 * Windows). After this one-time step, GDB skips the full DWARF scan when
 * loading the binary's symbols, so every attach starts in seconds — the same
 * "index once, load fast forever" behavior winIDEA gets from its persistent
 * symbol database.
 *
 * This path is needed because GDB's built-in *index cache* only works for
 * binaries carrying a build-id, which MinGW-linked Windows binaries (e.g.
 * dSPACE model DLLs) do not have by default. Embedding the index in the file
 * itself has no such requirement.
 *
 * Per binary the steps are:
 *   1. `gdb --batch -ex "file BIN" -ex "save gdb-index DIR"` writes
 *      `DIR/BIN.gdb-index` (this is the slow DWARF scan, paid once),
 *   2. `objcopy --add-section .gdb_index=... --set-section-flags
 *      .gdb_index=readonly BIN` embeds it.
 *
 * The binary must not be in use (VEOS/host process stopped), since objcopy
 * rewrites the file in place.
 */

interface IndexResult {
    file: string;
    status: 'indexed' | 'already-indexed' | 'no-debug-info' | 'failed';
    detail?: string;
    durationMs?: number;
}

/** Resolves the GDB executable to use, from the one-click-attach setting. */
function gdbPath(): string {
    const configured = (
        vscode.workspace.getConfiguration('gdbLiveWatch').get<string>('autoAttach.miDebuggerPath') ||
        ''
    ).trim();
    return configured || 'gdb';
}

/**
 * Finds an objcopy that can rewrite PE files: prefer one shipped next to the
 * configured GDB (a matching binutils understands the same targets), then
 * fall back to PATH.
 */
async function findObjcopy(gdb: string): Promise<string | undefined> {
    const candidates: string[] = [];
    if (path.isAbsolute(gdb)) {
        candidates.push(path.join(path.dirname(gdb), 'objcopy.exe'));
        candidates.push(path.join(path.dirname(gdb), 'objcopy'));
    }
    candidates.push('objcopy');
    for (const candidate of candidates) {
        try {
            await execFileAsync(candidate, ['--version'], { windowsHide: true });
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }
    return undefined;
}

/** True when the binary already contains an embedded `.gdb_index` section. */
async function hasGdbIndexSection(objcopy: string, file: string): Promise<boolean> {
    try {
        // objcopy's sibling objdump lists sections; fall back to objcopy's
        // --dump-section probe when objdump is unavailable.
        const objdump = path.join(path.dirname(objcopy), path.basename(objcopy).replace(/objcopy/i, 'objdump'));
        const { stdout } = await execFileAsync(objdump, ['-h', file], {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024
        });
        return /\.gdb_index/.test(stdout);
    } catch {
        return false;
    }
}

async function indexOneBinary(
    gdb: string,
    objcopy: string,
    file: string,
    log: vscode.OutputChannel
): Promise<IndexResult> {
    const start = Date.now();
    if (await hasGdbIndexSection(objcopy, file)) {
        return { file, status: 'already-indexed' };
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gdb-index-'));
    try {
        // Step 1: let GDB scan the DWARF once and write the index file. The
        // binary is passed as GDB's positional program argument (not through a
        // `file` console command) so paths with spaces need no quoting. `save
        // gdb-index` takes the whole rest of the line as the directory, so the
        // temp dir needs no quoting either.
        log.appendLine('  building index (this is the slow one-time DWARF scan)...');
        let gdbOutput = '';
        try {
            const { stdout, stderr } = await execFileAsync(
                gdb,
                [
                    '--batch',
                    '-nx',
                    '-iex',
                    'set auto-load no',
                    '-iex',
                    'maintenance set worker-threads unlimited',
                    '-ex',
                    `save gdb-index ${tmpDir}`,
                    file
                ],
                { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
            );
            gdbOutput = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        } catch (e) {
            // GDB --batch exits non-zero when a command errored; keep its
            // output for the log so the real cause is visible.
            const err = e as { stdout?: string; stderr?: string; message?: string };
            gdbOutput = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || String(err.message ?? e);
        }
        if (gdbOutput) {
            for (const line of gdbOutput.split(/\r?\n/)) {
                log.appendLine(`    gdb: ${line}`);
            }
        }

        const indexFile = path.join(tmpDir, `${path.basename(file)}.gdb-index`);
        try {
            const stat = await fs.promises.stat(indexFile);
            if (stat.size === 0) {
                return { file, status: 'no-debug-info', detail: 'GDB produced an empty index' };
            }
        } catch {
            // No index file: either the binary really has no DWARF debug info
            // ("no debugging symbols found" in the GDB output above), or GDB
            // failed on it — the distinction is in the logged output.
            const noDebug = /no debugging symbols found/i.test(gdbOutput);
            return {
                file,
                status: noDebug ? 'no-debug-info' : 'failed',
                detail: noDebug
                    ? undefined
                    : `GDB produced no index — see the gdb output above (${gdbOutput.split(/\r?\n/).pop() ?? 'no output'})`
            };
        }

        // Step 2: embed the index. objcopy rewrites the file, so write to a
        // temp output first and swap it in — this both detects a locked/in-use
        // binary cleanly and never leaves a half-written file behind.
        log.appendLine(`  embedding .gdb_index section...`);
        const tmpOut = `${file}.gdb-index-tmp`;
        await execFileAsync(
            objcopy,
            [
                '--add-section',
                `.gdb_index=${indexFile}`,
                '--set-section-flags',
                '.gdb_index=readonly',
                file,
                tmpOut
            ],
            { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
        );
        try {
            await fs.promises.rename(tmpOut, file);
        } catch (e) {
            await fs.promises.rm(tmpOut, { force: true });
            throw new Error(
                `could not replace the binary (is the process still running / file in use?): ${e instanceof Error ? e.message : String(e)}`
            );
        }
        return { file, status: 'indexed', durationMs: Date.now() - start };
    } catch (e) {
        return {
            file,
            status: 'failed',
            detail: String(e instanceof Error ? e.message : e).split('\n')[0]
        };
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Collects the binaries worth indexing: the dSPACE model modules of the
 * active session (the DLL/.vap carrying the release symbols) plus the session
 * `program`. Without a session, falls back to a file picker.
 */
async function collectTargetBinaries(symbols: SymbolService): Promise<string[]> {
    const session = vscode.debug.activeDebugSession;
    const files = new Set<string>();
    if (session) {
        const cfg = session.configuration as { program?: string; executable?: string };
        const program = cfg.program ?? cfg.executable;
        if (program) {
            files.add(program);
        }
        for (const m of await symbols.getModules(session)) {
            if (m.path && /\.(dll|so|vap|exe)$/i.test(m.path)) {
                files.add(m.path);
            }
        }
    }
    if (files.size > 0) {
        return [...files];
    }
    const picked = await vscode.window.showOpenDialog({
        title: 'Select release binaries to index (host .exe and model .dll)',
        canSelectMany: true,
        filters: { 'Binaries': ['exe', 'dll', 'so', 'vap'], 'All files': ['*'] }
    });
    return (picked ?? []).map((u) => u.fsPath);
}

/**
 * Command implementation: embeds a `.gdb_index` into the binaries of the
 * current release so all future symbol loads skip the DWARF scan.
 *
 * Important: the target process must not be running while the files are
 * rewritten. When a debug session is active the binaries are collected from
 * it first, and the user is told to stop the process before continuing.
 */
export async function optimizeReleaseSymbols(
    symbols: SymbolService,
    log: vscode.OutputChannel
): Promise<void> {
    const gdb = gdbPath();
    const objcopy = await findObjcopy(gdb);
    if (!objcopy) {
        void vscode.window.showErrorMessage(
            'GDB Symbols: objcopy was not found (looked next to the configured GDB and in PATH). ' +
                'It ships with binutils/MinGW; install it or add it to PATH to use fast-index optimization.'
        );
        return;
    }

    const files = await collectTargetBinaries(symbols);
    if (files.length === 0) {
        return;
    }

    if (vscode.debug.activeDebugSession) {
        const choice = await vscode.window.showWarningMessage(
            'The binaries cannot be rewritten while the target process is running. ' +
                'Stop the debug session AND the target process (e.g. VEOS simulation), then continue.',
            { modal: true },
            'Continue anyway'
        );
        if (choice !== 'Continue anyway') {
            return;
        }
    }

    log.clear();
    log.show(true);
    log.appendLine(`Embedding GDB symbol index (.gdb_index) into ${files.length} binaries`);
    log.appendLine(`GDB: ${gdb}`);
    log.appendLine(`objcopy: ${objcopy}`);
    log.appendLine('');

    const results: IndexResult[] = [];
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'GDB Symbols: optimizing release for fast symbol loading',
            cancellable: false
        },
        async (progress) => {
            for (const file of files) {
                progress.report({ message: path.basename(file) });
                log.appendLine(`${file}`);
                const result = await indexOneBinary(gdb, objcopy, file, log);
                results.push(result);
                switch (result.status) {
                    case 'indexed':
                        log.appendLine(`  done in ${((result.durationMs ?? 0) / 1000).toFixed(1)} s`);
                        break;
                    case 'already-indexed':
                        log.appendLine('  already indexed, skipped');
                        break;
                    case 'no-debug-info':
                        log.appendLine('  no DWARF debug info, skipped');
                        break;
                    case 'failed':
                        log.appendLine(`  FAILED: ${result.detail}`);
                        break;
                }
                log.appendLine('');
            }
        }
    );

    const indexed = results.filter((r) => r.status === 'indexed').length;
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
        void vscode.window.showWarningMessage(
            `GDB Symbols: indexed ${indexed} of ${results.length} binaries; ${failed.length} failed (see the GDB Symbols output).`
        );
    } else if (indexed > 0) {
        void vscode.window.showInformationMessage(
            `GDB Symbols: embedded a symbol index into ${indexed} binaries. ` +
                'Symbol loading for this release will now skip the DWARF scan on every attach.'
        );
    } else {
        void vscode.window.showInformationMessage(
            'GDB Symbols: nothing to do — the binaries are already indexed or carry no debug info.'
        );
    }
}
