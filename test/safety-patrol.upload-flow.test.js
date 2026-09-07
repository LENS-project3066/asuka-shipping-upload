'use strict';
/**
 * 送信フローを **実行して** 検証する（2026-09-07・S877）。
 *
 * 【なぜ静的検査では足りないか】このリポの他のテストはソースを正規表現で見る方式で、
 * 「書かれているか」は分かるが「**その順序で動くか**」「**サムネの方が本当に小さいか**」は
 * 分からない。2026-09-07 の詰まりは現場で初めて見つかった ── 実行して確かめる層が要る。
 *
 * 【何を実行で確かめるか】
 *   ① Phase1 で送られるのが**サムネ**（＝原寸より小さい）であること
 *   ② DB 書き込みが **Phase1 の後・Phase3 の前**に来ること（業務価値が先に確定する）
 *   ③ Phase3 が**同じパス**へ原寸を送ること（PC 改修を不要にしている核心）
 *   ④ XHR が無い端末では supabase-js に倒れ、**1 回で**送り切ること（従来動作）
 *   ⑤ 画像 API が無い端末ではサムネを作らず、原寸を **1 回だけ**送ること
 *
 * ⚠ スタブの canvas は「面積 × 品質」に比例した擬似サイズを返す。⛔ ここを固定値に
 *   変えないこと ── サムネと原寸の大小関係が再現できなくなり、①が常に緑になる。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractScript, runScript, delay } = require('./_harness');

const HTML_PATH = path.join(__dirname, '..', 'safety-patrol.html');
const SCRIPT = extractScript(fs.readFileSync(HTML_PATH, 'utf8'));

/** 3MB 相当の擬似原本（iPhone/Android のカメラ原本の大きさ感）。 */
function makeSourceFile() {
  return new File([new Uint8Array(3 * 1024 * 1024)], 'photo.jpg', { type: 'image/jpeg' });
}

/** 新規指摘を 1 件送って drain が落ち着くまで待つ。 */
async function submitOne(opts) {
  const h = runScript(SCRIPT, opts);
  assert.strictEqual(h.loadError, null, `ロードで落ちた: ${h.loadError && h.loadError.message}`);
  h.fire('newCameraInput', 'change', { target: { files: [makeSourceFile()], value: '' } });
  await delay(30); // 縮小とサムネ生成(裏)を流す
  h.els['workplaceSelect'].value = '1';
  h.els['commentInput'].value = '実行テスト';
  h.fire('newSendBtn', 'click');
  await delay(120); // enqueue → drain → Phase1/2/3
  return h;
}

/** FormData から本体 Blob を取り出す（フィールド名は空文字）。 */
function bodyBlob(rec) {
  assert.ok(rec.body && typeof rec.body.get === 'function', 'FormData で送っていない');
  const b = rec.body.get('');
  assert.ok(b, 'FormData のフィールド名が空文字でない（サーバーが本体を見つけられない）');
  return b;
}

// ================================================================
// ★ 陽性対照 ── ハーネスに検出力があること
// ================================================================
test('陽性対照: 画像 API と XHR を与えれば実際に送信が走る', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  assert.ok(h.xhrCalls.length > 0, 'アップロードが 1 回も走っていない = ハーネスが動いていない');
  assert.ok(h.dbCalls.length > 0, 'DB 書き込みが 1 回も走っていない');
});

// ================================================================
// ① サムネ先行（送る量が実際に減っている）
// ================================================================
test('① Phase1 で送られるのはサムネで、原寸よりはっきり小さい', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  assert.strictEqual(h.xhrCalls.length, 2, `送信回数が 2 回でない: ${h.xhrCalls.length}`);
  const first = bodyBlob(h.xhrCalls[0]);
  const second = bodyBlob(h.xhrCalls[1]);
  assert.ok(first.size < second.size,
    `1 回目(${first.size}B)が 2 回目(${second.size}B)より小さくない = サムネ先行が効いていない`);
  // ⚠ 「少し小さい」では意味が無い。指摘の登録に要る通信量を桁で減らすのが目的。
  assert.ok(first.size * 5 < second.size,
    `サムネが原寸の 1/5 より大きい(${first.size}B vs ${second.size}B) = 先行させる効果が薄い`);
});

test('① サムネのキャッシュは短命、原寸は通常（差し替えが見えるようにする）', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  const c1 = h.xhrCalls[0].body.get('cacheControl');
  const c2 = h.xhrCalls[1].body.get('cacheControl');
  assert.ok(Number(c1) < Number(c2),
    `サムネの cacheControl(${c1}) が原寸(${c2}) 以上 = 粗いままキャッシュされ続ける`);
});

// ================================================================
// ② 業務価値が先に確定する（DB 書き込みの位置）
// ================================================================
test('② DB 書き込みは Phase1 の後・Phase3 の前に来る', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  assert.strictEqual(h.dbCalls.length, 1, `DB 書き込みが 1 回でない: ${h.dbCalls.length}`);
  // `at` = その時点で完了していたアップロード回数。1 なら「サムネの後・原寸の前」。
  assert.strictEqual(h.dbCalls[0].at, 1,
    `DB 書き込みの位置が想定外(at=${h.dbCalls[0].at}) = 原寸を待ってから登録している`);
  assert.strictEqual(h.dbCalls[0].op, 'insert', 'new なのに insert していない');
});

// ================================================================
// ③ 原寸は同じパスへ後追い（PC 改修を不要にしている核心）
// ================================================================
test('③ 2 回とも同じ URL へ送る（別パスに分けていない）', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  assert.strictEqual(h.xhrCalls[0].url, h.xhrCalls[1].url,
    'サムネと原寸が別パス = PC の指摘ビューアが原寸を見つけられない');
  assert.match(h.xhrCalls[0].url, /\/storage\/v1\/object\/quality-docs\/safety-patrol\//,
    'Storage のパスが想定と違う');
});

test('③ 上書きの意思表示（x-upsert）を毎回送っている', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true });
  for (const c of h.xhrCalls) {
    assert.strictEqual(c.method, 'POST', 'POST でない');
    assert.strictEqual(c.headers['x-upsert'], 'true', 'x-upsert が true でない = 原寸で上書きできない');
    assert.ok(c.headers['apikey'], 'apikey が無い');
    assert.ok(/^Bearer /.test(c.headers['Authorization'] || ''), 'Authorization が Bearer でない');
  }
});

// ================================================================
// ④⑤ 環境が欠けていても壊れない（機能を落とすだけ）
// ================================================================
test('④ XHR が無い端末では supabase-js に倒れて送れる', async () => {
  const h = await submitOne({ imageSupport: true, xhr: false });
  assert.ok(h.xhrCalls.length > 0, 'フォールバックでも送れていない');
  assert.ok(h.xhrCalls.every(c => c.via === 'supabase-js'), 'XHR 無しなのに XHR 経路を通っている');
  assert.ok(h.dbCalls.length > 0, 'フォールバック時に DB 書き込みが走っていない');
});

test('⑤ 画像 API が無い端末はサムネを作らず、原寸を 1 回だけ送る', async () => {
  const h = await submitOne({ imageSupport: false, xhr: true });
  // createImageBitmap が無い＝ shrinkImage も makeThumb も効かない＝原本をそのまま 1 回。
  assert.strictEqual(h.xhrCalls.length, 1,
    `送信回数が 1 回でない(${h.xhrCalls.length}) = サムネ無しなのに後追いが走っている`);
  assert.ok(h.dbCalls.length > 0, 'DB 書き込みが走っていない');
});

test('⑤ アップロードが失敗する端末では DB を書かない（写真が無いのに指摘だけ残さない）', async () => {
  const h = await submitOne({ imageSupport: true, xhr: true, xhrStatus: 500 });
  assert.ok(h.xhrCalls.length > 0, 'アップロードを試みていない');
  assert.strictEqual(h.dbCalls.length, 0,
    'Phase1 が失敗したのに DB 行を作っている = 写真の無い指摘が一覧に出る');
});
