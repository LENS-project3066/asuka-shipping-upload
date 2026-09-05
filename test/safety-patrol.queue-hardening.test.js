/**
 * 2026-09-05 の現場障害（安全パトロールで写真が送れない）への補修の回帰ガード。
 *
 * 【何が起きたか】電波の弱い所で:
 *   ① アップロードの fetch がハングし、`draining` が立ちっぱなしになって
 *      「今すぐ再送」も 15 秒間隔の自動再送も入口で弾かれた（クルクル回ったまま復帰不能）
 *   ② 再送が 15 秒 × 5 回 = 約 1 分で「送信できない」確定になり自動再送が止まった
 *   ③ 送信待ちバナー（position:fixed）が **送信ボタンを覆って押せなくなった**
 *   ④ 逃がす手が無く、残る操作が「破棄」だけ = 押すと原本ごと消える
 *      （撮影は capture 経由なのでカメラロールに写真は無い）
 *
 * 【方針】DOM/ブラウザ API が要る部分は jsdom を持たないこの環境では動かせないので、
 * **HTML の実文面を読んで、直した形が残っているかを固定する**。
 * ⚠⚠ これは「文字列が在るか」しか見ない弱い検定なので、⛔ 陽性対照を必ず併記して
 *    照合器に検出力があることを毎回撃つ（S869 の作法）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'safety-patrol.html'), 'utf8');

// ----------------------------------------------------------------
// 陽性対照: 照合器に検出力があること
// ----------------------------------------------------------------
test('陽性対照: 存在しない文字列は見つからない（照合器が素通しでない）', () => {
  assert.ok(SRC.length > 10000, 'HTML が読めていない');
  assert.ok(!SRC.includes('ZZZ_NOT_PRESENT_MARKER'), '照合器が常に true を返している');
});

// ----------------------------------------------------------------
// ① アップロードのタイムアウト（ハングで詰まない）
// ----------------------------------------------------------------
test('① 全リクエストにタイムアウトが掛かっている（AbortController で実際に切る）', () => {
  assert.match(SRC, /REQUEST_TIMEOUT_MS\s*=\s*\d+/, 'タイムアウト定数が無い');
  assert.match(SRC, /new AbortController\(\)/, 'AbortController を使っていない');
  // ⛔ Promise.race で見捨てる形は不可（死んだ通信が裏で帯域を食う）
  assert.match(SRC, /signal:\s*ctl\.signal/, 'signal を fetch に渡していない');
  // supabase の全リクエストに効かせていること（upload だけ差し替えても select が固まる）
  assert.match(SRC, /createClient\([\s\S]{0,200}global:\s*\{\s*fetch:\s*fetchWithTimeout/,
    'createClient に global.fetch を渡していない');
});

test('① タイムアウトは現場に伝わる言葉で残る（破棄ダイアログに出る文字列）', () => {
  assert.match(SRC, /AbortError[\s\S]{0,200}時間切れ/, 'AbortError を現場語に訳していない');
});

// ----------------------------------------------------------------
// ② 諦めない再送（知らせるしきい値と諦めるしきい値を分ける）
// ----------------------------------------------------------------
test('② 知らせる(WARN)と諦める(MAX)が別のしきい値になっている', () => {
  // ⚠ **`const` を要求する**。素の /MAX_RETRY\s*=\s*(\d+)/ だと、経緯を書いたコメント中の
  //   「旧版は MAX_RETRY=5 の 1 本で」に先に当たって **実装ではなく散文を検定してしまう**
  //   （実際に踏んだ）。宣言だけを見る形に締める。
  const warn = SRC.match(/const WARN_RETRY\s*=\s*(\d+)/);
  const max = SRC.match(/const MAX_RETRY\s*=\s*(\d+)/);
  assert.ok(warn, 'WARN_RETRY が無い');
  assert.ok(max, 'MAX_RETRY が無い');
  assert.ok(
    Number(max[1]) > Number(warn[1]),
    `諦めるしきい値(${max[1]})が知らせるしきい値(${warn[1]})より大きくない`
  );
  // 旧障害の再発ガード: 1 分で諦める値に戻していないこと
  assert.ok(Number(max[1]) >= 20, `MAX_RETRY=${max[1]} は小さすぎる（1分で永久停止に戻る）`);
});

test('② 再送間隔が段階的に伸びる（固定 8 秒に戻っていない）', () => {
  assert.match(SRC, /RETRY_DELAYS_MS\s*=\s*\[/, 'バックオフ表が無い');
  const arr = SRC.match(/RETRY_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
  const nums = arr[1].split(',').map((s) => Number(s.trim()));
  assert.ok(nums.length >= 3, '段階が少なすぎる');
  for (let i = 1; i < nums.length; i++) {
    assert.ok(nums[i] > nums[i - 1], `間隔が単調増加でない: ${nums.join(',')}`);
  }
  // ⛔ 旧実装の固定 8000ms に戻っていないこと
  assert.ok(!/retryTimer = setTimeout\([^)]*8000\)/.test(SRC), '固定 8 秒に戻っている');
});

test('② バナーは自動再送中に「送信できない」と言い切らない', () => {
  // ⚠ 言い切ると現場に「破棄するしかない」と誤解させて写真を消させる
  const banner = SRC.slice(SRC.indexOf('function renderQueueBanner'), SRC.indexOf('async function saveToDevice'));
  assert.ok(banner.length > 200, 'renderQueueBanner を切り出せていない');
  assert.ok(!banner.includes('✕ 送信できない'), 'バナーがまだ「送信できない」と言い切っている');
  assert.match(banner, /まだ送れていません/, '再送中である旨の文言が無い');
});

// ----------------------------------------------------------------
// ③ バナーが送信ボタンを覆わない
// ----------------------------------------------------------------
test('③ バナー表示中は本文の下に逃げ場を作る', () => {
  // ⚠⚠ **値まで見ること**。宣言の有無だけを見ていると `padding-bottom: 0px` でも緑になり、
  //    ボタンが覆われる状態を素通しする（変異注入で実際に素通しした）。
  const m = SRC.match(/body\.has-queue \.container\s*\{[^}]*padding-bottom:\s*(\d+)px/);
  assert.ok(m, '下余白の CSS が無い');
  const px = Number(m[1]);
  // バナーは bottom:14px + padding 11px*2 + 中身 ≒ 55px。ボタン 1 行ぶんの余裕を含めて 80px 以上。
  assert.ok(px >= 80, `下余白 ${px}px ではバナー(約55px)に覆われる`);
  assert.match(SRC, /classList\.toggle\('has-queue'/, 'has-queue を切り替えていない');
});

// ----------------------------------------------------------------
// ④ 逃がす手（端末に保存）— 破棄しか道が無い状態を作らない
// ----------------------------------------------------------------
test('④ 端末に保存の口がある（共有シート優先・ダウンロードに倒す）', () => {
  assert.match(SRC, /id="qbSave"/, '保存ボタンが無い');
  assert.match(SRC, /async function saveToDevice/, '保存処理が無い');
  assert.match(SRC, /navigator\.canShare/, 'iOS 向けの共有シート経路が無い');
  assert.match(SRC, /a\.download = f\.name/, 'ダウンロードのフォールバックが無い');
});

test('④ 保存ボタンは破棄より先に置く（逃がす手を先に見せる）', () => {
  const save = SRC.indexOf('id="qbSave"');
  const discard = SRC.indexOf('id="qbDiscard"');
  assert.ok(save > 0 && discard > 0, 'ボタンが見つからない');
  assert.ok(save < discard, '破棄が保存より先に出ている');
});

test('④ 破棄の確認は「カメラロールに無い」ことを言う', () => {
  const fn = SRC.slice(SRC.indexOf('async function discardFailed'));
  assert.match(fn, /写真アプリには残っていません/, '原本が消えることを伝えていない');
  assert.match(fn, /端末に保存/, '逃がす手を案内していない');
  // 破棄の対象は「知らせた分」= WARN。⛔ MAX に戻すとボタンが出ても何も消えない
  assert.match(fn, />=\s*WARN_RETRY/, '破棄のしきい値が WARN_RETRY でない');
});

// ----------------------------------------------------------------
// ⑤ 画質（寸法は削らない・品質だけ落とす）
// ----------------------------------------------------------------
test('⑤ 拡大表示のために寸法 2048 は維持し、品質だけ 0.8 にする', () => {
  assert.match(SRC, /MAX_EDGE\s*=\s*2048/, '寸法を削っている（PC の拡大は原本を読む）');
  const q = SRC.match(/JPEG_QUALITY\s*=\s*([\d.]+)/);
  assert.ok(q, 'JPEG_QUALITY が無い');
  assert.ok(Number(q[1]) <= 0.85 && Number(q[1]) >= 0.7, `品質 ${q[1]} が想定外`);
});
