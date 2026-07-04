'use strict';
/**
 * safety-patrol.html スモークテスト（依存ゼロ・Node 組込み node:test のみ）
 *
 * 2026-07-04 の実機障害の再発防止。当時 `init()` が IIFE 先頭(キュー系
 * `let _qdb`/`const idbPut` の定義より前)で呼ばれ、init 内の
 * probeIndexedDB()→openQueueDB() が TDZ の `_qdb` を同期参照して throw →
 * init 中断で idbPut 等が永久未初期化 → 送信押下で「保存に失敗」全端末。
 * 既存の「関数抽出+スタブ実行」検証は IIFE を通し実行しないため見逃した。
 *
 * このテストは <script> 本体を丸ごと実 JS エンジンで通し実行し、
 * (1) ロード時に初期化順序/TDZ の throw が出ないこと
 * (2) 正常な新規送信が enqueue 失敗(idbPut TDZ 含む)を起こさないこと
 * を検証する。ブラウザ非依存の軽量スタブ(jsdom/fake-indexeddb 不要)。
 *
 * 実行: `node --test`（この repo に npm 依存は追加しない）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'safety-patrol.html');

// ---- <script>(function(){...})</script> 本体を抽出 ----
function extractScript(html) {
  const lines = html.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('(function()'));
  const end = lines.findIndex((l, i) => i > start && l.includes('</script>'));
  assert.ok(start >= 0 && end > start, 'IIFE <script> ブロックを抽出できること');
  return lines.slice(start, end).join('\n');
}

// ---- 最小 DOM/ブラウザスタブ + 実 IIFE 通し実行ランナー ----
function runScript(scriptText, { savedLocation = 'honsha' } = {}) {
  const consoleErrors = [];
  const els = {};       // id -> element(同一 id は同一インスタンスを返す=状態を保持)
  const handlers = {};  // "id:event" -> fn

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

  const documentStub = {
    getElementById: (id) => makeEl(id),
    querySelector: (s) => makeEl(`q:${s}`),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(`el:${t}:${Math.random()}`),
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
      open(name) {
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

  const supaChain = () => {
    const p = Promise.resolve({ data: [], error: null });
    return new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return p.then.bind(p);
        if (prop === 'catch') return p.catch.bind(p);
        if (prop === 'finally') return p.finally.bind(p);
        return () => supaChain();
      },
      apply: () => supaChain(),
    });
  };
  const supabaseClient = {
    from: () => supaChain(),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  };

  const mkStorage = (init) => {
    const m = { ...init };
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
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
  const setTimeoutStub = (fn, ms) => { const t = globalThis.setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const clearTimeoutStub = (t) => globalThis.clearTimeout(t);

  let loadError = null;
  // 直接 eval: script 内の bare グローバル(window/document/…)は下記ローカルに束縛される。
  // Promise/queueMicrotask/Date/Math 等は Node 実グローバルをそのまま使う。
  (function (window, document, navigator, indexedDB, sessionStorage, localStorage,
             crypto, console, setInterval, setTimeout, clearTimeout, createImageBitmap, FileReader, location) {
    try {
      // eslint-disable-next-line no-eval
      eval(scriptText);
    } catch (e) {
      loadError = e;
    }
  })(windowStub, documentStub, navigatorStub, indexedDBStub, mkStorage({ safetyPatrolLocation: savedLocation }),
     mkStorage({}), cryptoStub, consoleStub, setIntervalStub, setTimeoutStub, clearTimeoutStub,
     undefined /* createImageBitmap: 未対応扱い→縮小スキップ */, FileReaderStub, { href: 'https://x/safety-patrol.html' });

  const fire = (id, ev, arg) => { const h = handlers[`${id}:${ev}`]; if (!h) throw new Error(`handler ${id}:${ev} 未登録`); return h(arg); };
  const enqueueFailed = () => consoleErrors.some((a) => String(a[0] || '').includes('enqueue('));

  return { loadError, consoleErrors, els, handlers, fire, enqueueFailed };
}

const delay = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

// =============================== テスト ===============================

test('IIFE がロード時に初期化順序/TDZ で throw しない (2026-07-04 障害の回帰ガード)', () => {
  const script = extractScript(fs.readFileSync(HTML_PATH, 'utf8'));
  const { loadError } = runScript(script);
  assert.strictEqual(
    loadError, null,
    `ロード時に例外が出た: ${loadError && loadError.name}: ${loadError && loadError.message}\n` +
    '→ init() を定義群より前で呼んでいないか / init から前方参照する let/const が無いか確認',
  );
});

test('正常な新規送信が enqueue 失敗(idbPut TDZ 含む)を起こさない', async () => {
  const script = extractScript(fs.readFileSync(HTML_PATH, 'utf8'));
  const h = runScript(script, { savedLocation: 'honsha' });
  assert.strictEqual(h.loadError, null, 'まずロードが成功していること');

  // 写真添付(change)→職場/コメント入力→送信(click)
  h.fire('newCameraInput', 'change', { target: { files: [{ name: 'photo.jpg', type: 'image/jpeg', size: 1234 }], value: '' } });
  h.els['workplaceSelect'].value = '1';
  h.els['commentInput'].value = 'スモークテスト';
  h.fire('newSendBtn', 'click');

  await delay(50); // enqueue(idbPut)→drain の microtask/擬似 IDB を流す
  assert.ok(!h.enqueueFailed(), `enqueue 失敗ログが出た: ${JSON.stringify(h.consoleErrors)}`);
});

test('ガードのteeth確認: init を定義前で呼ぶ同型パターンは throw を検出できる', () => {
  // このテスト自身が「初期化順序 TDZ」を検出できることの自己検証(実ファイルは触らない)
  const broken = `(function(){
    init();
    function init(){ return helper(); }
    const helper = () => queueVar;
    let queueVar = null;
  })();`;
  const { loadError } = runScript(broken);
  assert.ok(loadError && loadError.name === 'ReferenceError',
    '同型 TDZ パターンで ReferenceError を捕捉できること');
});
