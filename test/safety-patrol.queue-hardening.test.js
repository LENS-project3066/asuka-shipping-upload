/**
 * 2026-09-05 の現場障害（安全パトロールで写真が送れない）への補修の回帰ガード。
 *
 * 【何が起きたか】電波の弱い所で:
 *   ① アップロードの fetch がハングし、drain ループの `draining` が立ちっぱなしになって
 *      「今すぐ再送」も自動再送も入口で弾かれた（クルクル回ったまま復帰不能）
 *   ② 再送が約 1 分で「送信できない」確定になり自動再送が止まった
 *   ③ 送信待ちバナー（position:fixed）が **送信ボタンを覆って押せなくなった**
 *   ④ 逃がす手が無く、残る操作が「破棄」だけ = 押すと原本ごと消える
 *      （撮影は capture 経由なのでカメラロールに写真は無い）
 *
 * 【⚠⚠ このテストの経緯 ── 初版は変異注入 8/8 が緑だった】
 * 初版は「宣言が在るか」を正規表現で見るだけで、次の壊し方を**全部素通し**した:
 *   タイムアウト値を 1ms にする / abort タイマーを潰す / 保存ボタンの配線を消す /
 *   has-queue の toggle を早期 return の後ろへ動かす / 15 秒 tick を消す / 諦めを消す
 * ∴ 以下を規約として全テストに適用する:
 *   ★1 **値を見る**（宣言の有無で満足しない）
 *   ★2 **配線を見る**（`addEventListener` まで見る。関数の存在だけで満足しない）
 *   ★3 **終端付きで関数本体を切り出す**（`indexOf` から末尾まで取ると、下に足した瞬間
 *        黙って偽緑化する。`-1` を返したときも `slice(start,-1)` でほぼ全文が通る）
 *   ★4 **散文に当たらせない**（`const` を要求する。経緯コメントに実装の旧値が書いてある）
 *   ★5 **陽性対照を置く**（照合器が素通しでないことを毎回撃つ）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'safety-patrol.html'), 'utf8');

/**
 * ★3 関数本体を波括弧の対応で切り出す（終端付き）。
 * ⛔ `SRC.slice(SRC.indexOf(sig))` で末尾まで取る形に戻さないこと。
 */
function fnBody(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start >= 0, `関数が見つからない: ${signature}`);
  const open = SRC.indexOf('{', start);
  assert.ok(open >= 0, `本体が見つからない: ${signature}`);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  assert.fail(`本体の終端が見つからない: ${signature}`);
}

/** CSS/HTML ブロックを開始文字列と終了文字列で切り出す。 */
function block(from, to) {
  const s = SRC.indexOf(from);
  assert.ok(s >= 0, `見つからない: ${from}`);
  const e = SRC.indexOf(to, s);
  assert.ok(e > s, `終端が見つからない: ${to}`);
  return SRC.slice(s, e);
}

// ================================================================
// ★5 陽性対照
// ================================================================
test('陽性対照: 照合器に検出力がある', () => {
  assert.ok(SRC.length > 10000, 'HTML が読めていない');
  assert.ok(!SRC.includes('ZZZ_NOT_PRESENT_MARKER'), '照合器が常に true を返している');
  // fnBody が本当に「終端付き」で切れているか（末尾まで取っていないこと）
  const b = fnBody('function isAbortError');
  assert.ok(b.length < 1500, `fnBody が長すぎる(${b.length}) = 終端が効いていない`);
  assert.ok(!b.includes('async function saveToDevice'), 'fnBody が次の関数まで飲み込んでいる');
});

// ================================================================
// ① タイムアウト（ハングで詰まない）
// ================================================================
test('① タイムアウトは AbortController で実際に切る（見捨てない）', () => {
  const fn = fnBody('function fetchWithTimeout');
  assert.match(fn, /new AbortController\(\)/, 'AbortController を使っていない');
  // ⚠ `[^)]*` はアロー関数の `()` を跨げない。⛔ 識別子名に密結合させないこと（リネームで偽赤）。
  assert.match(fn, /setTimeout\([\s\S]{0,60}abort\(\)/, 'abort タイマーが無い');
  assert.match(fn, /signal:\s*\w+\.signal/, 'signal を fetch に渡していない');
  // ⛔ 呼び出し側の signal を捨てないこと（cross-review M-7）
  assert.match(fn, /init\.signal/, '呼び出し側の signal を束ねていない');
});

test('① タイムアウト値が実用的（★1 値を見る）', () => {
  // ⚠ 初版は 60 秒で、462KB を 60kbps で送ると 63.1 秒かかり**間に合わなかった**
  //    （バイト/ビット換算の誤り）。実測に耐える下限を要求する。
  const base = SRC.match(/const BASE_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(base, 'BASE_TIMEOUT_MS が無い');
  const ms = Number(base[1]);
  assert.ok(ms >= 90000, `${ms}ms では 462KB を弱電波で送り切れない（63秒超が必要）`);
  // 失敗を重ねた item ほど伸ばす
  assert.match(SRC, /const timeoutForAttempt\s*=/, '試行ごとの延長が無い');
  assert.match(fnBody('async function drainQueueInner'), /requestTimeoutMs = timeoutForAttempt/,
    'drain が試行回数をタイムアウトへ渡していない');
});

test('① abort 判定が supabase-js の包み直しを貫通する', () => {
  // ⚠ Storage は StorageUnknownError、PostgREST は PostgrestError で包むので
  //    `err.name === 'AbortError'` だけでは**一度も当たらない**（cross-review H-3）。
  const fn = fnBody('function isAbortError');
  assert.match(fn, /originalError/, 'originalError を辿っていない');
  assert.match(fn, /\/abort\/i/, 'message からの判定が無い');
  assert.match(fnBody('async function drainQueueInner'), /isAbortError\(/, 'drain が使っていない');
});

// ================================================================
// ② 諦めない再送（バックオフが実際にカデンツを支配する）
// ================================================================
test('② 知らせる(WARN)と諦める(MAX)が別のしきい値（★4 const を要求）', () => {
  const warn = SRC.match(/const WARN_RETRY\s*=\s*(\d+)/);
  const max = SRC.match(/const MAX_RETRY\s*=\s*(\d+)/);
  assert.ok(warn && max, 'しきい値の宣言が無い');
  assert.ok(Number(max[1]) > Number(warn[1]), '諦めるしきい値が知らせるしきい値より大きくない');
  assert.ok(Number(max[1]) >= 20, `MAX_RETRY=${max[1]} は小さすぎる（1分で永久停止に戻る）`);
});

test('② バックオフが実際に再送間隔を支配している（★1 飾りにしない）', () => {
  // ⚠⚠ 初版は RETRY_DELAYS_MS を scheduleRetry の遅延にしか使わず、
  //    `setInterval(drainQueue, 15000)` が無条件で叩くので **15 秒間隔のまま**だった。
  //    表が在るだけでは意味が無い ── **per-item のゲートが在るか**を見る。
  const drain = fnBody('async function drainQueueInner');
  assert.match(drain, /nextAttemptAt\s*&&\s*Date\.now\(\)\s*<\s*item\.nextAttemptAt/,
    'per-item の「次に試す時刻」ゲートが無い＝バックオフが効かない');
  assert.match(drain, /item\.nextAttemptAt = Date\.now\(\) \+ retryDelayFor/,
    '失敗時に次回時刻を書いていない');
  const arr = SRC.match(/const RETRY_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
  assert.ok(arr, 'バックオフ表が無い');
  const nums = arr[1].split(',').map((s) => Number(s.trim()));
  assert.ok(nums.length >= 3, '段階が少なすぎる');
  for (let i = 1; i < nums.length; i++) {
    assert.ok(nums[i] > nums[i - 1], `間隔が単調増加でない: ${nums.join(',')}`);
  }
});

test('② 定期 tick と諦めの両方が生きている（★1 消えたら再送が死ぬ）', () => {
  // ⚠ 変異注入で素通しした（M7）。`match` は「どこかに在るか」しか見ないので、
  //    ⛔ **呼び出しが実際に配線されているか**を init ブロックの中で見る。
  const init = fnBody('function init');
  assert.match(init, /setInterval\(drainQueue,\s*(\d+)\)/,
    'init に定期 tick が無い＝自動再送が消える');
  const tick = Number(init.match(/setInterval\(drainQueue,\s*(\d+)\)/)[1]);
  assert.ok(tick > 0 && tick <= 60000, `tick ${tick}ms が実用範囲外`);
  // online 復帰でも蹴ること（電波が戻った瞬間に動く唯一の経路）
  assert.match(init, /addEventListener\('online'[\s\S]{0,120}drainQueue\(\)/,
    'online 復帰で drain を蹴っていない');
  assert.match(fnBody('async function drainQueueInner'), />=\s*MAX_RETRY\)\s*continue/,
    '諦めのガードが消えている');
});

test('② 本当に諦めた分は「送信できない」と伝える（★新しい嘘を作らない）', () => {
  // ⚠⚠ 初版は「言い切るのをやめる」を徹底しすぎて、MAX 到達後も
  //    「電波の良い所で自動送信」と出し続けていた（cross-review H-2）。
  //    現場は良い場所へ移動して待つが永久に何も起きない＝障害の再演。
  const fn = fnBody('function renderQueueBanner');
  assert.match(fn, />=\s*MAX_RETRY\)\.length/, '諦めた件数(dead)を数えていない');
  assert.match(fn, /送信できない/, '諦めたことを伝える文言が無い');
  assert.match(fn, /まだ送れていません/, '再送中である旨の文言が無い');
  // 順序: dead を先に判定しないと warned に飲まれる
  assert.ok(fn.indexOf('送信できない') < fn.indexOf('まだ送れていません'),
    'dead の判定が warned より後ろにある＝諦めた分が warned に飲まれる');
});

// ================================================================
// ③ バナーが送信ボタンを覆わない
// ================================================================
test('③ 下余白はバナーの実高さに追従する（★固定値に戻さない）', () => {
  // ⚠⚠ 初版は 108px 固定で、同じコミットで足した 3 つ目のボタンに足りていなかった
  //    （cross-review M-1・肯定/否定の両レビュアーが独立に指摘）。
  const css = block('body.has-queue .container', '}');
  assert.match(css, /padding-bottom:\s*var\(--queue-pad,\s*(\d+)px\)/,
    '実測値を使っていない（固定値に戻っている）');
  const fallback = Number(css.match(/var\(--queue-pad,\s*(\d+)px\)/)[1]);
  assert.ok(fallback >= 140, `JS が動かない時の保険 ${fallback}px が薄い`);
  const fn = fnBody('function renderQueueBanner');
  assert.match(fn, /offsetHeight/, 'バナーの高さを測っていない');
  assert.match(fn, /setProperty\('--queue-pad'/, '測った値を反映していない');
});

test('③ has-queue のトグルが早期 return より前にある（★2 位置まで見る）', () => {
  const fn = fnBody('function renderQueueBanner');
  assert.match(fn, /classList\.toggle\('has-queue',\s*n\s*>\s*0\)/,
    'has-queue の条件が n>0 でない（false 固定でも通る形に戻っている）');
  const toggle = fn.indexOf("toggle('has-queue'");
  const early = fn.indexOf('if (n === 0)');
  assert.ok(toggle >= 0 && early >= 0, '判定箇所が見つからない');
  assert.ok(toggle < early, 'トグルが早期 return の後ろ＝0 件で余白が外れない');
});

test('③ バナーは折り返す（ボタンが増えても文字が細切れにならない）', () => {
  const css = block('.queue-banner {', '}');
  assert.match(css, /flex-wrap:\s*wrap/, 'nowrap のままだと文字側だけが潰れて縦に伸びる');
  assert.match(block('.qb-text {', '}'), /flex:\s*1 1 100%/, 'テキストが 1 行目を占有していない');
});

// ================================================================
// ④ 逃がす手（端末に保存）
// ================================================================
test('④ 保存ボタンが配線されている（★2 存在だけで満足しない）', () => {
  assert.match(SRC, /id="qbSave"/, '保存ボタンが無い');
  assert.match(SRC, /qbSave\.addEventListener\('click'[\s\S]{0,200}saveToDevice\(\)/,
    '保存ボタンが saveToDevice に配線されていない');
  // ⛔ void で握りつぶさない（最後の砦が無言で死ぬ）
  assert.ok(!/qbSave\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*void saveToDevice/.test(SRC),
    'void で Promise を捨てている＝失敗が無言');
  assert.match(SRC, /saveToDevice\(\)\.catch/, '例外を拾っていない');
});

test('④ 保存は結果を必ず画面に出す', () => {
  const fn = fnBody('async function saveToDevice');
  assert.match(fn, /setQueueNote\(/, '結果表示が無い');
  assert.match(fn, /保存できる写真がありませんでした/, '0 件のときの表示が無い');
  assert.match(fn, /しか保存できませんでした/, '部分成功を伝えていない');
});

test('④ ダウンロードのフォールバックが実際にクリックする', () => {
  // ⚠ 変異注入で素通しした（M6）。`a.click()` を消すと**何も落ちてこないのに
  //    「ダウンロードしました」と出る**＝最後の砦が嘘をつく。
  const fn = fnBody('async function saveToDevice');
  assert.match(fn, /a\.click\(\)/, 'ダウンロードの click が無い＝1 枚も保存されない');
  assert.match(fn, /a\.download\s*=/, 'download 属性が無い');
  assert.match(fn, /createObjectURL/, 'オブジェクト URL を作っていない');
  assert.match(fn, /revokeObjectURL/, '後始末が無い');
  // click が saved のカウントより前にあること（数えるだけで押していない形を防ぐ）
  assert.ok(fn.indexOf('a.click()') < fn.indexOf('saved++'), 'click せずに数えている');
});

test('④ 壊れた item を保存しない（9 バイトのゴミを作らない）', () => {
  // ⚠ `new File([undefined], …)` は throw せず文字列 "undefined" の 9 バイトを作る（実測）。
  const fn = fnBody('function buildSaveFiles');
  assert.match(fn, /blob instanceof Blob/, 'blob の実在を確かめていない');
  assert.match(fn, /typeof File !== 'function'/, 'File 非対応端末を見ていない');
  assert.match(fn, /createdAt/, '撮影順に並べていない');
});

test('④ 共有シートの前に await を挟まない（iOS のユーザー活性化）', () => {
  // ⚠ iOS Safari は await を跨ぐと navigator.share が NotAllowedError で落ちる。
  const fn = fnBody('function buildSaveFiles');
  assert.ok(!/await/.test(fn), 'buildSaveFiles に await がある＝iOS で共有が落ちる');
  const save = fnBody('async function saveToDevice');
  const firstAwait = save.indexOf('await');
  const share = save.indexOf('navigator.share(');
  assert.ok(share >= 0, 'navigator.share を使っていない');
  assert.ok(firstAwait > save.indexOf('buildSaveFiles'), '組み立ての前に await がある');
});

test('④ 保存ボタンは破棄より先に置く（逃がす手を先に見せる）', () => {
  const save = SRC.indexOf('id="qbSave"');
  const discard = SRC.indexOf('id="qbDiscard"');
  assert.ok(save > 0 && discard > 0, 'ボタンが見つからない');
  assert.ok(save < discard, '破棄が保存より先に出ている');
});

test('④ 破棄の確認は「カメラロールに無い」ことを言う', () => {
  const fn = fnBody('async function discardFailed');
  assert.match(fn, /写真アプリには残っていません/, '原本が消えることを伝えていない');
  assert.match(fn, /端末に保存/, '逃がす手を案内していない');
  assert.match(fn, />=\s*WARN_RETRY/, '破棄のしきい値が WARN_RETRY でない');
});

// ================================================================
// ⑤ DB 書き込みの取りこぼし
// ================================================================
test('⑤ 23505（重複）は成功として扱う', () => {
  // ⚠ storagePath は item の UUID 由来なので、重複＝自分の再送＝行は既に在る。
  //    throw すると送信待ちのまま retryCount を食い潰し、最後は現場に破棄させる。
  // ⚠ 2026-09-07 に DB 書き込みは processQueueItem から `writeDbRow` へ切り出した
  //    （処理自体は変えていない）。⛔ 照合先を processQueueItem に戻さないこと。
  const fn = fnBody('async function writeDbRow');
  assert.match(fn, /error\.code !== '23505'/, '23505 を失敗として扱っている');
  assert.match(fn, /error: dupErr/, '重複チェックの error を握り潰している');
});

// ================================================================
// ⑥ 画質（寸法は削らない・品質だけ落とす）
// ================================================================
test('⑥ 拡大表示のために寸法 2048 は維持し、品質だけ 0.8 にする', () => {
  const edge = SRC.match(/const MAX_EDGE\s*=\s*(\d+)/);
  assert.ok(edge && Number(edge[1]) >= 2048, '寸法を削っている（PC の拡大は原本を読む）');
  const q = SRC.match(/const JPEG_QUALITY\s*=\s*([\d.]+)/);
  assert.ok(q, 'JPEG_QUALITY が無い');
  assert.ok(Number(q[1]) <= 0.85 && Number(q[1]) >= 0.7, `品質 ${q[1]} が想定外`);
});
