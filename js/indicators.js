/* ============================================================
   Technical indicators.
   Every function takes arrays and returns an array the same
   length as the input, padded with null where the indicator
   is not yet defined (warm-up period).
   ============================================================ */
const Indicators = (() => {

  /** Simple moving average of `values` over `period`. */
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /** Exponential moving average, seeded with the SMA of the first `period` values. */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    seed /= period;
    out[period - 1] = seed;
    for (let i = period; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }

  /** Wilder's RSI. Values in 0–100; >70 overbought, <30 oversold. */
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /** MACD line, signal line, and histogram. */
  function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const line = closes.map((_, i) =>
      emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);

    // Signal = EMA of the MACD line over the non-null region.
    const firstIdx = line.findIndex(v => v != null);
    const signal = new Array(closes.length).fill(null);
    if (firstIdx !== -1 && closes.length - firstIdx >= signalPeriod) {
      const seg = ema(line.slice(firstIdx), signalPeriod);
      for (let i = 0; i < seg.length; i++) signal[firstIdx + i] = seg[i];
    }
    const histogram = line.map((v, i) =>
      v != null && signal[i] != null ? v - signal[i] : null);
    return { line, signal, histogram };
  }

  /** Bollinger bands: middle SMA ± mult · rolling stdev. */
  function bollinger(closes, period = 20, mult = 2) {
    const middle = sma(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let variance = 0;
      for (let j = i - period + 1; j <= i; j++) {
        variance += (closes[j] - middle[i]) ** 2;
      }
      const sd = Math.sqrt(variance / period);
      upper[i] = middle[i] + mult * sd;
      lower[i] = middle[i] - mult * sd;
    }
    return { middle, upper, lower };
  }

  /** Daily log returns (index 0 is null). */
  function returns(closes) {
    const out = new Array(closes.length).fill(null);
    for (let i = 1; i < closes.length; i++) out[i] = Math.log(closes[i] / closes[i - 1]);
    return out;
  }

  /** Annualized volatility from the last `window` daily returns. */
  function annualizedVol(closes, window = 20) {
    const r = returns(closes).filter(v => v != null).slice(-window);
    if (r.length < 2) return null;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  /** Average True Range (Wilder) — the symbol's typical daily price travel. */
  function atr(bars, period = 14) {
    const out = new Array(bars.length).fill(null);
    if (bars.length <= period) return out;
    const tr = i => Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close));
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr(i);
    out[period] = sum / period;
    for (let i = period + 1; i < bars.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + tr(i)) / period;
    }
    return out;
  }

  /** Rate of change over `period` bars, as a fraction. */
  function roc(closes, period = 63) {
    const out = new Array(closes.length).fill(null);
    for (let i = period; i < closes.length; i++) {
      out[i] = closes[i] / closes[i - period] - 1;
    }
    return out;
  }

  /**
   * Compute the full indicator set for a series of bars
   * ({date, open, high, low, close, volume}).
   */
  function computeAll(bars) {
    const closes = bars.map(b => b.close);
    return {
      closes,
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      sma200: sma(closes, 200),
      rsi14: rsi(closes, 14),
      macd: macd(closes),
      bb: bollinger(closes),
      roc63: roc(closes, 63),
      vol20: annualizedVol(closes, 20),
      atr14: atr(bars, 14),
    };
  }

  /**
   * Classify the current market regime from the indicators —
   * this is what strategy "fit" scores are judged against.
   */
  function detectRegime(bars, ind) {
    const i = bars.length - 1;
    const close = ind.closes[i];
    const sma20 = ind.sma20[i], sma50 = ind.sma50[i];
    const vol = ind.vol20 ?? 0.2;

    // Trend strength: SMA20 vs SMA50 separation, in % of price.
    let trendPct = 0;
    if (sma20 != null && sma50 != null) trendPct = (sma20 - sma50) / sma50 * 100;

    let trend = 'sideways';
    if (trendPct > 1.5) trend = 'strong uptrend';
    else if (trendPct > 0.4) trend = 'mild uptrend';
    else if (trendPct < -1.5) trend = 'strong downtrend';
    else if (trendPct < -0.4) trend = 'mild downtrend';

    let volLabel = 'moderate';
    if (vol < 0.15) volLabel = 'low';
    else if (vol > 0.35) volLabel = 'high';

    return {
      trend,
      trending: Math.abs(trendPct) > 1.5,
      direction: Math.sign(trendPct),
      trendPct,
      vol,
      volLabel,
      rsi: ind.rsi14[i],
      aboveSma50: sma50 != null && close > sma50,
    };
  }

  return { sma, ema, rsi, macd, bollinger, returns, annualizedVol, roc, atr, computeAll, detectRegime };
})();
