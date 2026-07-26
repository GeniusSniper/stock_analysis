/* ============================================================
   Strategy definitions, backtesting, and the recommender.

   Each strategy exposes:
   - positions(bars, ind): array of 0/1 per bar (1 = hold the stock,
     0 = sit in cash). Long/flat only — simple and easy to learn from.
   - fit(regime): { score 0–100, reason } — how suited the strategy
     is to the CURRENT market regime.
   - lesson: the educational content shown in the Learn modal.
   ============================================================ */
const Strategies = (() => {

  // ---------- helpers ----------

  /** Turn a per-bar boolean entry/exit rule pair into a 0/1 position series. */
  function statefulPositions(bars, enter, exit) {
    const pos = new Array(bars.length).fill(0);
    let inPos = false;
    for (let i = 0; i < bars.length; i++) {
      if (!inPos && enter(i)) inPos = true;
      else if (inPos && exit(i)) inPos = false;
      pos[i] = inPos ? 1 : 0;
    }
    return pos;
  }

  // ---------- strategy catalog ----------

  const catalog = [
    {
      id: 'sma-cross',
      name: 'Moving Average Crossover',
      type: 'Trend following',
      summary: 'Buy when the fast average (20-day) crosses above the slow one (50-day); sell when it crosses back below. The classic way to ride a trend.',
      positions(bars, ind) {
        return statefulPositions(bars,
          i => ind.sma20[i] != null && ind.sma50[i] != null && ind.sma20[i] > ind.sma50[i],
          i => ind.sma20[i] != null && ind.sma50[i] != null && ind.sma20[i] < ind.sma50[i]);
      },
      fit(r) {
        if (r.trending && r.direction > 0) return { score: 90, reason: 'the market is in a clear uptrend, exactly what crossover systems are built to ride' };
        if (r.trending && r.direction < 0) return { score: 70, reason: 'a clear downtrend — the crossover keeps you safely in cash until it turns' };
        if (r.trend.includes('mild')) return { score: 55, reason: 'the trend is mild, so crossovers work but give later, noisier signals' };
        return { score: 25, reason: 'the market is moving sideways, where crossovers get "whipsawed" — repeated false signals' };
      },
      lesson: {
        what: 'A trend-following strategy that compares a fast moving average (the last 20 days\' average price) with a slow one (50 days). When the fast average is above the slow one, recent prices are higher than older prices — the stock is trending up.',
        rules: [
          '<b>Buy</b> when SMA 20 crosses <b>above</b> SMA 50 (a "golden cross" on this timescale).',
          '<b>Sell</b> (go to cash) when SMA 20 crosses <b>below</b> SMA 50 (a "death cross").',
        ],
        formula: 'SMA(n) = (P₁ + P₂ + … + Pₙ) / n — the plain average of the last n closing prices.',
        strengths: [
          'Catches every big, sustained trend — you will never miss a huge move.',
          'Mechanically limits losses: a collapsing stock forces the averages to cross down and kicks you out.',
          'Simple, objective, and emotionless — no judgment calls.',
        ],
        weaknesses: [
          'Whipsaws in sideways markets: the averages cross back and forth, producing many small losing trades.',
          'Always late — you buy after the rise has started and sell after the top is in.',
          'A sharp overnight crash can move faster than any moving average.',
        ],
        bestFor: 'Markets with long, clean trends. Terrible in choppy, range-bound markets.',
        tip: 'Watch the SMA 20 (aqua) and SMA 50 (yellow) lines on the chart above — every place they cross is a trade this strategy would have made.',
      },
    },

    {
      id: 'rsi-reversion',
      name: 'RSI Mean Reversion',
      type: 'Mean reversion',
      summary: 'Buy when RSI says the stock is oversold (below 30), sell once it recovers. Bets that extreme dips bounce back.',
      positions(bars, ind) {
        return statefulPositions(bars,
          i => ind.rsi14[i] != null && ind.rsi14[i] < 30,
          i => ind.rsi14[i] != null && ind.rsi14[i] > 55);
      },
      fit(r) {
        if (!r.trending && r.volLabel !== 'low') return { score: 85, reason: 'a range-bound market with decent volatility — dips keep getting bought back, which is what this strategy harvests' };
        if (!r.trending) return { score: 65, reason: 'a sideways market suits mean reversion, though low volatility means fewer oversold extremes to buy' };
        if (r.direction < 0) return { score: 30, reason: 'a downtrend is dangerous for dip-buying — "oversold" can keep getting more oversold' };
        return { score: 45, reason: 'a strong uptrend rarely gets oversold, so this strategy mostly sits in cash and misses the ride' };
      },
      lesson: {
        what: 'A mean-reversion strategy built on the Relative Strength Index (RSI), a 0–100 gauge of how one-sided recent price movement has been. Below 30 means selling has been extreme ("oversold"); above 70 means buying has been extreme ("overbought"). Mean reversion bets that extremes snap back toward normal.',
        rules: [
          '<b>Buy</b> when RSI(14) drops <b>below 30</b> — panic selling is likely overdone.',
          '<b>Sell</b> when RSI(14) recovers <b>above 55</b> — the bounce has played out, take the profit.',
        ],
        formula: 'RSI = 100 − 100 / (1 + RS), where RS = average gain ÷ average loss over the last 14 days.',
        strengths: [
          'Buys fear and sells relief — the emotionally hardest, often most profitable trade.',
          'High win rate in sideways markets: most oversold dips do bounce.',
          'Spends little time in the market, reducing exposure to crashes.',
        ],
        weaknesses: [
          '"Catching a falling knife": in a real downtrend, RSI can pin below 30 while the stock keeps falling.',
          'Misses long uptrends entirely — a steadily rising stock rarely gets oversold.',
          'Needs discipline: the buy signal fires exactly when the news feels worst.',
        ],
        bestFor: 'Choppy, range-bound markets and quality stocks that recover from dips. Avoid in confirmed downtrends.',
        tip: 'Look at the RSI panel above — the shaded zone marks 30–70. Every dip below the lower line is a moment this strategy would buy.',
      },
    },

    {
      id: 'macd-momentum',
      name: 'MACD Momentum',
      type: 'Momentum',
      summary: 'Buy when the MACD line crosses above its signal line while momentum is positive; sell on the cross down. A faster, more sensitive trend tool.',
      positions(bars, ind) {
        const { line, signal } = ind.macd;
        return statefulPositions(bars,
          i => line[i] != null && signal[i] != null && line[i] > signal[i] && line[i] > 0,
          i => line[i] != null && signal[i] != null && line[i] < signal[i]);
      },
      fit(r) {
        if (r.trending && r.direction > 0) return { score: 80, reason: 'positive momentum is confirmed by the uptrend — MACD signals are reliable here' };
        if (r.trend.includes('mild')) return { score: 60, reason: 'momentum is modest; MACD will trade, but expect some false starts' };
        if (r.trending && r.direction < 0) return { score: 40, reason: 'momentum is negative — this strategy stays defensive and waits for a turn' };
        return { score: 35, reason: 'sideways markets make MACD cross back and forth, generating noise trades' };
      },
      lesson: {
        what: 'MACD (Moving Average Convergence Divergence) measures momentum — whether price movement is accelerating or decelerating. It is the gap between a fast EMA (12-day) and a slow EMA (26-day). A 9-day EMA of that gap (the "signal line") smooths it; crossings between the two mark momentum shifts.',
        rules: [
          '<b>Buy</b> when the MACD line crosses <b>above</b> the signal line <i>and</i> MACD is above zero (momentum is positive, not just "less negative").',
          '<b>Sell</b> when the MACD line crosses <b>below</b> the signal line.',
        ],
        formula: 'MACD = EMA(12) − EMA(26); Signal = EMA(9) of MACD; Histogram = MACD − Signal. EMAs weight recent prices more than old ones.',
        strengths: [
          'Reacts faster than simple moving-average crossovers, catching turns earlier.',
          'The zero-line filter (only buy when MACD > 0) screens out many false signals.',
          'The histogram gives an early warning: shrinking bars mean momentum is fading before the cross happens.',
        ],
        weaknesses: [
          'More sensitive means more false signals in choppy markets.',
          'Like all lagging indicators, it is built from past prices — it confirms momentum, it does not predict it.',
          'Parameters (12/26/9) are conventions, not laws — they suit some stocks better than others.',
        ],
        bestFor: 'Swing trading in markets that make sustained multi-week moves. Pairs well with a trend filter.',
        tip: 'On the MACD panel above, the bars (histogram) show the gap between the two lines — watch how the bars shrink before each crossover.',
      },
    },

    {
      id: 'bollinger-reversion',
      name: 'Bollinger Band Reversion',
      type: 'Mean reversion',
      summary: 'Buy when price closes below the lower Bollinger band (statistically stretched), sell when it returns to the middle. Trades the rubber-band snap-back.',
      positions(bars, ind) {
        return statefulPositions(bars,
          i => ind.bb.lower[i] != null && bars[i].close < ind.bb.lower[i],
          i => ind.bb.middle[i] != null && bars[i].close > ind.bb.middle[i]);
      },
      fit(r) {
        if (!r.trending && r.volLabel === 'high') return { score: 80, reason: 'a volatile range — price keeps stretching to the bands and snapping back' };
        if (!r.trending) return { score: 70, reason: 'a sideways market where the band boundaries act like rails' };
        if (r.direction < 0) return { score: 25, reason: 'in a downtrend price can "walk the lower band" — repeatedly closing below it while falling' };
        return { score: 40, reason: 'in an uptrend price hugs the upper band, so lower-band buys are rare' };
      },
      lesson: {
        what: 'Bollinger Bands draw a statistical envelope around price: a 20-day average (middle band) plus and minus two standard deviations. Roughly 95% of closes should fall inside the bands — so a close outside them is a statistically unusual stretch, and this strategy bets it snaps back.',
        rules: [
          '<b>Buy</b> when the close drops <b>below the lower band</b> — price is stretched ~2 standard deviations cheap.',
          '<b>Sell</b> when the close rises back <b>above the middle band</b> (the 20-day average) — the snap-back is done.',
        ],
        formula: 'Middle = SMA(20); Upper = SMA(20) + 2σ; Lower = SMA(20) − 2σ, where σ is the 20-day standard deviation of closes.',
        strengths: [
          'Self-adjusting: the bands widen in volatile markets and tighten in calm ones, so "stretched" is always relative.',
          'Clear, pre-defined exit at the middle band.',
          'Works on any stock without tuning — the statistics adapt.',
        ],
        weaknesses: [
          'The 95% logic assumes prices behave statistically "normally" — in crashes they do not, and price can ride the lower band down for weeks.',
          'Profits per trade are modest (lower band to middle band), so costs matter.',
          'A band "squeeze" (very tight bands) often precedes a breakout — the exact opposite of reversion.',
        ],
        bestFor: 'Range-bound markets and patient traders comfortable buying red days. Avoid during strong trends.',
        tip: 'Turn on the Bollinger toggle above the chart — the violet envelope shows the bands. Notice how price touches the bands far more often in choppy stretches.',
      },
    },

    {
      id: 'momentum-roc',
      name: 'Time-Series Momentum',
      type: 'Momentum',
      summary: 'Own the stock only while its 3-month return is positive and price is above the 50-day average. "Buy strength, avoid weakness."',
      positions(bars, ind) {
        return statefulPositions(bars,
          i => ind.roc63[i] != null && ind.sma50[i] != null && ind.roc63[i] > 0.02 && bars[i].close > ind.sma50[i],
          i => (ind.roc63[i] != null && ind.roc63[i] < 0) || (ind.sma50[i] != null && bars[i].close < ind.sma50[i] * 0.97));
      },
      fit(r) {
        if (r.trending && r.direction > 0) return { score: 85, reason: 'strong positive momentum — the exact condition this strategy is designed to exploit' };
        if (r.trend.includes('mild') && r.direction > 0) return { score: 60, reason: 'momentum is positive but modest, so the edge is smaller' };
        if (r.direction < 0) return { score: 55, reason: 'momentum is negative — the strategy correctly keeps you in cash, which is itself valuable' };
        return { score: 35, reason: 'no meaningful momentum either way, so entries and exits will churn' };
      },
      lesson: {
        what: 'One of the most researched effects in finance: stocks that have gone up over the last 3–12 months tend, on average, to keep going up over the next weeks. This strategy simply owns the stock while its medium-term momentum is positive and steps aside when it is not.',
        rules: [
          '<b>Buy</b> when the 3-month (63 trading-day) return is above +2% <i>and</i> price is above its 50-day average.',
          '<b>Sell</b> when the 3-month return turns negative, <i>or</i> price falls 3% below the 50-day average.',
        ],
        formula: 'ROC(63) = Price today ÷ Price 63 days ago − 1. Positive means the last quarter was an up quarter.',
        strengths: [
          'Backed by decades of academic evidence across nearly every market and era.',
          'Automatic crash protection: extended declines turn momentum negative and move you to cash.',
          'Very few trades — low costs, low maintenance, easy to follow.',
        ],
        weaknesses: [
          '"Momentum crashes": at sharp V-shaped bottoms you are in cash and re-enter late, missing the fastest part of the rebound.',
          'Slow by design — it lags at every turning point.',
          'Long flat stretches in cash test your patience while the market bounces around.',
        ],
        bestFor: 'Longer-horizon investors who want upside participation with a systematic exit plan. The least "twitchy" active strategy here.',
        tip: 'Compare the stat tiles: if the trend regime tile says "uptrend" and price is above the yellow SMA 50 line, this strategy is long right now.',
      },
    },

    {
      id: 'buy-hold',
      name: 'Buy & Hold',
      type: 'Passive',
      summary: 'Buy on day one, never sell. The benchmark every active strategy has to beat — and often the hardest one to beat.',
      positions(bars) {
        return new Array(bars.length).fill(1);
      },
      fit(r) {
        if (r.trending && r.direction > 0) return { score: 75, reason: 'in an uptrend, doing nothing captures the whole move with zero effort or cost' };
        if (r.direction < 0) return { score: 35, reason: 'a downtrend means riding losses — buy & hold asks you to stomach the full drawdown' };
        return { score: 55, reason: 'a sideways market: no gains but no whipsaw costs either' };
      },
      lesson: {
        what: 'The simplest strategy: buy and never sell. It sounds too naive to be a "strategy," but it is the benchmark professionals are measured against — and most active traders fail to beat it after costs and taxes.',
        rules: [
          '<b>Buy</b> on the first day.',
          '<b>Hold</b> through everything — dips, crashes, recoveries.',
        ],
        formula: 'Return = Final price ÷ First price − 1. That\'s all.',
        strengths: [
          'Zero trading costs, minimal taxes, zero time spent.',
          'Never misses the best days — a handful of huge up-days drive most long-run returns, and market-timers routinely miss them.',
          'Impossible to whipsaw; immune to false signals by definition.',
        ],
        weaknesses: [
          'Takes the full force of every crash — 30–50% drawdowns are part of the deal.',
          'Psychologically brutal: doing nothing while your position halves is harder than it sounds.',
          'Works on diversified indexes far more reliably than on a single stock, which can go to zero.',
        ],
        bestFor: 'Long horizons and diversified holdings. The default that any active strategy must justify itself against.',
        tip: 'Check the strategy table: the "Buy & hold" column shows what doing nothing earned. Any active strategy that returned less on this data added complexity without adding value.',
      },
    },
  ];

  /* ----------------------------------------------------------
     Short-term / intraday trading lessons.
     These are educational only — they operate on minutes-to-hours
     horizons, so they are not backtested on the daily series like
     the catalog above. Use the app's Hourly / 1D / 5D ranges to
     study them on real intraday bars.
     ---------------------------------------------------------- */
  const shortTermCatalog = [
    {
      id: 'day-trading-survival',
      name: 'Day-Trading Survival Rules',
      type: 'Foundations — read first',
      summary: 'Before any short-term strategy: the risk, cost, and psychology rules that decide whether you survive long enough to get good.',
      lesson: {
        what: 'Short-term trading is a different sport from investing: you trade often, costs compound, and emotions get amplified. Most day traders lose money — the survivors are the ones who treat risk management, not prediction, as the actual job. This lesson is the foundation everything else sits on.',
        rules: [
          '<b>Risk ≤ 1%</b> of your account on any single trade — position size from your stop distance, never from conviction.',
          '<b>Daily loss limit ~3%</b>: hit it and you are done for the day, no exceptions. Three losing trades in a row also means stop and review.',
          '<b>Plan before entry</b>: entry, stop, and target written down before you click. If you can\'t state where you\'re wrong, you have no trade.',
          '<b>Journal every trade</b> (screenshot, reason, outcome, emotion). Your journal — not your P&amp;L — is where the learning lives.',
          '<b>Paper trade first</b> for at least 2–3 months, then start with the smallest real size your broker allows.',
          'US accounts under $25,000 are limited by the <b>pattern day trader (PDT) rule</b> to 3 day-trades per 5 business days — plan around it.',
        ],
        formula: 'Position size = (account × 1%) ÷ (entry − stop). Expectancy = win% × avg win − loss% × avg loss — positive expectancy after costs is the only thing that matters.',
        strengths: [
          'Following these rules keeps your "tuition" — the losses every beginner pays — small enough to survive.',
          'A journal turns random trades into data: after 100 logged trades you know whether you actually have an edge.',
          'Hard limits remove the catastrophic days (revenge trading, averaging down) that end most trading careers.',
        ],
        weaknesses: [
          'The uncomfortable statistics: the large majority of day traders lose money after costs; profitability usually takes years, not weeks.',
          'Commissions, spreads, slippage, and short-term capital-gains taxes eat thin edges alive.',
          'It is a screen-time job with lumpy income — not passive, not quick, not easy.',
        ],
        bestFor: 'Anyone even considering short-term trading. Read this before the strategy lessons — the strategies only work inside this risk framework.',
        tip: 'Use the Hourly / 1D / 5D ranges and click through bars one by one as if replaying the day: "would I have entered here? where was my stop?" — then write it down. That is journaling, free of charge.',
      },
    },
    {
      id: 'orb',
      name: 'Opening Range Breakout',
      type: 'Day trading',
      summary: 'Mark the first hour\'s high and low, then trade the breakout in that direction with a stop inside the range. Classic structure for day traders.',
      lesson: {
        what: 'The first 15–60 minutes of a session concentrate the day\'s biggest volume and set an "opening range" — the market\'s initial auction. A clean break above or below that range often means institutions are committed in that direction, and the move continues into the day. The opening range gives a day trade rare gifts: a defined entry, a defined stop, and a defined invalidation.',
        rules: [
          '<b>Mark the range:</b> the high and low of the first 30–60 minutes of the session.',
          '<b>Buy</b> a decisive break above the range high (or short below the range low) — ideally on above-average volume.',
          '<b>Stop:</b> the opposite side (or the midpoint) of the opening range — if price falls back inside, the breakout failed.',
          '<b>Target:</b> 2× your risk (2R), or scale out along the way; <b>always flat by the close</b> — no overnight risk.',
        ],
        formula: 'Opening range = High(first hour) − Low(first hour). Entry = range high + a small buffer; Stop = range low; Target ≈ entry + 2 × (entry − stop).',
        strengths: [
          'Everything is defined before you enter — risk, invalidation, and target. Discipline is built into the structure.',
          'Trades the most liquid, most volatile part of the day, when moves actually follow through.',
          'Easy to journal and measure: every ORB trade looks the same, so your stats become meaningful quickly.',
        ],
        weaknesses: [
          'False breakouts are common — choppy or news-less days break the range and immediately reverse ("look above and fail").',
          'Needs live screen time at the open, fast execution, and per-trade costs eat into the typical 1–2R outcomes.',
          'Range size varies wildly: a huge opening range makes the stop too far for a 1% risk budget — skip those days.',
        ],
        bestFor: 'Liquid large-caps and index ETFs on days with real catalysts (earnings, economic data). Skip quiet, rangeless days.',
        tip: 'Switch to the 1D range (hourly bars): the first bar of the session approximates the opening range. Flip through several days and count how often a break of the first bar\'s high actually carried through the day — that hit rate is the strategy\'s reality check.',
      },
    },
    {
      id: 'vwap',
      name: 'VWAP Trading',
      type: 'Intraday',
      summary: 'VWAP is the volume-weighted average price — the institutions\' benchmark. Trade pullbacks to it on trend days, and fades back toward it on range days.',
      lesson: {
        what: 'VWAP (volume-weighted average price) is the average price actually paid for the stock today, weighting each trade by its size. Institutions benchmark their fills against it, algorithms pivot around it — which makes it the single most-watched intraday reference line. Price above VWAP = buyers in control today; far above it = stretched and likely to snap back; returning to it = the spot where big players often defend.',
        rules: [
          '<b>Trend day:</b> when price holds above a rising VWAP, buy the pullbacks that touch or slightly pierce VWAP, stop just below it.',
          '<b>Range day:</b> when price keeps crossing a flat VWAP, fade the stretches — short/sell 1–2% above it, buy 1–2% below it, targeting a return to VWAP.',
          '<b>Exit:</b> trend trades ride until price closes below VWAP; fade trades exit at VWAP. Flat by the close.',
        ],
        formula: 'VWAP = Σ(price × volume) ÷ Σ(volume), accumulated from the session open. It resets every day.',
        strengths: [
          'Anchored to real institutional behavior, not an arbitrary average — the self-fulfilling reference of the intraday world.',
          'Gives an objective definition of "expensive" and "cheap" <i>for today</i>, plus a natural stop location.',
          'Adapts automatically to volume: heavy-volume prices pull VWAP toward them.',
        ],
        weaknesses: [
          'Says nothing about direction on its own — fading a strong trend day because price is "far from VWAP" is a classic account-burner.',
          'First 30 minutes of VWAP is noisy (little volume accumulated); late-day VWAP barely moves.',
          'Everyone watches it, so obvious VWAP touches get front-run in liquid names.',
        ],
        bestFor: 'Liquid stocks and ETFs from mid-morning onward, once you\'ve identified whether today is a trend day or a range day.',
        tip: 'On the Hourly range, approximate the day\'s VWAP by weighting each bar\'s close by its volume (the data table shows both). Notice how often afternoon dips toward that level found buyers.',
      },
    },
    {
      id: 'momentum-scalp',
      name: 'Momentum Scalping',
      type: 'Scalping',
      summary: 'Many small, fast trades riding minutes-long bursts of volume and news. High skill ceiling, brutal costs — know what you\'re signing up for.',
      lesson: {
        what: 'Scalping is trading\'s shortest game: dozens of positions a day, held for seconds to minutes, each aiming for a fraction of a percent. Scalpers hunt "in-play" stocks — names with news, earnings, or unusual volume where the crowd\'s attention creates fast, repeated moves. The edge, when it exists, comes from speed, tape-reading, and ruthless risk control, not prediction.',
        rules: [
          'Trade <b>only in-play symbols</b>: relative volume well above normal (2×+), a real catalyst, and tight spreads.',
          '<b>Enter on continuation</b>, not on the first spike: let the burst pull back, enter as it resumes, stop below the pullback low (~0.3–0.5%).',
          '<b>Take profits fast</b> — 1R to 2R, or scale out into strength. Winners are not allowed to become losers.',
          '<b>Hard daily loss limit</b> and a three-strikes rule; when the morning momentum dies (~11:00), stop trading.',
        ],
        formula: 'Expectancy per trade is tiny, so: Net edge = gross edge − spread − commissions − slippage. If that\'s not clearly positive, the strategy is a donation machine.',
        strengths: [
          'Dozens of occurrences a day — a real statistical edge compounds quickly and your stats converge fast.',
          'Tiny per-trade risk and zero overnight exposure.',
          'Skills transfer: tape reading, execution speed, and emotional control sharpen every other style of trading.',
        ],
        weaknesses: [
          'Costs dominate: at scalping frequency, spreads and slippage are a constant headwind most scalpers never overcome.',
          'Requires elite focus, fast tooling, and real-time data — and it is emotionally the most exhausting style there is.',
          'The PDT rule effectively locks small US accounts out of true scalping frequency.',
        ],
        bestFor: 'Experienced, well-capitalized traders with fast execution who have already proven discipline on slower timeframes. Explicitly not a starting point.',
        tip: 'Look at the volume column in the Hourly data table: bursts of 2–3× the neighboring bars mark the "in-play" hours where scalpers operate — and notice how quickly those bursts fade.',
      },
    },
  ];

  // ---------- backtesting ----------

  /**
   * Long/flat backtest of a 0/1 position series.
   * Position changes take effect at the next bar's close-to-close return
   * (you can't trade on a signal before it exists).
   */
  function backtest(bars, positions) {
    let equity = 1;
    const curve = [1];
    let trades = 0, wins = 0, entryEquity = null;
    let peak = 1, maxDD = 0;

    for (let i = 1; i < bars.length; i++) {
      const held = positions[i - 1] === 1;          // yesterday's signal decides today's exposure
      const ret = bars[i].close / bars[i - 1].close - 1;
      if (held) equity *= 1 + ret;
      curve.push(equity);

      const entering = positions[i] === 1 && positions[i - 1] !== 1;
      const exiting = positions[i] !== 1 && positions[i - 1] === 1;
      if (entering) entryEquity = equity;
      if (exiting && entryEquity != null) {
        trades++;
        if (equity > entryEquity) wins++;
        entryEquity = null;
      }

      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, 1 - equity / peak);
    }
    // Close out an open position for win-rate accounting.
    if (entryEquity != null) {
      trades++;
      if (equity > entryEquity) wins++;
    }

    return {
      totalReturn: equity - 1,
      winRate: trades ? wins / trades : null,
      maxDrawdown: maxDD,
      trades,
      curve,
    };
  }

  /** Human-readable current signal from the tail of a position series. */
  function currentSignal(positions) {
    const n = positions.length;
    const now = positions[n - 1], prev = positions[n - 2] ?? 0;
    if (now === 1 && prev === 0) return { label: 'Buy', cls: 'buy', icon: '▲' };
    if (now === 0 && prev === 1) return { label: 'Sell', cls: 'sell', icon: '▼' };
    if (now === 1) return { label: 'Hold long', cls: 'hold', icon: '●' };
    return { label: 'Stay in cash', cls: 'hold', icon: '○' };
  }

  // ---------- recommendation ----------

  /**
   * Run every strategy, score it, and pick a recommendation.
   * Overall score = 60% regime fit + 40% relative backtest performance.
   */
  function analyze(bars, ind) {
    const regime = Indicators.detectRegime(bars, ind);
    const buyHoldReturn = bars[bars.length - 1].close / bars[0].close - 1;

    const results = catalog.map(s => {
      const positions = s.positions(bars, ind);
      const bt = backtest(bars, positions);
      const fit = s.fit(regime);
      return { strategy: s, positions, bt, fit, signal: currentSignal(positions) };
    });

    // Normalize backtest returns to 0–100 within this run.
    const rets = results.map(r => r.bt.totalReturn);
    const min = Math.min(...rets), max = Math.max(...rets);
    for (const r of results) {
      const perf = max === min ? 50 : ((r.bt.totalReturn - min) / (max - min)) * 100;
      r.score = 0.6 * r.fit.score + 0.4 * perf;
    }

    const ranked = [...results].sort((a, b) => b.score - a.score);
    return { regime, buyHoldReturn, results, recommended: ranked[0], runnerUp: ranked[1] };
  }

  /**
   * Buy / don't-buy verdict plus position sizing.
   *
   * Stance: 'wait' (0% allocation) when the best-fit strategy itself is
   * out of the market, the regime is a confirmed downtrend, or the market
   * is heavily overbought. Otherwise 'invest' with a size derived from
   * two classic rules, taking the SMALLER:
   * - risk rule: risk max 1% of capital with a 2×ATR protective stop;
   * - volatility rule: cap the position so its volatility contribution
   *   stays near a 10% annualized target;
   * and never more than 25% of capital in one position.
   */
  function positionPlan(bars, ind, analysisObj, capital) {
    const i = bars.length - 1;
    const price = bars[i].close;
    const regime = analysisObj.regime;
    const rec = analysisObj.recommended;
    const sig = rec.signal.label;

    const reasons = [];
    if (sig === 'Stay in cash' || sig === 'Sell') {
      reasons.push('the best-fit strategy (' + rec.strategy.name + ') currently says "' + sig + '" — its rules see no entry here');
    }
    if (regime.trending && regime.direction < 0) {
      reasons.push('the market regime is a confirmed downtrend — buying against it has historically poor odds');
    }
    if (regime.rsi != null && regime.rsi > 75) {
      reasons.push('RSI is ' + regime.rsi.toFixed(0) + ' — heavily overbought; chasing an extended move is a weak entry');
    }
    const stance = reasons.length ? 'wait' : 'invest';

    const atrNow = ind.atr14 && ind.atr14[i] != null ? ind.atr14[i] : price * 0.02;
    const stopDist = 2 * atrNow;
    const stopPct = stopDist / price;
    const riskPct = Math.min(0.25, 0.01 / stopPct);
    const volPct = Math.min(1, 0.10 / (regime.vol || 0.2));
    const suggestedPct = Math.min(riskPct, volPct, 0.25);
    const dollars = capital * suggestedPct;

    return {
      stance, reasons, price,
      atr: atrNow, stopDist, stopPct,
      riskPct, volPct, suggestedPct,
      dollars,
      shares: price > 0 ? Math.floor(dollars / price) : 0,
    };
  }

  return { catalog, shortTermCatalog, analyze, backtest, positionPlan };
})();
