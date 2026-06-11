// DAQ chart + data table webview (daqIDEA-style).
// Communicates with the extension host via postMessage; all acquired data is
// mirrored here so the chart can redraw without round-trips.
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ---- mirrored state ------------------------------------------------------

    /** @type {{id:string, expression:string, enabled:boolean, color:string, lastRaw:string, lastValue:number|null}[]} */
    let variables = [];
    /** @type {number[]} */
    let times = [];
    /** @type {Map<string, (number|null)[]>} */
    const series = new Map();
    let recording = false;
    let periodMs = 100;
    let maxSamples = 100000;

    const MAX_TABLE_ROWS = 200;

    // ---- elements --------------------------------------------------------------

    const $ = (id) => document.getElementById(id);
    const btnStart = $('btnStart');
    const btnStop = $('btnStop');
    const btnFit = $('btnFit');
    const btnClear = $('btnClear');
    const btnExport = $('btnExport');
    const btnSaveCfg = $('btnSaveCfg');
    const btnLoadCfg = $('btnLoadCfg');
    const periodSelect = $('period');
    const statusEl = $('status');
    const varListEl = $('varList');
    const addInput = $('addInput');
    const btnAdd = $('btnAdd');
    const tableHead = document.querySelector('#dataTable thead');
    const tableBody = document.querySelector('#dataTable tbody');
    const canvas = $('chart');
    const ctx = canvas.getContext('2d');

    // ---- toolbar -----------------------------------------------------------------

    btnStart.addEventListener('click', () => vscode.postMessage({ type: 'start' }));
    btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    btnClear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    btnExport.addEventListener('click', () => vscode.postMessage({ type: 'export' }));
    btnSaveCfg.addEventListener('click', () => vscode.postMessage({ type: 'saveConfig' }));
    btnLoadCfg.addEventListener('click', () => vscode.postMessage({ type: 'loadConfig' }));
    btnFit.addEventListener('click', () => { view.auto = true; requestRender(); });
    periodSelect.addEventListener('change', () =>
        vscode.postMessage({ type: 'setPeriod', ms: Number(periodSelect.value) })
    );

    const addVariable = () => {
        const expr = addInput.value.trim();
        if (expr) {
            vscode.postMessage({ type: 'addVariable', expression: expr });
            addInput.value = '';
        }
    };
    btnAdd.addEventListener('click', addVariable);
    addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            addVariable();
        }
    });

    // ---- messages from the extension ------------------------------------------------

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'snapshot':
                variables = msg.variables;
                recording = msg.recording;
                periodMs = msg.periodMs;
                maxSamples = msg.maxSamples;
                times = msg.t.slice();
                series.clear();
                for (const v of variables) {
                    series.set(v.id, (msg.series[v.id] || []).slice());
                }
                renderAll();
                break;

            case 'config':
                variables = msg.variables;
                recording = msg.recording;
                periodMs = msg.periodMs;
                maxSamples = msg.maxSamples;
                // Reconcile series columns with the variable list.
                for (const v of variables) {
                    if (!series.has(v.id)) {
                        series.set(v.id, new Array(times.length).fill(null));
                    }
                }
                for (const id of Array.from(series.keys())) {
                    if (!variables.some((v) => v.id === id)) {
                        series.delete(id);
                    }
                }
                renderAll();
                break;

            case 'samples': {
                for (let i = 0; i < msg.t.length; i++) {
                    times.push(msg.t[i]);
                }
                for (const v of variables) {
                    const col = series.get(v.id);
                    if (!col) { continue; }
                    const incoming = msg.series[v.id] || [];
                    for (let i = 0; i < msg.t.length; i++) {
                        col.push(i < incoming.length ? incoming[i] : null);
                    }
                    if (incoming.length) {
                        v.lastValue = incoming[incoming.length - 1];
                    }
                }
                if (times.length > maxSamples) {
                    const drop = times.length - maxSamples;
                    times.splice(0, drop);
                    for (const col of series.values()) {
                        col.splice(0, drop);
                    }
                }
                renderStatus();
                renderTable();
                renderVarValues();
                requestRender();
                break;
            }

            case 'clear':
                times = [];
                for (const id of series.keys()) {
                    series.set(id, []);
                }
                view.auto = true;
                renderAll();
                break;
        }
    });

    // ---- variables panel --------------------------------------------------------------

    function renderVars() {
        varListEl.textContent = '';
        for (const v of variables) {
            const row = document.createElement('div');
            row.className = 'varRow';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = v.enabled;
            cb.title = 'Acquire and display this variable';
            cb.addEventListener('change', () =>
                vscode.postMessage({ type: 'setEnabled', id: v.id, enabled: cb.checked })
            );

            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.background = v.color;

            const expr = document.createElement('span');
            expr.className = 'expr' + (v.enabled ? '' : ' disabled');
            expr.textContent = v.expression;
            expr.title = v.expression;

            const val = document.createElement('span');
            val.className = 'val';
            val.dataset.varId = v.id;
            val.textContent = formatLast(v);

            const remove = document.createElement('button');
            remove.className = 'remove';
            remove.textContent = '\u2715';
            remove.title = 'Remove variable';
            remove.addEventListener('click', () =>
                vscode.postMessage({ type: 'removeVariable', id: v.id })
            );

            row.append(cb, swatch, expr, val, remove);
            varListEl.appendChild(row);
        }
    }

    function renderVarValues() {
        for (const el of varListEl.querySelectorAll('.val')) {
            const v = variables.find((x) => x.id === el.dataset.varId);
            if (v) {
                el.textContent = formatLast(v);
            }
        }
    }

    function formatLast(v) {
        if (v.lastValue !== null && v.lastValue !== undefined) {
            return formatNumber(v.lastValue);
        }
        return v.lastRaw || '';
    }

    // ---- data table -----------------------------------------------------------------------

    function renderTableHead() {
        tableHead.textContent = '';
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = 'time [s]';
        tr.appendChild(th);
        for (const v of variables) {
            const cell = document.createElement('th');
            cell.textContent = v.expression;
            cell.style.color = v.color;
            tr.appendChild(cell);
        }
        tableHead.appendChild(tr);
    }

    function renderTable() {
        tableBody.textContent = '';
        const n = times.length;
        const count = Math.min(n, MAX_TABLE_ROWS);
        const frag = document.createDocumentFragment();
        // Newest sample on top.
        for (let r = 0; r < count; r++) {
            const i = n - 1 - r;
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.textContent = times[i].toFixed(3);
            tr.appendChild(td);
            for (const v of variables) {
                const cell = document.createElement('td');
                const value = series.get(v.id) ? series.get(v.id)[i] : null;
                cell.textContent = value === null || value === undefined ? '' : formatNumber(value);
                tr.appendChild(cell);
            }
            frag.appendChild(tr);
        }
        tableBody.appendChild(frag);
    }

    function formatNumber(x) {
        if (Number.isInteger(x) && Math.abs(x) < 1e15) {
            return String(x);
        }
        const abs = Math.abs(x);
        if (abs !== 0 && (abs >= 1e9 || abs < 1e-4)) {
            return x.toExponential(6);
        }
        return String(parseFloat(x.toPrecision(9)));
    }

    // ---- status / toolbar state --------------------------------------------------------------

    function renderStatus() {
        const n = times.length;
        const dur = n > 1 ? times[n - 1] - times[0] : 0;
        const rate = dur > 0 ? (n - 1) / dur : 0;
        const parts = [];
        if (recording) {
            parts.push('<span class="rec">&#9679; REC</span>');
        }
        if (n > 0) {
            parts.push(`${n} samples`);
            parts.push(`${dur.toFixed(1)} s`);
            if (rate > 0) {
                parts.push(`~${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)} Hz`);
            }
        }
        statusEl.innerHTML = parts.join(' &middot; ');

        btnStart.disabled = recording;
        btnStop.disabled = !recording;
        btnStart.classList.toggle('primary', !recording);
        btnStop.classList.toggle('recording', recording);
        periodSelect.value = String(periodMs);
    }

    function renderAll() {
        renderStatus();
        renderVars();
        renderTableHead();
        renderTable();
        requestRender();
    }

    // ---- chart -------------------------------------------------------------------------------

    const MARGIN = { left: 64, right: 14, top: 12, bottom: 26 };

    const view = {
        auto: true, // follow mode: always fit all (latest) data
        x0: 0,
        x1: 1,
        y0: -1,
        y1: 1
    };

    let renderQueued = false;
    function requestRender() {
        if (!renderQueued) {
            renderQueued = true;
            requestAnimationFrame(() => {
                renderQueued = false;
                drawChart();
            });
        }
    }

    function cssVar(name, fallback) {
        const v = getComputedStyle(document.body).getPropertyValue(name).trim();
        return v || fallback;
    }

    function plotRect() {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        return {
            x: MARGIN.left,
            y: MARGIN.top,
            w: Math.max(10, w - MARGIN.left - MARGIN.right),
            h: Math.max(10, h - MARGIN.top - MARGIN.bottom)
        };
    }

    function autoFit() {
        if (times.length === 0) {
            view.x0 = 0; view.x1 = 1; view.y0 = -1; view.y1 = 1;
            return;
        }
        let x0 = times[0];
        let x1 = times[times.length - 1];
        if (x1 - x0 < 1e-9) {
            x1 = x0 + 1;
        }
        let yMin = Infinity;
        let yMax = -Infinity;
        for (const v of variables) {
            if (!v.enabled) { continue; }
            const col = series.get(v.id);
            if (!col) { continue; }
            for (let i = 0; i < col.length; i++) {
                const y = col[i];
                if (y !== null && isFinite(y)) {
                    if (y < yMin) { yMin = y; }
                    if (y > yMax) { yMax = y; }
                }
            }
        }
        if (yMin === Infinity) {
            yMin = -1; yMax = 1;
        }
        if (yMax - yMin < 1e-12) {
            const pad = Math.max(1, Math.abs(yMax) * 0.1);
            yMin -= pad; yMax += pad;
        } else {
            const pad = (yMax - yMin) * 0.05;
            yMin -= pad; yMax += pad;
        }
        view.x0 = x0; view.x1 = x1; view.y0 = yMin; view.y1 = yMax;
    }

    function drawChart() {
        const dpr = window.devicePixelRatio || 1;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (cw === 0 || ch === 0) { return; }
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
            canvas.width = Math.round(cw * dpr);
            canvas.height = Math.round(ch * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const bg = cssVar('--vscode-editor-background', '#1e1e1e');
        const fg = cssVar('--vscode-foreground', '#ccc');
        const gridColor = cssVar('--vscode-panel-border', '#444');

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);

        if (view.auto) {
            autoFit();
        }

        const r = plotRect();
        const xScale = r.w / (view.x1 - view.x0);
        const yScale = r.h / (view.y1 - view.y0);
        const px = (t) => r.x + (t - view.x0) * xScale;
        const py = (y) => r.y + r.h - (y - view.y0) * yScale;

        // grid + ticks
        ctx.font = '11px ' + cssVar('--vscode-font-family', 'sans-serif');
        ctx.strokeStyle = gridColor;
        ctx.fillStyle = fg;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;

        const xTicks = niceTicks(view.x0, view.x1, Math.max(2, Math.floor(r.w / 90)));
        const yTicks = niceTicks(view.y0, view.y1, Math.max(2, Math.floor(r.h / 45)));

        ctx.beginPath();
        ctx.globalAlpha = 0.25;
        for (const t of xTicks) {
            const x = Math.round(px(t)) + 0.5;
            ctx.moveTo(x, r.y);
            ctx.lineTo(x, r.y + r.h);
        }
        for (const v of yTicks) {
            const y = Math.round(py(v)) + 0.5;
            ctx.moveTo(r.x, y);
            ctx.lineTo(r.x + r.w, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const t of xTicks) {
            ctx.fillText(formatTick(t, view.x1 - view.x0), px(t), r.y + r.h + 5);
        }
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of yTicks) {
            ctx.fillText(formatTick(v, view.y1 - view.y0), r.x - 6, py(v));
        }

        // frame
        ctx.globalAlpha = 0.6;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.globalAlpha = 1;

        // series (clipped to the plot area)
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();

        for (const v of variables) {
            if (!v.enabled) { continue; }
            const col = series.get(v.id);
            if (!col || times.length === 0) { continue; }
            drawSeries(col, v.color, px, py, r);
        }
        ctx.restore();

        // empty-state hint
        if (times.length === 0) {
            ctx.fillStyle = fg;
            ctx.globalAlpha = 0.5;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
                variables.length === 0
                    ? 'Add a variable below, then press Start to acquire data'
                    : 'Press Start to acquire data',
                r.x + r.w / 2,
                r.y + r.h / 2
            );
            ctx.globalAlpha = 1;
        }
    }

    function drawSeries(col, color, px, py, r) {
        // Visible index range (times are monotonically increasing).
        let i0 = lowerBound(times, view.x0) - 1;
        let i1 = lowerBound(times, view.x1) + 1;
        i0 = Math.max(0, i0);
        i1 = Math.min(times.length, i1);
        const count = i1 - i0;
        if (count <= 0) { return; }

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.25;

        const pxPerSample = r.w / Math.max(1, count);

        if (pxPerSample < 0.5) {
            // Dense: min/max per pixel column to keep rendering fast and faithful.
            ctx.beginPath();
            let i = i0;
            let prevX = -1;
            while (i < i1) {
                const x = Math.round(px(times[i]));
                let yMin = Infinity;
                let yMax = -Infinity;
                let last = null;
                while (i < i1 && Math.round(px(times[i])) === x) {
                    const y = col[i];
                    if (y !== null && isFinite(y)) {
                        if (y < yMin) { yMin = y; }
                        if (y > yMax) { yMax = y; }
                        last = y;
                    }
                    i++;
                }
                if (yMin !== Infinity) {
                    const top = py(yMax);
                    const bot = py(yMin);
                    ctx.moveTo(x + 0.5, top);
                    ctx.lineTo(x + 0.5, Math.max(bot, top + 1));
                    if (prevX >= 0 && x - prevX > 1 && last !== null) {
                        // thin connector across gaps between columns
                        ctx.moveTo(prevX + 0.5, py(last));
                        ctx.lineTo(x + 0.5, py(last));
                    }
                    prevX = x;
                }
            }
            ctx.stroke();
            return;
        }

        // Sparse enough: polyline plus one dot per acquired sample.
        ctx.beginPath();
        let pen = false;
        for (let i = i0; i < i1; i++) {
            const y = col[i];
            if (y === null || !isFinite(y)) {
                pen = false;
                continue;
            }
            const X = px(times[i]);
            const Y = py(y);
            if (pen) {
                ctx.lineTo(X, Y);
            } else {
                ctx.moveTo(X, Y);
                pen = true;
            }
        }
        ctx.stroke();

        if (pxPerSample >= 3) {
            const radius = pxPerSample >= 12 ? 2.5 : 1.75;
            ctx.beginPath();
            for (let i = i0; i < i1; i++) {
                const y = col[i];
                if (y === null || !isFinite(y)) { continue; }
                const X = px(times[i]);
                const Y = py(y);
                ctx.moveTo(X + radius, Y);
                ctx.arc(X, Y, radius, 0, Math.PI * 2);
            }
            ctx.fill();
        }
    }

    /** First index with times[i] >= value (binary search). */
    function lowerBound(arr, value) {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < value) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    function niceTicks(min, max, target) {
        const span = max - min;
        if (!(span > 0) || !isFinite(span)) { return []; }
        const rawStep = span / target;
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        let step = mag;
        for (const m of [1, 2, 5, 10]) {
            if (mag * m >= rawStep) {
                step = mag * m;
                break;
            }
        }
        const ticks = [];
        const first = Math.ceil(min / step) * step;
        for (let t = first; t <= max + step * 1e-9; t += step) {
            ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
        }
        return ticks;
    }

    function formatTick(value, span) {
        if (value === 0) { return '0'; }
        const abs = Math.abs(value);
        if (abs >= 1e6 || abs < 1e-4) {
            return value.toExponential(1);
        }
        const decimals = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(span / 4))));
        let s = value.toFixed(decimals);
        if (s.includes('.')) {
            s = s.replace(/0+$/, '').replace(/\.$/, '');
        }
        return s;
    }

    // ---- chart interaction (zoom / stretch / pan) ----------------------------------------------

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (view.auto) {
            autoFit();
            view.auto = false;
        }
        const r = plotRect();
        const factor = Math.pow(1.25, e.deltaY > 0 ? 1 : -1);
        if (e.shiftKey || e.ctrlKey) {
            // stretch/zoom the value axis around the cursor
            const fy = 1 - Math.min(1, Math.max(0, (e.offsetY - r.y) / r.h));
            const yAt = view.y0 + fy * (view.y1 - view.y0);
            view.y0 = yAt - (yAt - view.y0) * factor;
            view.y1 = yAt + (view.y1 - yAt) * factor;
        } else {
            // zoom the time axis around the cursor
            const fx = Math.min(1, Math.max(0, (e.offsetX - r.x) / r.w));
            const xAt = view.x0 + fx * (view.x1 - view.x0);
            view.x0 = xAt - (xAt - view.x0) * factor;
            view.x1 = xAt + (view.x1 - xAt) * factor;
        }
        requestRender();
    }, { passive: false });

    let dragging = null;
    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) { return; }
        if (view.auto) {
            autoFit();
            view.auto = false;
        }
        dragging = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) { return; }
        const r = plotRect();
        const dx = (e.clientX - dragging.x) * (view.x1 - view.x0) / r.w;
        const dy = (e.clientY - dragging.y) * (view.y1 - view.y0) / r.h;
        view.x0 -= dx; view.x1 -= dx;
        view.y0 += dy; view.y1 += dy;
        dragging = { x: e.clientX, y: e.clientY };
        requestRender();
    });
    window.addEventListener('mouseup', () => {
        dragging = null;
        canvas.style.cursor = 'crosshair';
    });
    canvas.addEventListener('dblclick', () => {
        view.auto = true;
        requestRender();
    });

    new ResizeObserver(() => requestRender()).observe(canvas);

    // ---- init ------------------------------------------------------------------------------------

    vscode.postMessage({ type: 'ready' });
})();
