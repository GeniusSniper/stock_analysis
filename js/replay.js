/* ============================================================
   Replay trainer — practice investing against real history, one
   day at a time, with a strategy advisor you can swap anytime.

   The user never sees a bar past the cursor. All six strategies'
   position arrays are precomputed ONCE per run on the full series:
   every indicator they read (SMA/EMA/RSI/MACD/Bollinger/ROC) is
   strictly trailing, so positions[i] on the full array is identical
   to positions[i] on bars.slice(0, i+1) — no lookahead. (Do NOT
   surface ind.vol20 / regime here: those are scalars over the
   array TAIL and would leak the future.)

   Talks to the practice core only via Practice.getSlot/setSlot
   ('replay'), Practice.fmt, and the practice:ready / practice:tab
   events. Fills happen at the CURRENT day's close — the end-of-run
   agent race uses Simulation.runWindow with the same convention.
   ============================================================ */
const Replay = (() => {

  const $ = id => document.getElementById(id);
  const { fmt } = Practice;
  const round2 = Practice.round2, round4 = Practice.round4;

  const SLOT_VERSION = 1;
  const WARMUP_BARS = 65;      // ROC(63) + MACD signal warm-up: all six advisors live on day 1
  const MIN_PLAY_BARS = 30;
  const RANGE_CHIPS = { '3M': 63, '6M': 126, '1Y': 252, 'RUN': null };

  let replay = null;           // active run (see beginRun for shape)
  let lastResult = null;       // finished-run view model
  let replayReq = 0;           // race token for setup/resume fetches
  let rangeKey = '6M';

  // ---------- slot I/O ----------
  function slot() {
    return Practice.getSlot('replay') || { v: SLOT_VERSION, active: null, history: [] };
  }

  function saveSlot(active) {
    const s = slot();
    Practice.setSlot('replay', { v: SLOT_VERSION, active, history: s.history || [] });
  }

  function pushHistory(entry) {
    const s = slot();
    const history = [entry, ...(s.history || [])].slice(0, 20);
    Practice.setSlot('replay', { v: SLOT_VERSION, active: null, history });
  }

  function serializeActive() {
    if (!replay) return null;
    const b = replay.data.bars;
    return {
      config: {
        symbol: replay.data.symbol,
        source: replay.data.source,
        startDate: b[replay.startIdx].date,
        startClose: b[replay.startIdx].close,
        startCash: replay.startCash,
        firstBarDate: b[0].date,
        lastBarDate: b[b.length - 1].date,
        barCount: b.length,
        warmupBars: WARMUP_BARS,
      },
      cursorDate: b[replay.cursor].date,
      strategyId: replay.strategyId,
      strategyChanges: replay.strategyChanges,
      account: {
        cash: replay.cash, shares: replay.shares, costBasis: replay.costBasis,
        realized: replay.realized, roundTrips: replay.roundTrips, wins: replay.wins,
        tripRealized: replay.tripRealized,
      },
      trades: replay.trades,
      equityByDay: replay.equityByDay.map(round2),
      startedAt: replay.startedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---------- run lifecycle ----------
  function computeAdvisors(bars, ind) {
    const byId = {};
    for (const s of Strategies.catalog) byId[s.id] = s.positions(bars, ind);
    return byId;
  }

  function beginRunWith(data, startIdx, startCash, strategyId) {
    stopPlay();
    replay = {
      data,                                  // { bars, ind, symbol, source }
      positionsById: computeAdvisors(data.bars, data.ind),
      startIdx,
      cursor: startIdx,
      strategyId,
      strategyChanges: 0,
      startCash,
      cash: startCash,
      shares: 0,
      costBasis: 0,
      realized: 0,
      roundTrips: 0,
      wins: 0,
      tripRealized: 0,
      trades: [],
      equityByDay: [startCash],
      startedAt: new Date().toISOString(),
      finished: false,
    };
    lastResult = null;
    rangeKey = '6M';
    saveSlot(serializeActive());
    renderReplay();
  }

  async function beginRun() {
    const status = $('replay-status');
    status.textContent = '';
    status.classList.remove('error');

    const input = $('replay-symbol').value.trim();
    const main = Practice.getMainData();
    const symbol = DataSource.normalizeSymbol(input || (main && main.symbol) || 'AAPL');
    const dateStr = $('replay-date').value;
    if (!dateStr) { setupError('Pick a starting date first.'); return; }
    const startCash = round2(parseFloat($('replay-cash').value));
    if (!isFinite(startCash) || startCash <= 0) { setupError('Starting cash must be a positive number.'); return; }
    const strategyId = $('replay-strategy').value;

    const myReq = ++replayReq;
    $('replay-begin').disabled = true;
    try {
      let data;
      if (main && main.symbol === symbol) {
        data = { bars: main.bars, ind: main.ind, symbol, source: main.source };
      } else {
        const sourceSel = document.getElementById('source-select');
        const source = sourceSel ? sourceSel.value : 'yahoo';
        status.textContent = 'Fetching history for ' + symbol + '…';
        const bars = await DataSource.load(source, symbol, (document.getElementById('apikey-input') || {}).value || '');
        if (myReq !== replayReq) return;
        data = { bars, ind: Indicators.computeAll(bars), symbol, source };
      }

      // The chosen date may predate the fast ~10y window — try full history.
      if (dateStr < data.bars[0].date.slice(0, 10)) {
        status.textContent = 'Loading the full history for ' + symbol + '…';
        try {
          const full = await DataSource.loadFullHistory(data.source, symbol);
          if (myReq !== replayReq) return;
          if (full && full.length > data.bars.length) {
            data = { bars: full, ind: Indicators.computeAll(full), symbol, source: data.source };
          }
        } catch (e) { /* fall through to validation below */ }
      }

      const v = findStartIdx(data.bars, dateStr);
      if (v.error) { setupError(v.error); return; }
      status.textContent = '';
      beginRunWith(data, v.startIdx, startCash, strategyId);
    } catch (e) {
      if (myReq === replayReq) setupError('Could not load ' + symbol + ': ' + e.message);
    } finally {
      if (myReq === replayReq) $('replay-begin').disabled = false;
    }
  }

  function setupError(msg) {
    const status = $('replay-status');
    status.textContent = msg;
    status.classList.add('error');
  }

  function findStartIdx(bars, dateStr) {
    const minBars = WARMUP_BARS + MIN_PLAY_BARS + 1;
    if (bars.length < minBars) {
      return { error: 'This symbol only has ' + bars.length + ' trading days of history — at least ' + minBars + ' are needed (' + WARMUP_BARS + ' warm-up + ' + MIN_PLAY_BARS + ' playable).' };
    }
    let startIdx = bars.findIndex(b => b.date.slice(0, 10) >= dateStr);
    if (startIdx === -1) return { error: 'That date is after the newest bar (' + bars[bars.length - 1].date + ').' };
    if (startIdx < WARMUP_BARS) {
      return { error: 'Not enough history before that date to warm up the indicators — earliest playable date for this symbol is ' + bars[WARMUP_BARS].date + '.' };
    }
    if (bars.length - 1 - startIdx < MIN_PLAY_BARS) {
      return { error: 'Fewer than ' + MIN_PLAY_BARS + ' trading days after that date — latest playable date is ' + bars[bars.length - 1 - MIN_PLAY_BARS].date + '.' };
    }
    return { startIdx };
  }

  // ---------- stepping & trading ----------
  function lastIdx() { return replay.data.bars.length - 1; }

  function stepDays(k) {
    if (!replay || replay.finished) return;
    const bars = replay.data.bars;
    const target = Math.min(replay.cursor + k, lastIdx());
    for (let i = replay.cursor + 1; i <= target; i++) {
      replay.equityByDay.push(replay.cash + replay.shares * bars[i].close);
    }
    replay.cursor = target;
    if (replay.cursor >= lastIdx()) stopPlay();
    saveSlot(serializeActive());
    renderRun();
  }

  function applyTrade(side, dollars) {
    if (!replay || replay.finished) return;
    stopPlay();
    const bar = replay.data.bars[replay.cursor];
    const price = bar.close;

    if (side === 'buy') {
      const value = round2(Math.min(+dollars, replay.cash));
      if (!isFinite(value) || value <= 0) return;
      const added = round4(value / price);
      if (added <= 0) return;
      replay.shares = round4(replay.shares + added);
      replay.costBasis = round2(replay.costBasis + value);
      replay.cash = round2(replay.cash - value);
      replay.trades.push({ date: bar.date, side: 'BUY', price: round2(price), shares: added, value });
    } else {
      if (replay.shares <= 0) return;
      const all = side === 'sell-all';
      const sellShares = all ? replay.shares : round4(replay.shares / 2);
      if (sellShares <= 0) return;
      const value = round2(sellShares * price);
      const costRemoved = all ? replay.costBasis : round2(replay.costBasis * (sellShares / replay.shares));
      const profit = round2(value - costRemoved);
      replay.cash = round2(replay.cash + value);
      replay.shares = all ? 0 : round4(replay.shares - sellShares);
      replay.costBasis = all ? 0 : round2(replay.costBasis - costRemoved);
      replay.realized = round2(replay.realized + profit);
      replay.tripRealized = round2(replay.tripRealized + profit);
      replay.trades.push({
        date: bar.date, side: 'SELL', price: round2(price), shares: sellShares, value,
        profit, profitPct: costRemoved > 0 ? round4(profit / costRemoved) : 0,
      });
      if (replay.shares === 0) {
        replay.roundTrips++;
        if (replay.tripRealized > 0) replay.wins++;
        replay.tripRealized = 0;
      }
    }
    // Today's equity reflects the fill immediately.
    replay.equityByDay[replay.equityByDay.length - 1] = replay.cash + replay.shares * price;
    saveSlot(serializeActive());
    renderRun();
  }

  function advisorWantsLong() {
    return replay.positionsById[replay.strategyId][replay.cursor] === 1;
  }

  function advisorSignal() {
    const positions = replay.positionsById[replay.strategyId];
    return Strategies.currentSignal(positions.slice(0, replay.cursor + 1));
  }

  function obeyAdvisor() {
    if (!replay || replay.finished) return;
    const want = advisorWantsLong();
    if (want && replay.shares === 0) applyTrade('buy', replay.cash);
    else if (!want && replay.shares > 0) applyTrade('sell-all', 0);
  }

  function setStrategy(id) {
    if (!replay || !Strategies.catalog.some(s => s.id === id)) return;
    if (id === replay.strategyId) return;
    replay.strategyId = id;
    replay.strategyChanges++;
    saveSlot(serializeActive());
    renderRun();
  }

  let playTimer = null;
  function togglePlay() {
    if (playTimer) { stopPlay(); renderRun(); return; }
    playTimer = setInterval(() => {
      if (!replay || replay.finished || replay.cursor >= lastIdx()) { stopPlay(); renderRun(); return; }
      stepDays(1);
    }, 500);
    renderRun();
  }
  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
  }

  // ---------- finishing ----------
  function maxDrawdownOf(equity) {
    let peak = -Infinity, dd = 0;
    for (const v of equity) {
      if (v > peak) peak = v;
      dd = Math.max(dd, 1 - v / peak);
    }
    return dd;
  }

  function finishRun() {
    if (!replay || replay.finished) return;
    stopPlay();
    replay.finished = true;
    const bars = replay.data.bars;
    const endIdx = replay.cursor;
    const finalClose = bars[endIdx].close;
    const finalValue = replay.cash + replay.shares * finalClose;

    // An open position counts as a round trip at its market value — same
    // accounting as the simulation agents' endsInMarket convention.
    let roundTrips = replay.roundTrips, wins = replay.wins;
    const endsInMarket = replay.shares > 0;
    if (endsInMarket) {
      roundTrips++;
      if (replay.shares * finalClose - replay.costBasis + replay.tripRealized > 0) wins++;
    }

    const race = Simulation.runWindow(bars, replay.data.ind, {
      startIdx: replay.startIdx, endIdx, startCash: replay.startCash, fill: 'same-close',
    });

    lastResult = {
      symbol: replay.data.symbol,
      startDate: bars[replay.startIdx].date,
      endDate: bars[endIdx].date,
      days: endIdx - replay.startIdx + 1,
      startCash: replay.startCash,
      finalValue: round2(finalValue),
      totalReturn: round4(finalValue / replay.startCash - 1),
      maxDrawdown: round4(maxDrawdownOf(replay.equityByDay)),
      trades: roundTrips,
      winRate: roundTrips ? round4(wins / roundTrips) : null,
      strategyChanges: replay.strategyChanges,
      endsInMarket,
      equityByDay: replay.equityByDay.slice(),
      tradeLog: replay.trades.slice(),
      agents: race.agents,
      dates: race.dates,
    };
    lastResult.beatCount = race.agents.filter(a => a.stats.finalValue < lastResult.finalValue).length;

    pushHistory({
      finishedAt: new Date().toISOString(),
      symbol: lastResult.symbol,
      startDate: lastResult.startDate,
      endDate: lastResult.endDate,
      days: lastResult.days,
      startCash: lastResult.startCash,
      finalValue: lastResult.finalValue,
      totalReturn: lastResult.totalReturn,
      maxDrawdown: lastResult.maxDrawdown,
      trades: lastResult.trades,
      winRate: lastResult.winRate,
      strategyChanges: lastResult.strategyChanges,
      beatCount: lastResult.beatCount,
    });

    renderReplay();
  }

  function discardRun() {
    stopPlay();
    replay = null;
    lastResult = null;
    saveSlot(null);
    renderReplay();
  }

  function saveRunToFile() {
    if (!lastResult) return;
    const doc = {
      title: 'Replay trainer run — practice investing vs the strategy agents',
      generatedAt: new Date().toISOString(),
      symbol: lastResult.symbol,
      period: { from: lastResult.startDate, to: lastResult.endDate, tradingDays: lastResult.days },
      startingCash: lastResult.startCash,
      assumptions: [
        'All fills at the daily closing price (yours and the agents\').',
        'Fractional shares; no commissions, slippage, taxes, or dividends.',
        'Educational simulation — past performance does not predict future results.',
      ],
      you: {
        finalValue: lastResult.finalValue, totalReturn: lastResult.totalReturn,
        maxDrawdown: lastResult.maxDrawdown, trades: lastResult.trades,
        winRate: lastResult.winRate, strategyChanges: lastResult.strategyChanges,
        endsInMarket: lastResult.endsInMarket,
        beatCount: lastResult.beatCount,
        tradeLog: lastResult.tradeLog,
        equityByDay: lastResult.equityByDay.map(round2),
      },
      agents: lastResult.agents.map(a => ({ id: a.id, strategy: a.name, stats: a.stats })),
    };
    const name = 'replay_' + lastResult.symbol.replace(/[^A-Za-z0-9_.-]/g, '') + '_' +
      lastResult.startDate.slice(0, 10) + '_to_' + lastResult.endDate.slice(0, 10) + '.json';
    Practice.downloadFile(name, JSON.stringify(doc, null, 2), 'application/json');
  }

  // ---------- resume ----------
  function rebuildAccountFromTrades(bars, startIdx, cursorIdx, trades, startCash) {
    let cash = startCash, shares = 0, costBasis = 0, realized = 0;
    let roundTrips = 0, wins = 0, tripRealized = 0;
    const equityByDay = [];
    let t = 0;
    for (let i = startIdx; i <= cursorIdx; i++) {
      const date = bars[i].date;
      while (t < trades.length && trades[t].date === date) {
        const tr = trades[t++];
        if (tr.side === 'BUY') {
          shares = round4(shares + tr.shares);
          costBasis = round2(costBasis + tr.value);
          cash = round2(cash - tr.value);
        } else {
          const costRemoved = round2(tr.value - (tr.profit || 0));
          cash = round2(cash + tr.value);
          shares = round4(shares - tr.shares);
          if (shares < 1e-6) shares = 0;
          costBasis = round2(Math.max(0, costBasis - costRemoved));
          realized = round2(realized + (tr.profit || 0));
          tripRealized = round2(tripRealized + (tr.profit || 0));
          if (shares === 0) {
            roundTrips++;
            if (tripRealized > 0) wins++;
            tripRealized = 0;
            costBasis = 0;
          }
        }
      }
      equityByDay.push(cash + shares * bars[i].close);
    }
    // consumed lets the caller detect trades whose bar date vanished from a
    // revised history — resuming past them would silently corrupt the account.
    return { cash, shares, costBasis, realized, roundTrips, wins, tripRealized, equityByDay, consumed: t };
  }

  function validateResume(active, bars) {
    const startIdx = bars.findIndex(b => b.date === active.config.startDate);
    if (startIdx === -1 || startIdx < WARMUP_BARS) return { error: 'start date missing from the refreshed history' };
    const cursorIdx = bars.findIndex(b => b.date === active.cursorDate);
    if (cursorIdx === -1 || cursorIdx < startIdx) return { error: 'last played day missing from the refreshed history' };
    const drift = Math.abs(bars[startIdx].close - active.config.startClose) / active.config.startClose;
    if (drift > 0.005) return { error: 'the data feed has revised this history (prices shifted ' + (drift * 100).toFixed(1) + '%)' };
    return { startIdx, cursorIdx };
  }

  async function resumeRun() {
    const active = slot().active;
    if (!active) return;
    const myReq = ++replayReq;
    const errEl = $('replay-resume-err');
    errEl.textContent = '';
    $('replay-resume-go').disabled = true;
    try {
      let data;
      const main = Practice.getMainData();
      // The refetched window is a ROLLING ~10y — a start date that was safely
      // inside it can slide below the 65-bar warm-up between sessions.
      const lacksWarmup = bs => {
        const i = bs.findIndex(b => b.date === active.config.startDate);
        return i === -1 || i < WARMUP_BARS;
      };
      if (main && main.symbol === active.config.symbol && main.source === active.config.source && !lacksWarmup(main.bars)) {
        data = { bars: main.bars, ind: main.ind, symbol: main.symbol, source: main.source };
      } else {
        errEl.textContent = 'Fetching history for ' + active.config.symbol + '…';
        const apiKey = (document.getElementById('apikey-input') || {}).value || '';
        let bars = await DataSource.load(active.config.source, active.config.symbol, apiKey);
        if (myReq !== replayReq) return;
        if (lacksWarmup(bars)) {
          const full = await DataSource.loadFullHistory(active.config.source, active.config.symbol);
          if (myReq !== replayReq) return;
          if (full && full.length > bars.length) bars = full;
        }
        data = { bars, ind: Indicators.computeAll(bars), symbol: active.config.symbol, source: active.config.source };
      }
      const v = validateResume(active, data.bars);
      if (v.error) {
        errEl.textContent = 'Cannot resume: ' + v.error + '. Start a new run (the old one stays saved until you discard it).';
        return;
      }
      const acct = rebuildAccountFromTrades(data.bars, v.startIdx, v.cursorIdx, active.trades, active.config.startCash);
      if (acct.consumed !== active.trades.length) {
        errEl.textContent = 'Cannot resume: the refreshed history no longer contains one of the days you traded on. Start a new run (the old one stays saved until you discard it).';
        return;
      }
      stopPlay();
      replay = {
        data,
        positionsById: computeAdvisors(data.bars, data.ind),
        startIdx: v.startIdx,
        cursor: v.cursorIdx,
        strategyId: active.strategyId,
        strategyChanges: active.strategyChanges || 0,
        startCash: active.config.startCash,
        cash: round2(acct.cash),
        shares: acct.shares,
        costBasis: acct.costBasis,
        realized: acct.realized,
        roundTrips: acct.roundTrips,
        wins: acct.wins,
        tripRealized: acct.tripRealized,
        trades: active.trades.slice(),
        equityByDay: acct.equityByDay,
        startedAt: active.startedAt,
        finished: false,
      };
      lastResult = null;
      renderReplay();
    } catch (e) {
      if (myReq === replayReq) errEl.textContent = 'Could not reload the data: ' + e.message + ' — try again.';
    } finally {
      if (myReq === replayReq) $('replay-resume-go').disabled = false;
    }
  }

  // ---------- rendering ----------
  function show(id, visible) { $(id).hidden = !visible; }

  function renderReplay() {
    const active = slot().active;
    show('replay-resume', !replay && !lastResult && !!active);
    show('replay-setup', !replay && !lastResult && !active);
    show('replay-run', !!replay && !replay.finished);
    show('replay-result', !!lastResult);
    if (!replay && !lastResult && active) renderResumeCard(active);
    if (replay && !replay.finished) renderRun();
    if (lastResult) renderResult();
  }

  function renderResumeCard(active) {
    const days = active.equityByDay ? active.equityByDay.length : 1;
    const equity = active.equityByDay && active.equityByDay.length
      ? active.equityByDay[active.equityByDay.length - 1] : active.config.startCash;
    $('replay-resume-info').innerHTML =
      'You have an unfinished run: <b>' + fmt.esc(active.config.symbol) + '</b>, Day <b>' + days +
      '</b> (' + fmt.esc(active.cursorDate) + '), equity <b>' + fmt.money(equity) + '</b> from ' +
      fmt.money(active.config.startCash) + ' on ' + fmt.esc(active.config.startDate) + '.';
  }

  function signalBadge(sig) {
    return '<span class="signal-badge signal-' + sig.cls + '">' + sig.icon + ' ' + sig.label + '</span>';
  }

  function renderRun() {
    if (!replay) return;
    const bars = replay.data.bars;
    const bar = bars[replay.cursor];
    const prev = bars[replay.cursor - 1];
    const dayN = replay.cursor - replay.startIdx + 1;
    const equity = replay.equityByDay[replay.equityByDay.length - 1];
    const change = prev ? bar.close / prev.close - 1 : 0;
    const atEnd = replay.cursor >= lastIdx();

    $('replay-title').innerHTML = '<b>' + fmt.esc(replay.data.symbol) + '</b> replay — started ' +
      fmt.esc(bars[replay.startIdx].date) + ' with ' + fmt.money(replay.startCash) +
      (atEnd ? ' · <b>You reached the newest bar — press Finish.</b>' : '');

    $('replay-tiles').innerHTML = [
      ['Today', bar.date, 'Day ' + dayN + ' of ' + (lastIdx() - replay.startIdx + 1)],
      ['Close', fmt.money(bar.close), (change >= 0 ? '▲ ' : '▼ ') + fmt.pct(change, 2), change >= 0 ? 'up' : 'down'],
      ['Position', replay.shares > 0 ? fmt.shares(replay.shares) + ' sh' : 'in cash',
        replay.shares > 0 ? fmt.money(replay.shares * bar.close) : 'no shares held'],
      ['Cash', fmt.money(replay.cash), ''],
      ['Equity', fmt.money(equity), fmt.pct(equity / replay.startCash - 1) + ' since start',
        equity >= replay.startCash ? 'up' : 'down'],
    ].map(([label, value, note, cls]) =>
      '<div class="tile"><div class="tile-label">' + label + '</div>' +
      '<div class="tile-value">' + value + '</div>' +
      '<div class="tile-delta ' + (cls || 'muted') + '">' + note + '</div></div>'
    ).join('');

    // Advisor card
    const strat = Strategies.catalog.find(s => s.id === replay.strategyId);
    const sig = advisorSignal();
    const want = advisorWantsLong();
    const following = (replay.shares > 0) === want;
    let reason;
    if (sig.label === 'Buy') reason = strat.lesson.rules[0];
    else if (sig.label === 'Sell') reason = strat.lesson.rules[1];
    else if (sig.label === 'Hold long') reason = 'The entry condition still holds. Exit rule: ' + strat.lesson.rules[1];
    else reason = 'Waiting for: ' + strat.lesson.rules[0];
    $('replay-advisor').innerHTML =
      '<div class="replay-advisor-head">Advisor — <b>' + fmt.esc(strat.name) + '</b> says ' + signalBadge(sig) +
      ' <span class="' + (following ? 'up' : 'down') + '">' +
      (following ? '✓ you are following the strategy' : '✗ you are doing the opposite') + '</span></div>' +
      '<p class="hint">' + reason + '</p>' +
      '<button class="btn btn-secondary" id="replay-obey"' + (following ? ' disabled' : '') + '>Do what the strategy says</button> ' +
      '<button class="learn-link" id="replay-lesson" type="button">How this strategy works →</button>';
    $('replay-obey').addEventListener('click', obeyAdvisor);
    $('replay-lesson').addEventListener('click', () => {
      if (window.openStrategyLesson) window.openStrategyLesson(replay.strategyId);
    });
    const sel = $('replay-strategy-live');
    if (sel.value !== replay.strategyId) sel.value = replay.strategyId;

    // Controls
    $('replay-buy').disabled = replay.cash <= 0;
    $('replay-sell-half').disabled = replay.shares <= 0;
    $('replay-sell-all').disabled = replay.shares <= 0;
    $('replay-next').disabled = atEnd;
    $('replay-skip').disabled = atEnd;
    $('replay-play').disabled = atEnd;
    $('replay-play').textContent = playTimer ? '❚❚ Pause' : '▶ Play';
    $('replay-finish').classList.toggle('btn-primary', atEnd);
    $('replay-finish').classList.toggle('btn-secondary', !atEnd);
    const amt = $('replay-buy-amt');
    if (document.activeElement !== amt) amt.value = Math.floor(replay.cash);

    document.querySelectorAll('#replay-range [data-rrange]').forEach(b =>
      b.classList.toggle('active', b.dataset.rrange === rangeKey));

    drawReplayChart();
    drawEquityStrip();
    renderTradeLog();
  }

  function renderTradeLog() {
    const wrap = $('replay-trades-wrap');
    wrap.hidden = replay.trades.length === 0;
    if (!replay.trades.length) return;
    $('replay-trades').querySelector('tbody').innerHTML = [...replay.trades].reverse().map(t =>
      '<tr><td>' + fmt.esc(t.date) + '</td><td>' + fmt.esc(t.side) + '</td><td>' + fmt.money(t.price) + '</td>' +
      '<td>' + fmt.shares(t.shares) + '</td><td>' + fmt.money(t.value) + '</td>' +
      '<td class="' + (t.profit > 0 ? 'up' : t.profit < 0 ? 'down' : '') + '">' +
      (t.side === 'SELL' ? (t.profit >= 0 ? '+' : '−') + fmt.money(Math.abs(t.profit)) : '–') + '</td></tr>'
    ).join('');
  }

  // ---------- charts (standalone drawSimChart pattern) ----------
  const PAD = { left: 64, right: 14, top: 12, bottom: 24 };
  const chartHeights = {};   // canvas id -> css height, captured once (hi-DPI guard)

  function setupCanvas(id) {
    const canvas = $(id);
    if (!(id in chartHeights)) {
      chartHeights[id] = +canvas.getAttribute('height');
      canvas.style.height = chartHeights[id] + 'px';
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = chartHeights[id];
    if (!w) return null;   // hidden pane — redrawn on reveal
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    return { ctx, w, h };
  }

  function yTicks(useLog, yMin, yMax) {
    if (useLog) {
      let ticks = [];
      for (let e = Math.floor(Math.log10(yMin)); e <= Math.ceil(Math.log10(yMax)); e++) {
        for (const m of [1, 2, 5]) {
          const tv = m * Math.pow(10, e);
          if (tv >= yMin && tv <= yMax) ticks.push(tv);
        }
      }
      while (ticks.length > 7) ticks = ticks.filter((_, k) => k % 2 === 0);
      if (ticks.length < 2) ticks = StockCharts.niceTicks(yMin, yMax, 4).filter(tv => tv >= yMin && tv <= yMax);
      return ticks;
    }
    return StockCharts.niceTicks(yMin, yMax, 4);
  }

  function drawGrid(ctx, w, h, ticks, y, format) {
    const v = name => StockCharts.cssVar(name);
    ctx.strokeStyle = v('--gridline');
    ctx.lineWidth = 1;
    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tv of ticks) {
      const py = Math.round(y(tv)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(w - PAD.right, py);
      ctx.stroke();
      ctx.fillText(format(tv), PAD.left - 8, py);
    }
  }

  function drawReplayChart() {
    if (!replay) return;
    const c = setupCanvas('replay-chart');
    if (!c) return;
    const { ctx, w, h } = c;
    const v = name => StockCharts.cssVar(name);
    const bars = replay.data.bars;
    const cursor = replay.cursor;

    const winLen = RANGE_CHIPS[rangeKey] == null
      ? cursor - replay.startIdx + WARMUP_BARS + 1
      : RANGE_CHIPS[rangeKey];
    const i0 = Math.max(0, cursor - winLen + 1);
    // Domain over the visible slice ONLY — nothing past the cursor exists yet.
    let min = Infinity, max = -Infinity;
    for (let i = i0; i <= cursor; i++) {
      const cl = bars[i].close;
      if (cl < min) min = cl;
      if (cl > max) max = cl;
    }
    const useLog = $('replay-log').checked && min > 0;
    const T = useLog ? Math.log : (x => x);
    let tMin = T(min), tMax = T(max);
    const pad = (tMax - tMin) * 0.06 || 1;
    tMin -= pad; tMax += pad;
    const yMin = useLog ? Math.exp(tMin) : tMin;
    const yMax = useLog ? Math.exp(tMax) : tMax;
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const n = cursor - i0;
    const x = i => PAD.left + (n === 0 ? plotW / 2 : ((i - i0) / n) * plotW);
    const y = val => PAD.top + plotH - ((T(val) - tMin) / (tMax - tMin)) * plotH;

    drawGrid(ctx, w, h, yTicks(useLog, yMin, yMax), y,
      tv => '$' + (tv >= 100 ? Math.round(tv).toLocaleString('en-US') : tv >= 10 ? tv.toFixed(0) : tv.toFixed(2)));

    // X date labels
    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.round((n + 1) / 6));
    for (let i = i0; i <= cursor; i += labelEvery) {
      if (x(i) > w - PAD.right - 30) break;
      const d = bars[i].date;
      ctx.fillText(n < 130 ? d.slice(5) : n < 2600 ? d.slice(0, 7) : d.slice(0, 4), x(i), h - PAD.bottom + 7);
    }

    // Price line: dimmed pre-start context, then the played segment.
    const drawSeg = (from, to, color, alpha) => {
      if (to < from) return;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const px = x(i), py = y(bars[i].close);
        i === from ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const startIdx = replay.startIdx;
    if (i0 < startIdx) drawSeg(i0, Math.min(startIdx, cursor), v('--text-muted'), 0.45);
    drawSeg(Math.max(i0, startIdx), cursor, v('--series-1'), 1);

    // Dashed "start" marker
    if (startIdx >= i0 && startIdx <= cursor) {
      const px = Math.round(x(startIdx)) + 0.5;
      ctx.strokeStyle = v('--baseline');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, h - PAD.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = v('--text-muted');
      ctx.textAlign = 'left';
      ctx.fillText('start', px + 4, PAD.top + 2);
    }

    // Trade markers: ▲ buys below the price, ▼ sells above it.
    const idxByDate = new Map();
    for (let i = i0; i <= cursor; i++) idxByDate.set(bars[i].date, i);
    for (const t of replay.trades) {
      const i = idxByDate.get(t.date);
      if (i == null) continue;
      const px = x(i), py = y(bars[i].close);
      ctx.fillStyle = t.side === 'BUY' ? v('--status-good') : v('--status-critical');
      ctx.beginPath();
      if (t.side === 'BUY') {
        ctx.moveTo(px, py + 6);
        ctx.lineTo(px - 5, py + 14);
        ctx.lineTo(px + 5, py + 14);
      } else {
        ctx.moveTo(px, py - 6);
        ctx.lineTo(px - 5, py - 14);
        ctx.lineTo(px + 5, py - 14);
      }
      ctx.closePath();
      ctx.fill();
    }

    // "Today" ringed dot at the cursor.
    const px = x(cursor), py = y(bars[cursor].close);
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = v('--surface-1');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = v('--accent');
    ctx.fill();
  }

  function drawEquityStrip() {
    if (!replay) return;
    const c = setupCanvas('replay-equity');
    if (!c) return;
    const { ctx, w, h } = c;
    const v = name => StockCharts.cssVar(name);
    const eq = replay.equityByDay;
    const n = eq.length;
    let min = Math.min(...eq, replay.startCash), max = Math.max(...eq, replay.startCash);
    if (min === max) { min *= 0.98; max *= 1.02; }
    const pad = (max - min) * 0.1;
    min -= pad; max += pad;
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - 8;
    const x = i => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = val => PAD.top + plotH - ((val - min) / (max - min)) * plotH;

    // Baseline at the starting cash.
    const by = Math.round(y(replay.startCash)) + 0.5;
    ctx.strokeStyle = v('--baseline');
    ctx.beginPath();
    ctx.moveTo(PAD.left, by);
    ctx.lineTo(w - PAD.right, by);
    ctx.stroke();
    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('your equity — start ' + fmt.equity(replay.startCash), w - PAD.right - 4, by - 9);

    ctx.strokeStyle = v('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      i === 0 ? ctx.moveTo(x(i), y(eq[i])) : ctx.lineTo(x(i), y(eq[i]));
    }
    ctx.stroke();
  }

  const SIM_COLOR = k => StockCharts.cssVar('--sim-' + ((k % 6) + 1));

  function drawResultChart() {
    if (!lastResult) return;
    const c = setupCanvas('replay-result-chart');
    if (!c) return;
    const { ctx, w, h } = c;
    const v = name => StockCharts.cssVar(name);
    const series = [
      ...lastResult.agents.map((a, k) => ({ values: a.equity, color: SIM_COLOR(k), width: 2 })),
      { values: lastResult.equityByDay, color: v('--accent'), width: 3 },   // you, on top
    ];
    let min = Infinity, max = -Infinity;
    for (const s of series) for (const val of s.values) { if (val < min) min = val; if (val > max) max = val; }
    const useLog = min > 0 && max / min > 4;
    const T = useLog ? Math.log : (x => x);
    let tMin = T(min), tMax = T(max);
    const pad = (tMax - tMin) * 0.06 || 1;
    tMin -= pad; tMax += pad;
    const yMin = useLog ? Math.exp(tMin) : tMin;
    const yMax = useLog ? Math.exp(tMax) : tMax;
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const n = lastResult.dates.length;
    const x = i => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = val => PAD.top + plotH - ((T(val) - tMin) / (tMax - tMin)) * plotH;

    drawGrid(ctx, w, h, yTicks(useLog, yMin, yMax), y, tv => fmt.equity(tv));

    ctx.fillStyle = v('--text-muted');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.round(n / 6));
    for (let i = 0; i < n; i += labelEvery) {
      if (x(i) > w - PAD.right - 30) break;
      const d = lastResult.dates[i];
      ctx.fillText(n < 130 ? d.slice(5) : d.slice(0, 7), x(i), h - PAD.bottom + 7);
    }

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < s.values.length; i++) {
        i === 0 ? ctx.moveTo(x(i), y(s.values[i])) : ctx.lineTo(x(i), y(s.values[i]));
      }
      ctx.stroke();
    }
  }

  function renderResult() {
    const r = lastResult;
    const best = [...r.agents].sort((a, b) => b.stats.finalValue - a.stats.finalValue)[0];
    $('replay-verdict').innerHTML =
      '<h3>You beat ' + r.beatCount + ' of ' + r.agents.length + ' strategy agents</h3>' +
      '<p><b>' + fmt.esc(r.symbol) + '</b>, ' + fmt.esc(r.startDate) + ' → ' + fmt.esc(r.endDate) +
      ' (' + r.days + ' trading days): you turned ' + fmt.money(r.startCash) + ' into <b>' + fmt.money(r.finalValue) +
      '</b> (' + fmt.pct(r.totalReturn) + ') with ' + r.trades + ' trade' + (r.trades === 1 ? '' : 's') +
      (r.winRate != null ? ' (' + Math.round(r.winRate * 100) + '% winners)' : '') +
      ' and ' + r.strategyChanges + ' strategy switch' + (r.strategyChanges === 1 ? '' : 'es') +
      '. Best agent: <b>' + fmt.esc(best.name) + '</b> at ' + fmt.money(best.stats.finalValue) + '.' +
      (r.endsInMarket ? ' You finished still holding a position, valued at the final close.' : '') + '</p>' +
      '<p class="hint">All fills at daily closes for you and the agents alike; no costs, slippage, or dividends. Skill takes many runs to separate from luck — try the same period with a different strategy.</p>';

    const rows = [
      { name: 'You', you: true, stats: { finalValue: r.finalValue, totalReturn: r.totalReturn, maxDrawdown: r.maxDrawdown, trades: r.trades, winRate: r.winRate } },
      ...r.agents.map((a, k) => ({ name: a.name, colorIdx: k, stats: a.stats })),
    ].sort((a, b) => b.stats.finalValue - a.stats.finalValue);

    $('replay-result-table').querySelector('tbody').innerHTML = rows.map((row, i) =>
      '<tr' + (row.you ? ' class="recommended"' : '') + '>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + (row.you ? '<b>You ★</b>'
        : '<span class="sim-swatch" style="background:' + SIM_COLOR(row.colorIdx) + ';margin-left:0"></span>' + fmt.esc(row.name)) + '</td>' +
      '<td><b>' + fmt.money(row.stats.finalValue) + '</b></td>' +
      '<td>' + fmt.pct(row.stats.totalReturn) + '</td>' +
      '<td>' + fmt.pct(-row.stats.maxDrawdown) + '</td>' +
      '<td>' + row.stats.trades + '</td>' +
      '<td>' + (row.stats.winRate != null ? Math.round(row.stats.winRate * 100) + '%' : '–') + '</td></tr>'
    ).join('');

    $('replay-result-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch" style="background:' + StockCharts.cssVar('--accent') + '"></span>You</span>' +
      lastResult.agents.map((a, k) =>
        '<span class="legend-item"><span class="legend-swatch" style="background:' + SIM_COLOR(k) + '"></span>' + fmt.esc(a.name) + '</span>'
      ).join('');

    drawResultChart();
  }

  // ---------- setup form wiring ----------
  function prefillDates() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    $('replay-date').value = d.toISOString().slice(0, 10);
  }

  function applyStartPreset(kind) {
    const main = Practice.getMainData();
    if (kind === 'random') {
      const bars = main && main.bars;
      if (bars && bars.length > WARMUP_BARS + MIN_PLAY_BARS + 30) {
        const lo = WARMUP_BARS;
        const hi = bars.length - 1 - Math.max(MIN_PLAY_BARS, Math.min(252, bars.length >> 2));
        const idx = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
        $('replay-date').value = bars[idx].date.slice(0, 10);
      } else {
        const years = 1 + Math.floor(Math.random() * 9);
        const d = new Date();
        d.setFullYear(d.getFullYear() - years);
        d.setMonth(Math.floor(Math.random() * 12));
        $('replay-date').value = d.toISOString().slice(0, 10);
      }
      return;
    }
    const years = { '1y': 1, '3y': 3, '5y': 5 }[kind] || 3;
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    $('replay-date').value = d.toISOString().slice(0, 10);
  }

  function init() {
    // Strategy selects (setup + live)
    const options = Strategies.catalog.map(s => '<option value="' + s.id + '">' + fmt.esc(s.name) + '</option>').join('');
    $('replay-strategy').innerHTML = options;
    $('replay-strategy-live').innerHTML = options;

    prefillDates();
    const cap = document.getElementById('capital-input');
    $('replay-cash').value = cap && parseFloat(cap.value) > 0 ? cap.value : '10000';

    document.querySelectorAll('#replay-presets [data-start]').forEach(btn =>
      btn.addEventListener('click', () => applyStartPreset(btn.dataset.start)));
    $('replay-begin').addEventListener('click', beginRun);
    $('replay-symbol').addEventListener('keydown', e => { if (e.key === 'Enter') beginRun(); });

    $('replay-next').addEventListener('click', () => stepDays(1));
    $('replay-skip').addEventListener('click', () => stepDays(5));
    $('replay-play').addEventListener('click', togglePlay);
    $('replay-finish').addEventListener('click', finishRun);
    $('replay-buy').addEventListener('click', () => applyTrade('buy', parseFloat($('replay-buy-amt').value)));
    $('replay-sell-half').addEventListener('click', () => applyTrade('sell-half', 0));
    $('replay-sell-all').addEventListener('click', () => applyTrade('sell-all', 0));
    document.querySelectorAll('#replay-buy-chips [data-frac]').forEach(btn =>
      btn.addEventListener('click', () => {
        $('replay-buy-amt').value = Math.floor(replay ? replay.cash * (+btn.dataset.frac) : 0);
      }));
    $('replay-strategy-live').addEventListener('change', e => setStrategy(e.target.value));
    $('replay-log').addEventListener('change', () => { drawReplayChart(); });
    document.querySelectorAll('#replay-range [data-rrange]').forEach(btn =>
      btn.addEventListener('click', () => { rangeKey = btn.dataset.rrange; renderRun(); }));

    $('replay-resume-go').addEventListener('click', resumeRun);
    $('replay-resume-discard').addEventListener('click', discardRun);
    $('replay-abandon').addEventListener('click', () => {
      if (confirm('Abandon this run? Its progress will be discarded.')) discardRun();
    });
    $('replay-save-json').addEventListener('click', saveRunToFile);
    $('replay-again').addEventListener('click', () => {
      lastResult = null;
      replay = null;
      renderReplay();
    });

    // Symbol prefill from the main app's loads — read directly in case the
    // load already finished (cached/stubbed data), then follow the event.
    const md = Practice.getMainData();
    if (md && md.symbol) $('replay-symbol').value = md.symbol;
    document.addEventListener('practice:maindata', e => {
      const sym = e.detail && e.detail.symbol;
      const inp = $('replay-symbol');
      if (sym && !inp.dataset.dirty) inp.value = sym;
    });
    $('replay-symbol').addEventListener('input', () => { $('replay-symbol').dataset.dirty = '1'; });

    // Redraw canvases when the pane becomes visible, on resize, on theme
    // flips — and PAUSE auto-play whenever the replay is not being watched:
    // days must never tick away invisibly.
    document.addEventListener('practice:tab', e => {
      if (e.detail.tab === 'replay') { drawReplayChart(); drawEquityStrip(); drawResultChart(); }
      else if (playTimer) { stopPlay(); renderRun(); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && playTimer) { stopPlay(); renderRun(); }
    });
    window.addEventListener('resize', () => { drawReplayChart(); drawEquityStrip(); drawResultChart(); });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        drawReplayChart(); drawEquityStrip(); drawResultChart();
      });
    }

    // The core finished restoring state (possibly from the save file).
    document.addEventListener('practice:ready', renderReplay);
    document.addEventListener('practice:reloaded', () => {
      stopPlay();
      replay = null;
      lastResult = null;
      renderReplay();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { renderReplay };
})();
