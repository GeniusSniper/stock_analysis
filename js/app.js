/* ============================================================
   App wiring: load data → indicators → charts → recommendation
   → learn section.
   ============================================================ */
(() => {
  const $ = id => document.getElementById(id);

  // ---------- formatting ----------
  const fmtMoney = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v, digits = 1) => {
    const p = v * 100;
    const d = Math.abs(p) >= 100 ? 0 : digits;   // "+40,213%" beats "+40213.4%"
    return (v >= 0 ? '+' : '') + p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
  };
  const fmtNum = v => v.toLocaleString('en-US');

  // ---------- state ----------
  let bars = null, ind = null, analysis = null;      // daily data — drives tiles, backtests, recommendation
  let hourly = null;                                  // { bars, ind, simulated } — lazy, for the 1D/5D ranges
  let viewMode = 'daily';                             // what the charts are currently showing
  let currentSource = 'yahoo', currentSymbol = 'AAPL';

  /** Dataset the charts should draw right now. */
  function chartData() {
    return viewMode === 'hourly' && hourly ? hourly : { bars, ind };
  }

  const priceChart = StockCharts.createChart($('price-chart'));
  const rsiChart = StockCharts.createChart($('rsi-chart'));
  const macdChart = StockCharts.createChart($('macd-chart'));

  // ---------- controls ----------
  $('source-select').addEventListener('change', () => {
    $('apikey-control').hidden = $('source-select').value !== 'alphavantage';
  });

  $('load-btn').addEventListener('click', loadAndAnalyze);
  $('symbol-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadAndAnalyze(); });

  // The "Amount to invest" field lives in the top controls; the buy-verdict
  // and position-sizing numbers in the recommendation recompute live from it.
  $('capital-input').addEventListener('input', () => {
    capitalValue = Math.max(0, parseFloat($('capital-input').value) || 0);
    renderSizing();
  });

  // ---------- symbol search (Yahoo Finance, no key) ----------
  async function doSearch() {
    const q = $('search-input').value.trim();
    const box = $('search-results');
    if (!q) return;
    box.innerHTML = '<button class="search-result" disabled><span class="sr-name">Searching…</span></button>';
    box.hidden = false;
    try {
      const results = await DataSource.searchSymbols(q);
      if (!results.length) {
        box.innerHTML = '<button class="search-result" disabled><span class="sr-name">No matches for "' + q + '".</span></button>';
        return;
      }
      box.innerHTML = results.map(r =>
        '<button class="search-result" data-symbol="' + r.symbol + '">' +
        '<span class="sr-symbol">' + r.symbol + '</span>' +
        '<span class="sr-name">' + r.name + '</span>' +
        '<span class="sr-exch">' + [r.type, r.exch].filter(Boolean).join(' · ') + '</span>' +
        '</button>'
      ).join('');
      box.querySelectorAll('[data-symbol]').forEach(btn =>
        btn.addEventListener('click', () => {
          $('symbol-input').value = btn.dataset.symbol;
          $('source-select').value = 'tradingview';     // full experience: ratings + chart + history
          $('apikey-control').hidden = true;
          box.hidden = true;
          loadAndAnalyze();
        }));
    } catch (err) {
      box.innerHTML = '<button class="search-result" disabled><span class="sr-name">' + err.message + '</span></button>';
    }
  }
  $('search-btn').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-control')) $('search-results').hidden = true;
  });

  // ---------- "Browse all" symbol directory (TradingView, ~20k US tickers) ----------
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtCap = v => v == null || !isFinite(v) ? ''
    : v >= 1e12 ? '$' + (v / 1e12).toFixed(1) + 'T'
    : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B'
    : v >= 1e6 ? '$' + (v / 1e6).toFixed(0) + 'M'
    : '$' + Math.round(v).toLocaleString('en-US');

  const dir = { query: '', offset: 0, total: 0, pageSize: 50, timer: null };

  function dirRowHTML(r) {
    return '<button class="dir-row" data-pick="' + esc(r.symbol) + '">' +
      '<span class="dir-sym">' + esc(r.symbol) + '</span>' +
      '<span class="dir-name">' + esc(r.name) + '</span>' +
      '<span class="dir-price">' + (r.close != null ? fmtMoney(r.close) : '–') + '</span>' +
      '<span class="dir-chg ' + (r.change >= 0 ? 'up' : 'down') + '">' + (r.change != null ? fmtPct(r.change / 100) : '') + '</span>' +
      '<span class="dir-cap">' + fmtCap(r.cap) + '</span>' +
      '</button>';
  }

  async function dirFetch(reset) {
    const list = $('dir-list'), more = $('dir-more'), count = $('dir-count');
    if (reset) { dir.offset = 0; list.innerHTML = '<div class="dir-row">Loading…</div>'; }
    more.disabled = true;
    try {
      const page = await DataSource.browseSymbols(dir.query, dir.offset, dir.pageSize);
      dir.total = page.total;
      const rowsHTML = page.rows.map(dirRowHTML).join('');
      if (reset) list.innerHTML = rowsHTML || '<div class="dir-row">No symbols match.</div>';
      else list.insertAdjacentHTML('beforeend', rowsHTML);
      dir.offset += page.rows.length;
      count.textContent = dir.total.toLocaleString('en-US') + ' symbols' + (dir.query ? ' match' : ' available') + ' — showing ' + dir.offset;
      more.hidden = dir.offset >= dir.total;
      list.querySelectorAll('[data-pick]:not([data-wired])').forEach(btn => {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          $('symbol-input').value = btn.dataset.pick;
          closeModal();
          loadAndAnalyze();
        });
      });
    } catch (err) {
      if (reset) list.innerHTML = '<div class="dir-row">' + esc(err.message) + '</div>';
      count.textContent = '';
    } finally {
      more.disabled = false;
    }
  }

  function openSymbolBrowser() {
    $('modal-body').innerHTML =
      '<div class="lesson-type">TradingView directory</div>' +
      '<h2 id="modal-title">All available symbols</h2>' +
      '<p class="hint">Every US-listed stock, ETF, and fund on TradingView, biggest first. Filter by ticker or company name, then click one to load it.</p>' +
      '<div class="dir-controls"><input id="dir-filter" type="text" placeholder="Filter: ticker or company name…" autocomplete="off" />' +
      '<span class="hint" id="dir-count"></span></div>' +
      '<div class="dir-list" id="dir-list"></div>' +
      '<button class="btn btn-primary" id="dir-more" type="button">Load more</button>';
    $('modal-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';

    $('dir-filter').addEventListener('input', () => {
      clearTimeout(dir.timer);
      dir.timer = setTimeout(() => {
        dir.query = $('dir-filter').value.trim();
        dirFetch(true);
      }, 350);
    });
    $('dir-more').addEventListener('click', () => dirFetch(false));
    dir.query = '';
    dirFetch(true);
    $('dir-filter').focus();
  }

  $('browse-btn').addEventListener('click', openSymbolBrowser);

  for (const id of ['toggle-candles', 'toggle-sma20', 'toggle-sma50', 'toggle-bb', 'toggle-log']) {
    $(id).addEventListener('change', () => { if (bars) renderPriceChart(); });
  }
  $('toggle-table').addEventListener('change', () => {
    $('data-table-wrap').hidden = !$('toggle-table').checked;
  });

  // ---------- point details (always visible; defaults to the latest bar) ----------
  function showLatestDetails() {
    StockCharts.setSelection(null);   // no marker line for the default view
    renderPointDetails(chartData().bars.length - 1);
  }

  function renderPointDetails(i) {
    const d = chartData();
    const b = d.bars[i];
    const prev = d.bars[i - 1];
    const change = prev ? b.close / prev.close - 1 : null;

    const items = [
      ['Open', fmtMoney(b.open)],
      ['High', fmtMoney(b.high)],
      ['Low', fmtMoney(b.low)],
      ['Close', fmtMoney(b.close)],
      ['Change', change != null ? fmtPct(change, 2) : '–', change == null ? '' : change >= 0 ? 'up' : 'down'],
      ['Volume', fmtNum(b.volume)],
      ['SMA 20', d.ind.sma20[i] != null ? fmtMoney(d.ind.sma20[i]) : '–'],
      ['SMA 50', d.ind.sma50[i] != null ? fmtMoney(d.ind.sma50[i]) : '–'],
      ['RSI 14', d.ind.rsi14[i] != null ? d.ind.rsi14[i].toFixed(1) : '–'],
      ['MACD', d.ind.macd.line[i] != null ? d.ind.macd.line[i].toFixed(2) : '–'],
      ['Signal', d.ind.macd.signal[i] != null ? d.ind.macd.signal[i].toFixed(2) : '–'],
      ['Histogram', d.ind.macd.histogram[i] != null ? d.ind.macd.histogram[i].toFixed(2) : '–'],
    ];

    $('pd-date').textContent = b.date + (viewMode === 'hourly' ? ' (hourly bar)' : '');
    $('pd-grid').innerHTML = items.map(([label, value, cls]) =>
      '<div class="pd-item"><div class="pd-label">' + label + '</div>' +
      '<div class="pd-value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>'
    ).join('');
    $('point-details').hidden = false;
  }

  StockCharts.onSelect(renderPointDetails);

  // Time-range presets: 1D/5D/Hourly switch to hourly bars, the rest window the daily data.
  const RANGES = {
    '1D': { mode: 'hourly', bars: 7 },
    '5D': { mode: 'hourly', bars: 35 },
    'HOURLY': { mode: 'hourly', bars: null },
    '1M': { mode: 'daily', bars: 21 },
    '6M': { mode: 'daily', bars: 126 },
    '1Y': { mode: 'daily', bars: 252 },
    '3Y': { mode: 'daily', bars: 756 },
    '5Y': { mode: 'daily', bars: 1260 },
    'ALL': { mode: 'daily', bars: null },
  };

  function markRangeActive(key) {
    document.querySelectorAll('#range-row .tool-btn[data-range]')
      .forEach(b => b.classList.toggle('active', b.dataset.range === key));
  }

  // Monotonic token: any newer range switch or data load invalidates the
  // hourly fetch a slower, older setRange call may still be awaiting.
  let rangeReq = 0;

  let currentRangeKey = 'ALL';

  async function setRange(key) {
    if (!bars) return;
    const cfg = RANGES[key];
    const myReq = ++rangeReq;
    currentRangeKey = key;
    markRangeActive(key);

    if (cfg.mode === 'hourly') {
      if (!hourly) {
        $('range-hint').textContent = 'Loading hourly data…';
        const h = await DataSource.loadHourly(currentSource, currentSymbol, $('apikey-input').value.trim(), bars);
        if (myReq !== rangeReq) return;   // superseded while fetching — drop this result
        hourly = { bars: h.bars, ind: Indicators.computeAll(h.bars), simulated: h.simulated };
      }
      viewMode = 'hourly';
      $('range-hint').textContent = hourly.simulated
        ? 'No live intraday feed — hourly bars simulated inside each real daily bar.'
        : 'Hourly bars (live intraday data).';
      renderPriceChart();
      renderSubcharts();
      const n = hourly.bars.length;
      if (cfg.bars == null) StockCharts.resetView();
      else StockCharts.setView(Math.max(0, n - cfg.bars), n - 1, n);
    } else {
      const wasHourly = viewMode === 'hourly';
      viewMode = 'daily';
      $('range-hint').textContent = '';
      if (wasHourly) { renderPriceChart(); renderSubcharts(); }
      if (cfg.bars == null) StockCharts.resetView();
      else StockCharts.setView(Math.max(0, bars.length - cfg.bars), bars.length - 1, bars.length);
    }
    showLatestDetails();   // a stale selection means nothing in a different window
  }

  document.querySelectorAll('#range-row .tool-btn[data-range]').forEach(btn =>
    btn.addEventListener('click', () => setRange(btn.dataset.range)));

  // Monotonic token: if a second load starts (Enter key / search click can
  // bypass the disabled button), the earlier in-flight load's result is
  // dropped instead of racing for the UI.
  let loadReq = 0;
  let resolveTriedFor = null;   // one search-based resolution attempt per bad ticker

  function setChartTitle(source, symbol) {
    const SOURCE_LABELS = { tradingview: 'TradingView + Yahoo history', yahoo: 'Yahoo Finance', alphavantage: 'Alpha Vantage' };
    $('chart-title').textContent = symbol + ' — daily ('
      + (SOURCE_LABELS[source] || source) + ', ' + bars[0].date.slice(0, 4) + ' → today)';
  }

  async function loadAndAnalyze(arg) {
    const isRetry = arg === true;
    // Normalize friendly names ("SP500", "DOW", "NASDAQ") to real tickers so
    // the history feed, the scanner, and the widget all resolve the same thing.
    const symbol = DataSource.normalizeSymbol($('symbol-input').value) || 'AAPL';
    $('symbol-input').value = symbol;
    const source = $('source-select').value;
    const status = $('status-msg');
    const btn = $('load-btn');
    const myReq = ++loadReq;

    btn.disabled = true;
    $('retry-btn').hidden = true;
    status.classList.remove('error');
    status.textContent = (isRetry ? 'Retrying — ' : '') + 'Fetching live data for ' + symbol + '…';

    // The TradingView panels depend only on the symbol, not on the history
    // feed — show and fill them even if the series fetch below fails.
    $('tva-section').hidden = false;
    $('tv-section').hidden = false;
    renderTradingView(symbol);
    renderTvAnalysis(symbol, myReq);

    try {
      const newBars = await DataSource.load(source, symbol, $('apikey-input').value.trim());
      if (myReq !== loadReq) return;   // a newer load superseded this one
      if (newBars.length < 60) throw new Error('Not enough history to analyze (' + newBars.length + ' bars).');
      bars = newBars;
      ind = Indicators.computeAll(bars);
      analysis = Strategies.analyze(bars, ind);
      currentSource = source;
      currentSymbol = symbol;
      resolveTriedFor = null;
      hourly = null;                 // stale intraday data from the previous load
      rangeReq++;                    // invalidate any in-flight hourly fetch
      viewMode = 'daily';
      markRangeActive('ALL');
      $('range-hint').textContent = '';

      setChartTitle(source, symbol);
      // Multi-decade histories need a log axis to stay readable.
      $('toggle-log').checked = bars.length > 2600;

      // Unhide BEFORE rendering: canvases inside a hidden section have
      // zero width, so charts drawn there stay blank until a re-render.
      $('stat-tiles').hidden = false;
      $('chart-section').hidden = false;
      $('reco-section').hidden = false;

      StockCharts.resetView();   // new data — drop any zoom from the previous load
      renderTiles();
      renderPriceChart();
      renderSubcharts();
      renderDataTable();
      renderRecommendation();
      showLatestDetails();
      // The practice section reuses this history — best-effort: a broken or
      // missing practice.js must never derail the core load.
      try { if (typeof Practice !== 'undefined') Practice.notifyDataLoaded({ source, symbol, bars, ind }); } catch (e) { /* optional */ }
      // If TradingView's panel resolved before this history did, its
      // suggestion was built without our engine — rebuild it now.
      if (lastTvSymbol === symbol && lastTv) {
        $('tva-suggestion').innerHTML = tvSuggestionHTML(lastTv, symbol);
      }
      status.textContent = 'Analyzed ' + bars.length + ' trading days ('
        + bars[0].date + ' → ' + bars[bars.length - 1].date + ') — loading full history in the background…';
      backfillFullHistory(source, symbol, myReq);
    } catch (err) {
      if (myReq !== loadReq) return;
      const noData = /no data|empty series|delisted|Unknown symbol/i.test(err.message);
      if (noData && resolveTriedFor !== symbol) {
        // The ticker itself is wrong (not a network problem) — try to
        // resolve it by name through the search API once.
        resolveTriedFor = symbol;
        try {
          const cands = (await DataSource.searchSymbols(symbol))
            .filter(c => /equity|etf|index|fund/i.test(c.type || ''));
          const c = cands[0];
          if (c && c.symbol && c.symbol.toUpperCase() !== symbol && myReq === loadReq) {
            status.textContent = '"' + symbol + '" not recognized — trying ' + c.symbol + ' (' + c.name + ')…';
            $('symbol-input').value = c.symbol;
            loadAndAnalyze();
            return;
          }
        } catch (e2) { /* resolution is best-effort */ }
      }
      if (!noData && !isRetry) {
        // Public CORS proxies are flaky minute-to-minute — one automatic
        // retry rescues most transient failures.
        status.textContent = 'The data feed is busy — retrying in a moment…';
        setTimeout(() => { if (myReq === loadReq) loadAndAnalyze(true); }, 2500);
        return;
      }
      status.textContent = err.message + (noData ? ' Try the Search box or "Browse all" to find the right ticker.' : '');
      status.classList.add('error');
      $('retry-btn').hidden = false;
    } finally {
      if (myReq === loadReq) btn.disabled = false;
    }
  }

  $('retry-btn').addEventListener('click', () => loadAndAnalyze());

  /**
   * The first load fetches a fast ~10-year window; this quietly replaces
   * it with the complete history (e.g. ^GSPC back to 1927) once that
   * bigger payload arrives.
   */
  async function backfillFullHistory(source, symbol, reqAtCall) {
    try {
      const full = await DataSource.loadFullHistory(source, symbol);
      if (!full || reqAtCall !== loadReq || !bars) return;
      if (full.length <= bars.length) return;
      bars = full;
      ind = Indicators.computeAll(bars);
      analysis = Strategies.analyze(bars, ind);
      setChartTitle(source, symbol);
      $('toggle-log').checked = bars.length > 2600;
      renderTiles();
      renderDataTable();
      renderRecommendation();
      try { if (typeof Practice !== 'undefined') Practice.notifyDataLoaded({ source, symbol, bars, ind }); } catch (e) { /* optional */ }
      if (lastTvSymbol === symbol && lastTv) {
        $('tva-suggestion').innerHTML = tvSuggestionHTML(lastTv, symbol);
      }
      if (viewMode === 'daily') {
        renderPriceChart();
        renderSubcharts();
        setRange(currentRangeKey);
      }
      $('status-msg').textContent = 'Analyzed ' + bars.length + ' trading days — full history ('
        + bars[0].date + ' → ' + bars[bars.length - 1].date + ').';
    } catch (e) {
      // The 10-year view is already on screen — finish its status line.
      if (reqAtCall === loadReq && bars) {
        $('status-msg').textContent = 'Analyzed ' + bars.length + ' trading days ('
          + bars[0].date + ' → ' + bars[bars.length - 1].date + '). Full-history backfill unavailable right now.';
      }
    }
  }

  // ---------- stat tiles ----------
  function renderTiles() {
    const last = bars[bars.length - 1], prev = bars[bars.length - 2];
    const change = last.close / prev.close - 1;
    $('tile-price').textContent = fmtMoney(last.close);
    const chEl = $('tile-change');
    chEl.textContent = fmtPct(change, 2) + ' vs prior day';
    chEl.className = 'tile-delta ' + (change >= 0 ? 'up' : 'down');

    const lows = bars.map(b => b.low), highs = bars.map(b => b.high);
    $('tile-range').textContent = fmtMoney(Math.min(...lows)) + ' – ' + fmtMoney(Math.max(...highs));

    const r = analysis.regime;
    $('tile-rsi').textContent = r.rsi != null ? r.rsi.toFixed(1) : '–';
    $('tile-rsi-note').textContent = r.rsi == null ? '–'
      : r.rsi > 70 ? 'overbought (>70)'
      : r.rsi < 30 ? 'oversold (<30)'
      : 'neutral zone';

    $('tile-vol').textContent = (r.vol * 100).toFixed(1) + '%';
    $('tile-vol-note').textContent = r.volLabel + ' volatility';

    $('tile-trend').textContent = r.trend.charAt(0).toUpperCase() + r.trend.slice(1);
    $('tile-trend-note').textContent = 'SMA spread ' + fmtPct(r.trendPct / 100, 2);
  }

  // ---------- charts ----------
  function legendHTML(items) {
    return items.map(it =>
      '<span class="legend-item"><span class="legend-swatch' + (it.dot ? ' dot' : '') + '" style="background:' + it.color + '"></span>' + it.name + '</span>'
    ).join('');
  }

  function renderPriceChart() {
    const v = name => StockCharts.cssVar(name);
    const d = chartData();
    const candles = $('toggle-candles').checked;
    const showSma20 = $('toggle-sma20').checked;
    const showSma50 = $('toggle-sma50').checked;
    const showBB = $('toggle-bb').checked;

    const series = [];
    if (!candles) series.push({ name: 'Close', color: v('--series-1'), values: d.ind.closes });
    if (showSma20) series.push({ name: 'SMA 20', color: v('--series-2'), values: d.ind.sma20 });
    if (showSma50) series.push({ name: 'SMA 50', color: v('--series-3'), values: d.ind.sma50 });

    const bands = showBB
      ? [{ name: 'Bollinger (20, 2)', color: v('--series-4'), upper: d.ind.bb.upper, lower: d.ind.bb.lower }]
      : [];

    const legendItems = [];
    if (candles) {
      legendItems.push({ name: 'Up day', color: v('--status-good'), dot: true });
      legendItems.push({ name: 'Down day', color: v('--status-critical'), dot: true });
    }
    for (const s of series) legendItems.push({ name: s.name, color: s.color });
    for (const b of bands) legendItems.push({ name: b.name, color: b.color });
    $('price-legend').innerHTML = legendHTML(legendItems);

    priceChart.update({
      bars: d.bars, candles, series, bands,
      logScale: $('toggle-log').checked,
      format: x => '$' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x >= 10 ? x.toFixed(0) : x.toFixed(2)),
      point: i => ({
        value: d.bars[i].close,
        label: d.bars[i].date + ' · close ' + fmtMoney(d.bars[i].close),
      }),
    });
  }

  function renderSubcharts() {
    const v = name => StockCharts.cssVar(name);
    const d = chartData();

    rsiChart.update({
      bars: d.bars,
      series: [{ name: 'RSI 14', color: v('--series-1'), values: d.ind.rsi14 }],
      guides: [{ y: 70, label: '70' }, { y: 30, label: '30' }],
      guideBand: { from: 30, to: 70 },
      yDomain: [0, 100],
      format: x => String(Math.round(x)),
      point: i => ({
        value: d.ind.rsi14[i],
        label: 'RSI ' + (d.ind.rsi14[i] != null ? d.ind.rsi14[i].toFixed(1) : 'not yet defined'),
      }),
    });

    $('macd-legend').innerHTML = legendHTML([
      { name: 'MACD', color: v('--series-1') },
      { name: 'Signal', color: v('--series-3') },
      { name: 'Histogram + / −', color: v('--diverge-neg') },
    ]);

    macdChart.update({
      bars: d.bars,
      series: [
        { name: 'MACD', color: v('--series-1'), values: d.ind.macd.line },
        { name: 'Signal', color: v('--series-3'), values: d.ind.macd.signal },
      ],
      histogram: { values: d.ind.macd.histogram, posColor: v('--series-1'), negColor: v('--diverge-neg') },
      guides: [{ y: 0 }],
      format: x => x.toFixed(1),
      point: i => ({
        value: d.ind.macd.line[i],
        label: 'MACD ' + (d.ind.macd.line[i] != null ? d.ind.macd.line[i].toFixed(2) : 'not yet defined'),
      }),
    });
  }

  // Re-bake series colors when the OS theme flips.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (bars) { renderPriceChart(); renderSubcharts(); renderRecommendation(); renderTradingView(currentSymbol); }
    });
  }

  // ---------- TradingView widget (official embed — live TradingView data) ----------
  let tvScriptPromise = null;
  function loadTvScript() {
    if (!tvScriptPromise) {
      tvScriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://s3.tradingview.com/tv.js';
        s.onload = resolve;
        s.onerror = () => { tvScriptPromise = null; reject(new Error('TradingView script blocked')); };
        document.head.appendChild(s);
      });
    }
    return tvScriptPromise;
  }

  /**
   * Map a Yahoo-style symbol to something the FREE TradingView widget can
   * actually display. Raw licensed indices (SP:SPX, DJ:DJI…) show an
   * "open in TradingView" notice instead of a chart in embeds, so indices
   * map to widget-safe tracking instruments; the scanner analysis above
   * still uses the real index.
   */
  const TV_WIDGET_INDEX_MAP = {
    '^GSPC': { sym: 'FOREXCOM:SPXUSD', note: 'S&P 500 index CFD' },
    '^SPX': { sym: 'FOREXCOM:SPXUSD', note: 'S&P 500 index CFD' },
    '^DJI': { sym: 'FOREXCOM:DJI', note: 'Dow Jones index CFD' },
    '^NDX': { sym: 'CAPITALCOM:US100', note: 'Nasdaq-100 index CFD' },
    '^IXIC': { sym: 'NASDAQ:IXIC', note: null },
    '^RUT': { sym: 'AMEX:IWM', note: 'Russell 2000 ETF (IWM)' },
    '^VIX': { sym: 'CAPITALCOM:VIX', note: 'VIX index CFD' },
  };

  function tvSymbolFor(symbol) {
    const s = symbol.toUpperCase();
    const mapped = TV_WIDGET_INDEX_MAP[s];
    if (mapped) return mapped;
    return { sym: s.replace(/^\^/, ''), note: null };
  }

  function renderTradingView(symbol) {
    const container = $('tv-widget');
    const { sym, note } = tvSymbolFor(symbol);
    $('tv-note').textContent = note
      ? 'TradingView restricts the raw index in free embeds, so this chart shows a tracking instrument (' +
        sym + ' — ' + note + '). The analysis panel above still uses the real index.'
      : '';
    loadTvScript().then(() => {
      container.innerHTML = '';
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      new TradingView.widget({
        container_id: 'tv-widget',
        autosize: true,
        symbol: sym,
        interval: 'D',
        timezone: 'Etc/UTC',
        theme: dark ? 'dark' : 'light',
        style: '1',
        locale: 'en',
        allow_symbol_change: true,
        hide_side_toolbar: false,
      });
    }).catch(() => {
      container.innerHTML = '<p class="hint">The TradingView widget could not load (script blocked or offline).</p>';
    });
  }

  // ---------- TradingView analysis + "what to do next" ----------

  /** TradingView's rating score (−1…+1) → label, following their gauge bands. */
  function tvRating(v) {
    if (v == null || !isFinite(v)) return null;
    if (v >= 0.5) return { label: 'Strong Buy', cls: 'buy' };
    if (v >= 0.1) return { label: 'Buy', cls: 'buy' };
    if (v > -0.1) return { label: 'Neutral', cls: 'neutral' };
    if (v > -0.5) return { label: 'Sell', cls: 'sell' };
    return { label: 'Strong Sell', cls: 'sell' };
  }

  function ratingPill(name, score) {
    const r = tvRating(score);
    return '<div class="rating-pill"><div class="rp-label">' + name + '</div>' +
      '<div class="rp-value ' + (r ? r.cls : 'neutral') + '">' + (r ? r.label : '–') + '</div>' +
      '<div class="rp-score">' + (score != null && isFinite(score) ? 'score ' + score.toFixed(2) : '') + '</div></div>';
  }

  function tvSuggestionHTML(tv, symbol) {
    // Our own engine only has an opinion once this symbol's history loaded.
    const engineReady = analysis && currentSymbol === symbol;
    const rec = engineReady ? analysis.recommended : null;
    const score = tv['Recommend.All'];
    const tvR = tvRating(score) || { label: 'Neutral', cls: 'neutral' };
    const tvBull = score != null && score >= 0.1;
    const tvBear = score != null && score <= -0.1;

    const maR = tvRating(tv['Recommend.MA']);
    const oscR = tvRating(tv['Recommend.Other']);
    const lead = 'TradingView currently rates <b>' + tv.ticker + '</b> a <b>' + tvR.label + '</b>' +
      (score != null ? ' (score ' + score.toFixed(2) + ')' : '') + ' on the daily timeframe' +
      (maR && oscR ? ' — moving averages say ' + maR.label + ', oscillators say ' + oscR.label : '') +
      (rec
        ? '. This app\'s regime engine recommends <b>' + rec.strategy.name + '</b>, whose current signal is <b>' + rec.signal.label + '</b>.'
        : '. This app\'s own engine has no price history loaded for this symbol, so the advice below uses TradingView\'s reading alone.');

    const steps = [];
    if (rec) {
      const ourLong = rec.signal.label === 'Buy' || rec.signal.label === 'Hold long';
      if ((tvBull && ourLong) || (tvBear && !ourLong)) {
        steps.push('<b>The two engines agree' + (tvBull ? ' (bullish)' : ' (defensive)') + '.</b> Follow the ' +
          rec.strategy.name + ' rules mechanically: ' + rec.strategy.lesson.rules.join(' ') +
          ' Let the exit rule close the position — not emotions or headlines.');
      } else {
        steps.push('<b>The engines disagree</b> (TradingView: ' + tvR.label + ', this app: ' + rec.signal.label +
          '). Conflicting signals are historically the worst time to open new positions — the patient move is to wait until they line up, and watch the levels below in the meantime.');
      }
    } else if (tvBull) {
      steps.push('<b>TradingView leans bullish.</b> If you act on it, act with a written plan: know the entry reason, the exit rule, and the maximum acceptable loss before buying.');
    } else if (tvBear) {
      steps.push('<b>TradingView leans defensive.</b> Avoid fresh entries; if you hold the stock, decide in advance what level or signal would make you exit.');
    } else {
      steps.push('<b>TradingView reads this as Neutral.</b> No edge either way — waiting costs nothing.');
    }
    if (tv.SMA50 != null && tv.close != null) {
      const above = tv.close > tv.SMA50;
      steps.push('<b>Watch the 50-day average at ' + fmtMoney(tv.SMA50) + '.</b> Price is ' +
        (above ? 'above' : 'below') + ' it now; a decisive close ' + (above ? 'below' : 'above') +
        ' that level would flip the medium-term trend reading and should make you re-check the signals.');
    }
    if (tv.ATR != null && tv.close != null) {
      const stop = 2 * tv.ATR;
      steps.push('<b>Plan risk before acting.</b> This symbol moves about ' + fmtMoney(tv.ATR) +
        ' per day (ATR). A common protective stop is 2×ATR ≈ ' + fmtMoney(stop) + ' away from entry (' +
        (stop / tv.close * 100).toFixed(1) + '% of price) — size the position so losing that much is acceptable.');
    }
    if (tv.price_52_week_high != null && tv.price_52_week_low != null && tv.close != null) {
      const pos = (tv.close - tv.price_52_week_low) / (tv.price_52_week_high - tv.price_52_week_low) * 100;
      const perf = [['1M', tv['Perf.1M']], ['6M', tv['Perf.6M']], ['1Y', tv['Perf.Y']]]
        .filter(p => p[1] != null)
        .map(p => p[0] + ' ' + fmtPct(p[1] / 100))
        .join(' · ');
      steps.push('<b>Context:</b> price sits at ' + Math.round(pos) + '% of its 52-week range (' +
        fmtMoney(tv.price_52_week_low) + ' – ' + fmtMoney(tv.price_52_week_high) + ').' +
        (perf ? ' Performance: ' + perf + '.' : '') +
        ' Momentum strategies prefer entries near the top of the range; mean-reversion entries near the bottom.');
    }
    steps.push('Signals age fast — reload before acting, and treat all of this as education, not financial advice.');

    return '<h3>What to do next</h3><p>' + lead + '</p><ul>' +
      steps.map(x => '<li>' + x + '</li>').join('') + '</ul>';
  }

  let lastTv = null, lastTvSymbol = null;   // so the suggestion can refresh once our engine catches up

  async function renderTvAnalysis(symbol, reqAtCall) {
    const statusEl = $('tva-status'), bodyEl = $('tva-body');
    statusEl.textContent = 'Loading TradingView analysis…';
    bodyEl.hidden = true;
    try {
      const tv = await DataSource.fetchTradingViewAnalysis(symbol);
      if (reqAtCall !== loadReq) return;   // a newer symbol load superseded this
      lastTv = tv;
      lastTvSymbol = symbol;

      $('tva-ratings').innerHTML =
        ratingPill('TradingView rating · Daily', tv['Recommend.All']) +
        ratingPill('Weekly', tv['Recommend.All|1W']) +
        ratingPill('Monthly', tv['Recommend.All|1M']) +
        ratingPill('Moving averages', tv['Recommend.MA']) +
        ratingPill('Oscillators', tv['Recommend.Other']);

      const f2 = v => v != null && isFinite(v) ? v.toFixed(2) : '–';
      const items = [
        ['Close (TradingView)', tv.close != null ? fmtMoney(tv.close) : '–'],
        ['Change today', tv.change != null ? fmtPct(tv.change / 100, 2) : '–', tv.change == null ? '' : tv.change >= 0 ? 'up' : 'down'],
        ['RSI (14)', f2(tv.RSI)],
        ['MACD − signal', tv['MACD.macd'] != null && tv['MACD.signal'] != null ? f2(tv['MACD.macd'] - tv['MACD.signal']) : '–'],
        ['ADX (trend strength)', tv.ADX != null ? f2(tv.ADX) + (tv.ADX >= 25 ? ' (trending)' : ' (weak trend)') : '–'],
        ['Stochastic %K', f2(tv['Stoch.K'])],
        ['ATR (daily range)', tv.ATR != null ? fmtMoney(tv.ATR) : '–'],
        ['vs SMA 20', tv.SMA20 != null && tv.close != null ? (tv.close > tv.SMA20 ? 'above' : 'below') + ' (' + fmtMoney(tv.SMA20) + ')' : '–'],
        ['vs SMA 50', tv.SMA50 != null && tv.close != null ? (tv.close > tv.SMA50 ? 'above' : 'below') + ' (' + fmtMoney(tv.SMA50) + ')' : '–'],
        ['vs SMA 200', tv.SMA200 != null && tv.close != null ? (tv.close > tv.SMA200 ? 'above' : 'below') + ' (' + fmtMoney(tv.SMA200) + ')' : '–'],
      ];
      $('tva-grid').innerHTML = items.map(([label, value, cls]) =>
        '<div class="pd-item"><div class="pd-label">' + label + '</div>' +
        '<div class="pd-value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>'
      ).join('');

      $('tva-suggestion').innerHTML = tvSuggestionHTML(tv, symbol);
      statusEl.textContent = 'Live values from TradingView\'s scanner for ' + tv.ticker +
        ' — the same numbers behind their technicals gauge.';
      bodyEl.hidden = false;
    } catch (err) {
      if (reqAtCall !== loadReq) return;
      statusEl.textContent = 'TradingView analysis unavailable: ' + err.message;
    }
  }

  // ---------- data table (accessibility fallback) ----------
  function renderDataTable() {
    const tbody = $('data-table').querySelector('tbody');
    const recent = bars.slice(-30);
    const offset = bars.length - recent.length;
    tbody.innerHTML = recent.map((b, j) => {
      const i = offset + j;
      return '<tr><td>' + b.date + '</td><td>' + fmtMoney(b.open) + '</td><td>' + fmtMoney(b.high)
        + '</td><td>' + fmtMoney(b.low) + '</td><td>' + fmtMoney(b.close) + '</td><td>' + fmtNum(b.volume)
        + '</td><td>' + (ind.sma20[i] != null ? fmtMoney(ind.sma20[i]) : '–')
        + '</td><td>' + (ind.rsi14[i] != null ? ind.rsi14[i].toFixed(1) : '–') + '</td></tr>';
    }).reverse().join('');
  }

  // ---------- recommendation ----------
  function signalBadge(sig) {
    return '<span class="signal-badge signal-' + sig.cls + '">' + sig.icon + ' ' + sig.label + '</span>';
  }

  function renderRecommendation() {
    const { regime, recommended, runnerUp, results, buyHoldReturn } = analysis;
    const s = recommended.strategy;

    $('reco-card').innerHTML =
      '<h3>' + s.name + ' <span class="muted" style="font-weight:400;font-size:13px">· ' + s.type + '</span></h3>' +
      '<div class="reco-signal">Current signal: ' + signalBadge(recommended.signal) + '</div>' +
      '<p><b>Why this strategy now:</b> The market regime reads as <b>' + regime.trend + '</b> with ' +
      regime.volLabel + ' volatility (' + (regime.vol * 100).toFixed(0) + '% annualized), and ' + recommended.fit.reason + '.</p>' +
      '<ul>' +
      '<li>Backtested on this data: <b>' + fmtPct(recommended.bt.totalReturn) + '</b> vs <b>' + fmtPct(buyHoldReturn) + '</b> for buy &amp; hold.</li>' +
      '<li>Win rate ' + (recommended.bt.winRate != null ? Math.round(recommended.bt.winRate * 100) + '%' : 'n/a') +
      ' across ' + recommended.bt.trades + ' trade' + (recommended.bt.trades === 1 ? '' : 's') +
      ', worst drawdown ' + fmtPct(-recommended.bt.maxDrawdown) + '.</li>' +
      '<li>Runner-up: <b>' + runnerUp.strategy.name + '</b> (' + runnerUp.fit.reason + ').</li>' +
      '</ul>' +
      '<button class="learn-link" data-learn="' + s.id + '">Learn how ' + s.name + ' works →</button>' +
      '<div class="plan-block">' +
      '<h4>Should you buy — and how much?</h4>' +
      '<div id="sizing-block"></div>' +
      '</div>';

    $('reco-card').querySelector('[data-learn]')
      .addEventListener('click', e => openLesson(e.target.dataset.learn));
    renderSizing();

    const tbody = $('strategy-table').querySelector('tbody');
    tbody.innerHTML = [...results]
      .sort((a, b) => b.score - a.score)
      .map(r =>
        '<tr' + (r === recommended ? ' class="recommended"' : '') + '>' +
        '<td><button class="learn-link" data-learn="' + r.strategy.id + '" style="background:none;border:none;padding:0;color:var(--accent);cursor:pointer;text-decoration:underline;font:inherit">' + r.strategy.name + '</button>' +
        (r === recommended ? ' ★' : '') + '</td>' +
        '<td>' + signalBadge(r.signal) + '</td>' +
        '<td>' + Math.round(r.fit.score) + ' / 100</td>' +
        '<td>' + fmtPct(r.bt.totalReturn) + '</td>' +
        '<td>' + fmtPct(analysis.buyHoldReturn) + '</td>' +
        '<td>' + (r.bt.winRate != null ? Math.round(r.bt.winRate * 100) + '%' : '–') + '</td>' +
        '<td>' + fmtPct(-r.bt.maxDrawdown) + '</td>' +
        '<td>' + r.bt.trades + '</td>' +
        '</tr>'
      ).join('');

    tbody.querySelectorAll('[data-learn]').forEach(btn =>
      btn.addEventListener('click', () => openLesson(btn.dataset.learn)));
  }

  // ---------- buy verdict + position sizing ----------
  let capitalValue = 10000;

  function renderSizing() {
    if (!analysis || !$('sizing-block')) return;
    const p = Strategies.positionPlan(bars, ind, analysis, capitalValue);
    const rec = analysis.recommended;
    const pctTxt = (p.suggestedPct * 100).toFixed(0) + '%';
    const details =
      '<ul class="plan-details">' +
      '<li><b>Risk rule:</b> risking 1% of capital with a 2×ATR protective stop (' + fmtMoney(p.stopDist) +
      ' = ' + (p.stopPct * 100).toFixed(1) + '% below entry) allows up to ' + (p.riskPct * 100).toFixed(0) + '% of capital.</li>' +
      '<li><b>Volatility rule:</b> at ' + (analysis.regime.vol * 100).toFixed(0) +
      '% annualized volatility, a ~10% portfolio-volatility target allows up to ' + (p.volPct * 100).toFixed(0) + '%.</li>' +
      '<li><b>Concentration cap:</b> never more than 25% in a single position. The suggestion takes the smallest of the three.</li>' +
      '</ul>';

    const basedOn = '<p class="hint">Based on your amount to invest: <b>' + fmtMoney(capitalValue) +
      '</b> — edit it at the top of the page and these numbers update live.</p>';
    if (p.stance === 'wait') {
      $('sizing-block').innerHTML = basedOn +
        '<p class="plan-verdict no-buy">Verdict: <b>don\'t buy right now — 0% allocation.</b></p>' +
        '<ul class="plan-details">' + p.reasons.map(r => '<li>' + r + '.</li>').join('') + '</ul>' +
        '<p>What would change the verdict: ' + rec.strategy.lesson.rules[0] +
        ' If you already hold this, follow the strategy\'s exit rule instead of hoping.</p>' +
        '<p class="hint">When a buy signal does appear, the sizing rules will apply: a first position around <b>' +
        pctTxt + ' of capital</b>' + (capitalValue > 0 ? ' (≈ ' + fmtMoney(p.dollars) +
        (p.shares > 0 ? ', ' + p.shares.toLocaleString('en-US') + ' shares at ' + fmtMoney(p.price) : '') + ')' : '') + '.</p>' +
        details;
    } else {
      $('sizing-block').innerHTML = basedOn +
        '<p class="plan-verdict ok-buy">Verdict: <b>a position is defensible — suggested starting size ' + pctTxt +
        ' of capital</b>' + (capitalValue > 0 ? ' ≈ <b>' + fmtMoney(p.dollars) + '</b>' +
        (p.shares > 0 ? ' (' + p.shares.toLocaleString('en-US') + ' shares at ' + fmtMoney(p.price) + ')' : '') : '') + '.</p>' +
        details +
        '<p class="hint">Keep the rest in cash or diversified holdings; add only if the strategy\'s rules stay bullish. Never all-in on one symbol.</p>';
    }
  }

  // ---------- learn section ----------
  function learnCardsHTML(list) {
    return list.map(s =>
      '<button class="learn-card" data-learn="' + s.id + '">' +
      '<span class="card-type">' + s.type + '</span>' +
      '<h3>' + s.name + '</h3>' +
      '<p>' + s.summary + '</p>' +
      '</button>'
    ).join('');
  }

  function renderLearnGrid() {
    $('learn-groups').innerHTML =
      '<h3 class="learn-group-title">Position &amp; swing strategies <span class="muted">— backtested live on the loaded data</span></h3>' +
      '<div class="learn-grid">' + learnCardsHTML(Strategies.catalog) + '</div>' +
      '<h3 class="learn-group-title">Short-term &amp; day trading <span class="muted">— study them on the Hourly / 1D / 5D ranges</span></h3>' +
      '<div class="learn-grid">' + learnCardsHTML(Strategies.shortTermCatalog) + '</div>';
    $('learn-groups').querySelectorAll('[data-learn]').forEach(btn =>
      btn.addEventListener('click', () => openLesson(btn.dataset.learn)));
  }

  function openLesson(id) {
    const s = Strategies.catalog.find(x => x.id === id)
      || Strategies.shortTermCatalog.find(x => x.id === id);
    if (!s) return;
    const L = s.lesson;

    let liveNote = '';
    if (analysis) {
      const r = analysis.results.find(x => x.strategy.id === id);
      if (r) {
        liveNote = '<div class="live-note"><b>On the data you just loaded:</b> current signal is <b>' +
          r.signal.label + '</b>; this strategy returned <b>' + fmtPct(r.bt.totalReturn) +
          '</b> over the period (buy &amp; hold: ' + fmtPct(analysis.buyHoldReturn) + ') across ' +
          r.bt.trades + ' trade' + (r.bt.trades === 1 ? '' : 's') + '. Regime fit: ' +
          Math.round(r.fit.score) + '/100 — ' + r.fit.reason + '.</div>';
      }
    }

    $('modal-body').innerHTML =
      '<div class="lesson-type">' + s.type + '</div>' +
      '<h2 id="modal-title">' + s.name + '</h2>' +
      '<h3>What it is</h3><p>' + L.what + '</p>' +
      '<h3>The exact rules</h3><div class="rule-box"><ul>' +
      L.rules.map(r => '<li>' + r + '</li>').join('') + '</ul></div>' +
      '<h3>The math</h3><p><code>' + L.formula + '</code></p>' +
      '<h3>Strengths</h3><ul>' + L.strengths.map(x => '<li>' + x + '</li>').join('') + '</ul>' +
      '<h3>Weaknesses</h3><ul>' + L.weaknesses.map(x => '<li>' + x + '</li>').join('') + '</ul>' +
      '<h3>Best used when</h3><p>' + L.bestFor + '</p>' +
      '<h3>Try it on the chart</h3><p>' + L.tip + '</p>' +
      liveNote;

    $('modal-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('modal-backdrop').hidden = true;
    document.body.style.overflow = '';
  }
  window.openStrategyLesson = openLesson;   // the practice section links into the same lessons
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', e => { if (e.target === $('modal-backdrop')) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('modal-backdrop').hidden) closeModal();
    else if (bars) showLatestDetails();   // Esc jumps the details back to the latest bar
  });

  // ---------- boot ----------
  renderLearnGrid();
  // Browsers may restore a previously typed amount into the field on reload.
  capitalValue = Math.max(0, parseFloat($('capital-input').value) || 0) || capitalValue;
  loadAndAnalyze();   // auto-load live data for the default symbol on open
})();
