# Stock Analysis & Strategy Lab

A vanilla HTML/CSS/JS app that loads live stock price data, analyzes it
with technical indicators, recommends a trading strategy for the current
market regime — and teaches you how each strategy works.

## Run it

No build step, no dependencies. Just open `index.html` in a browser
(double-click it, or use VS Code's Live Server). It loads live AAPL data
on open — an internet connection is required.

## Features

- **Data sources (all live)** —
  - **Yahoo Finance (free, no key)**: search any stock, ETF, or index by
    name and load its daily history plus real hourly intraday bars. A
    fast ~10-year window loads first, then the entire available history
    (e.g. AAPL back to 1980, `^GSPC` back to 1927) backfills in the
    background. Yahoo's API sends no CORS headers, so browser requests
    ride through a chain of public CORS proxies; loads retry once
    automatically and a Retry button appears if the feed stays busy.
  - **Alpha Vantage** (live) with a
    [free API key](https://www.alphavantage.co/support/#api-key).
- **TradingView integration** —
  - **TradingView analysis panel**: for each loaded symbol the app queries
    TradingView's scanner API (the one behind their screener) and shows
    TradingView's own technical ratings (Strong Buy → Strong Sell, on
    daily/weekly/monthly timeframes, split into moving-average and
    oscillator votes) plus their computed indicator values (RSI, MACD,
    ADX, Stochastic, ATR, SMA 20/50/200, 52-week range, performance).
    A "What to do next" card combines TradingView's rating with this
    app's own regime/backtest recommendation into concrete next steps:
    whether the engines agree, the price level to watch, an ATR-based
    stop-sizing plan, and range/performance context. US-listed stocks
    and major indices.
  - **Browse all symbols**: a directory of every US-listed ticker on
    TradingView (~20,000), sorted by market size, with live prices and
    server-side filtering by ticker or company name — click any row to
    load it, no typing needed. Friendly index names (`SP500`, `DOW`,
    `NASDAQ`, `VIX`…) are normalized to real tickers automatically.
  - **TradingView chart widget**: the official Advanced Chart embed for
    the same symbol — their live chart and full toolkit.
  - Historical OHLC series for the app's charts/backtests come from the
    sources above (TradingView exposes no public history API).
- **Analysis** — SMA 20/50/200, EMA, RSI(14), MACD(12,26,9), Bollinger
  Bands(20,2), rate of change, annualized volatility, and a market-regime
  classifier (trend direction + volatility level).
- **Charts** — canvas price chart (line or candlesticks) with indicator
  overlays, RSI and MACD subcharts, a data-table view, optional log scale,
  and automatic light/dark theming. Time-range presets (1D · 5D · Hourly ·
  1M · 6M · 1Y · 3Y · 5Y · All) window all charts in sync; 1D/5D/Hourly
  switch to hourly bars (real intraday data, simulated inside each daily
  bar only as a fallback when no live intraday feed is available). Charts
  are static — click any point to select
  it across all charts and open a details card with that bar's OHLC,
  change, volume, and indicator values (close with ✕ or Escape).
- **Strategy recommendation** — six strategies (moving-average crossover,
  RSI mean reversion, MACD momentum, Bollinger reversion, time-series
  momentum, buy & hold) are each backtested on the loaded history
  (long/flat, next-bar execution) and scored 60% by fit to the current
  regime + 40% by relative backtest performance. The winner is explained
  in plain English with its current buy/sell/hold signal.
- **Buy verdict & position sizing** — the recommendation card asks how
  much you have to invest and gives an explicit verdict, including
  **"don't buy right now — 0% allocation"** when the best-fit strategy is
  out of the market, the regime is a confirmed downtrend, or the market
  is heavily overbought (plus what would change the verdict). When a
  position is defensible, it recommends how much of your capital to put
  in: the smallest of a 1%-risk / 2×ATR-stop rule, a 10%
  portfolio-volatility target, and a 25% single-position cap — shown as
  % of capital, dollars, and share count, recalculated live as you edit
  the amount.
- **Auto-trader (on `simulation.html`)** — a robot that lives through the
  market on its own, under strict rules:
  - **Born five years in the past with $1,000** of virtual money. It
    **gathers the entire stock listing**: a merit-mix seed first (largest
    + strongest 3-month movers + best-rated technicals + most traded),
    then it studies stock after stock from the whole screener — each
    history fetched, vetted, and **remembered forever**, so its pool
    grows run after run toward every listed stock (histories load one at
    a time through the proxy chain, so "all" is a journey, not one
    click). Each session it actively trades the most promising ~60
    (holdings always included; the size dropdown focuses what it studies
    next). It lives forward **one market day at a time** and **can never
    look ahead**: every decision uses only prices up to its simulated
    day, all indicators are trailing, fills happen at that day's close,
    and it may only act on its strategies' signals — never on known
    outcomes.
  - **It carries a monthly goal** (default **$2,000/month**, editable):
    every simulated month is scored against it. A missed month makes it
    trade **hungrier** the next — lower entry bar, bigger positions,
    thinner cash reserve, more option budget (hard caps still apply) — a
    met month calms it down. Its summary does the honest math: at its
    real pace it tells you how much *capital* earning $2,000 every month
    would actually take, because no strategy honestly turns $1,000 into
    $2,000 a month.
  - **Progression**: short-term trading only (RSI/Bollinger mean
    reversion, fast MACD momentum — max 2 positions, sold the moment
    their signal turns) until the account reaches **10× its start**
    ($1,000 → $10,000), which **unlocks long-term holding** (slow trend
    strategies, up to 3 more positions). A 20% cash reserve always.
  - **It tries different strategies and learns from its investments**:
    before any buy it *auditions* the signaling strategy on that stock's
    own trailing year (did it actually beat just holding?), and
    per-strategy weights follow its own win rates (Laplace-smoothed,
    0.60–1.40) — strategies that win for it get picked more; the
    learning table shows exactly what it has concluded so far.
  - **It trades calls and puts too** — a capped options sleeve (up to two
    1-month at-the-money contracts, ≤10% of equity in premium): calls to
    ride strong buy signals it has no stock slot for, puts to profit from
    fresh downtrends. No historical option quotes exist, so it prices
    them honestly itself with **Black-Scholes** fed only by each day's
    close and trailing 20-day realized volatility — the no-lookahead rule
    holds. A full **Options: Calls & Puts lesson** joins the short-term
    curriculum.
  - **It reads the news — but only at the present day**: once caught up,
    it fetches real headlines for each holding (Yahoo Finance, via the
    same proxy chain) and scores them with plain word-counting sentiment
    — positive-news holdings get practice-mirror top-ups first, negative
    ones get none. During the rewind news is banned: reading today's
    stories about the past would be looking up answers.
  - **It remembers**: cash, positions, journal, learned weights, and the
    day it reached persist — stop anytime, reopen later, the same life
    continues; when it catches up to the present it mirrors its holdings
    into the practice portfolio and waits for the next market day.
  - Everything is narrated (a research diary with every buy/sell and
    why), summarized in plain language (what it's doing, amounts
    invested, returns, timeframes), drawn as an equity curve with the
    start and unlock milestones, and saved on demand — plus, once you
    **link the project's `data/` folder**, it auto-writes
    `auto_trader_life.json`, `journal.csv`, and `equity_curve.csv` there
    at every checkpoint. Virtual money, education only.
- **Strategy race simulator — its own page (`simulation.html`)** — every
  strategy runs as an independent simulated agent: each starts with
  **$1,000** on the first day of a stock's history and follows its rules
  mechanically (all-in on buy with fractional shares, filled at the next
  day's open; fully to cash on sell; no costs or dividends). The page
  loads **all ~20,000 US-listed stocks** inline (biggest first, live
  prices, server-side filtering) — click any of them, or type a ticker,
  and the race runs on its full history (fast ~10-year window first,
  complete history backfilled). An equity-curve chart races all six
  agents from the same $1,000 line (click any point to compare them on a
  date), a leaderboard shows final value, total return, growth per year,
  max drawdown, trades, and win rate, and two buttons save the data to
  files: a **JSON** results file (leaderboard, per-agent stats, full
  trade logs) and a **CSV** of every agent's day-by-day portfolio value.
  Every stock you race lands in a **session comparison table** so races
  across different stocks line up side by side. Linked from the main
  page's header.
- **Practice investing (auto-saves to a file)** — a two-tab practice
  section with virtual money, no real dollars:
  - **Live portfolio**: build a multi-stock paper portfolio at today's
    real prices (add stocks by ticker, live search, or the Browse-all
    directory). Every stock has its **own strategy, changeable at any
    time** from a dropdown in its row, and shows that strategy's live
    signal (Buy / Sell / Hold long / Stay in cash). Shared cash,
    dollar-amount trades with fractional shares, average-cost P&L,
    day and total P&L tiles, one-request quote refresh for the whole
    table, and a full trade history.
  - **Replay trainer**: travel back to any date on any stock and trade
    forward one day at a time — the future is hidden. A strategy advisor
    (switchable mid-run) states its signal and rule each day, with a
    one-click "Do what the strategy says" button. Step, skip, or press
    Play; finish anytime to see whether you **beat the six automated
    strategy agents** run over the exact same window with the same
    fill rules — verdict, leaderboard, overlay chart, and a
    save-run-to-JSON button.
  - **Persistence**: progress auto-saves in the browser and reloads
    when you open the app; on Chromium browsers you can also **link a
    save file** once and the app silently auto-writes every change to
    it (one-click reconnect on reopen). Export / Load buttons move the
    practice file anywhere. An unfinished replay run resumes exactly
    where you left it.
- **Short-term trading curriculum** — a second Learn group covers
  intraday/day trading: Day-Trading Survival Rules (risk, costs, PDT
  rule, journaling — read first), Opening Range Breakout, VWAP Trading,
  and Momentum Scalping, each with full rules/strengths/weaknesses and
  tips for studying them on the app's Hourly / 1D / 5D ranges.
- **Learn mode** — every strategy has a full lesson: what it is, the exact
  rules, the math, strengths, weaknesses, when to use it, and a live note
  showing how it performed on the data you just loaded.

## Project structure

| File | Purpose |
|---|---|
| `index.html` | Main page: controls, stat tiles, charts, recommendation, practice, learn |
| `simulation.html` | Strategy race simulator page: all-stocks directory + the $1,000 agent race |
| `js/sim-page.js` | Simulator-page wiring: directory, staged loading, race chart, session compare |
| `js/auto-research.js` | Auto-trader: 5-year no-lookahead life simulation, learning, memory, data/ export |
| `data/` | The auto-trader's output files (life report, trade journal, equity curve) once linked |
| `css/styles.css` | Theme tokens (light + dark) and all styling |
| `js/indicators.js` | Indicator math (SMA, EMA, RSI, MACD, Bollinger, volatility, regime detection) |
| `js/data.js` | Yahoo Finance + Alpha Vantage fetchers, symbol search, hourly fallback |
| `js/strategies.js` | Strategy rules, lessons, backtester, and the recommender |
| `js/simulation.js` | Strategy race: one $1,000 agent per strategy + JSON/CSV file export |
| `js/practice.js` | Practice core: paper-trading account, save-file/localStorage persistence, signal cache |
| `js/practice-ui.js` | Practice section shell (tabs) + the live multi-stock portfolio pane |
| `js/replay.js` | Replay trainer: day-by-day time-travel trading vs the strategy agents |
| `js/chart.js` | Reusable canvas chart with crosshair + tooltip |
| `js/app.js` | Wiring: load → analyze → render |

> Educational project — not financial advice.
