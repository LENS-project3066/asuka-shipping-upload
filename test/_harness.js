'use strict';
/**
 * safety-patrol.html の <script> を **実 JS エンジンで通し実行**するためのハーネス。
 *
 * もとは smoke テストの中に閉じていたものを、2026-09-07 に切り出して共有した
 * （送信フローを実行して検証する upload-flow テストからも使うため）。
 *
 * 【なぜ「実行」するのか】このリポの他のテストはソースを正規表現で検査する静的方式で、
 * 「書かれているか」は見られるが「**動くか**」は見られない。初期化順序(TDZ)や
 * Phase の順序、サムネと原寸の大小関係は、実行しないと捕まらない。
 *
 * ⚠ `node --test` は test/ 配下の .js を全部拾うので、このファイルも「テスト 0 件の
 *   ファイル」として 1 件カウントされる（実行結果に `✔ test\_harness.js` が出る）。
 *   害は無い ── むしろ構文エラーや top-level の throw があれば赤くなるので有用。
 *
 * 【スタブの方針】既定は最小（= 画像 API もXHR も無い環境）。必要なテストだけが
 * `imageSupport` / `xhr` を有効にする。⛔ 既定を変えないこと ── smoke テストは
 * 「画像 API が無い端末でも落ちない」ことを見ているので、既定で有効にすると射程が変わる。
 */
const assert = require('node:assert');

/** <script>(function(){...})</script> 本体を抽出する。 */
function extractScript(html) {
  const lines = html.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('(function()'));
  const end = lines.findIndex((l, i) => i > start && l.includes('</script>'));
  assert.ok(start >= 0 && end > start, 'IIFE <script> ブロックを抽出できること');
  return lines.slice(start, end).join('\n');
}

/**
 * 最小 DOM/ブラウザスタブ + 実 IIFE 通し実行ランナー。
 *
 * @param {string} scriptText            実行する <script> 本体
 * @param {object} [opts]
 * @param {string} [opts.savedLocation]  localStorage に入っている拠点
 * @param {boolean} [opts.imageSupport]  createImageBitmap / canvas を生やす（縮小経路を通す）
 * @param {number}  [opts.imageWidth]    createImageBitmap が返す寸法
 * @param {number}  [opts.imageHeight]
 * @param {boolean} [opts.xhr]           XMLHttpRequest を生やす（アップロード経路を通す）
 * @param {number}  [opts.xhrStatus]     XHR が返すステータス（既定 200）
 */
function runScript(scriptText, opts = {}) {
  const {
    savedLocation = 'honsha',
    imageSupport = false,
    imageWidth = 4032,
    imageHeight = 3024,
    xhr = false,
    xhrStatus = 200,
  } = opts;

  const consoleErrors = [];
  const els = {};       // id -> element(同一 id は同一インスタンスを返す=状態を保持)
  const handlers = {};  // "id:event" -> fn
  const xhrCalls = [];  // 実際に送られたアップロード要求
  const dbCalls = [];   // 実際に撃たれた insert/update
  const timerWaits = []; // setTimeout に渡された待ち時間(ms) の記録
  const canvasOps = []; // canvas への drawImage の呼び方（縮小の段数と補間の質）

  const makeEl = (id) => {
    if (els[id]) return els[id];
    const el = {
      id, value: '', textContent: '', innerHTML: '', src: '', disabled: false,
      dataset: {}, style: {}, files: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(ev, fn) { handlers[`${id}:${ev}`] = fn; },
      removeEventListener() {},
      click() { const h = handlers[`${id}:click`]; if (h) h(); },
      appendChild() {}, removeChild() {}, remove() {},
      setAttribute() {}, removeAttribute() {}, scrollIntoView() {},
      querySelector() { return makeEl(`${id}__q`); }, querySelectorAll() { return []; },
      closest() { return null; },
    };
    els[id] = el;
    return el;
  };

  // canvas スタブ。⚠ toBlob は **面積と品質に比例した擬似サイズ**を返す ──
  //   「サムネが原寸より小さい」を実行で確かめたいので、大小関係が再現できないと無意味。
  const makeCanvas = () => {
    const c = {
      width: 0, height: 0,
      // ⚠ 縮小の**質**が仕様になったので（2026-09-07: iOS の既定補間が粗く、1 発で
      //   大きく縮めるとノイズを拾ってザラつく）、drawImage の呼び方を記録する。
      //   ⛔ no-op に戻さないこと ── 戻すと「補間 high」も「段階的縮小」も検定できない。
      getContext: () => {
        const ctx = {
          drawImage(_src, _x, _y, w, h) {
            canvasOps.push({ w, h, smoothing: ctx.imageSmoothingEnabled, quality: ctx.imageSmoothingQuality });
          },
        };
        return ctx;
      },
      toBlob: (cb, type, q) => {
        const bytes = Math.max(1, Math.round(c.width * c.height * (q || 0.8) * 0.25));
        cb(new Blob([new Uint8Array(bytes)], { type: type || 'image/jpeg' }));
      },
    };
    return c;
  };

  const documentStub = {
    getElementById: (id) => makeEl(id),
    querySelector: (s) => makeEl(`q:${s}`),
    querySelectorAll: () => [],
    createElement: (t) => (t === 'canvas' && imageSupport ? makeCanvas() : makeEl(`el:${t}:${Math.random()}`)),
    addEventListener() {},
    get body() { return makeEl('body'); },
  };

  // 動く最小 IndexedDB(open→transaction→put/getAll/delete が success を返す)
  const makeIDB = () => {
    const stores = {};
    const store = (n) => (stores[n] || (stores[n] = new Map()));
    const req = (op) => {
      const r = {};
      queueMicrotask(() => {
        try { r.result = op(); r.onsuccess && r.onsuccess({ target: r }); }
        catch (e) { r.error = e; r.onerror && r.onerror({ target: r }); }
      });
      return r;
    };
    return {
      // ⚠ テストから「実際に IndexedDB へ何が入ったか」を見るための口（2026-09-07 追加）。
      //   写真を Blob のまま入れると iOS で読み戻せない疑いがあり、**入れた形そのもの**が
      //   仕様になった。⛔ 消さないこと。
      _stores: stores,
      open() {
        const r = {};
        queueMicrotask(() => {
          const db = {
            objectStoreNames: { contains: (n) => n in stores },
            createObjectStore: (n) => { store(n); return {}; },
            transaction: (n) => {
              const s = store(n);
              const os = {
                put: (item) => req(() => { s.set(item.id, item); return item.id; }),
                get: (k) => req(() => s.get(k)),
                getAll: () => req(() => [...s.values()]),
                delete: (k) => req(() => { s.delete(k); }),
              };
              const tx = { _c: null, _e: null, _a: null, _err: null };
              const txObj = { objectStore: () => os };
              Object.defineProperty(txObj, 'oncomplete', {
                set(v) { tx._c = v; queueMicrotask(() => tx._c && tx._c()); }, get() { return tx._c; },
              });
              Object.defineProperty(txObj, 'onerror', { set(v) { tx._e = v; }, get() { return tx._e; } });
              Object.defineProperty(txObj, 'onabort', { set(v) { tx._a = v; }, get() { return tx._a; } });
              Object.defineProperty(txObj, 'error', { get() { return tx._err; } });
              return txObj;
            },
          };
          r.result = db;
          r.onupgradeneeded && r.onupgradeneeded({ target: r });
          r.onsuccess && r.onsuccess({ target: r });
        });
        return r;
      },
    };
  };
  const indexedDBStub = makeIDB();

  // supabase チェーン。⚠ insert/update は **記録する** ── 「DB 書き込みが Phase1 と
  //   Phase3 の間に来ているか」を順序で確かめたいので、素通しでは足りない。
  const supaChain = () => {
    const p = Promise.resolve({ data: [], error: null });
    return new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return p.then.bind(p);
        if (prop === 'catch') return p.catch.bind(p);
        if (prop === 'finally') return p.finally.bind(p);
        return (...args) => {
          if (prop === 'insert' || prop === 'update') {
            dbCalls.push({ op: prop, args, at: xhrCalls.length });
          }
          return supaChain();
        };
      },
      apply: () => supaChain(),
    });
  };
  const supabaseClient = {
    from: () => supaChain(),
    storage: {
      from: () => ({
        upload: async (path, blob) => { xhrCalls.push({ via: 'supabase-js', path, size: blob && blob.size }); return { error: null }; },
        remove: async () => ({ error: null }),
      }),
    },
  };

  const mkStorage = (init) => {
    const m = { ...init };
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
  };

  // XHR スタブ。open/setRequestHeader/send を記録し、progress→load を発火する。
  const XHRStub = class {
    constructor() {
      this._headers = {};
      this._listeners = {};
      this.upload = { addEventListener: (ev, fn) => { this._listeners[`upload:${ev}`] = fn; } };
      this.status = 0;
      this.responseText = '';
    }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    addEventListener(ev, fn) { this._listeners[ev] = fn; }
    abort() { const f = this._listeners.abort; if (f) f(); }
    send(body) {
      const rec = { via: 'xhr', method: this._method, url: this._url, headers: this._headers, body, progress: 0 };
      xhrCalls.push(rec);
      queueMicrotask(() => {
        const p = this._listeners['upload:progress'];
        if (p) { rec.progress++; p({ loaded: 1, total: 2 }); }
        this.status = xhrStatus;
        this.responseText = xhrStatus === 200 ? '{"Key":"k","Id":"i"}' : '{"message":"boom"}';
        const l = this._listeners.load;
        if (l) l();
      });
    }
  };

  const windowStub = {
    supabase: { createClient: () => supabaseClient },
    indexedDB: indexedDBStub,             // probeIndexedDB は window.indexedDB を見る
    crypto: { randomUUID: () => 'id-' + Math.random().toString(16).slice(2) },
    addEventListener() {},
    navigator: { onLine: true },
  };
  const navigatorStub = { onLine: true, locks: undefined };
  const cryptoStub = windowStub.crypto;
  const consoleStub = { error: (...a) => consoleErrors.push(a), log() {}, warn() {}, info() {} };
  const FileReaderStub = class { readAsDataURL() { if (this.onload) this.onload({ target: { result: 'data:,' } }); } };
  // 15s drain interval でプロセスを生かし続けない / retry/probe タイマーもテストを止めない
  const setIntervalStub = () => 0;
  // ⚠ 張られたタイマーの **待ち時間** を記録する（2026-09-07 追加）。アップロードの
  //   無進捗タイマーは「何秒で武装したか」が仕様そのもの ── 進捗イベントを報告しない
  //   端末に短い枠を当てると、実際は送れているのに毎回 abort する（黒鎺さんの iPhone）。
  //   実時間を待たずに検証できるよう ms を残す。⛔ 既定の挙動は変えていない。
  const setTimeoutStub = (fn, ms) => { timerWaits.push(ms); const t = globalThis.setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const clearTimeoutStub = (t) => globalThis.clearTimeout(t);
  const createImageBitmapStub = imageSupport
    ? async () => ({ width: imageWidth, height: imageHeight, close() {} })
    : undefined;

  let loadError = null;
  // 直接 eval: script 内の bare グローバル(window/document/…)は下記ローカルに束縛される。
  // Promise/queueMicrotask/Date/Math 等は Node 実グローバルをそのまま使う。
  (function (window, document, navigator, indexedDB, sessionStorage, localStorage,
             crypto, console, setInterval, setTimeout, clearTimeout, createImageBitmap, FileReader, location,
             XMLHttpRequest) {
    try {
      // eslint-disable-next-line no-eval
      eval(scriptText);
    } catch (e) {
      loadError = e;
    }
  })(windowStub, documentStub, navigatorStub, indexedDBStub, mkStorage({ safetyPatrolLocation: savedLocation }),
     mkStorage({}), cryptoStub, consoleStub, setIntervalStub, setTimeoutStub, clearTimeoutStub,
     createImageBitmapStub, FileReaderStub, { href: 'https://x/safety-patrol.html' },
     xhr ? XHRStub : undefined);

  const fire = (id, ev, arg) => { const h = handlers[`${id}:${ev}`]; if (!h) throw new Error(`handler ${id}:${ev} 未登録`); return h(arg); };
  const enqueueFailed = () => consoleErrors.some((a) => String(a[0] || '').includes('enqueue('));

  /** IndexedDB に実際に入っている行（キューの中身をそのまま見る）。 */
  const idbRows = () => Object.values(indexedDBStub._stores).flatMap((m) => [...m.values()]);

  return { loadError, consoleErrors, els, handlers, fire, enqueueFailed, xhrCalls, dbCalls, timerWaits, idbRows, canvasOps };
}

const delay = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

module.exports = { extractScript, runScript, delay };
