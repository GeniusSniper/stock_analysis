/* ============================================================
   Data layer — live sources only.
   - Yahoo Finance (free, no key): full daily history, real
     hourly intraday, and symbol search.
   - Alpha Vantage (free API key): daily + hourly.
   All loaders return bars sorted oldest → newest:
   { date: 'YYYY-MM-DD[ HH:MM]', open, high, low, close, volume }
   ============================================================ */
const DataSource = (() => {

  /* Friendly index names → canonical tickers, so "SP500" works everywhere
     (Yahoo history wants ^GSPC; the TradingView maps translate from there). */
  const SYMBOL_ALIASES = {
    'SP500': '^GSPC', 'S&P500': '^GSPC', 'SPX': '^GSPC', 'GSPC': '^GSPC', '^SPX': '^GSPC',
    'DOW': '^DJI', 'DOWJONES': '^DJI', 'DJI': '^DJI', 'DJIA': '^DJI',
    'NASDAQ': '^IXIC', 'IXIC': '^IXIC', 'NASDAQ100': '^NDX', 'NDX': '^NDX',
    'RUSSELL2000': '^RUT', 'RUT': '^RUT', 'VIX': '^VIX',
  };

  function normalizeSymbol(input) {
    const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
    return SYMBOL_ALIASES[s] || s;
  }

  /** Deterministic PRNG (used only for the hourly-fallback synthesis). */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSymbol(sym) {
    let h = 2166136261;
    for (const ch of String(sym)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ----------------------------------------------------------
     Hourly fallback: if a live intraday feed is unavailable,
     synthesize an intraday path inside each real daily bar
     (open → close with noise, kept within the day's high/low).
     ---------------------------------------------------------- */
  const HOURS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
  // Trading volume is U-shaped over the session: heavy open/close, quiet lunch.
  const HOUR_VOL_WEIGHT = [1.6, 1.0, 0.7, 0.6, 0.7, 1.0, 1.4];

  function synthesizeHourly(dailyBars, days = 10) {
    const recent = dailyBars.slice(-days);
    const rand = mulberry32(hashSymbol(recent[0].date + recent[0].close));
    const out = [];
    for (const day of recent) {
      const closes = [];
      for (let h = 0; h < HOURS.length; h++) {
        const f = (h + 1) / HOURS.length;
        let v = day.open + (day.close - day.open) * f
          + (rand() - 0.5) * (day.high - day.low) * 0.5;
        if (h === HOURS.length - 1) v = day.close;
        closes.push(Math.min(day.high, Math.max(day.low, v)));
      }
      let prevClose = day.open;
      for (let h = 0; h < HOURS.length; h++) {
        const open = prevClose, close = closes[h];
        out.push({
          date: day.date + ' ' + HOURS[h],
          open: +open.toFixed(2),
          high: +(Math.min(day.high, Math.max(open, close) * (1 + rand() * 0.002))).toFixed(2),
          low: +(Math.max(day.low, Math.min(open, close) * (1 - rand() * 0.002))).toFixed(2),
          close: +close.toFixed(2),
          volume: Math.round(day.volume / HOURS.length * HOUR_VOL_WEIGHT[h]),
        });
        prevClose = close;
      }
    }
    return out;
  }

  /* ----------------------------------------------------------
     Yahoo Finance (free, no key).
     Yahoo's API has no reliable CORS headers, so requests fall
     back through public CORS proxies when the direct call is
     blocked.
     ---------------------------------------------------------- */
  async function fetchJsonWithProxies(url) {
    const attempts = [
      { u: url },
      { u: 'https://corsproxy.io/?url=' + encodeURIComponent(url) },
      { u: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url) },
      // allorigins /get wraps the payload as JSON-in-a-string; it is often
      // up when /raw returns 5xx.
      { u: 'https://api.allorigins.win/get?url=' + encodeURIComponent(url), wrapped: true },
      { u: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url) },
      { u: 'https://api.cors.lol/?url=' + encodeURIComponent(url) },
    ];
    let lastErr;
    for (const a of attempts) {
      // Per-attempt timeout: a dead proxy must not stall the whole chain
      // for its ~30s connect timeout before the next one gets a shot.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(a.u, { signal: ctl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        return a.wrapped ? JSON.parse(json.contents) : json;
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('Could not reach the live data feed (network or CORS proxies blocked). '
      + 'Try again in a moment. [' + (lastErr && lastErr.message || 'unknown') + ']');
  }

  function parseYahooChart(json, intraday) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r) {
      const err = json && json.chart && json.chart.error;
      throw new Error(err && err.description || 'The feed returned no data for this symbol.');
    }
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open && q.open[i], h = q.high && q.high[i];
      const l = q.low && q.low[i], c = q.close && q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      const d = new Date(ts[i] * 1000).toISOString();
      bars.push({
        date: intraday ? d.slice(0, 10) + ' ' + d.slice(11, 16) : d.slice(0, 10),
        open: +o.toFixed(4),
        high: +h.toFixed(4),
        low: +l.toFixed(4),
        close: +c.toFixed(4),
        volume: (q.volume && q.volume[i]) || 0,
      });
    }
    if (!bars.length) throw new Error('The feed returned an empty series for this symbol.');
    return bars;
  }

  /** Last ~10 years of daily bars — a small, fast payload that survives
      flaky CORS proxies far better than the full history does. */
  async function fetchYahooDaily(symbol) {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
      + encodeURIComponent(symbol) + '?range=10y&interval=1d';
    return parseYahooChart(await fetchJsonWithProxies(url), false);
  }

  /** Entire available daily history (can be megabytes for old indices).
      Uses period1/period2 — "range=max&interval=1d" gets silently
      downgraded to quarterly bars. */
  async function fetchYahooDailyFull(symbol) {
    const now = Math.floor(Date.now() / 1000) + 86400;
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
      + encodeURIComponent(symbol) + '?period1=0&period2=' + now + '&interval=1d';
    return parseYahooChart(await fetchJsonWithProxies(url), false);
  }

  /** Real hourly bars for the last month. */
  async function fetchYahooHourly(symbol) {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
      + encodeURIComponent(symbol) + '?range=1mo&interval=60m';
    return parseYahooChart(await fetchJsonWithProxies(url), true).slice(-160);
  }

  /** Search any stock/ETF/index by name or ticker. Returns [{symbol, name, exch, type}]. */
  async function searchSymbols(query) {
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?quotesCount=8&newsCount=0&q='
      + encodeURIComponent(query);
    const json = await fetchJsonWithProxies(url);
    return (json.quotes || [])
      .filter(q => q.symbol)
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exch: q.exchDisp || q.exchange || '',
        type: q.typeDisp || q.quoteType || '',
      }));
  }

  /* ----------------------------------------------------------
     TradingView scanner — the API behind their stock screener.
     Returns TradingView's own computed indicators AND their
     Buy/Sell technical rating for a symbol. CORS-friendly, but
     ONLY as a "simple request": the preflight allowlist excludes
     Content-Type, so the POST must not set a JSON content type.
     ---------------------------------------------------------- */
  const TV_COLUMNS = [
    'name', 'description', 'close', 'change', 'volume',
    'RSI', 'MACD.macd', 'MACD.signal', 'SMA20', 'SMA50', 'SMA200',
    'ADX', 'Stoch.K', 'ATR',
    'Recommend.All', 'Recommend.MA', 'Recommend.Other',
    'Recommend.All|1W', 'Recommend.All|1M',
    'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y',
    'price_52_week_high', 'price_52_week_low', 'market_cap_basic',
  ];

  /** Exchange-qualified ticker candidates for TradingView. */
  function tvCandidates(symbol) {
    const s = String(symbol).toUpperCase();
    const indexMap = {
      '^GSPC': 'SP:SPX', '^SPX': 'SP:SPX', '^DJI': 'DJ:DJI',
      '^IXIC': 'NASDAQ:IXIC', '^NDX': 'NASDAQ:NDX', '^RUT': 'TVC:RUT', '^VIX': 'TVC:VIX',
    };
    if (indexMap[s]) return [indexMap[s]];
    if (s.includes(':')) return [s];
    const base = s.replace(/^\^/, '');
    return ['NASDAQ:' + base, 'NYSE:' + base, 'AMEX:' + base, 'OTC:' + base];
  }

  /** POST to the scanner with a hard timeout so a hung connection can't
      stall the page. No Content-Type header on purpose — see note above. */
  async function scannerPost(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      return await fetch('https://scanner.tradingview.com/america/scan',
        { method: 'POST', body, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** TradingView's live analysis for one symbol → { ticker, <column>: value }. */
  async function fetchTradingViewAnalysis(symbol) {
    const body = JSON.stringify({
      symbols: { tickers: tvCandidates(symbol), query: { types: [] } },
      columns: TV_COLUMNS,
    });
    const res = await scannerPost(body);
    if (!res.ok) throw new Error('TradingView scanner: HTTP ' + res.status);
    const json = await res.json();
    const row = json.data && json.data[0];
    if (!row) throw new Error('TradingView has no analysis for "' + symbol + '" (US-listed stocks and major indices only).');
    const out = { ticker: row.s };
    TV_COLUMNS.forEach((c, i) => { out[c] = row.d[i]; });
    return out;
  }

  /**
   * Browse TradingView's full US symbol directory (~20k tickers),
   * sorted by market size. `query` filters by ticker or company name
   * server-side. Returns { total, rows: [{ticker, symbol, name, close, change, cap}] }.
   */
  async function browseSymbols(query, offset = 0, limit = 50) {
    const body = {
      columns: ['name', 'description', 'close', 'change', 'market_cap_basic'],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [offset, offset + limit],
    };
    if (query) body.filter = [{ left: 'name,description', operation: 'match', right: query }];
    const res = await scannerPost(JSON.stringify(body));
    if (!res.ok) throw new Error('TradingView scanner: HTTP ' + res.status);
    const json = await res.json();
    return {
      total: json.totalCount || 0,
      rows: (json.data || []).map(r => ({
        ticker: r.s,
        symbol: r.d[0],
        name: r.d[1],
        close: r.d[2],
        change: r.d[3],
        cap: r.d[4],
      })),
    };
  }

  /**
   * General screener over TradingView's whole US universe — ONE request
   * returns any columns for any filter/sort/range. Rows are keyed BY
   * COLUMN NAME (plus ticker), not positionally, because callers ask for
   * many columns. Filter ops: greater/egreater/less/eless/equal/nequal/
   * in_range/match/nempty.
   */
  async function screenStocks({ filters = [], columns = [], sortBy, sortOrder = 'desc', offset = 0, limit = 50 } = {}) {
    const body = {
      columns,
      range: [offset, offset + limit],
    };
    if (filters.length) body.filter = filters;
    if (sortBy) body.sort = { sortBy, sortOrder };
    const res = await scannerPost(JSON.stringify(body));
    if (!res.ok) throw new Error('TradingView scanner: HTTP ' + res.status);
    const json = await res.json();
    return {
      total: json.totalCount || 0,
      rows: (json.data || []).map(r => {
        const out = { ticker: r.s };
        columns.forEach((c, i) => { out[c] = r.d[i]; });
        return out;
      }),
    };
  }

  /**
   * Live quotes for MANY symbols in one scanner request.
   * `tickers` are exchange-qualified ("NASDAQ:AAPL") — resolve them once
   * with resolveTicker()/browseSymbols() and store the result; the scanner
   * silently drops tickers it doesn't know, so a missing key in the
   * returned map means "no quote", not an error.
   * Returns { [ticker]: { ticker, symbol, name, close, change } }.
   */
  async function fetchQuotes(tickers) {
    if (!tickers || !tickers.length) return {};
    const body = JSON.stringify({
      symbols: { tickers, query: { types: [] } },
      columns: ['name', 'description', 'close', 'change'],
    });
    const res = await scannerPost(body);
    if (!res.ok) throw new Error('TradingView scanner: HTTP ' + res.status);
    const json = await res.json();
    const out = {};
    for (const r of json.data || []) {
      out[r.s] = { ticker: r.s, symbol: r.d[0], name: r.d[1], close: r.d[2], change: r.d[3] };
    }
    return out;
  }

  /**
   * Resolve a plain symbol ("AAPL", "^GSPC") to its exchange-qualified
   * TradingView ticker. Returns { ticker, symbol, name, close, change }
   * or null when TradingView doesn't know the symbol (never throws on
   * "not found" — only on network/HTTP failures).
   */
  async function resolveTicker(symbol) {
    const body = JSON.stringify({
      symbols: { tickers: tvCandidates(symbol), query: { types: [] } },
      columns: ['name', 'description', 'close', 'change'],
    });
    const res = await scannerPost(body);
    if (!res.ok) throw new Error('TradingView scanner: HTTP ' + res.status);
    const json = await res.json();
    const r = json.data && json.data[0];
    if (!r) return null;
    return { ticker: r.s, symbol: r.d[0], name: r.d[1], close: r.d[2], change: r.d[3] };
  }

  /* ----------------------------------------------------------
     Alpha Vantage (free tier: 25 requests/day).
     ---------------------------------------------------------- */
  async function fetchAlphaVantage(symbol, apiKey) {
    const url = 'https://www.alphavantage.co/query'
      + '?function=TIME_SERIES_DAILY'
      + '&symbol=' + encodeURIComponent(symbol)
      + '&outputsize=full'
      + '&apikey=' + encodeURIComponent(apiKey);

    const res = await fetch(url);
    if (!res.ok) throw new Error('Network error: HTTP ' + res.status);
    const json = await res.json();

    if (json['Error Message']) throw new Error('Unknown symbol "' + symbol + '".');
    if (json['Note'] || json['Information']) {
      throw new Error('API limit reached or key issue: ' + (json['Note'] || json['Information']));
    }
    const series = json['Time Series (Daily)'];
    if (!series) throw new Error('Unexpected API response — check your API key.');

    return Object.entries(series)
      .map(([date, v]) => ({
        date,
        open: parseFloat(v['1. open']),
        high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
        volume: parseInt(v['5. volume'], 10),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Real 60-minute bars from Alpha Vantage. */
  async function fetchAlphaVantageHourly(symbol, apiKey) {
    const url = 'https://www.alphavantage.co/query'
      + '?function=TIME_SERIES_INTRADAY&interval=60min&outputsize=full'
      + '&symbol=' + encodeURIComponent(symbol)
      + '&apikey=' + encodeURIComponent(apiKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Network error: HTTP ' + res.status);
    const json = await res.json();
    const series = json['Time Series (60min)'];
    if (!series) throw new Error(json['Note'] || json['Information'] || json['Error Message'] || 'No intraday data.');
    return Object.entries(series)
      .map(([ts, v]) => ({
        date: ts.slice(0, 16),   // "YYYY-MM-DD HH:MM"
        open: parseFloat(v['1. open']),
        high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
        volume: parseInt(v['5. volume'], 10),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-140);
  }

  /* ---------------------------------------------------------- */

  /** Hourly bars for the current dataset. Returns { bars, simulated }. */
  async function loadHourly(source, symbol, apiKey, dailyBars) {
    if (source === 'yahoo' || source === 'tradingview') {
      try {
        return { bars: await fetchYahooHourly(symbol), simulated: false };
      } catch (e) { /* fall through to synthesis */ }
    }
    if (source === 'alphavantage') {
      try {
        return { bars: await fetchAlphaVantageHourly(symbol, apiKey), simulated: false };
      } catch (e) { /* fall through to synthesis */ }
    }
    return { bars: synthesizeHourly(dailyBars), simulated: true };
  }

  async function load(source, symbol, apiKey) {
    if (source === 'alphavantage') {
      if (!apiKey) throw new Error('Enter an Alpha Vantage API key (free at alphavantage.co), or switch to the TradingView/Yahoo source.');
      return fetchAlphaVantage(symbol, apiKey);
    }
    // 'tradingview' and 'yahoo' both use the Yahoo series for OHLC history —
    // TradingView exposes ratings/indicators (scanner) but no history API.
    return fetchYahooDaily(symbol);
  }

  /** Full available history for background backfill after the fast 10y load.
      Returns null when the source already delivered everything. */
  async function loadFullHistory(source, symbol) {
    if (source === 'alphavantage') return null;   // outputsize=full is already complete
    return fetchYahooDailyFull(symbol);
  }

  return { load, loadFullHistory, loadHourly, searchSymbols, fetchTradingViewAnalysis, browseSymbols, screenStocks, normalizeSymbol, fetchQuotes, resolveTicker };
})();
