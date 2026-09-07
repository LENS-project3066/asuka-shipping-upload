'use strict';
/**
 * 細い回線での送信ハードニング（2026-09-07・S877）の回帰ガード。
 *
 * 【何が起きたか】安全パトロール当日、黒鎺さんの iPhone から写真が送れず、現場が破棄した。
 *   実測で分かったのは:
 *     ・Storage には **1 枚も届いていなかった**（＝ Phase1 が 5 回以上失敗し続けた）
 *     ・サーバーは無実（anon 鍵で必ず失敗する insert を撃つと 23502/23505/23503 が正しく返る）
 *     ・縮小は効いていた（同日の写真は 1536x2048・EXIF 剥がれ済み）
 *     ・本番 HTML は最新（Service Worker 無し・キャッシュ説も外れ）
 *   ∴ 詰まっていたのは **iPhone ↔ Storage のネットワーク層**だけ。
 *
 * 【⚠⚠ 前回の対策の穴】2026-09-05 の対策は「同じ 400-600KB を粘って送り切る」方向
 *   （60→90 秒 / MAX_RETRY 50 / バックオフ）だけで、**送る量を 1 バイトも減らしていなかった**。
 *   ∴ 42kbps を下回る回線では何回粘っても構造的に完走しない。
 *
 * 【この回の設計】
 *   ① 「写真が着く」と「指摘が登録される」を切り離す ── 30-50KB のサムネを先に送って
 *      DB 行を確定させ、原寸は**同じパスへ後追い upsert**（PC もスキーマも改修不要）
 *   ② タイムアウトを壁時計から **無進捗** へ（XHR の upload.onprogress）
 *   ③ lastError を破棄ダイアログの外でも読めるように（前回は写真と一緒に原因も消えた）
 *
 * 【テストの規約】既存 queue-hardening と同じ ★1 値を見る / ★2 配線を見る /
 *   ★3 終端付きで切り出す / ★4 散文に当たらせない / ★5 陽性対照を置く。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'safety-patrol.html'), 'utf8');

/** ★3 関数本体を波括弧の対応で切り出す（終端付き）。 */
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

// ================================================================
// ★5 陽性対照
// ================================================================
test('陽性対照: 照合器に検出力がある', () => {
  assert.ok(SRC.length > 10000, 'HTML が読めていない');
  assert.ok(!SRC.includes('ZZZ_NOT_PRESENT_MARKER'), '照合器が常に true を返している');
  const b = fnBody('function needsFullUpload');
  assert.ok(b.length < 800, `fnBody が長すぎる(${b.length}) = 終端が効いていない`);
  assert.ok(!b.includes('async function processQueueItem'), 'fnBody が次の関数まで飲み込んでいる');
});

// ================================================================
// ① サムネ先行（送る量そのものを減らす）
// ================================================================
test('① サムネの寸法/品質が実用値（★1 値を見る）', () => {
  const edge = SRC.match(/const THUMB_EDGE\s*=\s*(\d+)/);
  assert.ok(edge, 'THUMB_EDGE が無い');
  const e = Number(edge[1]);
  // 小さすぎると「原寸が永久に届かない端末で最終画質がこれ」になり指摘が読めない。
  // 大きすぎると先行させる意味（データ量 1/10）が消える。
  assert.ok(e >= 480 && e <= 1024, `THUMB_EDGE=${e} が想定外（480-1024）`);
  const q = SRC.match(/const THUMB_QUALITY\s*=\s*([\d.]+)/);
  assert.ok(q, 'THUMB_QUALITY が無い');
  assert.ok(Number(q[1]) >= 0.5 && Number(q[1]) <= 0.75, `THUMB_QUALITY=${q[1]} が想定外`);
});

test('① サムネは原寸より必ず小さい設定になっている（先行させる意味がある）', () => {
  const te = Number(SRC.match(/const THUMB_EDGE\s*=\s*(\d+)/)[1]);
  const me = Number(SRC.match(/const MAX_EDGE\s*=\s*(\d+)/)[1]);
  assert.ok(te < me, `THUMB_EDGE(${te}) が MAX_EDGE(${me}) 以上 = 先行送信の意味が無い`);
});

test('① Phase1 はサムネがあればサムネを先に送る', () => {
  const fn = fnBody('async function processQueueItem');
  // ⛔ item.blob を直に送る形へ戻すと、この回の修正が丸ごと無効になる。
  assert.match(fn, /item\.thumbBlob\s*\|\|\s*item\.blob/, 'Phase1 がサムネを優先していない');
  assert.match(fn, /item\.storageUploaded\s*=\s*true/, '部分成功フラグを立てていない');
});

test('① makeThumb は原本にフォールバックしない（フォールバックすると 400KB を 2 回送る）', () => {
  const fn = fnBody('async function makeThumb');
  assert.match(fn, /return null/, '作れなかったときに null を返していない');
  // ⛔ `return file` を入れると「サムネのつもりで原寸を送る」形になり、細い回線で悪化する。
  assert.ok(!/return\s+file\s*;/.test(fn), 'makeThumb が原本にフォールバックしている');
  // 陽性対照: この否定検査に検出力があること（shrinkImage 側には実際に return file がある）
  assert.match(fnBody('async function shrinkImage'), /return\s+file\s*;/,
    '陽性対照が壊れている（shrinkImage は原本フォールバックを持つはず）');
});

// ⚠⚠ ここから 3 本は **呼び出し口**のガード（2026-09-07 に実際に踏んだ穴）。
//   Phase1/makeThumb/定数を全部テストしても、`thumbBlob:` を payload に載せる 1 行を
//   消すだけで機能は丸ごと死ぬのに **39/39 が緑のまま**だった（変異注入で確認）。
//   ＝「変異が赤くなった」は「その修正が守られている」を意味しない。
//   ⛔ この 3 本を消さないこと ── 消すとサムネ先行は「呼ばれない実装」になれる。
test('① submitNew が payload にサムネを載せる（呼び出し口のガード）', () => {
  const fn = fnBody('async function submitNew');
  assert.match(fn, /thumbBlob:\s*newThumb/, 'submitNew がサムネを渡していない');
});

test('① submitFollow が payload にサムネを載せる（呼び出し口のガード）', () => {
  const fn = fnBody('async function submitFollow');
  assert.match(fn, /thumbBlob:\s*followThumb/, 'submitFollow がサムネを渡していない');
});

test('① handlePhoto が撮影直後にサムネを作る（呼び出し口のガード）', () => {
  const fn = fnBody('function handlePhoto');
  assert.match(fn, /makeThumb\(file\)/, 'handlePhoto が makeThumb を呼んでいない');
  // ⛔ 縮小とサムネを別々の then に分けないこと ── 先に縮小が newFile を差し替えると、
  //   後から来たサムネ側の同一性判定が偽になり「差し替えられた」と誤判定して毎回捨てる。
  assert.match(fn, /Promise\.all\(\s*\[\s*shrinkImage\(file\)\s*,\s*makeThumb\(file\)\s*\]/,
    '縮小とサムネの判定が 1 箇所にまとまっていない');
});

test('① 原寸は「同じパス」へ後追いする（PC 改修を不要にしている核心）', () => {
  const fn = fnBody('async function processQueueItem');
  assert.match(fn, /needsFullUpload\(item\)/, 'Phase3 のゲートが無い');
  // ⛔ 別パス（_full 等）に保存する形へ変えると、PC の指摘ビューアが原寸を見つけられない。
  assert.match(fn, /uploadBlob\(item\.storagePath,\s*item\.blob/, '原寸を同じパスへ送っていない');
});

test('① 旧版で積まれた item に後追いを走らせない（同じ原寸を 2 回送らない）', () => {
  const fn = fnBody('function needsFullUpload');
  assert.match(fn, /if\s*\(!item\.thumbBlob\)\s*return false/,
    'thumbBlob を持たない旧 item を除外していない');
});

// ================================================================
// ② 無進捗タイムアウト（遅いだけの回線を殺さない）
// ================================================================
test('② 無進捗タイムアウトの値が実用的（★1 値を見る）', () => {
  const m = SRC.match(/const STALL_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(m, 'STALL_TIMEOUT_MS が無い');
  const v = Number(m[1]);
  // 短すぎると詰まりかけの回線を切ってしまい、長すぎると死んだ通信を掴んだままになる。
  assert.ok(v >= 15000 && v <= 60000, `STALL_TIMEOUT_MS=${v} が想定外（15-60 秒）`);
});

/**
 * ⚠⚠ **2026-09-07 夕に期待を訂正した**（⛔ 元の形へ戻さないこと）。
 * 旧テストは「`upload.addEventListener('progress', armStall)` と**書いてあるか**」しか見ておらず、
 * **本文を送り終えた後に張り直す口が 1 つも無い**ことも、**進捗を報告しない端末を
 * 「無進捗」と誤診して必ず abort する**ことも通していた。
 * 実際に黒鎺さんの iPhone で、サーバー側の痕跡ゼロのまま「📤 送信中…」で止まった。
 * ∴ 見るのは「どの関数名を渡したか」ではなく **①生存 signal を上り/下りの両方から拾うか
 * ②最初の 1 回が来るまで短い枠を当てないか** の 2 点にした。
 */
test('② 生存 signal のたびにタイマーを張り直す（上りの progress だけに頼らない）', () => {
  const fn = fnBody('function uploadWithProgress');
  // 上り: 進捗と「本文を送り終えた」の両方
  assert.match(fn, /upload\.addEventListener\(\s*['"]progress['"]/, '上りの progress を購読していない');
  assert.match(fn, /upload\.addEventListener\(\s*['"]load['"]/,
    '本文を送り終えた瞬間を購読していない = 応答待ちが壁時計に化ける');
  // 下り: 応答が動いていることも生存 signal
  assert.match(fn, /addEventListener\(\s*['"]readystatechange['"]/,
    '応答ヘッダの到着を購読していない');
  // 張り直しの実体（clear してから set）
  const arm = fn.slice(fn.indexOf('const armStall'));
  assert.match(arm, /clearStall\(\)/, 'タイマーを張り直す前に消していない');
  assert.match(arm, /setTimeout\(/, '無進捗タイマーを張っていない');
});

test('② 進捗が 1 度も来ていない間は短い枠を当てない（無イベントを無進捗と誤診しない）', () => {
  const m = SRC.match(/const NO_PROGRESS_FALLBACK_MS\s*=\s*(\d+)/);
  assert.ok(m, 'NO_PROGRESS_FALLBACK_MS が無い = 進捗を報告しない端末を殺す形に戻っている');
  const v = Number(m[1]);
  // ⛔ 旧版(supabase-js + 壁時計 90 秒)で Android は完走していた。それより短いと退行。
  assert.ok(v >= 90000, `NO_PROGRESS_FALLBACK_MS=${v} が短すぎる（旧版 90 秒より短いと退行）`);
  // ⚠⚠ **`armStall` の中だけ**を見ること。関数全体に当てると、同じ三項式を書いている
  //   中断メッセージの側に当たってしまい、**タイマーの武装が 30 秒固定に戻されても緑**になる
  //   （2026-09-07 に変異注入で実際に素通りした ── 共有の文字列に当てる照合の穴）。
  const fn = fnBody('function uploadWithProgress');
  const arm = fn.slice(fn.indexOf('const armStall'), fn.indexOf('const bump'));
  assert.ok(arm.length > 0, 'armStall の本体を切り出せていない（実装の形が変わった？）');
  assert.match(arm, /sawSignal\s*\?\s*STALL_TIMEOUT_MS\s*:\s*NO_PROGRESS_FALLBACK_MS/,
    'タイマーの武装が 2 つの枠を signal の有無で使い分けていない');
});

/**
 * ⚠⚠ **2026-09-07 夕に期待を反転した**（⛔ 元へ戻さないこと・訂正の経緯ごと残す）。
 * 旧テストは multipart 前提で「フィールド名が空文字であること」「**Content-Type を
 * 付けていないこと**」を固定していた。iPhone 2 台（黒鎺さん・石田君＝別人）で送信だけが
 * 通らず、Android は 4G/WiFi 両方で通ったので、旧版(supabase-js)と新版(XHR)に
 * **共通していた唯一の構造 = 空フィールド名の multipart** をやめ、生ボディにした。
 * ∴ 今は **Content-Type が必須**で、FormData は**使ってはいけない**。
 * サーバー側が生ボディを受けることは実物で確認済み
 * （juchu-system `scripts/probe-storage-raw-body.js`・200 / image/jpeg / max-age=60）。
 */
test('② Storage へ生ボディで送る（multipart に戻っていない）', () => {
  const fn = fnBody('function uploadWithProgress');
  assert.match(fn, /xhr\.open\(\s*['"]POST['"]/, 'POST でない');
  assert.match(fn, /storage\/v1\/object\//, 'Storage のエンドポイントでない');
  assert.match(fn, /setRequestHeader\(\s*['"]x-upsert['"]\s*,\s*['"]true['"]\s*\)/, 'x-upsert が無い');
  assert.match(fn, /setRequestHeader\(\s*['"]apikey['"]/, 'apikey が無い');
  // ⛔ FormData を使わない（iPhone で通らなかった形）
  assert.ok(!/new\s+FormData\s*\(/.test(fn), 'FormData を作っている = multipart に戻っている');
  assert.match(fn, /xhr\.send\(\s*blob\s*\)/, 'blob をそのまま送っていない');
  // ⛔ 生ボディでは Content-Type が必須（付け忘れても 200 は返るので失敗では気づけない）
  assert.match(fn, /setRequestHeader\(\s*['"]Content-Type['"]/i,
    'Content-Type を送っていない = 保存される型が化ける');
  // cacheControl はヘッダーへ移った
  assert.match(fn, /setRequestHeader\(\s*['"]cache-control['"]/i,
    'cache-control をヘッダーで送っていない（サムネが粗いままキャッシュされ続ける）');
});

test('② XHR が無い環境では supabase-js に倒す（機能を落とすだけで壊さない）', () => {
  const fn = fnBody('async function uploadBlob');
  assert.match(fn, /typeof XMLHttpRequest/, 'XHR の有無を見ていない');
  assert.match(fn, /supabase\.storage\.from\(BUCKET\)/, 'フォールバック経路が無い');
  assert.match(fn, /upsert:\s*true/, 'フォールバック側で upsert を落としている');
});

// ================================================================
// ③ 画質待ちを「送れていません」と言わない（嘘を出して破棄させない）
// ================================================================
test('③ 原寸だけ残った item は MAX_RETRY よりずっと早く降ろす', () => {
  const g = SRC.match(/const FULL_GIVEUP_RETRY\s*=\s*(\d+)/);
  assert.ok(g, 'FULL_GIVEUP_RETRY が無い');
  const max = Number(SRC.match(/const MAX_RETRY\s*=\s*(\d+)/)[1]);
  assert.ok(Number(g[1]) < max, `FULL_GIVEUP_RETRY(${g[1]}) が MAX_RETRY(${max}) 以上`);
  // ★2 配線: drain の失敗経路で実際に降ろしていること
  const fn = fnBody('async function drainQueueInner');
  assert.match(fn, /item\.dbDone\s*&&\s*item\.retryCount\s*>=\s*FULL_GIVEUP_RETRY/,
    '画質待ちの item を降ろす分岐が無い');
  assert.match(fn, /await idbDelete\(item\.id\)/, '降ろす実体（idbDelete）が無い');
});

test('③ バナーが画質待ちを危機的に見せない', () => {
  const fn = fnBody('function renderQueueBanner');
  assert.match(fn, /const allDbDone\s*=[\s\S]{0,120}every\(i\s*=>\s*i\.dbDone\)/,
    '画質待ちだけの状態を判定していない');
  assert.match(fn, /allDbDone\)\s*text\s*=/, '画質待ち専用の文言が無い');
  // ⛔ 赤くしない・逃がすボタンを出さない（写真は既にサーバーに在るので嘘になる）
  assert.match(fn, /toggle\(\s*['"]error['"]\s*,\s*!allDbDone/, '画質待ちで error を付けている');
  assert.match(fn, /qbSave\.classList\.toggle\([\s\S]{0,60}allDbDone\)/, '画質待ちで「端末に保存」を出している');
  assert.match(fn, /qbDiscard\.classList\.toggle\([\s\S]{0,60}allDbDone\)/, '画質待ちで「破棄」を出している');
});

// ================================================================
// ④ 失敗理由が破棄しなくても読める（前回は原因ごと消えた）
// ================================================================
test('④ バナーのタップで失敗理由を出す配線がある（★2 配線を見る）', () => {
  assert.match(SRC, /queueBanner\.addEventListener\(\s*['"]click['"]/,
    'バナーに click を配線していない = lastError がまた破棄ダイアログの中だけになる');
  const fn = fnBody('function showQueueErrors');
  assert.match(fn, /i\.lastError/, 'lastError を読んでいない');
  assert.match(fn, /setQueueNote\(/, '画面に出していない');
});

test('④ 表示タイマーが 1 本に束ねてある（長い表示が短い表示に巻き込まれない）', () => {
  const fn = fnBody('function setQueueNote');
  assert.match(fn, /clearTimeout\(queueNoteTimer\)/, 'タイマーを束ねていない');
  assert.match(fn, /ms\s*\|\|\s*\d+/, '表示時間を指定できない');
});

// ================================================================
// ⑤ 既存の裁定を壊していないこと（S869 の画質裁定と両立している）
// ================================================================
test('⑤ 原寸の寸法/品質は据え置き（サムネ導入は寸法削減ではない）', () => {
  const edge = Number(SRC.match(/const MAX_EDGE\s*=\s*(\d+)/)[1]);
  assert.ok(edge >= 2048, `MAX_EDGE=${edge} ── PC の拡大は原本を読むので寸法は削らない`);
  const q = Number(SRC.match(/const JPEG_QUALITY\s*=\s*([\d.]+)/)[1]);
  assert.ok(q >= 0.7 && q <= 0.85, `JPEG_QUALITY=${q} が S869 の裁定から外れている`);
});
