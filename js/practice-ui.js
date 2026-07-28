/* ============================================================
   Practice UI — the section shell (sub-tabs) and the entire
   "Live portfolio" pane. The replay pane is js/replay.js.

   Talks to the core (js/practice.js) only through its public
   API; talks to the replay pane only through DOM events:
   - dispatches 'practice:ready' after Practice.init() resolves;
   - dispatches 'practice:tab' {detail:{tab}} on tab switches.
   ============================================================ */
const PracticeUI = (() => {

  const $ = id => document.getElementById(id);
  const { fmt } = Practice;

  // ---------- tab shell ----------
  let currentTab = 'portfolio';
  let tabChosen = false;   // once anyone picks a tab, boot's default must not override it

  function setTab(tab) {
    tabChosen = true;
    applyTab(tab);
  }

  function applyTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#practice-tabs [data-ptab]').forEach(b => {
      const active = b.dataset.ptab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('practice-portfolio').hidden = tab !== 'portfolio';
    $('practice-replay').hidden = tab !== 'replay';
    // Reveal FIRST, then let panes redraw: canvases in a hidden pane
    // have zero width and skip their draw guard.
    document.dispatchEvent(new CustomEvent('practice:tab', { detail: { tab } }));
  }

  // ---------- storage bar / banners ----------
  function renderStorageBar() {
    const info = Practice.storageInfo();
    const el = $('practice-save-status');
    const t = info.lastSavedAt ? new Date(info.lastSavedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
    let msg;
    if (info.fileStatus === 'connected') {
      msg = 'Auto-saving to ' + fmt.esc(info.fileName) + (t ? ' · saved ' + t : '');
    } else if (info.fileStatus === 'needs-permission') {
      msg = 'Save file needs one click to reconnect — auto-saving in this browser meanwhile.';
    } else if (info.fileStatus === 'missing') {
      msg = 'The linked save file was moved or deleted — link it again. Auto-saving in this browser meanwhile.';
    } else if (info.storageMode === 'memory') {
      msg = 'In-memory only — this browser blocks storage. Export a file to keep your progress.';
    } else {
      msg = 'Auto-saved in this browser' + (t ? ' · ' + t : '') +
        (info.fsaSupported ? ' — link a save file for a portable copy that reloads when you open the app.' : '');
    }
    el.innerHTML = msg;
    const hideLink = !info.fsaSupported || info.fileStatus === 'connected';
    $('practice-create-btn').hidden = hideLink;
    $('practice-link-btn').hidden = hideLink;
    $('practice-reconnect').hidden = info.fileStatus !== 'needs-permission';
  }

  function renderExternalBanner(show) {
    $('practice-external').hidden = !show;
  }

  // ---------- setup vs account ----------
  function renderAll() {
    renderStorageBar();
    const live = Practice.getState().live;
    $('practice-setup').hidden = !!live;
    $('practice-account').hidden = !live;
    // Self-heal: after a wholesale state swap (reset, import, multi-tab
    // reload, reconnect) an open trade form may point at a position that no
    // longer exists — drop it or the table below would freeze stale.
    if (openTrade && (!live || !Practice.findPosition(openTrade.symbol))) {
      const stale = document.querySelector('#practice-table .trade-row');
      if (stale) stale.remove();
      openTrade = null;
    }
    if (!live) return;
    renderTiles();
    if (!openTrade) renderTable();   // don't destroy an open trade form mid-typing
    renderTrades();
  }

  function renderTiles() {
    const t = Practice.totals();
    if (!t) return;
    $('practice-tile-total').textContent = fmt.money(t.totalValue);
    $('practice-tile-total-note').textContent = 'started with ' + fmt.money(t.startingCash);
    $('practice-tile-cash').textContent = fmt.money(t.cash);
    $('practice-tile-cash-note').textContent = fmt.money(t.marketValue) + ' invested';
    const day = $('practice-tile-day');
    day.textContent = (t.dayPnl >= 0 ? '+' : '−') + fmt.money(Math.abs(t.dayPnl));
    day.className = 'tile-value ' + (t.dayPnl >= 0 ? 'up' : 'down');
    const pnl = $('practice-tile-pnl');
    pnl.textContent = (t.totalPnl >= 0 ? '+' : '−') + fmt.money(Math.abs(t.totalPnl));
    pnl.className = 'tile-value ' + (t.totalPnl >= 0 ? 'up' : 'down');
    $('practice-tile-pnl-note').textContent = t.startingCash > 0 ? fmt.pct(t.totalPnl / t.startingCash) + ' overall' : '';
  }

  function signalPillHTML(sig) {
    if (!sig) return '<span class="muted">…</span>';
    // Everything here can arrive from an imported save file — escape it all.
    return '<span class="signal-badge signal-' + fmt.esc(sig.cls) + '">' + fmt.esc(sig.icon) + ' ' + fmt.esc(sig.label) + '</span>' +
      (sig.asOf ? '<span class="pr-asof">as of ' + fmt.esc(sig.asOf) + '</span>' : '');
  }

  function strategySelectHTML(symbol, selectedId) {
    return '<select class="pr-strategy" data-symbol="' + fmt.esc(symbol) + '">' +
      Strategies.catalog.map(s =>
        '<option value="' + s.id + '"' + (s.id === selectedId ? ' selected' : '') + '>' + fmt.esc(s.name) + '</option>'
      ).join('') + '</select>';
  }

  function renderTable() {
    const live = Practice.getState().live;
    const tbody = $('practice-table').querySelector('tbody');
    if (!live.positions.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="muted">No stocks yet — add any stock above to start practicing.</td></tr>';
      return;
    }
    tbody.innerHTML = live.positions.map(p => {
      const held = p.shares > 0;
      const mv = held && p.lastPrice != null ? p.shares * p.lastPrice : 0;
      const pnl = held && p.lastPrice != null ? p.shares * (p.lastPrice - p.avgCost) : null;
      return '<tr data-row="' + fmt.esc(p.symbol) + '">' +
        '<td><b>' + fmt.esc(p.symbol) + '</b></td>' +
        '<td class="pr-name">' + fmt.esc(p.name) + '</td>' +
        '<td>' + (p.lastPrice != null ? fmt.money(p.lastPrice) + (p.priceIsEOD ? ' <span class="pr-asof">EOD</span>' : '') : '–') + '</td>' +
        '<td class="' + (p.dayChangePct >= 0 ? 'up' : 'down') + '">' + (p.dayChangePct != null ? fmt.pct(p.dayChangePct / 100) : '–') + '</td>' +
        '<td>' + signalPillHTML(p.lastSignal) + '</td>' +
        '<td>' + strategySelectHTML(p.symbol, p.strategyId) + '</td>' +
        '<td>' + (held ? fmt.shares(p.shares) : '–') + '</td>' +
        '<td>' + (held ? fmt.money(mv) : '–') + '</td>' +
        '<td class="' + (pnl == null ? '' : pnl >= 0 ? 'up' : 'down') + '">' +
          (pnl != null ? (pnl >= 0 ? '+' : '−') + fmt.money(Math.abs(pnl)) : '–') + '</td>' +
        '<td class="pr-row-actions">' +
          '<button class="btn btn-primary pr-buy" data-symbol="' + fmt.esc(p.symbol) + '">Buy</button>' +
          '<button class="btn btn-secondary pr-sell" data-symbol="' + fmt.esc(p.symbol) + '"' + (held ? '' : ' disabled') + '>Sell</button>' +
          '<button class="pr-remove" title="Remove row" data-symbol="' + fmt.esc(p.symbol) + '">&times;</button>' +
        '</td></tr>';
    }).join('');
  }

  function renderTrades() {
    const live = Practice.getState().live;
    const wrap = $('practice-trades-wrap');
    const rows = live.trades.filter(t => t.kind === 'BUY' || t.kind === 'SELL');
    wrap.hidden = rows.length === 0;
    if (!rows.length) return;
    $('practice-trades').querySelector('tbody').innerHTML = [...rows].reverse().map(t =>
      '<tr><td>' + new Date(t.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</td>' +
      '<td><b>' + fmt.esc(t.symbol) + '</b></td>' +
      '<td>' + fmt.esc(t.kind) + '</td>' +
      '<td>' + fmt.shares(t.shares) + '</td>' +
      '<td>' + fmt.money(t.price) + '</td>' +
      '<td>' + fmt.money(t.value) + '</td>' +
      '<td class="' + (t.realizedPnl > 0 ? 'up' : t.realizedPnl < 0 ? 'down' : '') + '">' +
        (t.kind === 'SELL' ? (t.realizedPnl >= 0 ? '+' : '−') + fmt.money(Math.abs(t.realizedPnl)) : '–') + '</td>' +
      '<td>' + fmt.money(t.cashAfter) + '</td></tr>'
    ).join('');
  }

  // ---------- inline trade row ----------
  let openTrade = null;   // { symbol, side }

  function closeTradeRow() {
    const existing = document.querySelector('#practice-table .trade-row');
    if (existing) existing.remove();
    openTrade = null;
    renderAll();
  }

  function openTradeRow(symbol, side) {
    if (openTrade) {
      const existing = document.querySelector('#practice-table .trade-row');
      if (existing) existing.remove();
      openTrade = null;
    }
    const p = Practice.findPosition(symbol);
    if (!p) return;
    const anchor = document.querySelector('#practice-table tr[data-row="' + CSS.escape(symbol) + '"]');
    if (!anchor) return;
    openTrade = { symbol, side };
    const isBuy = side === 'buy';
    const cash = Practice.getState().live.cash;
    const maxDollars = isBuy ? cash : (p.shares * (p.lastPrice || 0));
    const row = document.createElement('tr');
    row.className = 'trade-row';
    row.innerHTML = '<td colspan="10"><div class="trade-form">' +
      '<b>' + (isBuy ? 'Buy' : 'Sell') + ' ' + fmt.esc(symbol) + '</b> at ' + (p.lastPrice != null ? fmt.money(p.lastPrice) : '–') +
      ' <label>$ <input type="number" class="trade-amt" min="0" step="100" value="' + Math.floor(maxDollars) + '"></label>' +
      '<button class="btn btn-secondary trade-max">' + (isBuy ? 'Max' : 'All') + '</button>' +
      '<span class="hint trade-preview"></span>' +
      '<button class="btn btn-primary trade-confirm">Confirm ' + (isBuy ? 'buy' : 'sell') + '</button>' +
      '<button class="btn btn-secondary trade-cancel">Cancel</button>' +
      '<span class="status error trade-err"></span>' +
      '</div></td>';
    anchor.after(row);

    const amt = row.querySelector('.trade-amt');
    const preview = row.querySelector('.trade-preview');
    let sellAll = !isBuy;   // sells default to the whole position until the amount is edited
    const updatePreview = () => {
      const v = parseFloat(amt.value) || 0;
      preview.textContent = p.lastPrice > 0
        ? '≈ ' + fmt.shares(v / p.lastPrice) + ' shares' + (sellAll ? ' (entire position)' : '')
        : '';
    };
    amt.addEventListener('input', () => { sellAll = false; updatePreview(); });
    row.querySelector('.trade-max').addEventListener('click', () => {
      amt.value = isBuy ? Math.floor(cash * 100) / 100 : Math.ceil(maxDollars * 100) / 100;
      sellAll = !isBuy;
      updatePreview();
    });
    row.querySelector('.trade-cancel').addEventListener('click', closeTradeRow);
    row.querySelector('.trade-confirm').addEventListener('click', () => {
      const dollars = parseFloat(amt.value);
      const r = isBuy ? Practice.buy(symbol, dollars) : Practice.sell(symbol, sellAll ? { all: true } : { dollars });
      if (!r.ok) {
        row.querySelector('.trade-err').textContent = r.error || 'Trade failed.';
        openTrade = { symbol, side };   // keep the form open
        return;
      }
      closeTradeRow();
    });
    updatePreview();
    amt.focus();
    amt.select();
  }

  // ---------- add-stock flow ----------
  let addBusy = false;
  let searchTimer = null;

  async function addBySymbol(rawSymbol, preset) {
    if (addBusy) return;
    const symbol = DataSource.normalizeSymbol(rawSymbol);
    if (!symbol) return;
    const err = $('practice-add-err');
    err.textContent = '';
    if (!Practice.getState().live) return;
    if (Practice.findPosition(symbol)) {
      err.textContent = symbol + ' is already in the table.';
      highlightRow(symbol);
      return;
    }
    addBusy = true;
    $('practice-add-btn').disabled = true;
    try {
      let info = preset || null;
      if (!info) {
        try { info = await DataSource.resolveTicker(symbol); } catch (e) { info = null; }
      }
      const r = Practice.addPosition({
        symbol,
        name: info && info.name ? info.name : symbol,
        resolvedTicker: info ? info.ticker : null,
        lastPrice: info ? info.close : null,
        dayChangePct: info ? info.change : null,
      });
      if (!r.ok && r.error !== 'duplicate') {
        err.textContent = r.error;
        return;
      }
      $('practice-add-input').value = '';
      $('practice-add-results').hidden = true;
      // History + signal for the new row (also sets an EOD price when no quote source).
      Practice.refreshSignals([symbol], (i, n, s) => {
        $('practice-progress').textContent = 'Loading history for ' + s + '…';
      }).then(res => {
        $('practice-progress').textContent = '';
        if (res.failed.length && !Practice.findPosition(symbol)?.lastPrice) {
          err.textContent = 'Could not load data for ' + symbol + ' — is the ticker right? (Row kept; use Refresh signals to retry.)';
        }
      });
    } finally {
      addBusy = false;
      $('practice-add-btn').disabled = false;
    }
  }

  function highlightRow(symbol) {
    const row = document.querySelector('#practice-table tr[data-row="' + CSS.escape(symbol) + '"]');
    if (row) {
      row.classList.add('pr-flash');
      row.scrollIntoView({ block: 'nearest' });
      setTimeout(() => row.classList.remove('pr-flash'), 1200);
    }
  }

  async function doAddSearch() {
    const q = $('practice-add-input').value.trim();
    const box = $('practice-add-results');
    if (q.length < 2) { box.hidden = true; return; }
    try {
      const results = await DataSource.searchSymbols(q);
      if (!results.length) { box.hidden = true; return; }
      box.innerHTML = results.map(r =>
        '<button class="search-result" data-symbol="' + fmt.esc(r.symbol) + '">' +
        '<span class="sr-symbol">' + fmt.esc(r.symbol) + '</span>' +
        '<span class="sr-name">' + fmt.esc(r.name) + '</span>' +
        '<span class="sr-exch">' + fmt.esc([r.type, r.exch].filter(Boolean).join(' · ')) + '</span>' +
        '</button>').join('');
      box.hidden = false;
      box.querySelectorAll('[data-symbol]').forEach(btn =>
        btn.addEventListener('click', () => { box.hidden = true; addBySymbol(btn.dataset.symbol); }));
    } catch (e) {
      box.hidden = true;
    }
  }

  // Practice-owned copy of the directory browser (rows ADD instead of loading
  // the main chart). Uses the shared lesson modal chrome.
  const dirState = { query: '', offset: 0, pageSize: 50, timer: null };

  function dirRowHTML(r) {
    const cap = r.cap == null || !isFinite(r.cap) ? ''
      : r.cap >= 1e12 ? '$' + (r.cap / 1e12).toFixed(1) + 'T'
      : r.cap >= 1e9 ? '$' + (r.cap / 1e9).toFixed(1) + 'B'
      : r.cap >= 1e6 ? '$' + (r.cap / 1e6).toFixed(0) + 'M' : '';
    return '<button class="dir-row" data-pick="' + fmt.esc(r.symbol) + '" data-ticker="' + fmt.esc(r.ticker) + '"' +
      ' data-name="' + fmt.esc(r.name) + '" data-close="' + (r.close ?? '') + '" data-change="' + (r.change ?? '') + '">' +
      '<span class="dir-sym">' + fmt.esc(r.symbol) + '</span>' +
      '<span class="dir-name">' + fmt.esc(r.name) + '</span>' +
      '<span class="dir-price">' + (r.close != null ? fmt.money(r.close) : '–') + '</span>' +
      '<span class="dir-chg ' + (r.change >= 0 ? 'up' : 'down') + '">' + (r.change != null ? fmt.pct(r.change / 100) : '') + '</span>' +
      '<span class="dir-cap">' + cap + '</span></button>';
  }

  async function dirFetch(reset) {
    const list = $('pr-dir-list'), more = $('pr-dir-more'), count = $('pr-dir-count');
    if (reset) { dirState.offset = 0; list.innerHTML = '<div class="dir-row">Loading…</div>'; }
    more.disabled = true;
    try {
      const page = await DataSource.browseSymbols(dirState.query, dirState.offset, dirState.pageSize);
      const rowsHTML = page.rows.map(dirRowHTML).join('');
      if (reset) list.innerHTML = rowsHTML || '<div class="dir-row">No symbols match.</div>';
      else list.insertAdjacentHTML('beforeend', rowsHTML);
      dirState.offset += page.rows.length;
      count.textContent = page.total.toLocaleString('en-US') + ' symbols — click one to add it';
      more.hidden = dirState.offset >= page.total;
      list.querySelectorAll('[data-pick]:not([data-wired])').forEach(btn => {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          closePracticeModal();
          addBySymbol(btn.dataset.pick, {
            ticker: btn.dataset.ticker,
            name: btn.dataset.name,
            close: parseFloat(btn.dataset.close),
            change: parseFloat(btn.dataset.change),
          });
        });
      });
    } catch (e) {
      if (reset) list.innerHTML = '<div class="dir-row">' + fmt.esc(e.message) + '</div>';
      count.textContent = '';
    } finally {
      more.disabled = false;
    }
  }

  function openPracticeBrowser() {
    const body = document.getElementById('modal-body');
    body.innerHTML =
      '<div class="lesson-type">Add to practice portfolio</div>' +
      '<h2 id="modal-title">All available symbols</h2>' +
      '<p class="hint">Every US-listed stock, ETF, and fund, biggest first — click one to add it to your practice table.</p>' +
      '<div class="dir-controls"><input id="pr-dir-filter" type="text" placeholder="Filter: ticker or company name…" autocomplete="off" />' +
      '<span class="hint" id="pr-dir-count"></span></div>' +
      '<div class="dir-list" id="pr-dir-list"></div>' +
      '<button class="btn btn-primary" id="pr-dir-more" type="button">Load more</button>';
    document.getElementById('modal-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    $('pr-dir-filter').addEventListener('input', () => {
      clearTimeout(dirState.timer);
      dirState.timer = setTimeout(() => {
        dirState.query = $('pr-dir-filter').value.trim();
        dirFetch(true);
      }, 350);
    });
    $('pr-dir-more').addEventListener('click', () => dirFetch(false));
    dirState.query = '';
    dirFetch(true);
    $('pr-dir-filter').focus();
  }

  function closePracticeModal() {
    document.getElementById('modal-backdrop').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- refresh flows ----------
  let quotesBusy = false;

  async function refreshQuotesUI(silent) {
    if (quotesBusy || !Practice.getState().live) return;
    quotesBusy = true;
    if (!silent) $('practice-progress').textContent = 'Refreshing quotes…';
    try {
      const res = await Practice.refreshQuotes();
      if (!silent) {
        $('practice-progress').textContent = res.missing.length
          ? 'No live quote for: ' + res.missing.join(', ') : '';
      }
    } catch (e) {
      if (!silent) $('practice-progress').textContent = 'Quote refresh failed: ' + e.message;
    } finally {
      quotesBusy = false;
    }
  }

  async function refreshSignalsUI() {
    const live = Practice.getState().live;
    if (!live || !live.positions.length) return;
    const symbols = live.positions.map(p => p.symbol);
    const res = await Practice.refreshSignals(symbols, (i, n, s) => {
      $('practice-progress').textContent = 'Updating signals ' + i + ' of ' + n + ' — ' + s + '…';
    });
    if (!res.cancelled) {
      $('practice-progress').textContent = res.failed.length
        ? 'Signals updated (feed busy for: ' + res.failed.join(', ') + ' — try again in a minute).' : '';
    }
  }

  let autoTimer = null;
  function startAutoRefresh() {
    clearInterval(autoTimer);
    const mins = Practice.getState().settings.autoRefreshMinutes;
    if (!mins) return;
    autoTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshQuotesUI(true);
    }, mins * 60 * 1000);
  }

  // ---------- init ----------
  async function init() {
    // Tab chips
    document.querySelectorAll('#practice-tabs [data-ptab]').forEach(btn =>
      btn.addEventListener('click', () => setTab(btn.dataset.ptab)));

    // Storage controls
    const onLink = async mode => {
      const r = await Practice.linkSaveFile(mode);
      if (!r.ok && r.error) $('practice-progress').textContent = r.error;
      if (r.ok && r.adopted) {
        // The linked file was newer and was adopted wholesale.
        renderAll();
        document.dispatchEvent(new CustomEvent('practice:reloaded'));
        refreshQuotesUI(true);
      }
      renderStorageBar();
    };
    $('practice-create-btn').addEventListener('click', () => onLink('create'));
    $('practice-link-btn').addEventListener('click', () => onLink('existing'));
    $('practice-reconnect-btn').addEventListener('click', async () => {
      const r = await Practice.reconnectSaveFile();
      if (!r.ok && r.error) $('practice-progress').textContent = r.error;
      renderAll();
      document.dispatchEvent(new CustomEvent('practice:reloaded'));
    });
    $('practice-export-btn').addEventListener('click', () => {
      Practice.downloadFile('practice-portfolio.json', Practice.exportText(), 'application/json');
    });
    $('practice-import-btn').addEventListener('click', () => $('practice-import-input').click());
    $('practice-import-input').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const r = Practice.importFromText(reader.result);
        if (!r.ok) { $('practice-progress').textContent = r.error; return; }
        const live = r.doc.live;
        const summary = live
          ? 'File holds ' + live.positions.length + ' stock' + (live.positions.length === 1 ? '' : 's') +
            ', ' + fmt.money(live.cash) + ' cash, saved ' + (r.doc.savedAt ? new Date(r.doc.savedAt).toLocaleString() : 'unknown')
          : 'File holds no live account';
        if (confirm(summary + '.\nReplace your current practice state? (The current state is backed up.)')) {
          Practice.applyImport(r.doc);
          document.dispatchEvent(new CustomEvent('practice:reloaded'));
          refreshQuotesUI(true);
        }
      };
      reader.readAsText(file);
    });

    // Reset (two-step)
    $('practice-reset-btn').addEventListener('click', () => {
      const btn = $('practice-reset-btn');
      if (btn.dataset.armed) {
        delete btn.dataset.armed;
        btn.textContent = 'Reset account';
        Practice.resetAccount();
      } else {
        btn.dataset.armed = '1';
        btn.textContent = 'Really reset? Erases holdings & history';
        setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Reset account'; }, 4000);
      }
    });

    // External-change banner
    Practice.onExternalChange(() => renderExternalBanner(true));
    $('practice-external-reload').addEventListener('click', () => {
      Practice.reloadFromLocal();
      renderExternalBanner(false);
      document.dispatchEvent(new CustomEvent('practice:reloaded'));
    });

    // Setup form
    const capital = document.getElementById('capital-input');
    $('practice-cash-input').value = capital && parseFloat(capital.value) > 0 ? capital.value : '10000';
    $('practice-start-btn').addEventListener('click', () => {
      const r = Practice.createAccount(parseFloat($('practice-cash-input').value));
      $('practice-setup-err').textContent = r.ok ? '' : r.error;
    });

    // Add flow
    $('practice-add-btn').addEventListener('click', () => addBySymbol($('practice-add-input').value));
    $('practice-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { $('practice-add-results').hidden = true; addBySymbol($('practice-add-input').value); }
    });
    $('practice-add-input').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doAddSearch, 400);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.practice-add')) $('practice-add-results').hidden = true;
    });
    $('practice-browse-btn').addEventListener('click', openPracticeBrowser);

    // Refresh buttons
    $('practice-refresh-quotes').addEventListener('click', () => refreshQuotesUI(false));
    $('practice-refresh-signals').addEventListener('click', refreshSignalsUI);

    // Table interactions (delegated)
    const table = $('practice-table');
    table.addEventListener('change', e => {
      const sel = e.target.closest('.pr-strategy');
      if (sel) Practice.setStrategy(sel.dataset.symbol, sel.value);
    });
    table.addEventListener('click', e => {
      const buyBtn = e.target.closest('.pr-buy');
      const sellBtn = e.target.closest('.pr-sell');
      const rmBtn = e.target.closest('.pr-remove');
      if (buyBtn) openTradeRow(buyBtn.dataset.symbol, 'buy');
      else if (sellBtn && !sellBtn.disabled) openTradeRow(sellBtn.dataset.symbol, 'sell');
      else if (rmBtn) {
        const r = Practice.removePosition(rmBtn.dataset.symbol);
        if (!r.ok) $('practice-progress').textContent = r.error;
      }
    });

    // Core → UI
    Practice.onChange(renderAll);

    // State was restored synchronously from localStorage at script load —
    // render right away; the async part below only handles the linked file.
    renderAll();
    document.dispatchEvent(new CustomEvent('practice:ready'));
    if (!tabChosen) {
      const slot0 = Practice.getSlot('replay');
      applyTab(slot0 && slot0.active ? 'replay' : 'portfolio');
    }

    const { needsReconnect } = await Practice.init();
    renderAll();
    renderStorageBar();
    if (needsReconnect) $('practice-reconnect').hidden = false;
    // If the linked save file was newer and adopted, let the replay pane
    // re-sync — but never yank a tab the user (or a click) already chose.
    document.dispatchEvent(new CustomEvent('practice:ready'));
    if (!tabChosen) {
      const replaySlot = Practice.getSlot('replay');
      applyTab(replaySlot && replaySlot.active ? 'replay' : 'portfolio');
    }

    // Background freshness for a restored account.
    if (Practice.getState().live) {
      refreshQuotesUI(true).then(() => refreshSignalsUI());
    }
    startAutoRefresh();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setTab };
})();
