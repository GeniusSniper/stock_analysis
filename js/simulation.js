/* ============================================================
   Strategy race simulation.

   Every strategy in Strategies.catalog runs as an independent
   simulated agent: each starts with the same cash ($1,000) on the
   first bar of the loaded daily history and follows its rules
   mechanically — all-in when the rule says buy (fractional shares,
   filled at the NEXT day's opening price), fully to cash when it
   says sell. No commissions, slippage, taxes, or dividends.

   run(bars, ind) → {
     startCash, dates,
     agents: [{ id, name, type, equity[], trades[], stats }]
   }
   toJSON(sim, meta) / toCSV(sim) build the downloadable files.
   ============================================================ */
const Simulation = (() => {

  const START_CASH = 1000;
  const round2 = v => Math.round(v * 100) / 100;
  const round4 = v => Math.round(v * 10000) / 10000;

  /** Execution price for a fill: the bar's open, or its close when
      the feed has no usable open (very old index data). */
  function fillPrice(bar) {
    return bar.open != null && isFinite(bar.open) && bar.open > 0 ? bar.open : bar.close;
  }

  /**
   * One strategy agent over the bar window [startIdx..endIdx].
   * positions/ind always come from the FULL arrays, so the agent trades
   * on exactly the signals a viewer of the full chart would have seen —
   * no cold-start indicator warm-up inside the window.
   *
   * fill modes:
   * - 'next-open':  yesterday's signal decides today's exposure, filled
   *                 at today's open (the classic backtest convention).
   * - 'same-close': today's signal fills at today's close — matches the
   *                 replay trainer, where the user acts on the close.
   */
  function runAgentWindow(strategy, bars, ind, startIdx, endIdx, startCash, fill) {
    const positions = strategy.positions(bars, ind);
    const equity = new Array(endIdx - startIdx + 1);
    const trades = [];
    let cash = startCash, shares = 0;
    let entryValue = null;
    let roundTrips = 0, wins = 0;

    const trade = (bar, want, price) => {
      if (want && shares === 0 && cash > 0) {
        shares = cash / price;
        entryValue = cash;
        trades.push({ date: bar.date, side: 'BUY', price: round2(price), shares: round4(shares), value: round2(cash) });
        cash = 0;
      } else if (!want && shares > 0) {
        cash = shares * price;
        const profit = cash - entryValue;
        trades.push({
          date: bar.date, side: 'SELL', price: round2(price), shares: round4(shares),
          value: round2(cash), profit: round2(profit), profitPct: round4(profit / entryValue),
        });
        roundTrips++;
        if (profit > 0) wins++;
        shares = 0;
        entryValue = null;
      }
    };

    if (fill === 'same-close') {
      for (let i = startIdx; i <= endIdx; i++) {
        const bar = bars[i];
        trade(bar, positions[i] === 1, bar.close);
        equity[i - startIdx] = cash + shares * bar.close;
      }
    } else {
      equity[0] = startCash;
      for (let i = startIdx + 1; i <= endIdx; i++) {
        const bar = bars[i];
        trade(bar, positions[i - 1] === 1, fillPrice(bar));   // yesterday's signal decides today's exposure
        equity[i - startIdx] = cash + shares * bar.close;
      }
    }

    const finalValue = equity[equity.length - 1];

    // A still-open position counts toward the win rate at its market value,
    // matching the backtester's accounting.
    const endsInMarket = shares > 0;
    if (endsInMarket) {
      roundTrips++;
      if (finalValue > entryValue) wins++;
    }

    let peak = -Infinity, maxDD = 0;
    for (const v of equity) {
      if (v > peak) peak = v;
      const dd = 1 - v / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const ms = Date.parse(bars[endIdx].date.slice(0, 10)) - Date.parse(bars[startIdx].date.slice(0, 10));
    const years = ms / (365.25 * 24 * 3600 * 1000);
    // Annualizing a sub-year window produces silly numbers — skip it there.
    const cagr = years > 0.75 ? Math.pow(finalValue / startCash, 1 / years) - 1 : null;

    return {
      id: strategy.id,
      name: strategy.name,
      type: strategy.type,
      equity,
      trades,
      stats: {
        startingCash: startCash,
        finalValue: round2(finalValue),
        totalReturn: round4(finalValue / startCash - 1),
        cagr: cagr != null ? round4(cagr) : null,
        maxDrawdown: round4(maxDD),
        trades: roundTrips,
        winRate: roundTrips ? round4(wins / roundTrips) : null,
        endsInMarket,
        years: round2(years),
      },
    };
  }

  /**
   * Race every catalog strategy over a window of the series.
   * opts = { startIdx, endIdx, startCash, fill: 'next-open' | 'same-close' }.
   */
  function runWindow(bars, ind, opts = {}) {
    const startIdx = opts.startIdx ?? 0;
    const endIdx = opts.endIdx ?? bars.length - 1;
    const startCash = opts.startCash ?? START_CASH;
    const fill = opts.fill ?? 'next-open';
    return {
      startCash,
      dates: bars.slice(startIdx, endIdx + 1).map(b => b.date),
      agents: Strategies.catalog.map(s => runAgentWindow(s, bars, ind, startIdx, endIdx, startCash, fill)),
    };
  }

  function run(bars, ind, startCash = START_CASH) {
    return runWindow(bars, ind, { startCash });
  }

  /** Full results file: metadata, leaderboard, and every agent's trade log.
      The day-by-day equity curves ship separately as CSV (toCSV). */
  function toJSON(sim, meta) {
    const leaderboard = [...sim.agents]
      .sort((a, b) => b.stats.finalValue - a.stats.finalValue)
      .map((a, rank) => ({ rank: rank + 1, strategy: a.name, style: a.type, ...a.stats }));

    return JSON.stringify({
      title: 'Strategy race simulation — every agent starts with $' + sim.startCash.toLocaleString('en-US'),
      symbol: meta.symbol,
      dataSource: meta.source,
      generatedAt: meta.generatedAt,
      period: {
        from: sim.dates[0],
        to: sim.dates[sim.dates.length - 1],
        tradingDays: sim.dates.length,
      },
      startingCash: sim.startCash,
      assumptions: [
        'Long/flat only: each agent is either fully invested or fully in cash.',
        'Signals are computed on daily closes; trades are filled at the NEXT day\'s opening price.',
        'Fractional shares allowed; no commissions, slippage, taxes, or dividends.',
        'Educational simulation — past performance does not predict future results.',
      ],
      leaderboard,
      agents: sim.agents.map(a => ({
        id: a.id,
        strategy: a.name,
        style: a.type,
        stats: a.stats,
        tradeLog: a.trades,
      })),
    }, null, 2);
  }

  /** Day-by-day equity curves, one column per agent — spreadsheet-ready. */
  function toCSV(sim) {
    const header = ['date', ...sim.agents.map(a => '"' + a.name.replace(/"/g, '""') + '"')].join(',');
    const lines = [header];
    for (let i = 0; i < sim.dates.length; i++) {
      lines.push([sim.dates[i], ...sim.agents.map(a => round2(a.equity[i]))].join(','));
    }
    return lines.join('\n');
  }

  return { run, runWindow, toJSON, toCSV, START_CASH };
})();
