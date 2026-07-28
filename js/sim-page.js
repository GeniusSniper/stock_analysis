/* ============================================================
   Strategy Race Simulator page (simulation.html).

   Loads the full TradingView US stock directory inline — filter,
   click any stock — then runs the $1,000 strategy race on its
   history: fast ~10-year window first, complete history backfilled
   in the background. Each simulated stock also lands in a session
   comparison table so races across different stocks line up.

   Chart code follows the app's standalone-canvas pattern (DPR-safe,
   CSS height captured once, zero-width guard) and the shared
   StockCharts.niceTicks / cssVar helpers.
   ============================================================ */
(() => {
  const $ = id => document.getElementById(id);

  // ---------- formatting (mirrors app.js) ----------
  const fmtMoney = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v, digits = 1) => {
    const p = v * 100;
    const d = Math.abs(p) >= 100 ? 0 : digits;
    return (v >= 0 ? '+' : '') + p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
  };
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtCap = v => v == null || !isFinite(v) ? ''
    : v >= 1e12 ? '$' + (v / 1e12).toFixed(1) + 'T'
    : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B'
    : v >= 1e6 ? '$' + (v / 1e6).toFixed(0) + 'M'
    : '$' + Math.round(v).toLocaleString('en-US');
  const fmtEquity = v =>
    v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M'
    : '$' + Math.round(v).toLocaleString('en-US');

  function legendHTML(items) {
    return items.map(it =>
      '<span class="legend-item"><span class="legend-swatch" style="background:' + it.color + '"></span>' + esc(it.name) + '</span>'
    ).join('');
  }

  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- state ----------
  let bars = null, ind = null;
  let sim = null;            // Simulation.run result for the current symbol
  let simSelected = null;    // clicked bar index on the race chart
  let currentSymbol = null;
  let loadReq = 0;           // monotonic token — a newer load supersedes an in-flight one
  const barsCache = new Map();      // symbol -> { bars, full } to avoid refetching this session
  const session = [];               // one row per simulated symbol, for the comparison table

  // ---------- the race chart (moved from app.js — same canvas pattern) ----------
  const SIM_PAD = { left: 64, right: 14, top: 12, bottom: 24 };
  const simCanvas = $('sim-chart');
  // Hi-DPI guard: capture the CSS height ONCE — setting canvas.height for
  // sharp rendering overwrites the attribute.
  const simCssH = +simCanvas.getAttribute('height');
  simCanvas.style.height = simCssH + 'px';
  simCanvas.style.cursor = 'pointer';

  const simColor = k => StockCharts.cssVar('--sim-' + ((k % 6) + 1));

  function runSimulation() {
    sim = Simulation.run(bars, ind);
    simSelected = null;
    $('sim-log').checked = bars.length > 2600;   // decades of compounding need a log axis
    renderSimVisuals();
    upsertSessionRow();
  }

  /** Legend + chart + table without recomputing the agents (theme flips, resize). */
  function renderSimVisuals() {
    if (!sim) return;
    $('sim-legend').innerHTML = legendHTML(sim.agents.map((a, k) => ({ name: a.name, color: simColor(k) })));
    drawSimChart();
    renderSimTable();
    renderSimPointNote();
  }

  function drawSimChart() {
    if (!sim) return;
    const dpr = window.devicePixelRatio || 1;
    const w = simCanvas.clientWidth, h = simCssH;
    if (!w) return;   // section still hidden — rendered again once visible
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (simCanvas.width !== bw) simCanvas.width = bw;
    if (simCanvas.height !== bh) simCanvas.height = bh;
    const ctx = simCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const v = name => StockCharts.cssVar(name);
    const n = sim.dates.length;

    let min = Infinity, max = -Infinity;
    for (const a of sim.agents) {
      for (const val of a.equity) { if (val < min) min = val; if (val > max) max = val; }
    }
    const useLog = $('sim-log').checked && min > 0;
    const T = useLog ? Math.log : (x => x);
    let tMin = T(min), tMax = T(max);
    const pad = (tMax - tMin) * 0.06 || 1;
    tMin -= pad; tMax += pad;
    const yMin = useLog ? Math.exp(tMin) : tMin;
    const yMax = useLog ? Math.exp(tMax) : tMax;

    const plotW = w - SIM_PAD.left - SIM_PAD.right;
    const plotH = h - SIM_PAD.top - SIM_PAD.bottom;
    const x = i => SIM_PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const y = val => SIM_PAD.top + plotH - ((T(val) - tMin) / (tMax - tMin)) * plotH;

    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';

    // Gridlines + $ ticks: 1–2–5 per decade on log, nice steps on linear.
    let ticks;
    if (useLog) {
      ticks = [];
      for (let e = Math.floor(Math.log10(yMin)); e <= Math.ceil(Math.log10(yMax)); e++) {
        for (const m of [1, 2, 5]) {
          const tv = m * Math.pow(10, e);
          if (tv >= yMin && tv <= yMax) ticks.push(tv);
        }
      }
      while (ticks.length > 7) ticks = ticks.filter((_, k) => k % 2 === 0);
      if (ticks.length < 2) ticks = StockCharts.niceTicks(yMin, yMax, 4).filter(tv => tv >= yMin && tv <= yMax);
    } else {
      ticks = StockCharts.niceTicks(yMin, yMax, 4);
    }
    ctx.strokeStyle = v('--gridline');
    ctx.lineWidth = 1;
    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tv of ticks) {
      const py = Math.round(y(tv)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(SIM_PAD.left, py);
      ctx.lineTo(w - SIM_PAD.right, py);
      ctx.stroke();
      ctx.fillText(fmtEquity(tv), SIM_PAD.left - 8, py);
    }

    // The shared starting line — every agent begins here.
    if (sim.startCash >= yMin && sim.startCash <= yMax) {
      const py = Math.round(y(sim.startCash)) + 0.5;
      ctx.strokeStyle = v('--baseline');
      ctx.beginPath();
      ctx.moveTo(SIM_PAD.left, py);
      ctx.lineTo(w - SIM_PAD.right, py);
      ctx.stroke();
      ctx.fillText('start ' + fmtEquity(sim.startCash), w - SIM_PAD.right - 4, py - 9);
    }

    // X date labels — about 6, evenly spaced.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.round(n / 6));
    for (let i = 0; i < n; i += labelEvery) {
      if (x(i) > w - SIM_PAD.right - 30) break;
      const dstr = sim.dates[i];
      const label = n < 130 ? dstr.slice(5) : n < 2600 ? dstr.slice(0, 7) : dstr.slice(0, 4);
      ctx.fillText(label, x(i), h - SIM_PAD.bottom + 7);
    }

    // One equity curve per agent — 2px, round joins, fixed color per strategy.
    sim.agents.forEach((a, k) => {
      ctx.strokeStyle = simColor(k);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x(0), y(a.equity[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(a.equity[i]));
      ctx.stroke();
    });

    // Ringed dots: at the clicked date (no lines across the chart), else the finish line.
    const dotAt = simSelected != null ? simSelected : n - 1;
    sim.agents.forEach((a, k) => {
      const px = x(dotAt), py = y(a.equity[dotAt]);
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = v('--surface-1');
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = simColor(k);
      ctx.fill();
    });
  }

  function renderSimTable() {
    const ranked = [...sim.agents].sort((a, b) => b.stats.finalValue - a.stats.finalValue);
    const winner = ranked[0];
    $('sim-caption').textContent = currentSymbol + ' — each agent started with ' + fmtEquity(sim.startCash) +
      ' on ' + sim.dates[0] + ' (' + sim.dates.length.toLocaleString('en-US') + ' trading days' +
      (winner.stats.years >= 1 ? ', ' + winner.stats.years.toFixed(1) + ' years' : '') + ')';
    $('sim-table').querySelector('tbody').innerHTML = ranked.map(a => {
      const s = a.stats;
      return '<tr' + (a === winner ? ' class="recommended"' : '') + '>' +
        '<td><span class="sim-swatch" style="background:' + simColor(sim.agents.indexOf(a)) + ';margin-left:0"></span>' +
        esc(a.name) + (a === winner ? ' ★' : '') + '</td>' +
        '<td><b>' + fmtMoney(s.finalValue) + '</b></td>' +
        '<td>' + fmtPct(s.totalReturn) + '</td>' +
        '<td>' + (s.cagr != null ? fmtPct(s.cagr) + '/yr' : '–') + '</td>' +
        '<td>' + fmtPct(-s.maxDrawdown) + '</td>' +
        '<td>' + s.trades + '</td>' +
        '<td>' + (s.winRate != null ? Math.round(s.winRate * 100) + '%' : '–') + '</td>' +
        '<td>' + (s.endsInMarket ? 'invested' : 'in cash') + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderSimPointNote() {
    const el = $('sim-point-note');
    if (simSelected == null) {
      el.textContent = 'Dots mark the finish line — click any point on the chart to compare the agents on that date.';
      return;
    }
    el.innerHTML = '<b>' + esc(sim.dates[simSelected]) + ':</b>' +
      sim.agents.map((a, k) =>
        '<span class="sim-swatch" style="background:' + simColor(k) + '"></span>' +
        esc(a.name) + ' <b>' + fmtMoney(a.equity[simSelected]) + '</b>'
      ).join('') +
      ' <button class="learn-link" id="sim-clear" type="button">back to latest</button>';
    $('sim-clear').addEventListener('click', () => {
      simSelected = null;
      drawSimChart();
      renderSimPointNote();
    });
  }

  simCanvas.addEventListener('click', evt => {
    if (!sim) return;
    const mx = evt.clientX - simCanvas.getBoundingClientRect().left;
    const plotW = simCanvas.clientWidth - SIM_PAD.left - SIM_PAD.right;
    const n = sim.dates.length;
    const frac = (mx - SIM_PAD.left) / plotW;
    simSelected = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    drawSimChart();
    renderSimPointNote();
  });

  $('sim-log').addEventListener('change', drawSimChart);
  window.addEventListener('resize', () => drawSimChart());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderSimVisuals());
  }

  // ---------- save to file ----------
  function simFilename(kind, ext) {
    const sym = currentSymbol.replace(/[^A-Za-z0-9_.-]/g, '') || 'data';
    return kind + '_' + sym + '_' + sim.dates[0].slice(0, 10) + '_to_' +
      sim.dates[sim.dates.length - 1].slice(0, 10) + '.' + ext;
  }

  $('sim-save-json').addEventListener('click', () => {
    if (!sim) return;
    downloadFile(
      simFilename('simulation', 'json'),
      Simulation.toJSON(sim, { symbol: currentSymbol, source: 'yahoo', generatedAt: new Date().toISOString() }),
      'application/json');
  });

  $('sim-save-csv').addEventListener('click', () => {
    if (!sim) return;
    downloadFile(simFilename('equity_curves', 'csv'), Simulation.toCSV(sim), 'text/csv');
  });

  // ---------- session comparison across stocks ----------
  function upsertSessionRow() {
    const ranked = [...sim.agents].sort((a, b) => b.stats.finalValue - a.stats.finalValue);
    const winner = ranked[0];
    const bh = sim.agents.find(a => a.id === 'buy-hold');
    const row = {
      symbol: currentSymbol,
      from: sim.dates[0],
      to: sim.dates[sim.dates.length - 1],
      days: sim.dates.length,
      winnerName: winner.name,
      winnerFinal: winner.stats.finalValue,
      winnerCagr: winner.stats.cagr,
      bhFinal: bh ? bh.stats.finalValue : null,
    };
    const at = session.findIndex(r => r.symbol === row.symbol);
    if (at >= 0) session[at] = row;
    else session.push(row);
    renderSession();
  }

  function renderSession() {
    $('sim-compare-wrap').hidden = session.length === 0;
    if (!session.length) return;
    $('sim-compare').querySelector('tbody').innerHTML = [...session]
      .sort((a, b) => b.winnerFinal - a.winnerFinal)
      .map(r =>
        '<tr class="sim-compare-row' + (r.symbol === currentSymbol ? ' recommended' : '') + '" data-symbol="' + esc(r.symbol) + '">' +
        '<td><b>' + esc(r.symbol) + '</b>' + (r.symbol === currentSymbol ? ' ◄' : '') + '</td>' +
        '<td>' + esc(r.from.slice(0, 10)) + ' → ' + esc(r.to.slice(0, 10)) + '</td>' +
        '<td>' + r.days.toLocaleString('en-US') + '</td>' +
        '<td>' + esc(r.winnerName) + ' ★</td>' +
        '<td><b>' + fmtMoney(r.winnerFinal) + '</b>' +
        (r.winnerCagr != null ? ' <span class="muted">(' + fmtPct(r.winnerCagr) + '/yr)</span>' : '') + '</td>' +
        '<td>' + (r.bhFinal != null ? fmtMoney(r.bhFinal) : '–') + '</td>' +
        '</tr>'
      ).join('');
    $('sim-compare').querySelectorAll('[data-symbol]').forEach(tr =>
      tr.addEventListener('click', () => loadAndSimulate(tr.dataset.symbol)));
  }

  // ---------- loading ----------
  function setStatus(msg, isError) {
    const el = $('sim-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  async function loadAndSimulate(rawSymbol) {
    const symbol = DataSource.normalizeSymbol(rawSymbol);
    if (!symbol) return;
    const myReq = ++loadReq;
    $('sim-load-btn').disabled = true;
    $('symbol-input').value = symbol;
    try {
      const cached = barsCache.get(symbol);
      let newBars;
      if (cached) {
        newBars = cached.bars;
        setStatus('Using this session\'s cached history for ' + symbol + '…');
      } else {
        setStatus('Fetching live history for ' + symbol + '…');
        newBars = await DataSource.load('yahoo', symbol, '');
        if (myReq !== loadReq) return;
        if (newBars.length < 60) throw new Error('Not enough history to simulate (' + newBars.length + ' bars).');
        barsCache.set(symbol, { bars: newBars, full: false });
      }
      bars = newBars;
      ind = Indicators.computeAll(bars);
      currentSymbol = symbol;
      $('sim-section').hidden = false;   // unhide BEFORE drawing — hidden canvases have zero width
      $('sim-title').textContent = symbol + ' — strategy race (' + bars[0].date.slice(0, 4) + ' → today)';
      runSimulation();
      setStatus('Simulated ' + bars.length.toLocaleString('en-US') + ' trading days (' + bars[0].date +
        ' → ' + bars[bars.length - 1].date + ')' +
        (barsCache.get(symbol).full ? '.' : ' — loading the complete history in the background…'));
      if (!barsCache.get(symbol).full) backfillFull(symbol, myReq);
    } catch (err) {
      if (myReq !== loadReq) return;
      setStatus(err.message + ' Try another ticker, or click a stock in the directory below.', true);
    } finally {
      if (myReq === loadReq) $('sim-load-btn').disabled = false;
    }
  }

  /** Quietly replace the fast ~10y window with the complete history. */
  async function backfillFull(symbol, reqAtCall) {
    try {
      const full = await DataSource.loadFullHistory('yahoo', symbol);
      if (!full || full.length <= bars.length) {
        if (reqAtCall === loadReq) barsCache.set(symbol, { bars, full: true });
        return;
      }
      barsCache.set(symbol, { bars: full, full: true });
      if (reqAtCall !== loadReq) return;   // user moved on to another symbol
      bars = full;
      ind = Indicators.computeAll(bars);
      $('sim-title').textContent = symbol + ' — strategy race (' + bars[0].date.slice(0, 4) + ' → today)';
      runSimulation();
      setStatus('Simulated the complete history: ' + bars.length.toLocaleString('en-US') +
        ' trading days (' + bars[0].date + ' → ' + bars[bars.length - 1].date + ').');
    } catch (e) {
      if (reqAtCall === loadReq) {
        setStatus('Simulated ' + bars.length.toLocaleString('en-US') +
          ' trading days — the full-history backfill is unavailable right now.');
      }
    }
  }

  // ---------- the all-stocks directory (inline, not a modal) ----------
  const dir = { query: '', offset: 0, pageSize: 50, timer: null };

  function dirRowHTML(r) {
    return '<button class="dir-row" data-pick="' + esc(r.symbol) + '" type="button">' +
      '<span class="dir-sym">' + esc(r.symbol) + '</span>' +
      '<span class="dir-name">' + esc(r.name) + '</span>' +
      '<span class="dir-price">' + (r.close != null ? fmtMoney(r.close) : '–') + '</span>' +
      '<span class="dir-chg ' + (r.change >= 0 ? 'up' : 'down') + '">' + (r.change != null ? fmtPct(r.change / 100) : '') + '</span>' +
      '<span class="dir-cap">' + fmtCap(r.cap) + '</span>' +
      '</button>';
  }

  async function dirFetch(reset) {
    const list = $('sim-dir-list'), more = $('sim-dir-more'), count = $('sim-dir-count');
    if (reset) { dir.offset = 0; list.innerHTML = '<div class="dir-row">Loading…</div>'; }
    more.disabled = true;
    try {
      const page = await DataSource.browseSymbols(dir.query, dir.offset, dir.pageSize);
      const rowsHTML = page.rows.map(dirRowHTML).join('');
      if (reset) list.innerHTML = rowsHTML || '<div class="dir-row">No symbols match.</div>';
      else list.insertAdjacentHTML('beforeend', rowsHTML);
      dir.offset += page.rows.length;
      count.textContent = page.total.toLocaleString('en-US') + ' symbols' +
        (dir.query ? ' match' : ' available') + ' — showing ' + dir.offset + '. Click one to simulate it.';
      more.hidden = dir.offset >= page.total;
      list.querySelectorAll('[data-pick]:not([data-wired])').forEach(btn => {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => loadAndSimulate(btn.dataset.pick));
      });
    } catch (err) {
      if (reset) list.innerHTML = '<div class="dir-row">' + esc(err.message) + ' — the directory needs TradingView reachable; you can still type a ticker above.</div>';
      count.textContent = '';
    } finally {
      more.disabled = false;
    }
  }

  // ---------- wiring + boot ----------
  $('sim-load-btn').addEventListener('click', () => loadAndSimulate($('symbol-input').value));
  $('symbol-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadAndSimulate($('symbol-input').value); });
  $('sim-dir-filter').addEventListener('input', () => {
    clearTimeout(dir.timer);
    dir.timer = setTimeout(() => {
      dir.query = $('sim-dir-filter').value.trim();
      dirFetch(true);
    }, 350);
  });
  $('sim-dir-more').addEventListener('click', () => dirFetch(false));

  dirFetch(true);                 // the whole directory, biggest first
  loadAndSimulate('AAPL');        // a race on screen immediately

  // Bridge for the auto-researcher: share the bars cache (research and the
  // manual race never fetch the same history twice) and let report rows
  // jump straight into a race.
  window.SimPageBridge = { loadAndSimulate, barsCache };
})();
