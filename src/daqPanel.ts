import * as vscode from 'vscode';
import { DaqEngine } from './daq';

/**
 * Singleton webview panel hosting the DAQ chart + data table UI
 * (daqIDEA-style data acquisition view).
 */
export class DaqPanelManager implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private readonly engineSubs: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly engine: DaqEngine
    ) {
        this.engineSubs.push(
            engine.onDidChangeConfig(() => this.postConfig()),
            engine.onDidAppendSamples((batch) => {
                void this.panel?.webview.postMessage({ type: 'samples', ...batch });
            }),
            engine.onDidClearData(() => {
                void this.panel?.webview.postMessage({ type: 'clear' });
            })
        );
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gdbDaq',
            'DAQ Chart',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
            }
        );
        this.panel = panel;
        panel.webview.html = this.html(panel.webview);

        panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
        panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    private async onMessage(msg: any): Promise<void> {
        switch (msg?.type) {
            case 'ready':
                this.postSnapshot();
                break;
            case 'start':
                try {
                    this.engine.start();
                } catch (e: any) {
                    void vscode.window.showWarningMessage(`DAQ: ${String(e?.message ?? e)}`);
                }
                break;
            case 'stop':
                this.engine.stop();
                break;
            case 'setPeriod':
                this.engine.setSamplingPeriod(Number(msg.ms) || 0);
                break;
            case 'addVariable':
                if (typeof msg.expression === 'string') {
                    this.engine.addVariable(msg.expression);
                }
                break;
            case 'removeVariable':
                this.engine.removeVariable(String(msg.id));
                break;
            case 'setEnabled':
                this.engine.setVariableEnabled(String(msg.id), !!msg.enabled);
                break;
            case 'clear':
                this.engine.clearData();
                break;
            case 'export':
                await this.exportData();
                break;
            case 'saveConfig':
                await this.saveConfig();
                break;
            case 'loadConfig':
                await this.loadConfig();
                break;
        }
    }

    private postConfig(): void {
        if (!this.panel) {
            return;
        }
        const snap = this.engine.snapshot();
        void this.panel.webview.postMessage({
            type: 'config',
            recording: snap.recording,
            periodMs: snap.periodMs,
            maxSamples: snap.maxSamples,
            variables: snap.variables
        });
    }

    private postSnapshot(): void {
        if (!this.panel) {
            return;
        }
        void this.panel.webview.postMessage({ type: 'snapshot', ...this.engine.snapshot() });
    }

    // ---- export -------------------------------------------------------------

    private async exportData(): Promise<void> {
        const snap = this.engine.snapshot();
        if (snap.t.length === 0) {
            void vscode.window.showWarningMessage('DAQ: no acquired data to export.');
            return;
        }
        const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
            title: 'Export acquired DAQ data',
            defaultUri: defaultDir ? vscode.Uri.joinPath(defaultDir, 'daq-data.csv') : undefined,
            filters: {
                'CSV (Excel compatible)': ['csv'],
                'Tab-separated text': ['txt']
            }
        });
        if (!uri) {
            return;
        }
        const sep = uri.fsPath.toLowerCase().endsWith('.txt') ? '\t' : ',';
        const vars = snap.variables;
        const lines: string[] = [];
        lines.push(['time [s]', ...vars.map((v) => csvField(v.expression, sep))].join(sep));
        for (let i = 0; i < snap.t.length; i++) {
            const row = [snap.t[i].toFixed(6)];
            for (const v of vars) {
                const value = snap.series[v.id]?.[i];
                row.push(value === null || value === undefined ? '' : String(value));
            }
            lines.push(row.join(sep));
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
        void vscode.window.showInformationMessage(
            `DAQ: exported ${snap.t.length} samples to ${uri.fsPath}`
        );
    }

    // ---- variable configuration files ----------------------------------------

    private async saveConfig(): Promise<void> {
        const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
            title: 'Save DAQ variable configuration',
            defaultUri: defaultDir ? vscode.Uri.joinPath(defaultDir, 'daq-config.json') : undefined,
            filters: { 'DAQ configuration (JSON)': ['json'] }
        });
        if (!uri) {
            return;
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(this.engine.exportConfig(), 'utf8'));
        void vscode.window.showInformationMessage(`DAQ: configuration saved to ${uri.fsPath}`);
    }

    private async loadConfig(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            title: 'Load DAQ variable configuration',
            canSelectMany: false,
            filters: { 'DAQ configuration (JSON)': ['json'] }
        });
        if (!picked || picked.length === 0) {
            return;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(picked[0]);
            this.engine.importConfig(Buffer.from(bytes).toString('utf8'));
            this.postSnapshot();
        } catch (e: any) {
            void vscode.window.showErrorMessage(
                `DAQ: failed to load configuration: ${String(e?.message ?? e)}`
            );
        }
    }

    // ---- html ------------------------------------------------------------------

    private html(webview: vscode.Webview): string {
        const mediaUri = (file: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
        const nonce = makeNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${mediaUri('daq.css')}">
<title>DAQ Chart</title>
</head>
<body>
<div id="toolbar">
    <button id="btnStart" title="Start acquisition">&#9654; Start</button>
    <button id="btnStop" title="Stop acquisition" disabled>&#9632; Stop</button>
    <label for="period">Sampling:</label>
    <select id="period">
        <option value="0">max</option>
        <option value="1">1 ms</option>
        <option value="10">10 ms</option>
        <option value="100">100 ms</option>
        <option value="1000">1 s</option>
    </select>
    <span class="sep"></span>
    <button id="btnFit" title="Reset zoom: fit all acquired data">Fit</button>
    <button id="btnClear" title="Discard acquired data">Clear</button>
    <span class="sep"></span>
    <button id="btnExport" title="Export acquired data (CSV / text)">Export&hellip;</button>
    <button id="btnSaveCfg" title="Save variable configuration to a file">Save Config&hellip;</button>
    <button id="btnLoadCfg" title="Load variable configuration from a file">Load Config&hellip;</button>
    <span id="status"></span>
</div>
<div id="chartArea">
    <canvas id="chart"></canvas>
    <div id="hint">wheel: zoom time &middot; shift+wheel: zoom value &middot; drag: pan &middot; double-click: fit latest data</div>
</div>
<div id="bottom">
    <div id="varsPanel">
        <div class="panelTitle">Variables</div>
        <div id="varList"></div>
        <div id="addRow">
            <input id="addInput" type="text" placeholder="expression, e.g. motor.speed" />
            <button id="btnAdd">Add</button>
        </div>
    </div>
    <div id="tablePanel">
        <div class="panelTitle">Acquired data</div>
        <div id="tableWrap">
            <table id="dataTable"><thead></thead><tbody></tbody></table>
        </div>
    </div>
</div>
<script nonce="${nonce}" src="${mediaUri('daq.js')}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this.engineSubs.forEach((d) => d.dispose());
        this.panel?.dispose();
    }
}

function csvField(value: string, sep: string): string {
    return value.includes(sep) || value.includes('"')
        ? `"${value.replace(/"/g, '""')}"`
        : value;
}

function makeNonce(): string {
    let s = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
}
