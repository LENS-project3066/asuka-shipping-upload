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
 * ⚠ ハーネス本体は 2026-09-07 に `./_harness.js` へ切り出した（送信フローを実行する
 *   upload-flow テストと共有するため）。**既定のスタブは従来どおり「画像 API も XHR も
 *   無い環境」**なので、このテストの射程は変わっていない。
 *   ⛔ ここで imageSupport/xhr を既定 ON にしないこと ── 「最小の端末でも落ちない」
 *      という、このテストが見ている性質が消える。
 *
 * 実行: `node --test`（この repo に npm 依存は追加しない）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractScript, runScript, delay } = require('./_harness');

const HTML_PATH = path.join(__dirname, '..', 'safety-patrol.html');

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
