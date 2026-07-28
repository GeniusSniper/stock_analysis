/* ============================================================
   Practice core — shared by the "Live portfolio" and "Replay
   trainer" tabs. No rendering in this file.

   Owns:
   - the versioned practice save document (account, positions with
     a per-stock strategy, trade log, opaque replay slot);
   - the persistence engine: localStorage mirror (always), an
     optional linked save file via the File System Access API
     (auto-writes after the user links a file once), and manual
     export/import text;
   - the per-symbol daily-bars cache and strategy-signal pipeline;
   - small shared formatting helpers for the two UI files.
   ============================================================ */
const Practice = (() => {

  const SCHEMA_VERSION = 1;
  const APP_MARK = 'stock-lab-practice';
  const LS_KEY = 'stockLab.practice.v1';
  const LS_BACKUP_KEY = 'stockLab.practice.backup';
  const IDB_NAME = 'stockLab-practice';
  const IDB_STORE = 'handles';
  const SAVE_DEBOUNCE_MS = 500;
  const BARS_TTL_MS = 2 * 3600 * 1000;      // re-fetch a symbol's history after 2 h
  const SIGNAL_GAP_MS = 400;                // pause between sequential history fetches

  const round2 = v => Math.round(v * 100) / 100;
  const round4 = v => Math.round(v * 10000) / 10000;
  const nowISO = () => new Date().toISOString();

  // ---------- shared formatting helpers (used by both UI files) ----------
  // Every numeric formatter COERCES first: values can arrive from an imported
  // save file, and String.prototype.toLocaleString would pass an attacker's
  // markup through verbatim into innerHTML.
  const fmt = {
    money: v => {
      const n = +v;
      return Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–';
    },
    pct: (v, digits = 1) => {
      const n = +v;
      if (!Number.isFinite(n)) return '–';
      const p = n * 100;
      const d = Math.abs(p) >= 100 ? 0 : digits;
      return (n >= 0 ? '+' : '') + p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
    },
    num: v => {
      const n = +v;
      return Number.isFinite(n) ? n.toLocaleString('en-US') : '–';
    },
    shares: v => {
      const n = +v;
      return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '–';
    },
    equity: v => {
      const n = +v;
      return !Number.isFinite(n) ? '–'
        : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
        : '$' + Math.round(n).toLocaleString('en-US');
    },
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };

  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- document ----------
  function defaultState() {
    return {
      app: APP_MARK,
      schemaVersion: SCHEMA_VERSION,
      savedAt: null,
      settings: { autoRefreshMinutes: 5 },
      live: null,          // no account until the user starts one
      replay: null,        // opaque slot owned by the replay tab
    };
  }

  // Stepwise upgrades, keyed by the version they upgrade FROM.
  const MIGRATIONS = {
    // 1: doc => { ...doc, schemaVersion: 2, ... },
  };

  function migrate(doc) {
    let d = doc;
    while (d.schemaVersion < SCHEMA_VERSION) {
      const step = MIGRATIONS[d.schemaVersion];
      if (!step) throw new Error('No migration path from schema v' + d.schemaVersion + '.');
      d = step(d);
    }
    return d;
  }

  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'Not a JSON object.';
    if (doc.app !== APP_MARK) return 'Not a practice save file (missing the "' + APP_MARK + '" marker).';
    if (typeof doc.schemaVersion !== 'number') return 'Damaged file: no schema version.';
    if (doc.schemaVersion > SCHEMA_VERSION) {
      return 'This file was saved by a newer version of the app (schema v' + doc.schemaVersion +
        ' vs supported v' + SCHEMA_VERSION + '). Refusing to load it to avoid data loss.';
    }
    if (doc.live != null) {
      if (typeof doc.live !== 'object' || !Array.isArray(doc.live.positions) || !Array.isArray(doc.live.trades)) {
        return 'Damaged file: the account block is malformed.';
      }
      // Number.isFinite, NOT the coercing global — "5000" must not pass and
      // later corrupt cash through string concatenation.
      if (!Number.isFinite(doc.live.cash) || !Number.isFinite(doc.live.startingCash)) {
        return 'Damaged file: account balances are not numbers.';
      }
    }
    return null;   // valid
  }

  function deserialize(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'Damaged JSON — the file could not be parsed.' };
    }
    const err = validate(doc);
    if (err) return { ok: false, error: err };
    try {
      doc = migrate(doc);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (doc.live) {
      doc.live.realizedPnl = Number.isFinite(+doc.live.realizedPnl) ? +doc.live.realizedPnl : 0;
      doc.live.netDeposits = Number.isFinite(+doc.live.netDeposits) ? +doc.live.netDeposits : 0;
    }
    return { ok: true, doc };
  }

  // ---------- state + change plumbing ----------
  let state = defaultState();
  let tradeSeq = 0;
  const changeCbs = [];
  const externalChangeCbs = [];

  function onChange(cb) { changeCbs.push(cb); }
  function onExternalChange(cb) { externalChangeCbs.push(cb); }

  let saveTimer = null;
  function emitChange() {
    scheduleSave();
    for (const cb of changeCbs) { try { cb(); } catch (e) { /* one bad listener must not stop the rest */ } }
  }

  function getState() { return state; }
  function getSlot(name) { return state[name]; }
  function setSlot(name, obj) {
    state[name] = obj;
    touch();          // slot writes are user actions (replay steps/trades)
    emitChange();
  }

  // ---------- persistence: localStorage mirror ----------
  let storageMode = 'local';        // 'local' | 'memory'
  let lastSavedAt = null;

  function writeLocal(text) {
    try {
      localStorage.setItem(LS_KEY, text);
      storageMode = 'local';
      return true;
    } catch (e) {
      storageMode = 'memory';       // quota exceeded or storage blocked
      return false;
    }
  }

  function loadLocal() {
    try {
      const text = localStorage.getItem(LS_KEY);
      if (!text) return null;
      const r = deserialize(text);
      return r.ok ? r.doc : null;
    } catch (e) {
      return null;
    }
  }

  function backupCurrent() {
    try { localStorage.setItem(LS_BACKUP_KEY, serialize()); } catch (e) { /* best effort */ }
  }

  // ---------- persistence: linked save file (File System Access API) ----------
  // fileStatus: 'unavailable' | 'none' | 'connected' | 'needs-permission' | 'missing' | 'error'
  const fsaSupported = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  let fileHandle = null;
  let fileStatus = fsaSupported ? 'none' : 'unavailable';
  let fileName = null;
  let fileWriting = false;

  // IndexedDB can hang (not reject) after an unclean shutdown — never let
  // it block boot; the localStorage mirror is the designed fallback.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB timed out')), ms)),
    ]);
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function idbDel(key) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  async function readFileDoc() {
    const file = await fileHandle.getFile();
    const r = deserialize(await file.text());
    return r.ok ? r.doc : null;
  }

  // Latest-wins write queue: a save arriving while a write is in flight must
  // not be dropped — it supersedes any queued text and is written next.
  let filePendingText = null;

  async function writeFile(text) {
    if (!fileHandle || fileStatus !== 'connected') return;
    filePendingText = text;
    if (fileWriting) return;
    fileWriting = true;
    try {
      while (filePendingText !== null) {
        const t = filePendingText;
        filePendingText = null;
        const w = await fileHandle.createWritable();
        await w.write(t);
        await w.close();
      }
    } catch (e) {
      filePendingText = null;
      if (e && e.name === 'NotAllowedError') fileStatus = 'needs-permission';
      else if (e && e.name === 'NotFoundError') fileStatus = 'missing';
      else fileStatus = 'error';
      for (const cb of changeCbs) { try { cb(); } catch (e2) { /* keep going */ } }
    } finally {
      fileWriting = false;
    }
  }

  /**
   * mode 'create': pick a NEW file to save into (save picker).
   * mode 'existing': pick an EXISTING practice file to load AND keep saving
   * into. This must use the OPEN picker — showSaveFilePicker EMPTIES the
   * picked file before it even returns, which would destroy the save the
   * user is trying to load.
   */
  async function linkSaveFile(mode) {
    if (!fsaSupported) return { ok: false, error: 'This browser cannot link files — use Export instead.' };
    try {
      let handle, adopted = false;
      if (mode === 'existing') {
        const picked = await window.showOpenFilePicker({
          types: [{ description: 'Practice portfolio', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
        handle = picked[0];
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          return { ok: false, error: 'Write permission was not granted — the file was left untouched.' };
        }
        fileHandle = handle;
        fileName = handle.name;
        fileStatus = 'connected';
        const fileDoc = await readFileDoc();
        if (fileDoc && (!state.savedAt || (fileDoc.savedAt && fileDoc.savedAt > state.savedAt))) {
          backupCurrent();
          state = fileDoc;
          tradeSeq = 0;
          adopted = true;
        } else if (fileDoc) {
          // Local state is newer and will overwrite the file — keep a copy.
          try { localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(fileDoc)); } catch (e) { /* best effort */ }
        }
      } else {
        handle = await window.showSaveFilePicker({
          suggestedName: 'practice-portfolio.json',
          types: [{ description: 'Practice portfolio', accept: { 'application/json': ['.json'] } }],
        });
        fileHandle = handle;
        fileName = handle.name;
        fileStatus = 'connected';
      }
      try { await withTimeout(idbSet('saveFile', handle), 4000); } catch (e) { /* handle persists this session only */ }
      await saveNow();
      return { ok: true, adopted };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: null };   // user cancelled
      // SecurityError etc. — e.g. pickers blocked on file:// pages
      fileStatus = 'unavailable';
      return { ok: false, error: 'File linking is blocked here (try opening the app via Live Server / localhost). Your progress still auto-saves in this browser.' };
    }
  }

  async function reconnectSaveFile() {
    if (!fileHandle) return { ok: false, error: 'No linked file.' };
    try {
      const perm = await fileHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        fileStatus = 'needs-permission';
        return { ok: false, error: 'Permission not granted — auto-saving continues in this browser only.' };
      }
      fileStatus = 'connected';
      const fileDoc = await readFileDoc();
      let adopted = false;
      if (fileDoc && (!state.savedAt || (fileDoc.savedAt && fileDoc.savedAt > state.savedAt))) {
        state = fileDoc;     // the file is newer — it wins wholesale
        tradeSeq = 0;
        adopted = true;
      } else if (fileDoc) {
        // Local state is newer and is about to overwrite the file — keep a copy.
        try { localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(fileDoc)); } catch (e) { /* best effort */ }
      }
      await saveNow();
      return { ok: true, adopted };
    } catch (e) {
      fileStatus = 'error';
      return { ok: false, error: 'Could not reconnect: ' + e.message };
    }
  }

  async function unlinkSaveFile() {
    fileHandle = null;
    fileName = null;
    fileStatus = fsaSupported ? 'none' : 'unavailable';
    try { await withTimeout(idbDel('saveFile'), 4000); } catch (e) { /* best effort */ }
  }

  // ---------- save pipeline ----------
  // savedAt advances ONLY on real user mutations (touch below). Background
  // quote/signal refreshes must not stamp the document "newer", or a stale
  // machine's auto-refresh would outrank — and overwrite — a genuinely newer
  // linked save file on reconnect.
  function touch() { state.savedAt = nowISO(); }

  function serialize() {
    return JSON.stringify(state, null, 2);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    const text = serialize();
    writeLocal(text);
    lastSavedAt = nowISO();   // display freshness — distinct from state.savedAt
    await writeFile(text);    // no-op unless a file is linked and permitted
  }

  function exportText() { return serialize(); }

  function importFromText(text) {
    const r = deserialize(text);
    if (!r.ok) return r;
    return { ok: true, doc: r.doc };
  }

  function applyImport(doc) {
    backupCurrent();
    state = doc;
    tradeSeq = 0;
    touch();          // an explicit import is the newest user intent
    emitChange();
  }

  function storageInfo() {
    return { storageMode, fileStatus, fileName, lastSavedAt, fsaSupported };
  }

  // ---------- boot ----------
  // The localStorage restore happens SYNCHRONOUSLY at script evaluation
  // (see the bottom of this file), so state is correct before any UI
  // wiring runs. init() only handles the async linked-file part.
  async function init() {
    let needsReconnect = false;
    if (fsaSupported) {
      try {
        const handle = await withTimeout(idbGet('saveFile'), 4000);
        if (handle) {
          fileHandle = handle;
          fileName = handle.name;
          const perm = await handle.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            fileStatus = 'connected';
            const fileDoc = await readFileDoc();
            if (fileDoc && (!state.savedAt || (fileDoc.savedAt && fileDoc.savedAt > state.savedAt))) {
              state = fileDoc;   // newer document wins wholesale
            }
          } else if (perm === 'prompt') {
            fileStatus = 'needs-permission';
            needsReconnect = true;
          } else {
            fileStatus = 'none';
            fileHandle = null;
          }
        }
      } catch (e) {
        // IDB blocked or handle unreadable — run on the localStorage mirror.
      }
    }

    // Flush any pending debounced save if the tab closes.
    window.addEventListener('beforeunload', () => {
      if (saveTimer) { clearTimeout(saveTimer); writeLocal(serialize()); }
    });
    // Another tab wrote the mirror — surface it, never merge silently.
    window.addEventListener('storage', e => {
      if (e.key === LS_KEY && e.newValue) {
        for (const cb of externalChangeCbs) { try { cb(); } catch (err) { /* keep going */ } }
      }
    });

    return { state, needsReconnect };
  }

  function reloadFromLocal() {
    const local = loadLocal();
    if (local) {
      state = local;
      // The just-loaded state IS the mirror — re-saving it would fire the
      // storage event in the other tab and ping-pong the banners forever.
      clearTimeout(saveTimer);
      saveTimer = null;
      for (const cb of changeCbs) { try { cb(); } catch (e) { /* keep going */ } }
    }
    return !!local;
  }

  // ---------- account mutators (all return { ok, error? }) ----------
  function requireAccount() {
    return state.live ? null : 'No practice account yet.';
  }

  function createAccount(startingCash) {
    const cash = round2(+startingCash);
    if (!isFinite(cash) || cash <= 0) return { ok: false, error: 'Starting cash must be a positive number.' };
    state.live = {
      createdAt: nowISO(),
      startingCash: cash,
      cash,
      realizedPnl: 0,
      netDeposits: 0,
      positions: [],
      trades: [],
    };
    touch();
    emitChange();
    return { ok: true };
  }

  function resetAccount() {
    state.live = null;        // the replay slot and settings survive
    touch();
    emitChange();
    return { ok: true };
  }

  function findPosition(symbol) {
    return state.live ? state.live.positions.find(p => p.symbol === symbol) : null;
  }

  function logTrade(entry) {
    state.live.trades.push({ id: 't-' + Date.now() + '-' + (++tradeSeq), at: nowISO(), ...entry });
  }

  function adjustCash(delta) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    const d = round2(+delta);
    if (!isFinite(d) || d === 0) return { ok: false, error: 'Amount must be a non-zero number.' };
    if (d < 0 && state.live.cash + d < 0) return { ok: false, error: 'Cannot withdraw more than the available cash.' };
    state.live.cash = round2(state.live.cash + d);
    state.live.netDeposits = round2(state.live.netDeposits + d);
    logTrade({ kind: 'CASH', symbol: null, shares: 0, price: null, value: d, realizedPnl: 0, cashAfter: state.live.cash, strategyId: null });
    touch();
    emitChange();
    return { ok: true };
  }

  function addPosition({ symbol, name, resolvedTicker, lastPrice, dayChangePct }) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    if (!symbol) return { ok: false, error: 'No symbol.' };
    if (findPosition(symbol)) return { ok: false, error: 'duplicate' };
    state.live.positions.push({
      symbol,
      name: name || symbol,
      resolvedTicker: resolvedTicker || null,
      shares: 0,
      avgCost: 0,
      strategyId: Strategies.catalog[0].id,
      lastSignal: null,
      lastPrice: lastPrice != null && isFinite(lastPrice) ? round2(lastPrice) : null,
      dayChangePct: dayChangePct != null && isFinite(dayChangePct) ? dayChangePct : null,
      lastQuoteAt: lastPrice != null ? nowISO() : null,
      priceIsEOD: false,
      addedAt: nowISO(),
    });
    touch();
    emitChange();
    return { ok: true };
  }

  function removePosition(symbol) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    const p = findPosition(symbol);
    if (!p) return { ok: false, error: 'Unknown symbol.' };
    if (p.shares > 0) return { ok: false, error: 'Sell the position first — removing a row does not sell it.' };
    state.live.positions = state.live.positions.filter(x => x !== p);
    touch();
    emitChange();
    return { ok: true };
  }

  function setStrategy(symbol, strategyId) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    const p = findPosition(symbol);
    if (!p) return { ok: false, error: 'Unknown symbol.' };
    if (!Strategies.catalog.some(s => s.id === strategyId)) return { ok: false, error: 'Unknown strategy.' };
    p.strategyId = strategyId;
    // The stored signal belonged to the previous strategy — recompute from
    // cached bars if we have them, otherwise clear until the next refresh.
    const cached = barsCache.get(symbol);
    if (cached) {
      const sig = computeSignalFromEntry(cached, strategyId);
      p.lastSignal = sig;
    } else {
      p.lastSignal = null;
    }
    touch();
    emitChange();
    return { ok: true };
  }

  function buy(symbol, dollars) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    const p = findPosition(symbol);
    if (!p) return { ok: false, error: 'Unknown symbol.' };
    if (p.lastPrice == null || !(p.lastPrice > 0)) return { ok: false, error: 'No price available for ' + symbol + ' — refresh quotes first.' };
    const amt = +dollars;
    if (!isFinite(amt) || amt <= 0) return { ok: false, error: 'Enter a positive dollar amount.' };
    if (amt > state.live.cash + 1e-9) return { ok: false, error: 'Not enough cash (' + fmt.money(state.live.cash) + ' available).' };
    const value = round2(Math.min(amt, state.live.cash));
    const newShares = round4(value / p.lastPrice);
    if (newShares <= 0) return { ok: false, error: 'Amount is too small to buy any shares.' };
    p.avgCost = round4((p.shares * p.avgCost + newShares * p.lastPrice) / (p.shares + newShares));
    p.shares = round4(p.shares + newShares);
    state.live.cash = round2(state.live.cash - value);
    logTrade({ kind: 'BUY', symbol, shares: newShares, price: p.lastPrice, value, realizedPnl: 0, cashAfter: state.live.cash, strategyId: p.strategyId });
    touch();
    emitChange();
    return { ok: true };
  }

  function sell(symbol, { dollars, all } = {}) {
    const err = requireAccount();
    if (err) return { ok: false, error: err };
    const p = findPosition(symbol);
    if (!p) return { ok: false, error: 'Unknown symbol.' };
    if (p.shares <= 0) return { ok: false, error: 'Nothing to sell.' };
    if (p.lastPrice == null || !(p.lastPrice > 0)) return { ok: false, error: 'No price available for ' + symbol + ' — refresh quotes first.' };
    let sellShares;
    if (all) {
      sellShares = p.shares;   // exact — no fractional dust
    } else {
      const amt = +dollars;
      if (!isFinite(amt) || amt <= 0) return { ok: false, error: 'Enter a positive dollar amount.' };
      sellShares = Math.min(p.shares, round4(amt / p.lastPrice));
      if (sellShares <= 0) return { ok: false, error: 'Amount is too small to sell any shares.' };
    }
    const value = round2(sellShares * p.lastPrice);
    const realized = round2(sellShares * (p.lastPrice - p.avgCost));
    state.live.cash = round2(state.live.cash + value);
    state.live.realizedPnl = round2(state.live.realizedPnl + realized);
    p.shares = all ? 0 : round4(p.shares - sellShares);
    if (p.shares === 0) p.avgCost = 0;
    logTrade({ kind: 'SELL', symbol, shares: sellShares, price: p.lastPrice, value, realizedPnl: realized, cashAfter: state.live.cash, strategyId: p.strategyId });
    touch();
    emitChange();
    return { ok: true };
  }

  function applyQuotes(quoteMap) {
    if (!state.live) return;
    let touched = false;
    for (const p of state.live.positions) {
      const q = p.resolvedTicker && quoteMap[p.resolvedTicker];
      if (q && q.close != null && isFinite(q.close)) {
        p.lastPrice = round2(q.close);
        p.dayChangePct = q.change != null && isFinite(q.change) ? q.change : null;
        p.lastQuoteAt = nowISO();
        p.priceIsEOD = false;
        touched = true;
      }
    }
    if (touched) emitChange();
  }

  function applySignal(symbol, sig) {
    const p = findPosition(symbol);
    if (p) {
      p.lastSignal = sig;
      emitChange();
    }
  }

  // ---------- portfolio totals ----------
  function totals() {
    const live = state.live;
    if (!live) return null;
    let marketValue = 0, dayPnl = 0, costBasis = 0;
    for (const p of live.positions) {
      if (p.shares > 0 && p.lastPrice != null) {
        const mv = p.shares * p.lastPrice;
        marketValue += mv;
        costBasis += p.shares * p.avgCost;
        if (p.dayChangePct != null) dayPnl += mv - mv / (1 + p.dayChangePct / 100);
      }
    }
    const totalValue = live.cash + marketValue;
    return {
      cash: live.cash,
      marketValue: round2(marketValue),
      totalValue: round2(totalValue),
      dayPnl: round2(dayPnl),
      unrealizedPnl: round2(marketValue - costBasis),
      realizedPnl: live.realizedPnl,
      totalPnl: round2(totalValue - live.startingCash - live.netDeposits),
      startingCash: live.startingCash,
    };
  }

  // ---------- main-app data bridge ----------
  let mainData = null;   // { source, symbol, bars, ind } from the app's last load

  function notifyDataLoaded(payload) {
    mainData = payload;
    if (payload && payload.symbol && payload.bars && payload.ind) {
      barsCache.set(payload.symbol, { bars: payload.bars, ind: payload.ind, fetchedAt: Date.now() });
    }
    document.dispatchEvent(new CustomEvent('practice:maindata', { detail: { symbol: payload && payload.symbol } }));
  }

  function getMainData() { return mainData; }

  // ---------- bars cache + signals ----------
  const barsCache = new Map();   // symbol -> { bars, ind, fetchedAt }

  function getCachedBars(symbol) { return barsCache.get(symbol) || null; }

  async function ensureBars(symbol, { force } = {}) {
    const hit = barsCache.get(symbol);
    if (hit && !force && Date.now() - hit.fetchedAt < BARS_TTL_MS) return hit;
    const bars = await DataSource.load('yahoo', symbol, '');
    const entry = { bars, ind: Indicators.computeAll(bars), fetchedAt: Date.now() };
    barsCache.set(symbol, entry);
    return entry;
  }

  function computeSignalFromEntry(entry, strategyId) {
    const strategy = Strategies.catalog.find(s => s.id === strategyId);
    if (!strategy) return null;
    const positions = strategy.positions(entry.bars, entry.ind);
    const sig = Strategies.currentSignal(positions);
    return { label: sig.label, cls: sig.cls, icon: sig.icon, asOf: entry.bars[entry.bars.length - 1].date };
  }

  function computeSignal(symbol, strategyId) {
    const entry = barsCache.get(symbol);
    return entry ? computeSignalFromEntry(entry, strategyId) : null;
  }

  // Sequential with gaps: the proxy chain behind Yahoo rate-limits, and a
  // burst of parallel fetches just knocks every request into slower proxies.
  // Concurrent calls QUEUE behind each other instead of cancelling — adding a
  // stock mid-refresh must not silently abandon the remaining rows.
  let signalsChain = Promise.resolve();
  function refreshSignals(symbols, onProgress) {
    const run = signalsChain.then(() => refreshSignalsRun(symbols, onProgress));
    signalsChain = run.catch(() => {});
    return run;
  }

  async function refreshSignalsRun(symbols, onProgress) {
    const failed = [];
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      if (onProgress) onProgress(i + 1, symbols.length, symbol);
      try {
        const entry = await ensureBars(symbol);
        const p = findPosition(symbol);
        if (p) {
          p.lastSignal = computeSignalFromEntry(entry, p.strategyId);
          // With no live quote source, the last daily close still prices the row.
          if (p.resolvedTicker == null && entry.bars.length) {
            p.lastPrice = round2(entry.bars[entry.bars.length - 1].close);
            p.priceIsEOD = true;
          }
          emitChange();
        }
      } catch (e) {
        failed.push(symbol);
      }
      if (i < symbols.length - 1) await new Promise(r => setTimeout(r, SIGNAL_GAP_MS));
    }
    return { cancelled: false, failed };
  }

  async function refreshQuotes() {
    if (!state.live) return { ok: true, missing: [] };
    const tickers = state.live.positions.map(p => p.resolvedTicker).filter(Boolean);
    if (!tickers.length) return { ok: true, missing: [] };
    const quotes = await DataSource.fetchQuotes(tickers);
    applyQuotes(quotes);
    const missing = state.live.positions
      .filter(p => p.resolvedTicker && !quotes[p.resolvedTicker])
      .map(p => p.symbol);
    return { ok: true, missing };
  }

  // Restore the mirror NOW, synchronously — before practice-ui/replay run,
  // so no click can ever race the restore.
  {
    const local = loadLocal();
    if (local) state = local;
  }

  return {
    // helpers
    fmt, downloadFile, round2, round4,
    // state
    init, getState, totals, findPosition, onChange, onExternalChange, reloadFromLocal,
    getSlot, setSlot,
    // mutators
    createAccount, resetAccount, adjustCash, addPosition, removePosition,
    setStrategy, buy, sell, applyQuotes, applySignal,
    // persistence
    saveNow, exportText, importFromText, applyImport, storageInfo,
    linkSaveFile, reconnectSaveFile, unlinkSaveFile,
    idbGet, idbSet, idbDel, withTimeout,
    // data bridge + signals
    notifyDataLoaded, getMainData, ensureBars, getCachedBars, computeSignal, refreshSignals, refreshQuotes,
  };
})();
