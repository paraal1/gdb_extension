import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface ProcInfo {
    processId: number;
    executablePath?: string;
}

/**
 * Finds the most recently started running process whose image name matches
 * `processName` (with or without a trailing `.exe`). Uses a single PowerShell /
 * CIM query so the call stays dependency-free and returns the executable path
 * GDB needs as the `program` of a cppdbg attach.
 */
async function findLatestProcess(processName: string): Promise<ProcInfo | undefined> {
    const name = processName.toLowerCase().endsWith('.exe') ? processName : `${processName}.exe`;
    // WQL string literals are single-quoted; escape embedded single quotes.
    const safeName = name.replace(/'/g, "''");
    const script =
        `$ErrorActionPreference='Stop';` +
        `$p = Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | ` +
        `Sort-Object CreationDate -Descending | Select-Object -First 1 ProcessId, ExecutablePath;` +
        `if ($p) { $p | ConvertTo-Json -Compress }`;

    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }
    );

    const text = stdout.trim();
    if (!text) {
        return undefined;
    }
    const parsed = JSON.parse(text) as { ProcessId: number; ExecutablePath?: string | null };
    if (!parsed?.ProcessId) {
        return undefined;
    }
    return {
        processId: parsed.ProcessId,
        executablePath: parsed.ExecutablePath ?? undefined
    };
}

/**
 * GDB commands that make symbol loading fast across sessions, prepended to the
 * attach `setupCommands` (see `withFastSymbolLoad`). The key one is the GDB
 * *index cache*: by default GDB re-scans the entire DWARF debug info of every
 * binary on every attach, which for a large model DLL takes tens of seconds.
 * With the index cache enabled, that scan happens once per binary and the
 * resulting index is persisted on disk keyed by the binary's build id — every
 * later attach to the same release maps it back in and symbol loading drops to
 * seconds. This is the same trick winIDEA uses (its own persistent symbol
 * database) expressed in GDB terms.
 *
 * All commands carry `ignoreFailures` since their availability depends on the
 * GDB version ('set index-cache enabled' is GDB >= 12, 'set index-cache on'
 * is the GDB 8.3-11 spelling, debuginfod exists from GDB 10.1, worker-threads
 * from GDB 9).
 */
const FAST_SYMBOL_LOAD_COMMANDS = [
    {
        description: 'Persist the symbol index across sessions (GDB >= 12)',
        text: 'set index-cache enabled on',
        ignoreFailures: true
    },
    {
        description: 'Persist the symbol index across sessions (GDB 8.3-11)',
        text: 'set index-cache on',
        ignoreFailures: true
    },
    {
        description: 'Never stall symbol loading on debuginfod server lookups',
        text: 'set debuginfod enabled off',
        ignoreFailures: true
    },
    {
        description: 'Index debug info with all available cores',
        text: 'maintenance set worker-threads unlimited',
        ignoreFailures: true
    }
];

/**
 * Prepends the fast-symbol-load GDB commands to the user's setup commands,
 * unless disabled via `gdbLiveWatch.autoAttach.fastSymbolLoad` or the user
 * already manages the index cache themselves. Prepending (not appending)
 * ensures the cache is enabled before any command that could trigger symbol
 * reading.
 */
function withFastSymbolLoad(setupCommands: object[]): object[] {
    const enabled = vscode.workspace
        .getConfiguration('gdbLiveWatch')
        .get<boolean>('autoAttach.fastSymbolLoad', true);
    if (!enabled) {
        return setupCommands;
    }
    // Only an actual cache-configuration command ("set index-cache ...")
    // counts as the user managing the cache; diagnostic commands such as
    // "set debug index-cache on" must not suppress the fast-load commands.
    const userManagesCache = setupCommands.some((c) =>
        /^\s*set\s+index-cache\b/.test(String((c as { text?: unknown })?.text ?? ''))
    );
    if (userManagesCache) {
        return setupCommands;
    }
    return [...FAST_SYMBOL_LOAD_COMMANDS, ...setupCommands];
}

/**
 * One-click auto-attach: locates the configured target process, resolves its
 * executable, and starts a `cppdbg` GDB attach session — no process picker, no
 * manual launch config. The Live Watch / Symbols / DAQ panels then light up
 * through the extension's normal session lifecycle handling.
 */
export async function attachToConfiguredProcess(): Promise<void> {
    if (process.platform !== 'win32') {
        void vscode.window.showErrorMessage(
            'GDB Live Watch: one-click attach currently supports Windows only.'
        );
        return;
    }

    const cfg = vscode.workspace.getConfiguration('gdbLiveWatch');
    const configName = (cfg.get<string>('autoAttach.configName') || '').trim();
    const programOverride = (cfg.get<string>('autoAttach.program') || '').trim();
    const miDebuggerPath = (cfg.get<string>('autoAttach.miDebuggerPath') || '').trim();
    const setupCommands = cfg.get<object[]>('autoAttach.setupCommands') ?? [];

    // launch.json is entirely optional: it is only consulted when the user
    // explicitly names a configuration to reuse via `autoAttach.configName`.
    // Otherwise the attach config is built directly from the settings below,
    // so no launch.json is required at all.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const launchMatch = configName ? findAttachLaunchConfig(folder, configName) : undefined;
    if (configName && !launchMatch) {
        void vscode.window.showErrorMessage(
            `GDB Live Watch: no attach configuration named "${configName}" was found in launch.json.`
        );
        return;
    }

    // The process name to look up: explicit setting wins, else derive it from
    // the program (override or reused config), else fall back to the default.
    const programForName = programOverride || launchMatch?.config.program;
    const processName =
        (cfg.get<string>('autoAttach.processName') || '').trim() ||
        (typeof programForName === 'string' ? basename(programForName) : '') ||
        'VeosVpuHost.exe';

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `GDB Live Watch: attaching to ${processName}...`
        },
        async () => {
            let proc: ProcInfo | undefined;
            try {
                proc = await findLatestProcess(processName);
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `GDB Live Watch: failed to enumerate processes: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }

            if (!proc) {
                void vscode.window.showErrorMessage(
                    `GDB Live Watch: no running process named "${processName}" was found.`
                );
                return;
            }

            let config: vscode.DebugConfiguration;
            if (launchMatch) {
                // Reuse the named launch.json config; clone so we never mutate it.
                config = JSON.parse(JSON.stringify(launchMatch.config)) as vscode.DebugConfiguration;
                config.processId = proc.processId;
                if (programOverride) {
                    config.program = programOverride;
                }
                config.setupCommands = withFastSymbolLoad(
                    Array.isArray(config.setupCommands) ? config.setupCommands : []
                );
            } else {
                // Build the attach config entirely from settings — no launch.json.
                const program = programOverride || proc.executablePath;
                if (!program) {
                    void vscode.window.showErrorMessage(
                        `GDB Live Watch: could not resolve the executable path for "${processName}" (PID ${proc.processId}). ` +
                            'Set "gdbLiveWatch.autoAttach.program" to the binary path.'
                    );
                    return;
                }
                config = {
                    type: 'cppdbg',
                    request: 'attach',
                    name: `GDB Live Watch: attach ${processName} (${proc.processId})`,
                    program,
                    processId: proc.processId,
                    MIMode: 'gdb',
                    setupCommands: withFastSymbolLoad(setupCommands)
                };
            }
            if (miDebuggerPath) {
                // Always honour an explicit override of the GDB path.
                config.miDebuggerPath = miDebuggerPath;
            }
            config.name = `GDB Live Watch: attach ${processName} (${proc.processId})`;

            const ok = await vscode.debug.startDebugging(folder, config);
            if (!ok) {
                void vscode.window.showErrorMessage(
                    `GDB Live Watch: failed to start the attach session for "${processName}" (PID ${proc.processId}). ` +
                        'Check that the C/C++ extension (cppdbg) and GDB are available.'
                );
            }
        }
    );
}

/** Basename of a Windows or POSIX path (avoids importing `path` just for this). */
function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/**
 * Locates a GDB attach configuration in the workspace's launch.json. When
 * `configName` is set, only that configuration is matched; otherwise the first
 * `cppdbg` (or `gdb`) attach configuration is used.
 */
function findAttachLaunchConfig(
    folder: vscode.WorkspaceFolder | undefined,
    configName: string
): { config: vscode.DebugConfiguration } | undefined {
    const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
    const configs = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
    const isAttach = (c: vscode.DebugConfiguration) =>
        c?.request === 'attach' && (c.type === 'cppdbg' || c.type === 'gdb');

    const match = configName
        ? configs.find((c) => c?.name === configName)
        : configs.find(isAttach);

    return match && isAttach(match) ? { config: match } : undefined;
}

interface SettingField {
    key: string;
    label: string;
    prompt: string;
    placeholder?: string;
    kind: 'string' | 'json';
}

const AUTO_ATTACH_FIELDS: SettingField[] = [
    {
        key: 'autoAttach.processName',
        label: 'Process name',
        prompt: 'Image name of the target process to attach to (trailing .exe optional)',
        placeholder: 'e.g. VeosVpuHost.exe',
        kind: 'string'
    },
    {
        key: 'autoAttach.miDebuggerPath',
        label: 'GDB path (miDebuggerPath)',
        prompt: 'Absolute path to the GDB executable (leave empty to use the C/C++ extension default)',
        placeholder: 'e.g. C:/winIDEA/gdb_multiarch/gdb.exe',
        kind: 'string'
    },
    {
        key: 'autoAttach.program',
        label: 'Program (executable path)',
        prompt: 'Optional path to the target executable (leave empty to resolve from the running process)',
        placeholder: 'e.g. C:/Program Files/.../VeosVpuHost.exe',
        kind: 'string'
    },
    {
        key: 'autoAttach.configName',
        label: 'launch.json config name',
        prompt: 'Optional name of a launch.json attach config to reuse (leave empty to build from these settings)',
        placeholder: 'e.g. C/C++ Debug (gdb Attach)',
        kind: 'string'
    },
    {
        key: 'autoAttach.setupCommands',
        label: 'GDB setup commands (JSON array)',
        prompt: 'JSON array of cppdbg setupCommands',
        placeholder: '[{"text":"-enable-pretty-printing","ignoreFailures":true}]',
        kind: 'json'
    }
];

/**
 * Interactive configuration UI for the one-click attach: a pick list of every
 * auto-attach setting with its current value, where selecting an entry opens an
 * input box to edit it. Avoids hand-editing settings.json and offers to attach
 * right after configuring.
 */
export async function configureAutoAttach(): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    for (;;) {
        const cfg = vscode.workspace.getConfiguration('gdbLiveWatch');
        const items: (vscode.QuickPickItem & { field?: SettingField; action?: 'attach' | 'settings' })[] =
            AUTO_ATTACH_FIELDS.map((field) => {
                const value = cfg.get(field.key);
                return {
                    label: field.label,
                    description: describeValue(value),
                    field
                };
            });
        items.push(
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(plug) Attach now', description: 'Attach GDB using the settings above', action: 'attach' },
            { label: '$(gear) Open Settings UI', description: 'Edit in the VS Code settings editor', action: 'settings' }
        );

        const choice = await vscode.window.showQuickPick(items, {
            title: 'Configure GDB Live Watch — auto attach',
            placeHolder: 'Pick a setting to edit'
        });
        if (!choice) {
            return;
        }
        if (choice.action === 'attach') {
            await attachToConfiguredProcess();
            return;
        }
        if (choice.action === 'settings') {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'gdbLiveWatch.autoAttach'
            );
            return;
        }

        const field = choice.field!;
        const current = cfg.get(field.key);
        if (field.kind === 'json') {
            const input = await vscode.window.showInputBox({
                title: field.label,
                prompt: field.prompt,
                placeHolder: field.placeholder,
                value: JSON.stringify(current ?? []),
                validateInput: (v) => {
                    const t = v.trim();
                    if (!t) {
                        return undefined;
                    }
                    try {
                        const parsed = JSON.parse(t);
                        return Array.isArray(parsed) ? undefined : 'Must be a JSON array.';
                    } catch {
                        return 'Invalid JSON.';
                    }
                }
            });
            if (input === undefined) {
                continue;
            }
            const trimmed = input.trim();
            await cfg.update(field.key, trimmed ? JSON.parse(trimmed) : [], target);
        } else {
            const input = await vscode.window.showInputBox({
                title: field.label,
                prompt: field.prompt,
                placeHolder: field.placeholder,
                value: typeof current === 'string' ? current : ''
            });
            if (input === undefined) {
                continue;
            }
            await cfg.update(field.key, input.trim(), target);
        }
    }
}

/** Short, human-readable summary of a setting value for the pick list. */
function describeValue(value: unknown): string {
    if (value === undefined || value === null || value === '') {
        return '(not set)';
    }
    if (Array.isArray(value)) {
        return `${value.length} command(s)`;
    }
    return String(value);
}

