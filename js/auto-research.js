/* ============================================================
   Auto-researcher — the app researches the market by itself.

   Stage 1 (cheap): screens TradingView's whole US universe in bulk
   — quality floors + ranking by technical rating and momentum.
   Stage 2 (slow, deliberate): grinds down the ranked list forever,
   one candidate at a time — 10 years of daily bars, indicators,
   regime, all six strategy backtests, a buy/wait sizing verdict —
   narrating every step in a visible research diary.

   FULLY AUTOMATIC investing: it manages the practice paper-
   portfolio (js/practice.js, shared with the main page through
   localStorage) — keeps the top K=5 BUY-verdict stocks, sells what
   drops out, buys what earns its way in. Virtual money only.

   Progress, results, and the grind position persist in
   localStorage; reopening the page restores the report and, if it
   was mid-grind, keeps researching.
   ============================================================ */
const AutoResearch = (() => {
  const $ = id => document.getElementById(id);
  const { fmt } = Practice;   // shared, coercing formatters + esc

  const LS_KEY = 'stockLab.autoResearch.v1';
  // The money is split three ways: slow strategies get patient capital,
  // fast mean-reversion setups get a smaller trading sleeve, and a hard
  // cash reserve always stays untouched.
  const LONG_SLOTS = 3;          // long-term holds (trend / momentum / buy & hold)
  const SHORT_SLOTS = 2;         // short-term trades (mean-reversion strategies)
  const LONG_FRACTION = 0.60;    // of total account value
  const SHORT_FRACTION = 0.20;
  const K_TARGETS = LONG_SLOTS + SHORT_SLOTS;
  const HYSTERESIS = 5;         // composite points a newcomer needs over the weakest incumbent
  const INVEST_FRACTION = LONG_FRACTION + SHORT_FRACTION;   // hard 20% cash reserve
  const RECHECK_EVERY = 10;     // re-check current holdings every N researched candidates
  const DATA_TTL_MS = 2 * 3600 * 1000;   // holdings re-checked on fresh data after 2 h
  const MIN_ALLOC = 25;         // $ floor per position
  const TOPUP_MIN = 50;         // only top-up when underweight by more than this
  const MIN_BARS = 250;         // regime/backtests need real history
  const STALE_MS = 24 * 3600 * 1000;      // re-research after a day
  const FAILED_RETRY_MS = 3600 * 1000;    // retry feed failures after an hour
  const PAGE_SIZE = 50;
  const MAX_DIARY = 200;
  const MAX_TABLE_ROWS = 50;
  const GAP_MS = () => (typeof window.__AUTO_GAP === 'number' ? window.__AUTO_GAP : 400);

  const SCREEN_COLUMNS = [
    'name', 'description', 'close', 'change', 'market_cap_basic', 'volume',
    'Recommend.All', 'Recommend.MA', 'Recommend.Other', 'RSI', 'ADX',
    'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y',
    'price_52_week_high', 'price_52_week_low',
  ];

  // ---------- state ----------
  let runToken = 0;
  let running = false;
  let practiceReady = false;
  let practiceInitPromise = null;

  // Practice.init registers window listeners — it must run exactly once.
  function initPractice() {
    if (!practiceInitPromise) {
      practiceInitPromise = Practice.init().then(() => { practiceReady = true; });
    }
    return practiceInitPromise;
  }

  const fmtBig = v =>
    v >= 1e12 ? '$' + (v / 1e12).toFixed(1).replace(/\.0$/, '') + 'T'
    : v >= 1e9 ? '$' + (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
    : '$' + Math.round(v / 1e6) + 'M';

  let state = {
    rows: [],            // researched results, unordered (rendering sorts)
    targets: { long: [], short: [] },   // current robo-portfolio, by sleeve
    queue: [],           // screened candidates waiting for deep research
    screenOffset: 0,     // next page into the rating screen
    universeTotal: null,
    momentumDone: false,
    params: { minCap: 2e9 },
    diary: [],           // [{ html, cls }]
    running: false,
    updatedAt: null,
  };
  const bySymbol = new Map();

  function persist() {
    state.running = running;
    state.updatedAt = new Date().toISOString();
    try {
      const { queue, ...rest } = state;
      localStorage.setItem(LS_KEY, JSON.stringify({ ...rest, queue: queue.slice(0, 200) }));
    } catch (e) { /* quota — the grind still works, it just won't survive reload */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const doc = JSON.parse(raw);
      if (!doc || !Array.isArray(doc.rows)) return false;
      state = { ...state, ...doc };
      state.queue = Array.isArray(doc.queue) ? doc.queue : [];
      // Older saves stored targets as a flat array — fold them into the long sleeve.
      if (Array.isArray(state.targets)) state.targets = { long: state.targets.slice(0, LONG_SLOTS), short: [] };
      if (!state.targets || typeof state.targets !== 'object') state.targets = { long: [], short: [] };
      state.targets.long = state.targets.long || [];
      state.targets.short = state.targets.short || [];
      bySymbol.clear();
      for (const r of state.rows) bySymbol.set(r.symbol, r);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- diary ----------
  function diary(html, cls) {
    state.diary.push({ html, cls: cls || '' });
    if (state.diary.length > MAX_DIARY) state.diary = state.diary.slice(-MAX_DIARY);
    const log = $('auto-log');
    log.hidden = false;
    const div = document.createElement('div');
    div.className = cls || '';
    div.innerHTML = html;
    log.appendChild(div);
    while (log.children.length > MAX_DIARY) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function renderDiaryFromState() {
    const log = $('auto-log');
    if (!state.diary.length) return;
    log.hidden = false;
    log.innerHTML = state.diary.map(l => '<div class="' + fmt.esc(l.cls) + '">' + l.html + '</div>').join('');
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(msg, isError) {
    const el = $('auto-status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  // ---------- scoring ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function tvRatingLabel(v) {
    if (v == null || !isFinite(v)) return '–';
    return v >= 0.5 ? 'Strong Buy' : v >= 0.1 ? 'Buy' : v > -0.1 ? 'Neutral' : v > -0.5 ? 'Sell' : 'Strong Sell';
  }

  function scoreCandidate(analysis, screenRow) {
    const engineScore = analysis.recommended.score;                       // 0-100
    const tvScore = isFinite(screenRow['Recommend.All']) ? (screenRow['Recommend.All'] + 1) / 2 * 100 : 50;
    const label = analysis.recommended.signal.label;
    const signalScore = label === 'Buy' ? 100 : label === 'Hold long' ? 75 : label === 'Stay in cash' ? 30 : 0;
    const dd = analysis.recommended.bt.maxDrawdown;
    const ddPenalty = Math.min(15, Math.max(0, (dd - 0.35) * 60));
    const composite = clamp(Math.round(0.45 * engineScore + 0.30 * tvScore + 0.25 * signalScore - ddPenalty), 0, 100);
    return { composite, engineScore: Math.round(engineScore), tvScore: Math.round(tvScore), signalScore, ddPenalty: Math.round(ddPenalty) };
  }

  // Which sleeve a pick belongs to follows from the strategy the research
  // itself chose: fast mean-reversion setups are short-term trades (sold as
  // soon as their signal turns); everything else is a long-term hold.
  function sleeveOf(strategyId) {
    const s = Strategies.catalog.find(x => x.id === strategyId);
    return s && s.type === 'Mean reversion' ? 'short' : 'long';
  }
  const SLEEVE_LABEL = { long: 'Long-term hold', short: 'Short-term trade' };

  function decideVerdict(analysis, plan, composite) {
    const label = analysis.recommended.signal.label;
    if (label === 'Sell') return { verdict: 'SKIP', reason: 'the best-fit strategy just fired a Sell' };
    if (composite < 45) return { verdict: 'SKIP', reason: 'composite score ' + composite + ' — nothing here works well' };
    if (plan.stance === 'invest' && (label === 'Buy' || label === 'Hold long') && composite >= 60) {
      return { verdict: 'BUY', reason: analysis.recommended.fit.reason };
    }
    return { verdict: 'WATCH', reason: plan.stance === 'wait' ? (plan.reasons[0] || 'entry conditions not met') : 'composite ' + composite + ' — not strong enough to buy' };
  }

  // ---------- stage 1: screening ----------
  function screenFilters(minCap) {
    return [
      { left: 'market_cap_basic', operation: 'egreater', right: minCap },
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'volume', operation: 'greater', right: 500000 },
      { left: 'Recommend.All', operation: 'nempty' },
    ];
  }

  function toCandidate(row) {
    return { ...row, symbol: row.name, companyName: row.description || row.name };
  }

  async function initialScreens(myRun) {
    setStatus('Screening the whole US universe…');
    diary('<span class="head">Screening ~all US stocks (cap ≥ ' + fmtBig(state.params.minCap) + ', price &gt; $5, liquid)…</span>', 'head');
    const rating = await DataSource.screenStocks({
      filters: screenFilters(state.params.minCap),
      columns: SCREEN_COLUMNS,
      sortBy: 'Recommend.All', sortOrder: 'desc',
      offset: 0, limit: PAGE_SIZE,
    });
    if (myRun !== runToken) return false;
    state.universeTotal = rating.total;
    state.screenOffset = PAGE_SIZE;

    let momentum = { rows: [] };
    try {
      momentum = await DataSource.screenStocks({
        filters: [...screenFilters(state.params.minCap), { left: 'Perf.6M', operation: 'greater', right: 0 }],
        columns: SCREEN_COLUMNS,
        sortBy: 'Perf.6M', sortOrder: 'desc',
        offset: 0, limit: 20,
      });
    } catch (e) {
      diary('Momentum screen unavailable — continuing on the rating screen alone.', 'note');
    }
    if (myRun !== runToken) return false;

    const seen = new Set();
    const pool = [];
    for (const r of [...rating.rows, ...momentum.rows]) {
      if (seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      pool.push(toCandidate(r));
    }
    // Best-first: 70% technical rating, 30% 6-month momentum.
    const screenScore = c => {
      const tvNorm = isFinite(c['Recommend.All']) ? (c['Recommend.All'] + 1) / 2 * 100 : 0;
      const perfNorm = clamp(isFinite(c['Perf.6M']) ? c['Perf.6M'] : 0, 0, 100);
      return 0.7 * tvNorm + 0.3 * perfNorm;
    };
    pool.sort((a, b) => screenScore(b) - screenScore(a));
    state.queue = pool;
    diary('Screen found <b>' + fmt.num(rating.total) + '</b> candidates passing the quality floors — researching them best-first, forever, until you press Stop.', 'note');
    return true;
  }

  async function fetchNextPage(myRun) {
    const page = await DataSource.screenStocks({
      filters: screenFilters(state.params.minCap),
      columns: SCREEN_COLUMNS,
      sortBy: 'Recommend.All', sortOrder: 'desc',
      offset: state.screenOffset, limit: PAGE_SIZE,
    });
    if (myRun !== runToken) return false;
    state.screenOffset += PAGE_SIZE;
    state.queue.push(...page.rows.map(toCandidate));
    return page.rows.length > 0;
  }

  // ---------- stage 2: deep research ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function accountValue() {
    const t = practiceReady ? Practice.totals() : null;
    if (t) return t.totalValue;
    return Math.max(100, parseFloat($('auto-capital').value) || 10000);
  }

  async function researchOne(cand, index) {
    const symbol = cand.symbol;
    const tag = '[' + index + (state.universeTotal ? '/' + fmt.num(state.universeTotal) : '') + '] <b>' + fmt.esc(symbol) + '</b>';
    let bars;
    const cached = window.SimPageBridge && SimPageBridge.barsCache.get(symbol);
    if (cached) {
      bars = cached.bars;
    } else {
      diary(tag + ' — fetching ~10 years of daily bars…');
      bars = await DataSource.load('yahoo', symbol, '');
      if (window.SimPageBridge) SimPageBridge.barsCache.set(symbol, { bars, full: false, fetchedAt: Date.now() });
    }
    if (bars.length < MIN_BARS) {
      diary(tag + ' — only ' + bars.length + ' trading days of history → <b>SKIP</b> (too young to judge).', 'fail');
      return makeRow(cand, null, null, null, { verdict: 'SKIP', reason: 'only ' + bars.length + ' days of history' });
    }
    const ind = Indicators.computeAll(bars);
    const analysis = Strategies.analyze(bars, ind);
    const plan = Strategies.positionPlan(bars, ind, analysis, accountValue());
    const scores = scoreCandidate(analysis, cand);
    const dec = decideVerdict(analysis, plan, scores.composite);
    const row = makeRow(cand, analysis, plan, scores, dec);
    diary(tag + ' — regime: ' + fmt.esc(analysis.regime.trend) + ' · best strategy: ' + fmt.esc(analysis.recommended.strategy.name) +
      ' (' + fmt.esc(analysis.recommended.signal.label) + ') · score <b>' + scores.composite + '</b> → ' +
      verdictChip(row.verdict), row.verdict === 'BUY' ? 'ok' : row.verdict === 'SKIP' ? 'fail' : '');
    return row;
  }

  function makeRow(cand, analysis, plan, scores, dec) {
    return {
      symbol: cand.symbol,
      ticker: cand.ticker,
      companyName: cand.companyName,
      close: cand.close,
      change: cand.change,
      tvRating: cand['Recommend.All'],
      verdict: dec.verdict,
      reason: dec.reason,
      composite: scores ? scores.composite : 0,
      engineScore: scores ? scores.engineScore : null,
      tvScore: scores ? scores.tvScore : null,
      signalScore: scores ? scores.signalScore : null,
      ddPenalty: scores ? scores.ddPenalty : null,
      strategyId: analysis ? analysis.recommended.strategy.id : null,
      strategyName: analysis ? analysis.recommended.strategy.name : null,
      sleeve: analysis ? sleeveOf(analysis.recommended.strategy.id) : 'long',
      signalLabel: analysis ? analysis.recommended.signal.label : null,
      signalCls: analysis ? analysis.recommended.signal.cls : null,
      btReturn: analysis ? analysis.recommended.bt.totalReturn : null,
      bhReturn: analysis ? analysis.buyHoldReturn : null,
      maxDrawdown: analysis ? analysis.recommended.bt.maxDrawdown : null,
      regime: analysis ? analysis.regime.trend : null,
      suggestedPct: plan ? plan.suggestedPct : 0,
      planDollars: plan ? plan.dollars : 0,
      failed: false,
      researchedAt: new Date().toISOString(),
    };
  }

  function upsertRow(row) {
    const old = bySymbol.get(row.symbol);
    if (old) state.rows[state.rows.indexOf(old)] = row;
    else state.rows.push(row);
    bySymbol.set(row.symbol, row);
  }

  // ---------- the robo-portfolio (fully automatic) ----------
  function heldSymbols() {
    const live = Practice.getState().live;
    return live ? live.positions.filter(p => p.shares > 0).map(p => p.symbol) : [];
  }

  function pickSleeve(sleeve, slots) {
    const desc = (a, b) => b.composite - a.composite;
    const buys = state.rows.filter(r => r.verdict === 'BUY' && r.sleeve === sleeve).sort(desc);
    // Incumbents keep their seat unless a newcomer clearly outscores them.
    let list = (state.targets[sleeve] || [])
      .map(s => bySymbol.get(s))
      .filter(r => r && r.verdict === 'BUY' && r.sleeve === sleeve)
      .sort(desc)
      .slice(0, slots);
    for (const cand of buys) {
      if (list.some(r => r.symbol === cand.symbol)) continue;
      if (list.length < slots) {
        list.push(cand);
        list.sort(desc);
      } else {
        const weakest = list[list.length - 1];
        if (cand.composite >= weakest.composite + HYSTERESIS) {
          diary(fmt.esc(cand.symbol) + ' (score ' + cand.composite + ') displaces ' + fmt.esc(weakest.symbol) +
            ' (score ' + weakest.composite + ') among the ' + SLEEVE_LABEL[sleeve].toLowerCase() + 's.', 'note');
          list[list.length - 1] = cand;
          list.sort(desc);
        }
      }
    }
    return list.map(r => r.symbol);
  }

  function computeTargets() {
    return { long: pickSleeve('long', LONG_SLOTS), short: pickSleeve('short', SHORT_SLOTS) };
  }

  function sameSet(a, b) {
    return a.length === b.length && a.every(x => b.includes(x));
  }

  async function ensureAccount() {
    await initPractice();
    const wanted = Math.max(100, parseFloat($('auto-capital').value) || 10000);
    const live = Practice.getState().live;
    if (!live) {
      Practice.createAccount(wanted);
      diary('<span class="head">Opened a practice account with ' + fmt.money(wanted) + ' of virtual money — the researcher manages it automatically.</span>', 'head');
    } else if (Math.abs(live.startingCash - wanted) >= 0.5) {
      // The user typed a different starting amount than the account they
      // already have — honor it only with their explicit OK, because the
      // reset erases the existing practice portfolio and its history.
      const t = Practice.totals();
      if (confirm('You already have a practice account worth ' + fmt.money(t.totalValue) +
        ' (it started with ' + fmt.money(live.startingCash) + ').\n\n' +
        'Reset it and start fresh with ' + fmt.money(wanted) + '?\n' +
        'OK = reset to ' + fmt.money(wanted) + '   ·   Cancel = keep the current account')) {
        Practice.resetAccount();
        Practice.createAccount(wanted);
        state.targets = { long: [], short: [] };
        persist();
        diary('<span class="head">Account reset — starting fresh with ' + fmt.money(wanted) + ' of virtual money.</span>', 'head');
      } else {
        $('auto-capital').value = String(Math.round(live.startingCash));
        diary('Keeping the existing account (started with ' + fmt.money(live.startingCash) + ').', 'note');
      }
    }
    renderPortfolio();
  }

  function reconcile(targets) {
    const live = Practice.getState().live;
    if (!live) return;
    const allTargets = [...targets.long, ...targets.short];

    // 1. Sell everything the researcher no longer wants.
    for (const symbol of heldSymbols()) {
      if (!allTargets.includes(symbol)) {
        const row = bySymbol.get(symbol);
        const r = Practice.sell(symbol, { all: true });
        if (r.ok) {
          diary('SOLD ' + fmt.esc(symbol) + ' — ' + (row
            ? (row.verdict === 'BUY' ? 'outscored by better ' + SLEEVE_LABEL[row.sleeve].toLowerCase() + 's (score ' + row.composite + ')' : 'verdict turned ' + fmt.esc(row.verdict) + ': ' + fmt.esc(row.reason))
            : 'not part of the research plan') + '.', 'fail');
        }
      }
    }

    // 2. Buy / top-up per sleeve: smaller of risk-based sizing and the
    // sleeve's fixed slot budget. Slots are always sized for the FULL slot
    // count — an early lone pick must not hog the budget later picks need.
    const totals = Practice.totals();
    const reserve = (1 - INVEST_FRACTION) * totals.totalValue;
    const slotBudget = {
      long: (LONG_FRACTION * totals.totalValue) / LONG_SLOTS,
      short: (SHORT_FRACTION * totals.totalValue) / SHORT_SLOTS,
    };
    for (const sleeve of ['long', 'short']) {
      for (const symbol of targets[sleeve]) {
        const row = bySymbol.get(symbol);
        if (!row) continue;
        let pos = Practice.findPosition(symbol);
        if (!pos) {
          Practice.addPosition({
            symbol,
            name: row.companyName,
            resolvedTicker: row.ticker,
            lastPrice: row.close,
            dayChangePct: row.change,
          });
          pos = Practice.findPosition(symbol);
        }
        if (!pos) continue;
        if (row.strategyId && pos.strategyId !== row.strategyId) Practice.setStrategy(symbol, row.strategyId);
        const alloc = Math.min(row.planDollars || slotBudget[sleeve], slotBudget[sleeve]);
        if (alloc < MIN_ALLOC) {
          diary(fmt.esc(symbol) + ' — allocation ' + fmt.money(alloc) + ' is below the ' + fmt.money(MIN_ALLOC) + ' floor, skipped.', 'note');
          continue;
        }
        const currentMV = pos.shares > 0 && pos.lastPrice != null ? pos.shares * pos.lastPrice : 0;
        const need = Math.floor(alloc - currentMV);
        if (need > TOPUP_MIN) {
          // Hard floor: buys never dip the cash below the 20% reserve.
          const cash = Practice.getState().live.cash;
          const spend = Math.floor(Math.min(need, cash - reserve));
          if (spend >= MIN_ALLOC) {
            const r = Practice.buy(symbol, spend);
            if (r.ok) {
              diary('BOUGHT ' + fmt.money(spend) + ' of ' + fmt.esc(symbol) + ' as a ' + SLEEVE_LABEL[sleeve].toLowerCase() +
                ' with the ' + fmt.esc(row.strategyName || '') + ' strategy (target ' + fmt.money(alloc) + ').', 'ok');
            } else {
              diary(fmt.esc(symbol) + ' — buy failed: ' + fmt.esc(r.error || 'unknown') + '.', 'fail');
            }
          }
        }
      }
    }

    state.targets = targets;
    renderPortfolio();
  }

  function maybeReconcile() {
    const targets = computeTargets();
    const allTargets = [...targets.long, ...targets.short];
    const holdingTurnedBad = heldSymbols().some(s => {
      const row = bySymbol.get(s);
      return row && row.verdict !== 'BUY' && !allTargets.includes(s);
    });
    const changed = !sameSet(targets.long, state.targets.long || []) ||
      !sameSet(targets.short, state.targets.short || []);
    if (changed || holdingTurnedBad) reconcile(targets);
  }

  // Short-term trades only work if holdings get re-examined: every few
  // researched candidates, holdings whose data has gone stale (2 h+) are
  // re-fetched and re-researched — a turned signal then triggers the sell.
  async function recheckHoldings(myRun) {
    for (const symbol of heldSymbols()) {
      if (myRun !== runToken) return;
      const row = bySymbol.get(symbol);
      if (!row) continue;
      const cached = window.SimPageBridge && SimPageBridge.barsCache.get(symbol);
      const stale = !cached || !cached.fetchedAt || Date.now() - cached.fetchedAt > DATA_TTL_MS;
      if (!stale) continue;
      if (cached) SimPageBridge.barsCache.delete(symbol);
      diary('Re-checking holding <b>' + fmt.esc(symbol) + '</b> with fresh data…', 'note');
      try {
        const fresh = await researchOne({
          symbol: row.symbol, ticker: row.ticker, companyName: row.companyName,
          close: row.close, change: row.change, 'Recommend.All': row.tvRating,
        }, '↻');
        if (myRun !== runToken) return;
        upsertRow(fresh);
        renderReport();
        maybeReconcile();
      } catch (e) {
        // Keep the old row — the next cycle retries.
      }
      await sleep(GAP_MS());
    }
  }

  // ---------- the grind ----------
  async function start() {
    if (running) return;
    const myRun = ++runToken;
    running = true;
    $('auto-start').textContent = 'Stop';
    $('auto-start').classList.remove('btn-primary');
    $('auto-start').classList.add('btn-secondary');

    try {
      await ensureAccount();
      if (myRun !== runToken) return;

      // Changed market-cap floor invalidates the queue/paging, not the results.
      const minCap = parseFloat($('auto-mincap').value);
      if (minCap !== state.params.minCap) {
        state.params.minCap = minCap;
        state.queue = [];
        state.screenOffset = 0;
        state.momentumDone = false;
        diary('Market-cap floor changed to ' + fmtBig(minCap) + ' — re-screening.', 'note');
      }

      if (!state.queue.length && state.screenOffset === 0) {
        const ok = await initialScreens(myRun);
        if (!ok || myRun !== runToken) return;
      }

      let index = state.rows.length;
      let consecutiveFailures = 0;
      let sinceRecheck = 0;

      while (myRun === runToken) {
        if (!state.queue.length) {
          setStatus('Fetching the next page of candidates…');
          let more = false;
          try {
            more = await fetchNextPage(myRun);
          } catch (e) {
            diary('Candidate screen failed: ' + fmt.esc(e.message) + ' — stopping here; results are kept.', 'fail');
            break;
          }
          if (myRun !== runToken) return;
          if (!more) {
            diary('<span class="head">Universe exhausted — every candidate passing the floors has been researched.</span>', 'head');
            setStatus('Done — the whole screened universe has been researched.');
            break;
          }
          continue;
        }

        const cand = state.queue.shift();
        const existing = bySymbol.get(cand.symbol);
        if (existing) {
          const age = Date.now() - Date.parse(existing.researchedAt);
          const ttl = existing.failed ? FAILED_RETRY_MS : STALE_MS;
          const isHolding = heldSymbols().includes(cand.symbol);
          if (age < ttl && !isHolding) continue;   // fresh enough — quietly keep it
        }

        index++;
        setStatus('Researching #' + index + (state.universeTotal ? ' of ~' + fmt.num(state.universeTotal) + ' candidates' : '') + ' — ' + cand.symbol + '…');
        // Research and rendering/portfolio steps fail SEPARATELY: a UI or
        // reconcile bug must never masquerade as a feed failure and destroy
        // a good research result.
        let row = null;
        try {
          row = await researchOne(cand, index);
        } catch (e) {
          if (myRun !== runToken) return;
          consecutiveFailures++;
          const failedRow = makeRow(cand, null, null, null, { verdict: 'SKIP', reason: 'feed unavailable' });
          failedRow.failed = true;
          upsertRow(failedRow);
          diary('[' + index + '] <b>' + fmt.esc(cand.symbol) + '</b> — feed unavailable (' + fmt.esc(e.message) + '), skipped.', 'fail');
          if (consecutiveFailures >= 5) {
            diary('<span class="head">5 candidates in a row failed — the data feed looks down. Pausing; your results are kept. Press Start to continue later.</span>', 'head');
            setStatus('Paused — the data feed looks down. Results kept.', true);
            break;
          }
        }
        if (myRun !== runToken) return;
        if (row) {
          upsertRow(row);
          consecutiveFailures = 0;
          try {
            renderReport();
            maybeReconcile();
          } catch (e) {
            diary('Portfolio/render step hit an error: ' + fmt.esc(e.message) + ' — the research result is kept.', 'fail');
          }
          if (++sinceRecheck >= RECHECK_EVERY) {
            sinceRecheck = 0;
            await recheckHoldings(myRun);
            if (myRun !== runToken) return;
          }
        }
        persist();
        await sleep(GAP_MS());
      }
    } finally {
      if (myRun === runToken) {
        running = false;
        try { reconcile(computeTargets()); } catch (e) { /* portfolio best-effort */ }
        persist();
        $('auto-start').textContent = 'Start researching';
        $('auto-start').classList.add('btn-primary');
        $('auto-start').classList.remove('btn-secondary');
      }
    }
  }

  function stop() {
    if (!running) return;
    runToken++;
    running = false;
    diary('Stopped by you — ' + state.rows.length + ' stocks researched. The portfolio reflects the latest picks.', 'note');
    setStatus('Stopped — ' + state.rows.length + ' stocks researched so far. Press Start to keep grinding.');
    try { reconcile(computeTargets()); } catch (e) { /* best-effort */ }
    persist();
    $('auto-start').textContent = 'Start researching';
    $('auto-start').classList.add('btn-primary');
    $('auto-start').classList.remove('btn-secondary');
  }

  // ---------- rendering ----------
  function verdictChip(verdict) {
    const cls = verdict === 'BUY' ? 'buy' : verdict === 'SKIP' ? 'sell' : 'hold';
    return '<span class="signal-badge signal-' + cls + '">' + verdict + '</span>';
  }

  function renderPortfolio() {
    const el = $('auto-portfolio');
    if (!practiceReady || !Practice.getState().live) {
      el.hidden = true;
      return;
    }
    const t = Practice.totals();
    const held = heldSymbols();
    el.hidden = false;
    el.innerHTML =
      '<div class="tile"><div class="tile-label">Robo portfolio</div><div class="tile-value">' + fmt.money(t.totalValue) + '</div>' +
      '<div class="tile-delta ' + (t.totalPnl >= 0 ? 'up' : 'down') + '">' + (t.totalPnl >= 0 ? '+' : '−') + fmt.money(Math.abs(t.totalPnl)) + ' total</div></div>' +
      '<div class="tile"><div class="tile-label">Cash reserve</div><div class="tile-value">' + fmt.money(t.cash) + '</div>' +
      '<div class="tile-delta muted">' + fmt.money(t.marketValue) + ' invested</div></div>' +
      '<div class="tile"><div class="tile-label">Holdings</div><div class="tile-value">' + held.length + ' / ' + K_TARGETS + '</div>' +
      '<div class="tile-delta muted">' + fmt.esc(held.join(' · ') || 'all cash') + '</div></div>';
    renderSummary();
  }

  // ---------- "what it's doing and why" + holdings breakdown ----------
  function heldSince(symbol) {
    const live = Practice.getState().live;
    if (!live) return null;
    let shares = 0, since = null;
    for (const t of live.trades) {
      if (t.symbol !== symbol) continue;
      if (t.kind === 'BUY') {
        if (shares <= 1e-9) since = t.at;
        shares += t.shares;
      } else if (t.kind === 'SELL') {
        shares -= t.shares;
        if (shares <= 1e-9) { shares = 0; since = null; }
      }
    }
    return since;
  }

  const daysBetween = iso => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));
  const daysLabel = d => (d === 0 ? 'today' : d + ' day' + (d === 1 ? '' : 's'));

  function renderSummary() {
    const brief = $('auto-brief');
    const live = practiceReady ? Practice.getState().live : null;
    if (!live && !state.rows.length) { brief.hidden = true; return; }
    brief.hidden = false;

    const counts = { BUY: 0, WATCH: 0, SKIP: 0 };
    for (const r of state.rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    const t = live ? Practice.totals() : null;
    const invested = live ? live.positions.reduce((s, p) => s + (p.shares > 0 ? p.shares * p.avgCost : 0), 0) : 0;
    const days = live ? daysBetween(live.createdAt) : 0;

    const sleeveLine = (sleeve, slots, frac) => {
      const syms = state.targets[sleeve] || [];
      const head = '<b>' + SLEEVE_LABEL[sleeve] + 's</b> (' + Math.round(frac * 100) + '% of the money, up to ' + slots + '): ';
      if (!syms.length) return head + 'none qualify right now — that part of the money waits in cash.';
      return head + syms.map(s => {
        const r = bySymbol.get(s);
        return r
          ? fmt.esc(s) + ' <span class="muted">(score ' + r.composite + ', ' + fmt.esc(r.strategyName || '') + ' — ' + fmt.esc(r.reason) + ')</span>'
          : fmt.esc(s);
      }).join('; ') + '.';
    };

    $('auto-summary').innerHTML =
      '<h3>What it\'s doing — and why</h3>' +
      '<p><b>The plan:</b> screen every US stock passing the quality floors, research the best-rated ones one by one, and split the money three ways — ' +
      Math.round(LONG_FRACTION * 100) + '% in up to ' + LONG_SLOTS + ' <b>long-term holds</b> (slow trend, momentum, and buy-and-hold strategies), ' +
      Math.round(SHORT_FRACTION * 100) + '% in up to ' + SHORT_SLOTS + ' <b>short-term trades</b> (fast mean-reversion strategies, sold as soon as their own signal turns), and ' +
      Math.round((1 - INVEST_FRACTION) * 100) + '% always held back in cash. A stock is bought only when its sizing verdict says "invest", its signal is actionable, and its composite score clears 60; it is sold when it drops out of its list or its verdict turns.</p>' +
      '<ul>' +
      '<li><b>Research so far:</b> ' + state.rows.length + ' stocks — ' + counts.BUY + ' buy, ' + counts.WATCH + ' watch, ' + counts.SKIP + ' skip' +
      (state.universeTotal ? ' <span class="muted">(from ' + fmt.num(state.universeTotal) + ' screened candidates)</span>' : '') + '.</li>' +
      '<li>' + sleeveLine('long', LONG_SLOTS, LONG_FRACTION) + '</li>' +
      '<li>' + sleeveLine('short', SHORT_SLOTS, SHORT_FRACTION) + '</li>' +
      (t ? '<li><b>Money:</b> ' + fmt.money(invested) + ' invested, ' + fmt.money(t.cash) + ' in cash — portfolio worth ' + fmt.money(t.totalValue) +
        ', return <b class="' + (t.totalPnl >= 0 ? 'up' : 'down') + '">' + (t.totalPnl >= 0 ? '+' : '−') + fmt.money(Math.abs(t.totalPnl)) +
        ' (' + fmt.pct(t.startingCash > 0 ? t.totalPnl / t.startingCash : 0) + ')</b> since ' +
        new Date(live.createdAt).toLocaleDateString() + ' <span class="muted">(' + daysLabel(days) + ')</span>.</li>' : '') +
      '</ul>';
    renderHoldings();
  }

  function renderHoldings() {
    const live = practiceReady ? Practice.getState().live : null;
    const wrap = $('auto-holdings-wrap');
    const held = live ? live.positions.filter(p => p.shares > 0) : [];
    wrap.hidden = held.length === 0;
    if (!held.length) return;
    $('auto-holdings').querySelector('tbody').innerHTML = held.map(p => {
      const row = bySymbol.get(p.symbol);
      const invested = p.shares * p.avgCost;
      const worth = p.lastPrice != null ? p.shares * p.lastPrice : invested;
      const ret = worth - invested;
      const since = heldSince(p.symbol);
      const sleeve = row ? row.sleeve : sleeveOf(p.strategyId);
      const strat = Strategies.catalog.find(s => s.id === p.strategyId);
      return '<tr><td><b>' + fmt.esc(p.symbol) + '</b></td>' +
        '<td>' + SLEEVE_LABEL[sleeve] + '</td>' +
        '<td>' + fmt.esc(strat ? strat.name : '–') + '</td>' +
        '<td>' + fmt.money(invested) + '</td>' +
        '<td>' + fmt.money(worth) + '</td>' +
        '<td class="' + (ret >= 0 ? 'up' : 'down') + '">' + (ret >= 0 ? '+' : '−') + fmt.money(Math.abs(ret)) +
        ' (' + fmt.pct(invested > 0 ? ret / invested : 0) + ')</td>' +
        '<td>' + (since ? new Date(since).toLocaleDateString() + ' · ' + daysLabel(daysBetween(since)) : '–') + '</td></tr>';
    }).join('');
  }

  function renderReco() {
    const buys = state.rows.filter(r => r.verdict === 'BUY').sort((a, b) => b.composite - a.composite);
    const el = $('auto-reco');
    if (!buys.length) {
      const best = [...state.rows].sort((a, b) => b.composite - a.composite)[0];
      el.innerHTML = '<h3>No buys yet</h3><p>Nothing researched so far met the bar (best composite: ' +
        (best ? best.composite + ' — ' + fmt.esc(best.symbol) : '–') +
        '). The researcher keeps the portfolio in cash until something qualifies.</p>';
      return;
    }
    const top = buys[0];
    el.innerHTML =
      '<h3>Top pick: ' + fmt.esc(top.symbol) + ' <span class="muted" style="font-weight:400;font-size:13px">· ' + fmt.esc(top.companyName) + '</span></h3>' +
      '<p>Composite score <b>' + top.composite + '</b> / 100 — engine ' + top.engineScore + ', TradingView ' + top.tvScore +
      ' (' + fmt.esc(tvRatingLabel(top.tvRating)) + '), signal ' + top.signalScore +
      (top.ddPenalty > 0 ? ', drawdown penalty −' + top.ddPenalty : '') + '.</p>' +
      '<ul>' +
      '<li>Best strategy for its regime (' + fmt.esc(top.regime || '?') + '): <b>' + fmt.esc(top.strategyName || '?') +
      '</b>, currently saying <b>' + fmt.esc(top.signalLabel || '?') + '</b> — because ' + fmt.esc(top.reason) + '.</li>' +
      '<li>That strategy backtested ' + fmt.pct(top.btReturn) + ' on its history vs ' + fmt.pct(top.bhReturn) + ' for buy &amp; hold, worst drawdown ' + fmt.pct(-(top.maxDrawdown || 0)) + '.</li>' +
      '<li>Position sizing suggests up to ' + Math.round((top.suggestedPct || 0) * 100) + '% of the account (risk + volatility rules).</li>' +
      '</ul>';
  }

  function renderReport() {
    $('auto-results').hidden = false;
    renderReco();
    const sorted = [...state.rows].sort((a, b) => b.composite - a.composite);
    const shown = sorted.slice(0, MAX_TABLE_ROWS);
    $('auto-table-note').textContent = sorted.length > MAX_TABLE_ROWS
      ? 'Showing the top ' + MAX_TABLE_ROWS + ' of ' + sorted.length + ' researched stocks (all are in the saved report). Click a row to race it below.'
      : sorted.length + ' stock' + (sorted.length === 1 ? '' : 's') + ' researched. Click a row to race it below.';
    $('auto-table').querySelector('tbody').innerHTML = shown.map((r, i) => {
      const allTargets = [...(state.targets.long || []), ...(state.targets.short || [])];
      const held = allTargets.includes(r.symbol) && heldSymbols().includes(r.symbol);
      return '<tr data-symbol="' + fmt.esc(r.symbol) + '"' + (held ? ' class="recommended"' : '') + '>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><b>' + fmt.esc(r.symbol) + '</b>' + (held ? ' ★' : '') + '<div class="pr-asof">' + fmt.esc(r.companyName || '') + '</div></td>' +
        '<td>' + verdictChip(r.verdict) + '</td>' +
        '<td><b>' + r.composite + '</b></td>' +
        '<td>' + fmt.esc(tvRatingLabel(r.tvRating)) + '</td>' +
        '<td>' + (r.strategyName ? fmt.esc(r.strategyName) +
          (r.verdict === 'BUY' ? '<div class="pr-asof">' + SLEEVE_LABEL[r.sleeve || 'long'] + '</div>' : '') : '–') + '</td>' +
        '<td>' + (r.signalLabel ? '<span class="signal-badge signal-' + fmt.esc(r.signalCls || 'hold') + '">' + fmt.esc(r.signalLabel) + '</span>' : '–') + '</td>' +
        '<td>' + (r.btReturn != null ? fmt.pct(r.btReturn) + ' vs ' + fmt.pct(r.bhReturn) : '–') + '</td>' +
        '<td>' + fmt.esc(r.regime || r.reason || '–') + '</td>' +
        '</tr>';
    }).join('');
    $('auto-table').querySelectorAll('[data-symbol]').forEach(tr =>
      tr.addEventListener('click', () => {
        if (window.SimPageBridge) {
          SimPageBridge.loadAndSimulate(tr.dataset.symbol);
          const sec = document.getElementById('sim-section');
          if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }));
  }

  function saveReport() {
    if (!state.rows.length) return;
    const doc = {
      title: 'Auto-research report — the app screened the market and researched candidates by itself',
      generatedAt: new Date().toISOString(),
      params: { ...state.params, targetSlots: K_TARGETS, cashReserve: 1 - INVEST_FRACTION },
      universeTotal: state.universeTotal,
      researchedCount: state.rows.length,
      portfolioTargets: state.targets,
      holdings: (() => {
        const live = Practice.getState().live;
        if (!live) return [];
        return live.positions.filter(p => p.shares > 0).map(p => {
          const row = bySymbol.get(p.symbol);
          const invested = p.shares * p.avgCost;
          const worth = p.lastPrice != null ? p.shares * p.lastPrice : invested;
          return {
            symbol: p.symbol,
            sleeve: SLEEVE_LABEL[row ? row.sleeve : sleeveOf(p.strategyId)],
            strategyId: p.strategyId,
            invested: Practice.round2(invested),
            currentValue: Practice.round2(worth),
            return: Practice.round2(worth - invested),
            returnPct: invested > 0 ? Practice.round4((worth - invested) / invested) : 0,
            heldSince: heldSince(p.symbol),
          };
        });
      })(),
      methodology: [
        'Stage 1: bulk screen of the whole US universe (quality floors: price > $5, volume > 500k, market-cap floor) ranked 70% TradingView technical rating / 30% 6-month momentum.',
        'Stage 2: per candidate — ~10y of daily history, indicators, market-regime detection, all six strategy backtests, position-sizing verdict.',
        'Composite = 0.45×engine score + 0.30×TradingView rating + 0.25×signal actionability − drawdown penalty.',
        'BUY requires: sizing stance "invest", signal Buy/Hold long, composite ≥ 60.',
        'Portfolio: ' + Math.round(LONG_FRACTION * 100) + '% in up to ' + LONG_SLOTS + ' long-term holds (trend/momentum/buy-and-hold strategies), ' +
        Math.round(SHORT_FRACTION * 100) + '% in up to ' + SHORT_SLOTS + ' short-term trades (mean-reversion strategies), ' +
        Math.round((1 - INVEST_FRACTION) * 100) + '% cash reserve. Holdings re-checked on fresh data; sold when their verdict or ranking turns. Virtual money.',
        'Educational only — not financial advice.',
      ],
      rows: [...state.rows].sort((a, b) => b.composite - a.composite),
      diary: state.diary.map(l => l.html.replace(/<[^>]+>/g, '')),
    };
    Practice.downloadFile('auto_research_' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(doc, null, 2), 'application/json');
  }

  // ---------- boot ----------
  function init() {
    $('auto-start').addEventListener('click', () => (running ? stop() : start()));
    $('auto-save').addEventListener('click', saveReport);

    const had = restore();
    if (had) {
      renderDiaryFromState();
      if (state.rows.length) renderReport();
      setStatus('Research from ' + (state.updatedAt ? new Date(state.updatedAt).toLocaleString() : 'earlier') +
        ' restored — ' + state.rows.length + ' stocks researched.' + (state.running ? ' Continuing…' : ''));
      if (state.params.minCap) $('auto-mincap').value = String(state.params.minCap);
      if (state.running) start();   // it was mid-grind — keep going, Stop is visible
    }

    // Always sync with the real practice account: show its tiles and make
    // the cash box reflect what the account ACTUALLY started with — typing
    // a different number offers a reset on Start.
    initPractice().then(() => {
      const live = Practice.getState().live;
      if (live && isFinite(live.startingCash)) {
        $('auto-capital').value = String(Math.round(live.startingCash));
      }
      renderPortfolio();
      if (state.rows.length) renderReport();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { start, stop, _state: () => state };
})();
