/* ============================================================
   Canvas time-series charts.

   Charts are static — no hover effects, no drag zoom. The time
   window is driven by the range preset buttons (via setView /
   resetView), and CLICKING a point selects that bar on every
   chart at once and reports it through the onSelect handler so
   the app can show its details.

   createChart(canvas) returns { update(state) } where state = {
     bars,                     // [{date, open, high, low, close}]
     candles: false,           // candlesticks instead of a close line
     series: [{ name, color, values }],         // overlay lines
     bands:  [{ name, color, upper, lower }],   // filled envelopes
     histogram: { values, posColor, negColor },
     guides: [{ y, label }],   // horizontal reference lines
     guideBand: { from, to },  // shaded horizontal zone
     yDomain: [min, max] | null,
     logScale: false,
     format: v => string,
   }
   ============================================================ */
const StockCharts = (() => {

  const PAD = { left: 56, right: 14, top: 12, bottom: 24 };
  const MIN_ZOOM_BARS = 5;

  let view = null;         // { start, end } bar indices shared by all charts
  let selected = null;     // clicked bar index, shared so all charts mark the same bar
  let selectHandler = null;
  const registry = [];     // every created chart, for synced re-renders

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      surface: cssVar('--surface-1'),
      grid: cssVar('--gridline'),
      baseline: cssVar('--baseline'),
      muted: cssVar('--text-muted'),
      ink: cssVar('--text-primary'),
      accent: cssVar('--accent'),
      up: cssVar('--status-good'),
      down: cssVar('--status-critical'),
    };
  }

  /** Clean, rounded axis tick values. */
  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const candidates = [1, 2, 2.5, 5, 10];
    const step = mag * candidates.find(c => c * mag >= step0);
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + 1e-9; v += step) ticks.push(+v.toPrecision(12));
    return ticks;
  }

  function rerenderAll() {
    for (const c of registry) c.rerender();
  }

  function setView(start, end, nAll) {
    start = Math.max(0, start);
    end = Math.min(nAll - 1, end);
    if (end - start < MIN_ZOOM_BARS) return;
    view = { start, end };
    rerenderAll();
  }

  function resetView() {
    view = null;
    rerenderAll();
  }

  function onSelect(fn) { selectHandler = fn; }

  function setSelection(idx) {
    selected = idx;
    rerenderAll();
  }

  function createChart(canvas) {
    let state = null;
    canvas.style.cursor = 'pointer';

    // Capture the intended CSS height ONCE. Setting canvas.height for
    // hi-DPI rendering overwrites the height attribute, so reading the
    // attribute again on later renders would return the inflated value
    // and the chart would grow by the device-pixel-ratio every redraw.
    const cssH = +canvas.getAttribute('height');
    canvas.style.height = cssH + 'px';

    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w: cssW, h: cssH };
    }

    /** Visible [first, last] bar indices under the shared view. */
    function visibleRange() {
      const nAll = state.bars.length;
      if (!view) return [0, nAll - 1];
      return [
        Math.max(0, Math.min(view.start, nAll - 1 - MIN_ZOOM_BARS)),
        Math.min(nAll - 1, Math.max(view.end, MIN_ZOOM_BARS)),
      ];
    }

    /** Raw (unpadded) [min, max] of everything visible. */
    function computeDomain(i0, i1) {
      if (state.yDomain) return state.yDomain;
      let min = Infinity, max = -Infinity;
      const push = v => { if (v != null && isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } };
      for (let i = i0; i <= i1; i++) {
        if (state.candles) { push(state.bars[i].low); push(state.bars[i].high); }
        (state.series || []).forEach(s => push(s.values[i]));
        (state.bands || []).forEach(b => { push(b.upper[i]); push(b.lower[i]); });
        if (state.histogram) push(state.histogram.values[i]);
      }
      if (!isFinite(min)) { min = 0; max = 1; }
      return [min, max];
    }

    function render() {
      if (!state || !state.bars.length) return;
      const t = theme();
      const { ctx, w, h } = layout();
      const [i0, i1] = visibleRange();
      const count = i1 - i0;
      const [rawMin, rawMax] = computeDomain(i0, i1);

      // Log scale (price charts spanning decades): map values through
      // ln() so equal percentage moves get equal height. Only valid
      // for all-positive domains without a zero-anchored histogram.
      // Padding happens in transformed space so it can't push a
      // positive minimum below zero and silently disable the log path.
      const useLog = state.logScale && rawMin > 0 && !state.histogram;
      const T = useLog ? Math.log : (v => v);
      let tMin = T(rawMin), tMax = T(rawMax);
      if (!state.yDomain) {
        const p = (tMax - tMin) * 0.06 || 1;
        tMin -= p; tMax += p;
      }
      const yMin = useLog ? Math.exp(tMin) : tMin;   // displayed raw bounds
      const yMax = useLog ? Math.exp(tMax) : tMax;

      const plotW = w - PAD.left - PAD.right;
      const plotH = h - PAD.top - PAD.bottom;
      const x = i => PAD.left + (count === 0 ? plotW / 2 : ((i - i0) / count) * plotW);
      const y = v => PAD.top + plotH - ((T(v) - tMin) / (tMax - tMin)) * plotH;

      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px system-ui, sans-serif';

      // Shaded horizontal zone (e.g. RSI 30–70), behind everything.
      if (state.guideBand) {
        ctx.fillStyle = t.grid;
        ctx.globalAlpha = 0.35;
        const y1 = y(state.guideBand.to), y2 = y(state.guideBand.from);
        ctx.fillRect(PAD.left, y1, plotW, y2 - y1);
        ctx.globalAlpha = 1;
      }

      // Hairline gridlines + y tick labels. On a log scale use
      // 1–2–5 steps per decade instead of evenly spaced values.
      let ticks;
      if (useLog) {
        ticks = [];
        for (let p = Math.floor(Math.log10(yMin)); p <= Math.ceil(Math.log10(yMax)); p++) {
          for (const m of [1, 2, 5]) {
            const v = m * Math.pow(10, p);
            if (v >= yMin && v <= yMax) ticks.push(v);
          }
        }
        while (ticks.length > 7) ticks = ticks.filter((_, k) => k % 2 === 0);
        // Narrow domains (e.g. one intraday session) contain no 1–2–5
        // steps — fall back to evenly spaced values so the axis never
        // goes blank.
        if (ticks.length < 2) ticks = niceTicks(yMin, yMax, 4).filter(v => v >= yMin && v <= yMax);
      } else {
        ticks = niceTicks(yMin, yMax, 4);
      }
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of ticks) {
        const py = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.left, py);
        ctx.lineTo(w - PAD.right, py);
        ctx.stroke();
        ctx.fillText(state.format(v), PAD.left - 8, py);
      }

      // Horizontal guide lines with labels (RSI 30/70, MACD zero).
      for (const g of state.guides || []) {
        const py = Math.round(y(g.y)) + 0.5;
        ctx.strokeStyle = t.baseline;
        ctx.beginPath();
        ctx.moveTo(PAD.left, py);
        ctx.lineTo(w - PAD.right, py);
        ctx.stroke();
        if (g.label) {
          ctx.fillStyle = t.muted;
          ctx.textAlign = 'left';
          ctx.fillText(g.label, w - PAD.right - 22, py - 7);
          ctx.textAlign = 'right';
        }
      }

      // X date labels — about 6, evenly spaced across the visible range.
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelEvery = Math.max(1, Math.round((count + 1) / 6));
      for (let i = i0; i <= i1; i += labelEvery) {
        if (x(i) > w - PAD.right - 30) break;
        const dstr = state.bars[i].date;
        const label = dstr.length > 10
          ? (count < 10 ? dstr.slice(11) : dstr.slice(5))      // hourly: "14:00" / "07-03 14:00"
          : count < 130 ? dstr.slice(5)
          : count < 2600 ? dstr.slice(0, 7)
          : dstr.slice(0, 4);
        ctx.fillText(label, x(i), h - PAD.bottom + 7);
      }

      // Bands (Bollinger): 10% wash + soft edge lines.
      for (const b of state.bands || []) {
        ctx.beginPath();
        let started = false;
        for (let i = i0; i <= i1; i++) {
          if (b.upper[i] == null) continue;
          const px = x(i), py = y(b.upper[i]);
          started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          started = true;
        }
        for (let i = i1; i >= i0; i--) {
          if (b.lower[i] == null) continue;
          ctx.lineTo(x(i), y(b.lower[i]));
        }
        ctx.closePath();
        ctx.fillStyle = b.color;
        ctx.globalAlpha = 0.10;
        ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        for (const edge of [b.upper, b.lower]) {
          ctx.beginPath();
          let on = false;
          for (let i = i0; i <= i1; i++) {
            if (edge[i] == null) { on = false; continue; }
            const px = x(i), py = y(edge[i]);
            on ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
            on = true;
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Histogram (MACD): diverging bars around zero with a 2px gap.
      if (state.histogram) {
        const zero = y(0);
        const slot = plotW / (count + 1);
        const bw = Math.max(1, Math.min(24, slot - 2));
        for (let i = i0; i <= i1; i++) {
          const v = state.histogram.values[i];
          if (v == null) continue;
          ctx.fillStyle = v >= 0 ? state.histogram.posColor : state.histogram.negColor;
          const py = y(v);
          ctx.fillRect(x(i) - bw / 2, Math.min(py, zero), bw, Math.max(1, Math.abs(py - zero)));
        }
      }

      // Candles: status green/red, 1px wick, body with a gap between neighbors.
      if (state.candles) {
        const slot = plotW / (count + 1);
        const bw = Math.max(1, Math.min(14, slot - 2));
        for (let i = i0; i <= i1; i++) {
          const b = state.bars[i];
          const up = b.close >= b.open;
          const color = up ? t.up : t.down;
          const px = x(i);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, y(b.high));
          ctx.lineTo(px, y(b.low));
          ctx.stroke();
          ctx.fillStyle = color;
          const top = y(Math.max(b.open, b.close));
          const bot = y(Math.min(b.open, b.close));
          ctx.fillRect(px - bw / 2, top, bw, Math.max(1, bot - top));
        }
      }

      // Overlay line series — 2px, round joins.
      for (const s of state.series || []) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        let on = false;
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i];
          if (v == null) { on = false; continue; }
          const px = x(i), py = y(v);
          on ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          on = true;
        }
        ctx.stroke();
      }

      // Clicked point: just a ringed dot on the point + a tag stating
      // its value. No lines across the chart — a click must never look
      // like the view zoomed or changed.
      if (selected != null && selected >= i0 && selected <= i1 && state.point) {
        const { value, label } = state.point(selected);
        const px = x(selected);

        let py = PAD.top + 12;
        if (value != null && isFinite(value)) {
          py = y(value);
          ctx.beginPath();
          ctx.arc(px, py, 6.5, 0, Math.PI * 2);
          ctx.fillStyle = t.surface;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fillStyle = t.accent;
          ctx.fill();
        }

        // Label box beside the point, flipped/clamped to stay on the chart.
        ctx.font = '11.5px system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const bw2 = tw + 16, bh = 22;
        let bx = px + 10;
        if (bx + bw2 > w - PAD.right) bx = px - bw2 - 10;
        let by = Math.max(PAD.top + 2, Math.min(py - bh - 8, h - PAD.bottom - bh - 2));
        ctx.fillStyle = t.surface;
        ctx.strokeStyle = t.baseline;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw2, bh, 5);
        else ctx.rect(bx, by, bw2, bh);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = t.ink;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + 8, by + bh / 2 + 0.5);
        ctx.font = '11px system-ui, sans-serif';
      }

      // End-dot with a surface ring on the primary series (line mode).
      const primary = (state.series || [])[0];
      if (primary && !state.candles) {
        for (let i = i1; i >= i0; i--) {
          if (primary.values[i] != null) {
            const px = x(i), py = y(primary.values[i]);
            ctx.beginPath();
            ctx.arc(px, py, 6, 0, Math.PI * 2);
            ctx.fillStyle = t.surface;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fillStyle = primary.color;
            ctx.fill();
            break;
          }
        }
      }

    }

    /** Bar index under a canvas-local x position. */
    function idxAt(mx) {
      const [i0, i1] = visibleRange();
      const plotW = canvas.clientWidth - PAD.left - PAD.right;
      const frac = (mx - PAD.left) / plotW;
      return Math.max(i0, Math.min(i1, Math.round(i0 + frac * (i1 - i0))));
    }

    canvas.addEventListener('click', evt => {
      if (!state) return;
      const mx = evt.clientX - canvas.getBoundingClientRect().left;
      const idx = idxAt(mx);
      setSelection(idx);
      if (selectHandler) selectHandler(idx);
    });

    window.addEventListener('resize', () => render());
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
    }

    const api = {
      update(newState) {
        state = newState;
        render();
      },
      rerender: render,
    };
    registry.push(api);
    return api;
  }

  return { createChart, cssVar, niceTicks, setView, resetView, onSelect, setSelection };
})();
