/* ============================================================
   Auto-trader — a robot that lives through the market.

   The rules the user set for it:
   - It starts FIVE YEARS IN THE PAST with $1,000 of virtual money.
   - It may ONLY trade short-term strategies (mean reversion, fast
     momentum) until it has grown the account 10× ($1,000 → $10,000)
     — that unlocks long-term investing.
   - It can NEVER look for answers: every decision on simulated day
     D uses only prices up to D (all indicators are trailing; fills
     happen at D's close; nothing about the future is readable).
     TradingView data is used ONLY to choose which ~20 big stocks
     exist in its world — never for in-game decisions.
   - It LEARNS from its own trades: strategies that win for it get
     used more, strategies that lose get used less (win-rate-based
     weights updated on every closed trade).
   - It REMEMBERS: the whole run — cash, positions, journal, learned
     weights, the day it reached — persists in localStorage. When it
     catches up to today it stops; the next run picks up exactly
     where it left off with fresh bars.

   When caught up to the present, its current holdings are mirrored
   into the practice paper-portfolio (js/practice.js, shared with the
   main page). Virtual money, education only.
   ============================================================ */
const AutoResearch = (() => {
  const $ = id => document.getElementById(id);
  const { fmt } = Practice;

  const LS_KEY = 'stockLab.autoResearch.v1';
  const STATE_V = 2;                 // v1 was the old current-day researcher — discarded
  const UNIVERSE_SIZE = 24;
  const DEFAULT_GOAL = 2000;         // $ it must try to earn each simulated month
  const YEARS_BACK = 5;
  const UNLOCK_MULT = 10;            // $1,000 must become $10,000 to unlock long-term
  const WARMUP_BARS = 65;
  const MIN_ENTRY_SCORE = 45;
  const MIN_TRADE = 25;              // $ floor for any position
  const CASH_RESERVE = 0.20;         // never fully invested
  const SHORT_BUDGET_LOCKED = 0.40;  // per position, while short-term-only (max 2)
  const SHORT_SLOTS_LOCKED = 2;
  const LONG_SLOTS = 3, SHORT_SLOTS = 2;
  const LONG_BUDGET = 0.20, SHORT_BUDGET = 0.10;   // per position after unlock
  const EQUITY_SAMPLE_EVERY = 5;     // trading days
  const PROGRESS_EVERY = 63;         // ~quarterly diary line
  const MAX_DIARY = 200, MAX_JOURNAL = 400, MAX_CURVE = 800;
  // Options sleeve — small and capped, because premiums can go to zero:
  const OPT_EXPIRY_DAYS = 30;        // ~1-month options, at-the-money
  const OPT_MAX_OPEN = 2;            // open option positions at once
  const OPT_BUDGET = 0.05;           // premium per trade ≤ 5% of equity
  const OPT_TOTAL_BUDGET = 0.10;     // all open premium ≤ 10% of equity
  const OPT_MIN_SCORE = 55;          // options demand stronger evidence than stock buys
  const OPT_VOL_WINDOW = 20;         // trailing bars for the volatility input
  const GAP_MS = () => (typeof window.__AUTO_GAP === 'number' ? window.__AUTO_GAP : 400);

  const SHORT_STRATS = ['rsi-reversion', 'bollinger-reversion', 'macd-momentum'];
  const LONG_STRATS = ['sma-cross', 'momentum-roc'];

  // The worlds it can be born into. A world is chosen at birth and kept for
  // life; the min/max are market-cap bounds, vol is a liquidity floor that
  // relaxes for smaller companies (junk-data guard, not a shortlist).
  const WORLDS = {
    all:   { label: 'all sizes ($300M and up)',   min: 3e8,  max: null, vol: 300000 },
    large: { label: 'large caps (over $10B)',     min: 1e10, max: null, vol: 500000 },
    mid:   { label: 'mid caps ($2B–$10B)',        min: 2e9,  max: 1e10, vol: 500000 },
    small: { label: 'small caps ($300M–$2B)',     min: 3e8,  max: 2e9,  vol: 300000 },
    micro: { label: 'micro caps ($50M–$300M)',    min: 5e7,  max: 3e8,  vol: 200000 },
  };
  // NOT just the biggest by market cap: the world is a merit mix — four
  // different screens, deduped, so movers, well-rated names, and heavily
  // traded stocks get in alongside the giants.
  const MERIT_SCREENS = [
    { sortBy: 'market_cap_basic', n: 7, label: 'biggest' },
    { sortBy: 'Perf.3M',          n: 7, label: 'strongest recent mover' },
    { sortBy: 'Recommend.All',    n: 7, label: 'best-rated technicals' },
    { sortBy: 'volume',           n: 7, label: 'most traded' },
  ];
  const stratName = id => (Strategies.catalog.find(s => s.id === id) || {}).name || id;
  const isShortStrat = id => SHORT_STRATS.includes(id);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round2 = Practice.round2;

  // ---------- state ----------
  let runToken = 0;
  let running = false;
  let practiceInitPromise = null;
  function initPractice() {
    if (!practiceInitPromise) practiceInitPromise = Practice.init();
    return practiceInitPromise;
  }

  let state = {
    v: STATE_V,
    params: { world: 'all' },
    universe: [],        // [{symbol, ticker, name, cap}] — the robot's world, chosen once
    universeWorld: null, // which WORLDS band the universe was built from (birth fact)
    robo: null,          // the persistent run — see freshRobo()
    news: null,          // last present-day news check — {checkedAt, bySymbol}
    diary: [],
    running: false,
    updatedAt: null,
  };

  // Per-session (recomputed each run from fetched bars, never persisted):
  // symbol -> { bars, ind, dateIdx: Map, posByStrat: {id: [0/1...]}, lastClose }
  const world = new Map();

  function freshRobo(startCash, monthlyGoal) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - YEARS_BACK);
    return {
      config: {
        startCash,
        unlockAt: startCash * UNLOCK_MULT,
        startDate: d.toISOString().slice(0, 10),
        monthlyGoal: monthlyGoal || DEFAULT_GOAL,
      },
      months: [],          // closed simulated months: [{ym, earned, goal, met}]
      monthStart: null,    // {ym, equity} — where the current month began
      goalPressure: 0,     // 1 after a missed month → it trades hungrier
      cursorDate: null,
      cash: startCash,
      unlocked: false,
      unlockedOn: null,
      positions: [],     // [{symbol, strategyId, shares, entryPrice, entryDate, lastPrice}]
      options: [],       // [{symbol, kind:'call'|'put', strategyId, strike, expiry, contracts, entryPremium, entryDate, lastPremium}]
      journal: [],       // closed trades (stock and option; options carry kind:'call'|'put')
      stats: { perStrategy: {}, perStock: {} },
      equityCurve: [],   // [{date, value}]
      startedRealAt: new Date().toISOString(),
      caughtUpTo: null,
    };
  }

  function persist() {
    state.running = running;
    state.updatedAt = new Date().toISOString();
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
  }

  function restore() {
    try {
      const doc = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!doc || doc.v !== STATE_V) return false;   // old researcher saves are discarded
      state = { ...state, ...doc };
      if (!state.params) state.params = {};
      if (!WORLDS[state.params.world]) {
        // Saves from before world bands stored a numeric size floor.
        const mc = +state.params.minCap || 0;
        state.params.world = mc >= 1e10 ? 'large' : mc >= 2e9 ? 'mid' : mc > 0 ? 'small' : 'all';
      }
      if (!WORLDS[state.universeWorld] && state.universe.length) state.universeWorld = state.params.world;
      if (state.robo) {
        // Saves from before options / the monthly goal get safe defaults.
        if (!Array.isArray(state.robo.options)) state.robo.options = [];
        if (!Array.isArray(state.robo.months)) state.robo.months = [];
        if (state.robo.monthStart === undefined) state.robo.monthStart = null;
        if (state.robo.goalPressure !== 1) state.robo.goalPressure = 0;
        if (!(state.robo.config.monthlyGoal > 0)) state.robo.config.monthlyGoal = DEFAULT_GOAL;
      }
      return true;
    } catch (e) { return false; }
  }

  // ---------- diary / status ----------
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

  // ---------- learning ----------
  // Laplace-smoothed win rate → weight in [0.6, 1.4]; no trades yet → 1.0.
  function stratWeight(id) {
    const s = state.robo.stats.perStrategy[id];
    const wins = s ? s.wins : 0, trades = s ? s.trades : 0;
    return clamp(0.6 + 0.8 * ((wins + 2) / (trades + 4)), 0.6, 1.4);
  }

  // ---------- the monthly goal ----------
  // It must TRY to earn its monthly goal. After a missed month it trades
  // hungrier — lower entry bar, bigger positions, thinner cash reserve,
  // more option budget — all still inside hard caps; a met month calms it
  // back down. This uses only its own past results: no lookahead.
  const hungry = () => !!(state.robo && state.robo.goalPressure === 1);
  const entryBar = () => MIN_ENTRY_SCORE - (hungry() ? 5 : 0);
  const optionBar = () => OPT_MIN_SCORE - (hungry() ? 5 : 0);
  const reserveFrac = () => (hungry() ? 0.10 : CASH_RESERVE);
  const budgetBoost = () => (hungry() ? 1.25 : 1);
  const optTotalFrac = () => (hungry() ? 0.15 : OPT_TOTAL_BUDGET);

  function rollMonth(date) {
    const robo = state.robo;
    const ym = date.slice(0, 7);
    if (!robo.monthStart) {
      robo.monthStart = { ym, equity: round2(equityNow()), from: date };
      return;
    }
    if (robo.monthStart.ym === ym) return;
    const eq = round2(equityNow());
    const earned = round2(eq - robo.monthStart.equity);
    const goal = robo.config.monthlyGoal || DEFAULT_GOAL;
    // A birth month (or a resumed save's stub month) covers only part of a
    // month — judge it against a prorated goal, not the full one.
    const daysCovered = robo.monthStart.from ? Math.max(1, daysBetweenDates(robo.monthStart.from, date)) : 31;
    const effGoal = round2(goal * Math.min(1, daysCovered / 30));
    const partial = effGoal < goal;
    const met = earned >= effGoal;
    robo.months.push({ ym: robo.monthStart.ym, earned, goal, met });
    if (robo.months.length > 70) robo.months = robo.months.slice(-70);
    robo.goalPressure = met ? 0 : 1;
    diary('[' + fmt.esc(date) + '] Month ' + fmt.esc(robo.monthStart.ym) + ' closed: ' +
      (earned >= 0 ? 'earned +' : 'lost −') + fmt.money(Math.abs(earned)) + ' vs its ' + fmt.money(effGoal) + ' goal' +
      (partial ? ' (prorated — a partial month)' : '') + ' — ' +
      (met ? 'GOAL MET. Trading calm this month.'
           : 'missed. Trading hungrier this month: lower entry bar, bigger positions, more option budget (still capped).'),
      met ? 'ok' : 'note');
    robo.monthStart = { ym, equity: eq, from: date };
  }

  function learnFrom(trade) {
    const byStrat = state.robo.stats.perStrategy;
    const byStock = state.robo.stats.perStock;
    const s = byStrat[trade.strategyId] || (byStrat[trade.strategyId] = { trades: 0, wins: 0, pnl: 0 });
    s.trades++; if (trade.pnl > 0) s.wins++; s.pnl = round2(s.pnl + trade.pnl);
    const k = byStock[trade.symbol] || (byStock[trade.symbol] = { trades: 0, wins: 0, pnl: 0 });
    k.trades++; if (trade.pnl > 0) k.wins++; k.pnl = round2(k.pnl + trade.pnl);
  }

  // ---------- the simulated world ----------
  async function screenMerit(band, screen) {
    const filters = [
      { left: 'market_cap_basic', operation: 'egreater', right: band.min },
      { left: 'close', operation: 'greater', right: 5 },
      { left: 'volume', operation: 'greater', right: band.vol },
    ];
    if (band.max) filters.push({ left: 'market_cap_basic', operation: 'less', right: band.max });
    if (screen.sortBy !== 'market_cap_basic' && screen.sortBy !== 'volume') {
      filters.push({ left: screen.sortBy, operation: 'nempty' });
    }
    const page = await DataSource.screenStocks({
      filters,
      columns: ['name', 'description', 'close', 'market_cap_basic'],
      sortBy: screen.sortBy, sortOrder: 'desc',
      offset: 0, limit: screen.n,
    });
    return page.rows;
  }

  async function buildUniverse(myRun) {
    const worldKey = WORLDS[state.params.world] ? state.params.world : 'all';
    const band = WORLDS[worldKey];
    setStatus('Choosing the robot\'s world — a merit mix, ' + band.label + '…');
    // All-or-nothing: a world silently missing one of its merit screens
    // would be persisted for the whole life mislabeled — better to fail the
    // run and let a retry rebuild it (universe stays empty until then).
    const rows = [];
    try {
      for (const screen of MERIT_SCREENS) {
        for (const r of await screenMerit(band, screen)) rows.push({ r, via: screen.label });
        if (myRun !== runToken) return false;
        await new Promise(r => setTimeout(r, GAP_MS()));
      }
    } catch (e) {
      if (myRun === runToken) {
        setStatus('The stock screener is unreachable (' + e.message + ') — its world was not chosen. Try again in a moment.', true);
      }
      return false;
    }
    if (myRun !== runToken) return false;   // stopped during the final pacing sleep
    const seen = new Set();
    state.universe = rows
      .filter(x => x.r.name && !seen.has(x.r.name) && seen.add(x.r.name))
      .slice(0, UNIVERSE_SIZE)
      .map(x => ({ symbol: x.r.name, ticker: x.r.ticker, name: x.r.description || x.r.name, cap: x.r.market_cap_basic, via: x.via }));
    if (!state.universe.length) {
      setStatus('The stock screener returned nothing — try again in a moment or pick a different world.', true);
      return false;
    }
    state.universeWorld = worldKey;   // the world it was BORN into — labels use this, not the select
    diary('<span class="head">World chosen: ' + state.universe.length + ' stocks — a merit mix (the biggest, the strongest recent movers, the best-rated, the most traded), ' +
      fmt.esc(band.label) + ' — NOT just the largest by size. Honest caveat: today\'s stock list is the one thing it knows from the present — every trading decision inside the game uses only past prices.</span>', 'head');
    return true;
  }

  async function loadWorld(myRun) {
    const startDate = state.robo.config.startDate;
    world.clear();
    auditionCache.clear();   // cached entries embed bars up to their compute
                             // index — a new life must never inherit them
    let kept = 0;
    for (let i = 0; i < state.universe.length; i++) {
      if (myRun !== runToken) return false;
      const u = state.universe[i];
      setStatus('Loading history ' + (i + 1) + ' of ' + state.universe.length + ' — ' + u.symbol + '…');
      try {
        let bars;
        const cached = window.SimPageBridge && SimPageBridge.barsCache.get(u.symbol);
        if (cached && cached.bars.length) {
          bars = cached.bars;
        } else {
          bars = await DataSource.load('yahoo', u.symbol, '');
          if (myRun !== runToken) return false;
          if (window.SimPageBridge) SimPageBridge.barsCache.set(u.symbol, { bars, full: false, fetchedAt: Date.now() });
        }
        const startIdx = bars.findIndex(b => b.date >= startDate);
        if (startIdx < WARMUP_BARS) {
          diary(fmt.esc(u.symbol) + ' — not enough history before ' + fmt.esc(startDate) + ', left out of the world.', 'note');
        } else {
          const ind = Indicators.computeAll(bars);
          const posByStrat = {};
          for (const id of [...SHORT_STRATS, ...LONG_STRATS]) {
            const strat = Strategies.catalog.find(s => s.id === id);
            posByStrat[id] = strat.positions(bars, ind);
          }
          const dateIdx = new Map();
          bars.forEach((b, k) => dateIdx.set(b.date, k));
          world.set(u.symbol, { bars, ind, dateIdx, posByStrat, lastClose: bars[bars.length - 1].close });
          kept++;
        }
      } catch (e) {
        diary(fmt.esc(u.symbol) + ' — feed unavailable (' + fmt.esc(e.message) + '), left out this run.', 'fail');
      }
      await new Promise(r => setTimeout(r, GAP_MS()));
    }
    diary('World loaded: ' + kept + ' stocks with full 5-year+ history.', 'note');
    return kept >= 3;
  }

  function masterDates() {
    const startDate = state.robo.config.startDate;
    const set = new Set();
    for (const w of world.values()) {
      for (const b of w.bars) if (b.date >= startDate) set.add(b.date);
    }
    return [...set].sort();
  }

  // ---------- no-lookahead day engine ----------
  function equityNow() {
    let mv = 0;
    for (const p of state.robo.positions) mv += p.shares * (p.lastPrice || p.entryPrice);
    for (const o of state.robo.options || []) mv += o.contracts * 100 * (o.lastPremium != null ? o.lastPremium : o.entryPremium);
    return state.robo.cash + mv;
  }

  const addDays = (dateStr, n) => new Date(Date.parse(dateStr) + n * 86400000).toISOString().slice(0, 10);

  // Trailing, index-safe fit: how well the strategy KIND suits this stock
  // right now, judged only from values at index i.
  function fitAt(w, i, strategyId) {
    const sma20 = w.ind.sma20[i], sma50 = w.ind.sma50[i];
    const trendPct = sma20 != null && sma50 ? (sma20 - sma50) / sma50 * 100 : 0;
    if (strategyId === 'rsi-reversion' || strategyId === 'bollinger-reversion') {
      return 80 - Math.min(60, Math.abs(trendPct) * 20);     // reversion wants sideways
    }
    return 55 + clamp(trendPct * 12, -35, 35);               // momentum wants a rising trend
  }

  // Audition: before trusting a buy signal, replay how THIS strategy would
  // have done on THIS stock over the trailing year, against just holding it.
  // Lookahead-safe by construction: it only reads bars/positions at indices
  // ≤ i (the precomputed position arrays are forward scans of trailing
  // indicators). Cached per symbol+strategy per ~month of simulated time.
  const AUDITION_BARS = 250;
  const auditionCache = new Map();   // session-only, like `world`
  function audition(w, symbol, i, strategyId, noCache) {
    const start = i - AUDITION_BARS;
    if (start < 1) return null;
    const key = symbol + '|' + strategyId + '|' + Math.floor(i / 21);
    if (!noCache) {
      const hit = auditionCache.get(key);
      if (hit !== undefined) return hit;
    }
    const pos = w.posByStrat[strategyId], bars = w.bars;
    let eq = 1;
    for (let j = start + 1; j <= i; j++) {
      if (pos[j - 1] === 1) eq *= bars[j].close / bars[j - 1].close;
    }
    const stratRet = eq - 1;
    const bhRet = bars[i].close / bars[start].close - 1;
    const out = {
      stratRet: Practice.round4(stratRet),
      bhRet: Practice.round4(bhRet),
      edge: Practice.round4(stratRet - bhRet),
    };
    if (!noCache) auditionCache.set(key, out);   // debug-hook calls must not seed the live cache
    return out;
  }

  // ---------- options math (calls & puts, no lookahead) ----------
  // There is no honest source of 5-year-old option quotes, so the rewind
  // prices its options itself with the Black-Scholes formula — fed ONLY by
  // trailing inputs: the day's close and the stock's own last-20-day
  // realized volatility. Contracts are 100 shares each (fractions allowed,
  // like everywhere else in the app); rates are taken as zero for clarity.
  function normCdf(x) {
    // Abramowitz–Stegun 26.2.17 polynomial approximation (|err| < 7.5e-8).
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }

  function bsPrice(kind, S, K, vol, days) {
    const T = Math.max(0, days) / 365;
    if (T <= 0 || vol <= 0) return Math.max(0, kind === 'call' ? S - K : K - S);   // intrinsic at expiry
    const sq = vol * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (vol * vol / 2) * T) / sq;
    const d2 = d1 - sq;
    return kind === 'call'
      ? S * normCdf(d1) - K * normCdf(d2)
      : K * normCdf(-d2) - S * normCdf(-d1);
  }

  function trailingVol(bars, i, window) {
    if (i < window) return null;
    let sum = 0, sum2 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const r = Math.log(bars[j].close / bars[j - 1].close);
      sum += r; sum2 += r * r;
    }
    const mean = sum / window;
    const variance = Math.max(0, (sum2 - window * mean * mean) / (window - 1));
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  function settleOption(o, premium, date, why) {
    const value = round2(o.contracts * 100 * premium);
    // Use the exact cash deducted at entry as the basis, so journal pnl and
    // the cash ledger can never drift apart (older saves lack entryCost).
    const cost = o.entryCost != null ? o.entryCost : round2(o.contracts * 100 * o.entryPremium);
    const pnl = round2(value - cost);
    state.robo.cash = round2(state.robo.cash + value);
    const trade = {
      kind: o.kind, symbol: o.symbol, strategyId: o.strategyId,
      entryDate: o.entryDate, entryPrice: round2(o.entryPremium),
      exitDate: date, exitPrice: round2(premium),
      shares: Practice.round4(o.contracts),
      pnl, pnlPct: Practice.round4(cost > 0 ? pnl / cost : 0),
    };
    state.robo.journal.push(trade);
    if (state.robo.journal.length > MAX_JOURNAL) state.robo.journal = state.robo.journal.slice(-MAX_JOURNAL);
    learnFrom(trade);
    state.robo.options = state.robo.options.filter(x => x !== o);
    diary('[' + fmt.esc(date) + '] ' + (/^expired/.test(why) ? 'EXPIRED' : 'CLOSED') + ' ' + o.kind.toUpperCase() +
      ' on ' + fmt.esc(o.symbol) + ' (strike ' + fmt.money(o.strike) + ', ' + fmt.esc(why) + ') — ' +
      (pnl >= 0 ? '+' : '−') + fmt.money(Math.abs(pnl)) + ' on ' + fmt.money(cost) + ' of premium.',
      pnl >= 0 ? 'ok' : 'fail');
  }

  function entryReason(w, i, strategyId) {
    const rsi = w.ind.rsi14[i];
    const sma20 = w.ind.sma20[i], sma50 = w.ind.sma50[i];
    const bits = ['fresh ' + stratName(strategyId) + ' buy signal'];
    if (rsi != null) bits.push('RSI ' + rsi.toFixed(0));
    if (sma20 != null && sma50 != null) bits.push('SMA20 ' + (sma20 > sma50 ? 'above' : 'below') + ' SMA50');
    return bits.join(', ');
  }

  function sellPosition(p, price, date, why) {
    const value = p.shares * price;
    const pnl = round2(value - p.shares * p.entryPrice);
    state.robo.cash = round2(state.robo.cash + value);
    const trade = {
      symbol: p.symbol, strategyId: p.strategyId,
      entryDate: p.entryDate, entryPrice: round2(p.entryPrice),
      exitDate: date, exitPrice: round2(price),
      shares: Practice.round4(p.shares),
      pnl, pnlPct: Practice.round4(p.shares * p.entryPrice > 0 ? pnl / (p.shares * p.entryPrice) : 0),
    };
    state.robo.journal.push(trade);
    if (state.robo.journal.length > MAX_JOURNAL) state.robo.journal = state.robo.journal.slice(-MAX_JOURNAL);
    learnFrom(trade);
    state.robo.positions = state.robo.positions.filter(x => x !== p);
    diary('[' + fmt.esc(date) + '] SOLD ' + fmt.esc(p.symbol) + ' (' + fmt.esc(stratName(p.strategyId)) + ', ' + fmt.esc(why) + ') — ' +
      (pnl >= 0 ? '+' : '−') + fmt.money(Math.abs(pnl)) + ' (' + fmt.pct(trade.pnlPct) + ') after ' +
      fmt.esc(p.entryDate) + ' → ' + fmt.esc(date) + '.', pnl >= 0 ? 'ok' : 'fail');
  }

  function stepDay(date) {
    const robo = state.robo;

    rollMonth(date);   // month bookkeeping first: yesterday's marks close the month

    // Mark to market + strategy-driven exits (its ONLY exit rule — the user
    // said: invest by strategy alone).
    for (const p of [...robo.positions]) {
      const w = world.get(p.symbol);
      if (!w) continue;
      const i = w.dateIdx.get(date);
      if (i == null) continue;                    // that stock didn't trade this day
      p.lastPrice = w.bars[i].close;
      if (w.posByStrat[p.strategyId][i] === 0) {
        sellPosition(p, w.bars[i].close, date, 'strategy exit signal');
      }
    }

    // Options: reprice from today's close + trailing volatility, settle
    // expiries at intrinsic value, and close early when the signal that
    // justified the bet flips against it.
    for (const o of [...robo.options]) {
      const w = world.get(o.symbol);
      if (!w) {
        if (date >= o.expiry) {
          settleOption(o, o.lastPremium != null ? o.lastPremium : o.entryPremium, date, 'expired — no fresh feed, settled at last known value');
        }
        continue;
      }
      const i = w.dateIdx.get(date);
      if (i == null) {
        // No bar for this stock today. If its data ended for good (delisted,
        // truncated feed) the option must still settle at expiry — otherwise
        // it would sit open forever, freezing cash and an option slot.
        if (date >= o.expiry) {
          settleOption(o, o.lastPremium != null ? o.lastPremium : o.entryPremium, date, 'expired with no trading data — settled at last known value');
        }
        continue;
      }
      const S = w.bars[i].close;
      const vol = trailingVol(w.bars, i, OPT_VOL_WINDOW) || 0.3;
      o.lastPremium = Practice.round4(bsPrice(o.kind, S, o.strike, vol, daysBetweenDates(date, o.expiry)));
      if (date >= o.expiry) {
        settleOption(o, Math.max(0, o.kind === 'call' ? S - o.strike : o.strike - S), date, 'expired');
      } else if (o.kind === 'call' ? w.posByStrat[o.strategyId][i] === 0 : w.posByStrat[o.strategyId][i] === 1) {
        settleOption(o, o.lastPremium, date, 'signal flipped');
      }
    }

    // Progression: 10× the start unlocks long-term investing — permanently.
    const equity = equityNow();
    if (!robo.unlocked && equity >= robo.config.unlockAt) {
      robo.unlocked = true;
      robo.unlockedOn = date;
      diary('<span class="head">[' + fmt.esc(date) + '] UNLOCKED long-term investing — the account reached ' +
        fmt.money(equity) + ' (10× the start). Slow trend and momentum strategies are now allowed.</span>', 'head');
    }

    // Entries: fresh buy signals today, scored by fit × learned weight.
    const heldSyms = new Set(robo.positions.map(p => p.symbol));
    const taken = new Set();     // symbols bought as stock today
    const shortHeld = robo.positions.filter(p => isShortStrat(p.strategyId)).length;
    const longHeld = robo.positions.length - shortHeld;
    const shortSlots = (robo.unlocked ? SHORT_SLOTS : SHORT_SLOTS_LOCKED) - shortHeld;
    const longSlots = (robo.unlocked ? LONG_SLOTS : 0) - longHeld;
    const eligible = robo.unlocked ? [...SHORT_STRATS, ...LONG_STRATS] : SHORT_STRATS;

    const optSyms = new Set(robo.options.map(o => o.symbol));   // one instrument per symbol
    if (shortSlots > 0 || longSlots > 0) {
      const candidates = [];
      for (const [symbol, w] of world) {
        if (heldSyms.has(symbol) || optSyms.has(symbol)) continue;
        const i = w.dateIdx.get(date);
        if (i == null || i < 1) continue;
        for (const id of eligible) {
          const pos = w.posByStrat[id];
          if (pos[i] === 1 && pos[i - 1] === 0) {   // signal born today — from the past only
            // fit (does this KIND of strategy suit the stock right now)
            // × learned weight (its own track record with the strategy)
            // + audition (did this strategy actually beat holding, on this
            //   stock, over the trailing year it can see)
            const aud = audition(w, symbol, i, id);
            const score = fitAt(w, i, id) * stratWeight(id) + (aud ? clamp(aud.edge * 40, -15, 15) : 0);
            if (score >= entryBar()) candidates.push({ symbol, w, i, strategyId: id, score, aud });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      let shortLeft = Math.max(0, shortSlots), longLeft = Math.max(0, longSlots);
      for (const c of candidates) {
        if (taken.has(c.symbol)) continue;
        const short = isShortStrat(c.strategyId);
        if (short ? shortLeft <= 0 : longLeft <= 0) continue;
        const eq = equityNow();
        const budget = eq * Math.min(0.5, (robo.unlocked ? (short ? SHORT_BUDGET : LONG_BUDGET) : SHORT_BUDGET_LOCKED) * budgetBoost());
        const spendable = Math.min(budget, state.robo.cash - reserveFrac() * eq);
        if (spendable < MIN_TRADE) continue;
        const price = c.w.bars[c.i].close;
        const shares = Practice.round4(spendable / price);
        if (shares <= 0) continue;
        state.robo.cash = round2(state.robo.cash - shares * price);
        state.robo.positions.push({
          symbol: c.symbol, strategyId: c.strategyId, shares,
          entryPrice: round2(price), entryDate: date, lastPrice: price,
        });
        taken.add(c.symbol);
        if (short) shortLeft--; else longLeft--;
        diary('[' + fmt.esc(date) + '] BOUGHT ' + fmt.money(shares * price) + ' of ' + fmt.esc(c.symbol) + ' — ' +
          (short ? 'short-term trade' : 'long-term hold') + ' (' + fmt.esc(entryReason(c.w, c.i, c.strategyId)) +
          '; learned weight ' + stratWeight(c.strategyId).toFixed(2) +
          (c.aud ? '; past-year audition: this strategy ' + (c.aud.edge >= 0 ? 'beat' : 'lagged') +
            ' just holding by ' + (Math.abs(c.aud.edge) * 100).toFixed(1) + '% on this stock' : '') + ').', 'ok');
      }
    }

    optionEntries(date, heldSyms, taken, eligible);
  }

  // Option entries — a small, capped side bet on the day's strongest
  // evidence. CALLS ride fresh buy signals it could not act on with stock
  // (slots full, cash reserved, or the signal scored below a stock buy);
  // PUTS act on fresh sell signals in confirmed downtrends — the one thing
  // a long-only stock book cannot trade. Premiums are Black-Scholes from
  // trailing inputs only.
  function optionEntries(date, heldSyms, boughtToday, eligible) {
    const robo = state.robo;
    if (robo.options.length >= OPT_MAX_OPEN) return;
    const cands = [];
    for (const [symbol, w] of world) {
      const i = w.dateIdx.get(date);
      if (i == null || i < 1) continue;
      if (robo.options.some(o => o.symbol === symbol)) continue;
      const vol = trailingVol(w.bars, i, OPT_VOL_WINDOW);
      if (!vol) continue;
      for (const id of eligible) {
        const pos = w.posByStrat[id];
        if (pos[i] === 1 && pos[i - 1] === 0 && !heldSyms.has(symbol) && !boughtToday.has(symbol)) {
          const aud = audition(w, symbol, i, id);
          const score = fitAt(w, i, id) * stratWeight(id) + (aud ? clamp(aud.edge * 40, -15, 15) : 0);
          if (score >= optionBar()) {
            cands.push({ kind: 'call', symbol, w, i, strategyId: id, score, vol,
              why: 'fresh ' + stratName(id) + ' buy signal it had no stock slot for' });
          }
        }
        if (pos[i] === 0 && pos[i - 1] === 1 && !heldSyms.has(symbol) && !boughtToday.has(symbol)) {
          // Sell signal born today on a stock it does NOT own — a put bets
          // the fall continues. Requires a genuinely confirmed downtrend
          // (SMA20 at least 0.5% under SMA50), not a hairline cross, so the
          // "stronger evidence" bar is real and not vacuous at weight 1.0.
          const sma20 = w.ind.sma20[i], sma50 = w.ind.sma50[i];
          if (sma20 != null && sma50 != null && sma20 < sma50) {
            const downPct = (sma50 - sma20) / sma50 * 100;
            if (downPct >= 0.5) {
              const score = (45 + clamp(downPct * 10, 0, 35)) * stratWeight(id);
              if (score >= optionBar()) {
                cands.push({ kind: 'put', symbol, w, i, strategyId: id, score, vol,
                  why: 'fresh ' + stratName(id) + ' sell signal with SMA20 ' + downPct.toFixed(1) + '% below SMA50 — betting the fall continues' });
              }
            }
          }
        }
      }
    }
    if (!cands.length) return;
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) {
      if (robo.options.length >= OPT_MAX_OPEN) break;
      if (robo.options.some(o => o.symbol === c.symbol)) continue;
      const eq = equityNow();
      const openPrem = robo.options.reduce((s, o) => s + o.contracts * 100 * (o.lastPremium != null ? o.lastPremium : o.entryPremium), 0);
      const S = c.w.bars[c.i].close;
      const premium = Practice.round4(bsPrice(c.kind, S, S, c.vol, OPT_EXPIRY_DAYS));
      if (!(premium > 0)) continue;
      const spendable = Math.min(eq * OPT_BUDGET * budgetBoost(), eq * optTotalFrac() - openPrem, robo.cash - reserveFrac() * eq);
      if (spendable < MIN_TRADE) continue;
      const contracts = Practice.round4(spendable / (premium * 100));
      if (contracts <= 0) continue;
      const cost = round2(contracts * 100 * premium);
      const expiry = addDays(date, OPT_EXPIRY_DAYS);
      robo.cash = round2(robo.cash - cost);
      robo.options.push({
        symbol: c.symbol, kind: c.kind, strategyId: c.strategyId,
        strike: round2(S), expiry, contracts,
        entryPremium: premium, entryCost: cost, entryDate: date, lastPremium: premium,
      });
      diary('[' + fmt.esc(date) + '] BOUGHT ' + c.kind.toUpperCase() + ' on ' + fmt.esc(c.symbol) + ' — ' +
        fmt.money(cost) + ' premium, strike ' + fmt.money(S) + ' (at-the-money), expires ' + fmt.esc(expiry) +
        ' (' + fmt.esc(c.why) + '; Black-Scholes at ' + Math.round(c.vol * 100) + '% trailing volatility).', 'ok');
    }
  }

  // ---------- the run ----------
  async function start() {
    if (running) return;
    const myRun = ++runToken;
    running = true;
    $('auto-start').textContent = 'Stop';
    $('auto-start').classList.remove('btn-primary');
    $('auto-start').classList.add('btn-secondary');

    try {
      await initPractice();
      if (myRun !== runToken) return;

      // Starting cash: honored on creation; changing it later offers a fresh run.
      const wanted = Math.max(100, parseFloat($('auto-capital').value) || 1000);
      const goalWanted = Math.max(100, parseFloat($('auto-goal') && $('auto-goal').value) || DEFAULT_GOAL);
      if (!state.robo) {
        state.robo = freshRobo(wanted, goalWanted);
        diary('<span class="head">New life started: ' + fmt.money(wanted) + ' on ' + fmt.esc(state.robo.config.startDate) +
          ' (five years ago). Rule: short-term trading only until it reaches ' + fmt.money(state.robo.config.unlockAt) +
          ' — that unlocks long-term investing. It cannot see a single day ahead, and it reads real news only once it ' +
          'reaches the present day (during the rewind, news is banned — that would be looking up answers).</span>', 'head');
      } else if (Math.abs(state.robo.config.startCash - wanted) >= 0.5) {
        if (confirm('The robot is mid-life: it started with ' + fmt.money(state.robo.config.startCash) +
          ' and its account is now worth ' + fmt.money(equityNow()) + '.\n\n' +
          'Start a NEW life from ' + fmt.money(wanted) + ' five years back? This erases its memory, trades, and learning.\n' +
          'OK = new life   ·   Cancel = continue the current one')) {
          state.robo = freshRobo(wanted, goalWanted);
          state.universe = [];      // a new life is born into a freshly chosen world
          state.news = null;
          state.diary = [];
          $('auto-log').innerHTML = '';
          diary('<span class="head">New life started: ' + fmt.money(wanted) + ' on ' + fmt.esc(state.robo.config.startDate) + '.</span>', 'head');
        } else {
          $('auto-capital').value = String(Math.round(state.robo.config.startCash));
        }
      }
      // The monthly goal may change mid-life — it is a target, not history.
      // Tolerance matches the capital box: a Math.round prefill after reload
      // must not read as a user-requested change.
      if (state.robo && Math.abs(goalWanted - state.robo.config.monthlyGoal) >= 0.5) {
        state.robo.config.monthlyGoal = goalWanted;
        diary('Monthly goal set to ' + fmt.money(goalWanted) + ' a month — a missed month makes it trade hungrier the next.', 'note');
      }
      const worldKey = WORLDS[$('auto-mincap').value] ? $('auto-mincap').value : 'all';
      if (worldKey !== state.params.world) {
        state.params.world = worldKey;
        if (state.universe.length) {
          diary('World change noted (' + fmt.esc(WORLDS[worldKey].label) +
            ') — it applies when a NEW life starts; this life keeps the world it was born into.', 'note');
        }
      }

      if (!state.universe.length) {
        const ok = await buildUniverse(myRun);
        if (!ok || myRun !== runToken) return;
      }
      const worldOk = await loadWorld(myRun);
      if (myRun !== runToken) return;
      if (!worldOk) {
        // A life that never traded isn't bound to this universe yet — let a
        // retry choose the world again instead of dead-ending forever.
        if (!state.robo.cursorDate && !state.robo.journal.length && !state.robo.positions.length) {
          state.universe = [];
          state.universeWorld = null;
        }
        setStatus('Not enough stock histories loaded — the data feed looks down. Try again later.', true);
        return;
      }

      const dates = masterDates();
      let cursor = state.robo.cursorDate ? dates.findIndex(d => d > state.robo.cursorDate) : 0;
      if (cursor === -1) cursor = dates.length;
      if (cursor >= dates.length) {
        diary('No new trading days since last time — it is already caught up to ' + fmt.esc(state.robo.cursorDate) + '. Come back after the next market day.', 'note');
      } else {
        diary('<span class="head">Living through ' + (dates.length - cursor) + ' trading day' + (dates.length - cursor === 1 ? '' : 's') +
          (state.robo.cursorDate ? ' (resuming after ' + fmt.esc(state.robo.cursorDate) + ')' : ' (from ' + fmt.esc(dates[0]) + ')') + '…</span>', 'head');
      }

      let sinceSample = 0, sinceProgress = 0;
      for (; cursor < dates.length; cursor++) {
        if (myRun !== runToken) return;
        const date = dates[cursor];
        stepDay(date);
        state.robo.cursorDate = date;

        if (++sinceSample >= EQUITY_SAMPLE_EVERY || cursor === dates.length - 1) {
          sinceSample = 0;
          state.robo.equityCurve.push({ date, value: round2(equityNow()) });
          if (state.robo.equityCurve.length > MAX_CURVE) {
            state.robo.equityCurve = state.robo.equityCurve.filter((_, k) => k % 2 === 0);
          }
        }
        if (++sinceProgress >= PROGRESS_EVERY) {
          sinceProgress = 0;
          const eq = equityNow();
          diary('[' + fmt.esc(date) + '] Progress: account ' + fmt.money(eq) + ' (' + fmt.pct(eq / state.robo.config.startCash - 1) +
            ' overall) · ' + state.robo.journal.length + ' closed trades · ' +
            (state.robo.unlocked ? 'long-term unlocked' : fmt.money(Math.max(0, state.robo.config.unlockAt - eq)) + ' to go until long-term unlocks') + '.', 'note');
          setStatus('Simulating ' + date + ' — account ' + fmt.money(eq) + '…');
          renderAll();
          persist();
          writeDataFiles();   // checkpoint into the linked data folder (no-op if unlinked)
          await new Promise(r => setTimeout(r, 0));   // let the page breathe
        }
      }

      if (myRun === runToken) {
        state.robo.caughtUpTo = state.robo.cursorDate;
        const eq = equityNow();
        diary('<span class="head">Caught up to the present (' + fmt.esc(state.robo.cursorDate || '–') + '). Account: ' +
          fmt.money(eq) + ' (' + fmt.pct(eq / state.robo.config.startCash - 1) + ' from ' + fmt.money(state.robo.config.startCash) +
          '). It will remember everything — run it again after the next market day to continue its life.</span>', 'head');
        await newsCheck(myRun);
        if (myRun !== runToken) return;
        await mirrorPractice();
        if (myRun !== runToken) return;
        await writeDataFiles();
        if (myRun !== runToken) return;
        setStatus('Caught up to ' + (state.robo.cursorDate || 'today') + ' — account ' + fmt.money(eq) +
          '. Press Start after the next market day to continue.');
      }
    } catch (e) {
      if (myRun === runToken) {
        setStatus('The run hit an error: ' + e.message + ' — progress up to here is saved.', true);
        diary('Run error: ' + fmt.esc(e.message) + ' — progress saved.', 'fail');
      }
    } finally {
      if (myRun === runToken) {
        running = false;
        persist();
        renderAll();
        $('auto-start').textContent = 'Start / continue its life';
        $('auto-start').classList.add('btn-primary');
        $('auto-start').classList.remove('btn-secondary');
      }
    }
  }

  function stop() {
    if (!running) return;
    runToken++;
    running = false;
    diary('Stopped by you at ' + fmt.esc(state.robo && state.robo.cursorDate || '–') + ' — everything is remembered.', 'note');
    setStatus('Stopped at ' + (state.robo && state.robo.cursorDate || '–') + ' — press Start to continue its life.');
    persist();
    writeDataFiles();
    renderAll();
    $('auto-start').textContent = 'Start / continue its life';
    $('auto-start').classList.add('btn-primary');
    $('auto-start').classList.remove('btn-secondary');
  }

  // ---------- present-day news (never during the rewind) ----------
  // The rule: during its five-year rewind there is no honest way to read
  // that day's newspapers, and reading TODAY's stories about the past
  // would be looking up answers — banned. So it reads real headlines only
  // once it has caught up to the present, for the stocks it holds, and
  // uses plain word-counting (no AI) to lean positive or negative when
  // sizing the practice mirror.
  const NEWS_POS = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'record', 'upgrade', 'upgrades', 'upgraded',
    'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'growth', 'strong', 'profit', 'profits',
    'outperform', 'outperforms', 'tops', 'rise', 'rises', 'boost', 'boosts', 'win', 'wins', 'high', 'bullish'];
  const NEWS_NEG = ['miss', 'misses', 'plunge', 'plunges', 'sink', 'sinks', 'drop', 'drops', 'fall', 'falls',
    'downgrade', 'downgrades', 'downgraded', 'lawsuit', 'probe', 'investigation', 'layoff', 'layoffs',
    'recall', 'cut', 'cuts', 'warn', 'warns', 'warning', 'weak', 'loss', 'losses', 'slump', 'slumps',
    'crash', 'crashes', 'fraud', 'low', 'fears', 'bearish', 'tumble', 'tumbles'];

  function headlineSentiment(title) {
    const words = new Set(String(title).toLowerCase().replace(/[^a-z]+/g, ' ').split(' '));
    let s = 0;
    for (const w of NEWS_POS) if (words.has(w)) s++;
    for (const w of NEWS_NEG) if (words.has(w)) s--;
    return clamp(s, -2, 2);
  }

  const newsLabel = score =>
    score == null ? 'news unavailable'
    : score >= 2 ? 'headlines lean positive'
    : score <= -2 ? 'headlines lean negative'
    : 'headlines mixed / neutral';

  async function newsCheck(myRun) {
    const syms = [...new Set([
      ...state.robo.positions.map(p => p.symbol),
      ...state.robo.options.map(o => o.symbol),
    ])];
    state.news = { checkedAt: new Date().toISOString(), bySymbol: {} };
    if (!syms.length) { renderNews(); return; }
    diary('<span class="head">Reached the present — reading today\'s real news for what it holds. (During the rewind news is banned: reading today\'s stories about the past would be looking up answers.)</span>', 'head');
    for (const sym of syms) {
      if (myRun !== runToken) return;
      setStatus('Reading today\'s news — ' + sym + '…');
      try {
        const items = await DataSource.fetchNews(sym, 8);
        if (myRun !== runToken) return;   // stopped mid-fetch — write nothing
        const scored = items.map(it => ({ ...it, sent: headlineSentiment(it.title) }));
        const score = scored.reduce((s, x) => s + x.sent, 0);
        state.news.bySymbol[sym] = { score, label: newsLabel(score), items: scored.slice(0, 4) };
        diary('News check: ' + fmt.esc(sym) + ' — ' + newsLabel(score) + ' (' + scored.length +
          ' headline' + (scored.length === 1 ? '' : 's') + ', score ' + (score > 0 ? '+' : '') + score + ').',
          score >= 2 ? 'ok' : score <= -2 ? 'fail' : 'note');
      } catch (e) {
        if (myRun !== runToken) return;
        state.news.bySymbol[sym] = { score: null, label: newsLabel(null), items: [] };
        diary('News check: ' + fmt.esc(sym) + ' — feed unavailable (' + fmt.esc(e.message) + ').', 'note');
      }
      await new Promise(r => setTimeout(r, GAP_MS()));
    }
    if (myRun !== runToken) return;
    renderNews();
  }

  function renderNews() {
    const el = $('auto-news');
    if (!el) return;
    const news = state.news;
    if (!news || !state.robo) { el.hidden = true; return; }
    const syms = Object.keys(news.bySymbol);
    el.hidden = false;
    el.innerHTML =
      '<h3>Today\'s news check — present day only</h3>' +
      '<p class="hint">During its five-year rewind it may not read news: there is no honest way to read the past\'s newspapers, and today\'s stories about the past would be answers. Once caught up, it reads real headlines for what it holds and uses simple word-counting (no AI, no lookahead) to lean positive or negative when topping up the practice mirror.' +
      (news.checkedAt ? ' Last check: ' + fmt.esc(String(news.checkedAt).replace('T', ' ').slice(0, 16)) + '.' : '') + '</p>' +
      (syms.length === 0
        ? '<p>It holds nothing right now, so there was nothing to read about.</p>'
        : syms.map(sym => {
            const n = news.bySymbol[sym];
            const cls = n.score != null && n.score >= 2 ? 'up' : n.score != null && n.score <= -2 ? 'down' : '';
            return '<div class="news-block"><b>' + fmt.esc(sym) + '</b> — <span class="' + cls + '">' + fmt.esc(n.label) + '</span>' +
              (n.items.length
                ? '<ul class="news-list">' + n.items.map(it =>
                    '<li>' + (it.link
                      ? '<a href="' + fmt.esc(it.link) + '" target="_blank" rel="noopener noreferrer">' + fmt.esc(it.title) + '</a>'
                      : fmt.esc(it.title)) +
                    ' <span class="news-src">' + fmt.esc(it.publisher || '') +
                    (it.publishedAt ? ' · ' + fmt.esc(String(it.publishedAt).slice(0, 10)) : '') + '</span></li>').join('') + '</ul>'
                : '<p class="hint">' + (n.score == null ? 'The news feed could not be reached for this one.' : 'No recent headlines found.') + '</p>') +
              '</div>';
          }).join(''));
  }

  // ---------- practice-portfolio mirror (when caught up to today) ----------
  async function mirrorPractice() {
    try {
      await initPractice();
      if (!Practice.getState().live) {
        Practice.createAccount(Math.max(100, round2(equityNow())));
        diary('Opened the practice account to mirror the robot\'s holdings on the main page.', 'note');
      }
      const bySleeve = { long: [], short: [] };
      for (const p of state.robo.positions) {
        bySleeve[isShortStrat(p.strategyId) ? 'short' : 'long'].push(p.symbol);
      }
      if (state.robo.options.length) {
        diary('Mirror: its ' + state.robo.options.length + ' open option' + (state.robo.options.length === 1 ? '' : 's') +
          ' stay on this page — the practice portfolio trades stocks only.', 'note');
      }
      bySleeve.long = bySleeve.long.slice(0, LONG_SLOTS);
      bySleeve.short = bySleeve.short.slice(0, SHORT_SLOTS);
      const targets = [...bySleeve.long, ...bySleeve.short];
      // Today's news tilts the mirror: positive-headline holdings get their
      // top-ups first (matters when cash is scarce), negative ones get none.
      const newsFor = sym => (state.news && state.news.bySymbol && state.news.bySymbol[sym]) || null;
      const newsScore = sym => { const n = newsFor(sym); return n && n.score != null ? n.score : 0; };
      targets.sort((a, b) => newsScore(b) - newsScore(a));

      for (const symbol of Practice.getState().live.positions.filter(p => p.shares > 0).map(p => p.symbol)) {
        if (!targets.includes(symbol)) {
          const r = Practice.sell(symbol, { all: true });
          if (r.ok) diary('Mirror: sold ' + fmt.esc(symbol) + ' in the practice portfolio (the robot no longer holds it).', 'note');
        }
      }
      const totals = Practice.totals();
      const reserve = CASH_RESERVE * totals.totalValue;
      for (const symbol of targets) {
        const p = state.robo.positions.find(x => x.symbol === symbol);
        const u = state.universe.find(x => x.symbol === symbol);
        const w = world.get(symbol);
        if (!p || !w) continue;
        let pos = Practice.findPosition(symbol);
        if (!pos) {
          Practice.addPosition({
            symbol, name: u ? u.name : symbol, resolvedTicker: u ? u.ticker : null,
            lastPrice: w.lastClose, dayChangePct: null,
          });
          pos = Practice.findPosition(symbol);
        }
        if (!pos) continue;
        if (pos.strategyId !== p.strategyId) Practice.setStrategy(symbol, p.strategyId);
        const n = newsFor(symbol);
        if (n && n.score != null && n.score <= -2) {
          diary('Mirror: ' + fmt.esc(symbol) + '\'s headlines lean negative today — its strategy still says hold, so it stays on the list, but the mirror did not add more money.', 'note');
          continue;
        }
        const share = (p.shares * (p.lastPrice || p.entryPrice)) / Math.max(1, equityNow());
        const alloc = Math.min(0.35, Math.max(0.05, share)) * totals.totalValue;
        const currentMV = pos.shares > 0 && pos.lastPrice != null ? pos.shares * pos.lastPrice : 0;
        const need = Math.floor(alloc - currentMV);
        if (need > 50) {
          const cash = Practice.getState().live.cash;
          const spend = Math.floor(Math.min(need, cash - reserve));
          if (spend >= MIN_TRADE) {
            const r = Practice.buy(symbol, spend);
            if (r.ok) diary('Mirror: bought ' + fmt.money(spend) + ' of ' + fmt.esc(symbol) + ' in the practice portfolio.', 'note');
          }
        }
      }
      renderAll();
    } catch (e) {
      diary('Practice mirror skipped: ' + fmt.esc(e.message) + '.', 'note');
    }
  }

  // ---------- rendering ----------
  const daysBetweenDates = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
  const daysLabel = d => (d === 0 ? 'same day' : d + ' day' + (d === 1 ? '' : 's'));

  function renderAll() {
    renderTiles();
    renderSummary();
    renderHoldings();
    renderNews();
    renderLearning();
    renderStocks();
    drawEquity();
  }

  function renderTiles() {
    const el = $('auto-portfolio');
    const robo = state.robo;
    if (!robo) { el.hidden = true; return; }
    const eq = equityNow();
    const ret = eq - robo.config.startCash;
    el.hidden = false;
    el.innerHTML =
      '<div class="tile"><div class="tile-label">Its account</div><div class="tile-value">' + fmt.money(eq) + '</div>' +
      '<div class="tile-delta ' + (ret >= 0 ? 'up' : 'down') + '">' + (ret >= 0 ? '+' : '−') + fmt.money(Math.abs(ret)) +
      ' (' + fmt.pct(robo.config.startCash > 0 ? ret / robo.config.startCash : 0) + ') since ' + fmt.esc(robo.config.startDate) + '</div></div>' +
      '<div class="tile"><div class="tile-label">Stage</div><div class="tile-value">' + (robo.unlocked ? 'Long + short' : 'Short-term only') + '</div>' +
      '<div class="tile-delta muted">' + (robo.unlocked
        ? 'long-term unlocked ' + fmt.esc(robo.unlockedOn || '')
        : fmt.money(Math.max(0, robo.config.unlockAt - eq)) + ' to go until ' + fmt.money(robo.config.unlockAt)) + '</div></div>' +
      '<div class="tile"><div class="tile-label">Simulated day</div><div class="tile-value">' + fmt.esc(robo.cursorDate || 'not started') + '</div>' +
      '<div class="tile-delta muted">' + robo.journal.length + ' closed trade' + (robo.journal.length === 1 ? '' : 's') +
      ' · ' + robo.positions.length + ' stock' + (robo.options.length ? ' + ' + robo.options.length + ' option' + (robo.options.length === 1 ? '' : 's') : '') + ' open</div></div>' +
      (() => {
        const months = robo.months || [];
        const last = months[months.length - 1];
        const metCount = months.filter(m => m.met).length;
        const goal = robo.config.monthlyGoal || DEFAULT_GOAL;
        return '<div class="tile"><div class="tile-label">Monthly goal</div><div class="tile-value">' +
          (last ? (last.earned >= 0 ? '+' : '−') + fmt.money(Math.abs(last.earned)) : fmt.money(goal) + '/mo') + '</div>' +
          '<div class="tile-delta ' + (last ? (last.met ? 'up' : 'down') : 'muted') + '">' +
          (last
            ? 'last month vs ' + fmt.money(goal) + ' goal · met ' + metCount + ' of ' + months.length
            : 'its target — first month still running') +
          (robo.goalPressure ? ' · hungry now' : ' · calm') + '</div></div>';
      })();
  }

  function renderSummary() {
    const brief = $('auto-brief');
    const robo = state.robo;
    if (!robo) { brief.hidden = true; return; }
    brief.hidden = false;
    const eq = equityNow();
    const ret = eq - robo.config.startCash;
    const invested = robo.positions.reduce((s, p) => s + p.shares * (p.lastPrice || p.entryPrice), 0) +
      robo.options.reduce((s, o) => s + o.contracts * 100 * (o.lastPremium != null ? o.lastPremium : o.entryPremium), 0);
    const wins = robo.journal.filter(t => t.pnl > 0).length;
    const simDays = robo.cursorDate ? daysBetweenDates(robo.config.startDate, robo.cursorDate) : 0;

    $('auto-summary').innerHTML =
      '<h3>What it\'s doing — and why</h3>' +
      '<p><b>Its life story:</b> it was born five years in the past (' + fmt.esc(robo.config.startDate) + ') with ' +
      fmt.money(robo.config.startCash) + ' and lives forward one market day at a time — it can never peek ahead, and it may only act on its strategies\' signals. ' +
      'Until the account reaches <b>' + fmt.money(robo.config.unlockAt) + '</b> (10× the start) it is limited to <b>short-term trades</b> ' +
      '(mean-reversion and fast momentum, sold the moment their signal turns). Reaching it unlocks <b>long-term holding</b> (slow trend strategies, up to ' + LONG_SLOTS + ' positions). ' +
      'It keeps ' + Math.round(CASH_RESERVE * 100) + '% cash at all times and learns from every closed trade: strategies that win for it get used more. ' +
      'Before any buy it <b>auditions the strategy</b> on that stock\'s own trailing year — did it actually beat just holding? — so different strategies compete on evidence, ' +
      'and once it catches up to the present it <b>reads real news headlines</b> for its holdings (plain word-counting, no AI) to tilt the practice mirror. News is banned during the rewind — that would be looking up answers. ' +
      'It may also spend a small capped slice (≤' + Math.round(OPT_TOTAL_BUDGET * 100) + '% of the account) on <b>1-month call and put options</b>: calls to ride strong buy signals it has no stock slot for, ' +
      'puts to act on fresh downtrends — the one thing a long-only stock book cannot trade. Option prices come from the Black-Scholes formula fed only by trailing data, so nothing about the future leaks in.</p>' +
      '<ul>' +
      '<li><b>Where it stands:</b> simulated up to <b>' + fmt.esc(robo.cursorDate || '–') + '</b> (' + simDays + ' calendar days lived), stage: <b>' +
      (robo.unlocked ? 'long-term unlocked since ' + fmt.esc(robo.unlockedOn || '?') : 'short-term only — ' + fmt.money(Math.max(0, robo.config.unlockAt - eq)) + ' still to earn') + '</b>.</li>' +
      '<li><b>Money:</b> ' + fmt.money(invested) + ' invested in ' + robo.positions.length + ' stock position' + (robo.positions.length === 1 ? '' : 's') +
      (robo.options.length ? ' and ' + robo.options.length + ' option' + (robo.options.length === 1 ? '' : 's') : '') + ', ' +
      fmt.money(robo.cash) + ' in cash — account worth ' + fmt.money(eq) + ', return <b class="' + (ret >= 0 ? 'up' : 'down') + '">' +
      (ret >= 0 ? '+' : '−') + fmt.money(Math.abs(ret)) + ' (' + fmt.pct(robo.config.startCash > 0 ? ret / robo.config.startCash : 0) + ')</b> over ' +
      fmt.esc(robo.config.startDate) + ' → ' + fmt.esc(robo.cursorDate || 'now') + '.</li>' +
      (() => {
        const months = robo.months || [];
        const goal = robo.config.monthlyGoal || DEFAULT_GOAL;
        const metCount = months.filter(m => m.met).length;
        const last = months[months.length - 1];
        let pace;
        // Pace uses months actually LIVED (from its birth date), not the
        // recorded-months array — migrated saves and the 70-entry cap would
        // otherwise wildly inflate the monthly rate.
        const lived = robo.cursorDate
          ? Math.max(1, Math.round(daysBetweenDates(robo.config.startDate, robo.cursorDate) / 30.44))
          : months.length;
        if (lived >= 2 && months.length >= 1) {
          const rate = Math.pow(Math.max(0.01, eq / robo.config.startCash), 1 / lived) - 1;
          pace = rate > 0.0005
            ? 'Straight talk: at its real pace (' + (rate * 100).toFixed(1) + '% a month) earning ' + fmt.money(goal) +
              ' EVERY month would take about <b>' + fmt.money(goal / rate) + '</b> of capital — no honest strategy turns ' +
              fmt.money(robo.config.startCash) + ' into ' + fmt.money(goal) + ' a month; capital, not luck, is what such a goal needs.'
            : 'Straight talk: its average month is flat-to-negative right now, so no amount of capital reaches the goal — it needs a better edge before it needs more money.';
        } else {
          pace = 'Too few closed months to judge its pace yet.';
        }
        return '<li><b>Its monthly goal:</b> earn at least <b>' + fmt.money(goal) + '</b> a month — met <b>' + metCount + ' of its last ' +
          months.length + '</b> closed months' +
          (last ? ' (last month: ' + (last.earned >= 0 ? '+' : '−') + fmt.money(Math.abs(last.earned)) + ')' : '') +
          '. After a missed month it trades hungrier — lower entry bar, bigger positions, more option budget, thinner cash reserve (hard caps still apply)' +
          (robo.goalPressure ? ' — <b>it is hungry right now</b>' : '') + '. ' + pace + '</li>';
      })() +
      '<li><b>Track record:</b> ' + robo.journal.length + ' closed trades, ' + wins + ' winners' +
      (robo.journal.length ? ' (' + Math.round(wins / robo.journal.length * 100) + '%)' : '') + '. Its memory and learning persist — next run continues this same life.</li>' +
      '</ul>';
  }

  function renderHoldings() {
    const robo = state.robo;
    const wrap = $('auto-holdings-wrap');
    const held = robo ? robo.positions : [];
    const opts = robo ? robo.options : [];
    wrap.hidden = held.length + opts.length === 0;
    if (wrap.hidden) return;
    const row = (invested, worth, cells) => {
      const ret = worth - invested;
      return '<tr>' + cells +
        '<td>' + fmt.money(invested) + '</td>' +
        '<td>' + fmt.money(worth) + '</td>' +
        '<td class="' + (ret >= 0 ? 'up' : 'down') + '">' + (ret >= 0 ? '+' : '−') + fmt.money(Math.abs(ret)) +
        ' (' + fmt.pct(invested > 0 ? ret / invested : 0) + ')</td>';
    };
    $('auto-holdings').querySelector('tbody').innerHTML = held.map(p => {
      const invested = p.shares * p.entryPrice;
      const worth = p.shares * (p.lastPrice || p.entryPrice);
      const simDays = robo.cursorDate ? daysBetweenDates(p.entryDate, robo.cursorDate) : 0;
      return row(invested, worth,
        '<td><b>' + fmt.esc(p.symbol) + '</b></td>' +
        '<td>' + (isShortStrat(p.strategyId) ? 'Short-term trade' : 'Long-term hold') + '</td>' +
        '<td>' + fmt.esc(stratName(p.strategyId)) + '</td>') +
        '<td>' + fmt.esc(p.entryDate) + ' · ' + daysLabel(simDays) + '</td></tr>';
    }).join('') + opts.map(o => {
      const invested = o.entryCost != null ? o.entryCost : o.contracts * 100 * o.entryPremium;
      const worth = o.contracts * 100 * (o.lastPremium != null ? o.lastPremium : o.entryPremium);
      return row(invested, worth,
        '<td><b>' + fmt.esc(o.symbol) + '</b><div class="pr-asof">' + fmt.esc(o.kind) + ' · strike ' + fmt.money(o.strike) + '</div></td>' +
        '<td>' + (o.kind === 'call' ? 'Call option — betting on a rise' : 'Put option — betting on a fall') + '</td>' +
        '<td>' + fmt.esc(stratName(o.strategyId)) + '</td>') +
        '<td>' + fmt.esc(o.entryDate) + ' · expires ' + fmt.esc(o.expiry) + '</td></tr>';
    }).join('');
  }

  function renderLearning() {
    const robo = state.robo;
    const el = $('auto-reco');
    if (!robo) { el.innerHTML = ''; return; }
    const ids = [...SHORT_STRATS, ...LONG_STRATS];
    const rows = ids.map(id => {
      const s = robo.stats.perStrategy[id] || { trades: 0, wins: 0, pnl: 0 };
      return { id, ...s, weight: stratWeight(id) };
    }).sort((a, b) => b.weight - a.weight);
    el.innerHTML =
      '<h3>What it has learned so far</h3>' +
      '<p class="hint">From its own closed trades only — strategies that win for it get a higher weight and are picked more often. Weights start at 1.00 and move with experience (never below 0.60 or above 1.40).</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Strategy</th><th>Kind</th><th>Its trades</th><th>Winners</th><th>P&amp;L</th><th>Learned weight</th></tr></thead><tbody>' +
      rows.map(r =>
        '<tr><td>' + fmt.esc(stratName(r.id)) + '</td>' +
        '<td>' + (isShortStrat(r.id) ? 'Short-term' : 'Long-term' + (robo.unlocked ? '' : ' (locked)')) + '</td>' +
        '<td>' + r.trades + '</td>' +
        '<td>' + (r.trades ? r.wins + ' (' + Math.round(r.wins / r.trades * 100) + '%)' : '–') + '</td>' +
        '<td class="' + (r.pnl > 0 ? 'up' : r.pnl < 0 ? 'down' : '') + '">' + (r.trades ? (r.pnl >= 0 ? '+' : '−') + fmt.money(Math.abs(r.pnl)) : '–') + '</td>' +
        '<td><b>' + r.weight.toFixed(2) + '</b></td></tr>'
      ).join('') + '</tbody></table></div>';
  }

  function renderStocks() {
    const robo = state.robo;
    $('auto-results').hidden = !robo;
    if (!robo) return;
    $('auto-table-note').textContent = 'Its world: ' + state.universe.length +
      ' stocks chosen at birth (' + (WORLDS[state.universeWorld] ? WORLDS[state.universeWorld].label : 'from an earlier save') +
      '). Click a row to race that stock below.';
    const heldBy = new Map(robo.positions.map(p => [p.symbol, p]));
    const optBy = new Map(robo.options.map(o => [o.symbol, o]));
    $('auto-table').querySelector('tbody').innerHTML = state.universe.map(u => {
      const s = robo.stats.perStock[u.symbol] || { trades: 0, wins: 0, pnl: 0 };
      const p = heldBy.get(u.symbol);
      const o = optBy.get(u.symbol);
      return '<tr data-symbol="' + fmt.esc(u.symbol) + '"' + (p || o ? ' class="recommended"' : '') + '>' +
        '<td><b>' + fmt.esc(u.symbol) + '</b><div class="pr-asof">' + fmt.esc(u.name || '') +
        (u.via ? ' · picked as: ' + fmt.esc(u.via) : '') + '</div></td>' +
        '<td>' + (p ? 'holding (' + fmt.esc(stratName(p.strategyId)) + ')' : o ? 'holding a ' + fmt.esc(o.kind) + ' option' : '–') + '</td>' +
        '<td>' + s.trades + '</td>' +
        '<td>' + (s.trades ? Math.round(s.wins / s.trades * 100) + '%' : '–') + '</td>' +
        '<td class="' + (s.pnl > 0 ? 'up' : s.pnl < 0 ? 'down' : '') + '">' + (s.trades || s.pnl ? (s.pnl >= 0 ? '+' : '−') + fmt.money(Math.abs(s.pnl)) : '–') + '</td>' +
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

  // Equity chart — standalone canvas, same DPR-safe pattern as the sim chart.
  const eqCanvas = () => $('auto-equity');
  let eqCssH = null;

  function drawEquity() {
    const canvas = eqCanvas();
    const robo = state.robo;
    const wrap = $('auto-equity-wrap');
    if (!robo || robo.equityCurve.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (eqCssH == null) {
      eqCssH = +canvas.getAttribute('height');
      canvas.style.height = eqCssH + 'px';
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = eqCssH;
    if (!w) return;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';

    const v = name => StockCharts.cssVar(name);
    const PAD = { left: 64, right: 14, top: 12, bottom: 22 };
    const curve = robo.equityCurve;
    const n = curve.length;
    let min = Math.min(robo.config.startCash, ...curve.map(c => c.value));
    let max = Math.max(robo.config.unlockAt, ...curve.map(c => c.value));
    const pad = (max - min) * 0.08 || 1;
    min -= pad; max += pad;
    const plotW = w - PAD.left - PAD.right, plotH = h - PAD.top - PAD.bottom;
    const x = i => PAD.left + (i / (n - 1)) * plotW;
    const y = val => PAD.top + plotH - ((val - min) / (max - min)) * plotH;

    ctx.strokeStyle = v('--gridline');
    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tv of StockCharts.niceTicks(min, max, 4)) {
      const py = Math.round(y(tv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, py); ctx.lineTo(w - PAD.right, py); ctx.stroke();
      ctx.fillText(fmt.equity(tv), PAD.left - 8, py);
    }
    // The two milestones: where it started, and what unlocks long-term.
    for (const [val, label] of [[robo.config.startCash, 'start'], [robo.config.unlockAt, 'unlock long-term']]) {
      const py = Math.round(y(val)) + 0.5;
      ctx.strokeStyle = v('--baseline');
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(PAD.left, py); ctx.lineTo(w - PAD.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(label + ' ' + fmt.equity(val), w - PAD.right - 4, py - 8);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const every = Math.max(1, Math.round(n / 5));
    for (let i = 0; i < n; i += every) {
      if (x(i) > w - PAD.right - 40) break;
      ctx.fillText(curve[i].date.slice(0, 7), x(i), h - PAD.bottom + 6);
    }
    ctx.strokeStyle = v('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    curve.forEach((c, i) => i === 0 ? ctx.moveTo(x(i), y(c.value)) : ctx.lineTo(x(i), y(c.value)));
    ctx.stroke();
    if (robo.unlockedOn) {
      const k = curve.findIndex(c => c.date >= robo.unlockedOn);
      if (k >= 0) {
        ctx.beginPath();
        ctx.arc(x(k), y(curve[k].value), 5, 0, Math.PI * 2);
        ctx.fillStyle = v('--status-good');
        ctx.fill();
      }
    }
  }

  // ---------- the project data/ folder (File System Access) ----------
  // The user links stock_analysis/data ONCE; the robot then auto-writes its
  // life files there at every checkpoint. Chromium-only; the localStorage
  // save keeps working regardless.
  const folderSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  let dataFolder = null;
  let folderStatus = folderSupported ? 'none' : 'unavailable';   // none|connected|needs-permission|unavailable

  function renderFolderNote() {
    const note = $('auto-folder-note');
    const btn = $('auto-folder-btn');
    if (!folderSupported) {
      btn.hidden = true;
      note.textContent = '';
      return;
    }
    btn.hidden = false;
    if (folderStatus === 'connected') {
      btn.textContent = 'Data folder linked ✓';
      note.textContent = 'Writing auto_trader_life.json, journal.csv, and equity_curve.csv into your data folder at every checkpoint.';
    } else if (folderStatus === 'needs-permission') {
      btn.textContent = 'Reconnect data folder';
      note.textContent = 'The data folder needs one click to reconnect.';
    } else {
      btn.textContent = 'Link data folder';
      note.textContent = 'Pick the project\'s stock_analysis/data folder once and the robot keeps its files there (needs Live Server / localhost).';
    }
  }

  async function linkDataFolder() {
    if (!folderSupported) return;
    try {
      let handle = dataFolder;
      if (handle && folderStatus === 'needs-permission') {
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') return;
      } else {
        handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        dataFolder = handle;
        try { await Practice.withTimeout(Practice.idbSet('dataFolder', handle), 4000); } catch (e) { /* session only */ }
      }
      folderStatus = 'connected';
      renderFolderNote();
      await writeDataFiles();
      diary('Data folder linked — its files now live in your project\'s data folder.', 'note');
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        folderStatus = 'unavailable';
        renderFolderNote();
        setStatus('Folder linking is blocked here (try Live Server / localhost). Everything still saves in the browser.', true);
      }
    }
  }

  async function restoreDataFolder() {
    if (!folderSupported) return;
    try {
      const handle = await Practice.withTimeout(Practice.idbGet('dataFolder'), 4000);
      if (!handle) return;
      dataFolder = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      folderStatus = perm === 'granted' ? 'connected' : 'needs-permission';
    } catch (e) { /* stay on browser storage */ }
    renderFolderNote();
  }

  async function writeFileTo(name, text) {
    const fh = await dataFolder.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  let writingFiles = false;
  async function writeDataFiles() {
    if (!dataFolder || folderStatus !== 'connected' || !state.robo || writingFiles) return;
    writingFiles = true;
    try {
      const robo = state.robo;
      await writeFileTo('auto_trader_life.json', JSON.stringify(buildReportDoc(), null, 2));
      const journalCsv = ['entryDate,exitDate,symbol,kind,strategy,sharesOrContracts,entryPrice,exitPrice,pnl,pnlPct']
        .concat(robo.journal.map(t =>
          [t.entryDate, t.exitDate, t.symbol, t.kind || 'stock', '"' + stratName(t.strategyId).replace(/"/g, '""') + '"',
            t.shares, t.entryPrice, t.exitPrice, t.pnl, t.pnlPct].join(',')))
        .join('\n');
      await writeFileTo('journal.csv', journalCsv);
      const curveCsv = ['date,value'].concat(robo.equityCurve.map(c => c.date + ',' + c.value)).join('\n');
      await writeFileTo('equity_curve.csv', curveCsv);
    } catch (e) {
      if (e && e.name === 'NotAllowedError') folderStatus = 'needs-permission';
      renderFolderNote();
    } finally {
      writingFiles = false;
    }
  }

  // ---------- save report ----------
  function buildReportDoc() {
    const robo = state.robo;
    return {
      title: 'Auto-trader life report — five simulated years, no lookahead, learning as it goes',
      generatedAt: new Date().toISOString(),
      rules: [
        'Born ' + robo.config.startDate + ' with $' + robo.config.startCash + '; lives forward one market day at a time — the future is unreadable.',
        'Short-term strategies only (mean reversion + fast momentum) until the account reaches 10× the start (' + fmt.money(robo.config.unlockAt) + '), which unlocks long-term holding.',
        'Decisions come ONLY from strategy signals on trailing data; fills at that day\'s close; ' + Math.round(CASH_RESERVE * 100) + '% cash reserve at all times.',
        'It learns: per-strategy weights follow its own win rates (0.60–1.40), and every buy signal is auditioned against just holding on that stock\'s trailing year first.',
        'Goal: earn at least ' + fmt.money(robo.config.monthlyGoal || DEFAULT_GOAL) + ' per simulated month. A missed month makes it trade hungrier the next (lower entry bar, bigger positions, more option budget — hard caps still apply); a met month calms it down.',
        'Universe: a merit mix, NOT just the biggest — four screens (largest, strongest 3-month movers, best-rated technicals, most traded), deduped.',
        'Options: up to ' + OPT_MAX_OPEN + ' one-month at-the-money calls/puts, premium capped at ' + Math.round(OPT_TOTAL_BUDGET * 100) +
        '% of equity, priced by Black-Scholes from the day\'s close and trailing ' + OPT_VOL_WINDOW + '-day realized volatility (rates 0, fractional contracts) — no historical option quotes exist, so it prices them honestly itself.',
        'News is read only at the present day (word-count sentiment on real headlines for its holdings) and only tilts the practice mirror — never a rewind decision.',
        'Universe: ' + state.universe.length + ' current US stocks — ' + (WORLDS[state.universeWorld] ? WORLDS[state.universeWorld].label : 'chosen before world bands existed') +
        ' (the one present-day fact it knows). Virtual money; educational only.',
      ],
      status: {
        simulatedUpTo: robo.cursorDate,
        accountValue: round2(equityNow()),
        cash: robo.cash,
        unlocked: robo.unlocked,
        unlockedOn: robo.unlockedOn,
        closedTrades: robo.journal.length,
        monthlyGoal: robo.config.monthlyGoal || DEFAULT_GOAL,
        monthsMet: (robo.months || []).filter(m => m.met).length + ' of ' + (robo.months || []).length,
        hungryNow: !!robo.goalPressure,
      },
      months: robo.months,
      learning: robo.stats,
      todaysNews: state.news,
      openPositions: robo.positions,
      openOptions: robo.options,
      journal: robo.journal,
      equityCurve: robo.equityCurve,
      universe: state.universe,
    };
  }

  function saveReport() {
    if (!state.robo) return;
    Practice.downloadFile('auto_trader_life_' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(buildReportDoc(), null, 2), 'application/json');
    writeDataFiles();
  }

  // ---------- boot ----------
  function init() {
    $('auto-start').addEventListener('click', () => (running ? stop() : start()));
    $('auto-save').addEventListener('click', saveReport);
    $('auto-folder-btn').addEventListener('click', linkDataFolder);
    renderFolderNote();
    restoreDataFolder();
    window.addEventListener('resize', drawEquity);
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawEquity);
    }

    if (restore()) {
      renderDiaryFromState();
      renderAll();
      if (state.robo) {
        $('auto-capital').value = String(Math.round(state.robo.config.startCash));
        if ($('auto-goal')) $('auto-goal').value = String(Math.round(state.robo.config.monthlyGoal || DEFAULT_GOAL));
        setStatus('Its life so far is remembered: at ' + (state.robo.cursorDate || 'birth') + ', account ' +
          fmt.money(equityNow()) + '. Press Start to continue' + (state.running ? 'ing…' : '.'));
        if (WORLDS[state.params.world]) $('auto-mincap').value = state.params.world;
        if (state.running) start();   // it was mid-run — keep living, Stop is visible
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    start, stop,
    _state: () => state,
    _world: () => world,
    _audition: (symbol, i, id) => { const w = world.get(symbol); return w ? audition(w, symbol, i, id, true) : null; },
    _sentiment: headlineSentiment,
    _bs: bsPrice,
  };
})();
