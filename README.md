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
| `index.html` | Page layout: controls, stat tiles, charts, recommendation, learn section |
| `css/styles.css` | Theme tokens (light + dark) and all styling |
| `js/indicators.js` | Indicator math (SMA, EMA, RSI, MACD, Bollinger, volatility, regime detection) |
| `js/data.js` | Yahoo Finance + Alpha Vantage fetchers, symbol search, hourly fallback |
| `js/strategies.js` | Strategy rules, lessons, backtester, and the recommender |
| `js/chart.js` | Reusable canvas chart with crosshair + tooltip |
| `js/app.js` | Wiring: load → analyze → render |

> Educational project — not financial advice.
