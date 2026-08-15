// YORU女 自動投稿（オアシスグループ公式アカウント用）
// happ-s.com から出勤スケジュール・写メ日記・口コミを取得して投稿文を動的生成する。
// 認証情報は環境変数 YORUJO_GROUP_EMAIL / YORUJO_GROUP_PASSWORD から読む。
// 投稿タイプは JST の時刻から自動判定（POST_TYPE で上書き可）。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = "https://jofu-yorujo.com";
const SITE = "https://happ-s.com";
const STORE = "/s/yokohama"; // 横浜サイトが横浜・渋谷・錦糸町の3店をカバー
const STATE_PATH = fileURLToPath(new URL("./state-group.json", import.meta.url));
const DIR = path.dirname(STATE_PATH);

const email = process.env.YORUJO_GROUP_EMAIL;
const password = process.env.YORUJO_GROUP_PASSWORD;
const PUBLIC_ID = process.env.YORUJO_GROUP_ID || "";
if (!email || !password) {
  console.log("YORUJO_GROUP_EMAIL / YORUJO_GROUP_PASSWORD が未設定のためスキップします。");
  process.exit(0);
}

// ---- JST 時刻ユーティリティ ----
const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
const jstHour = jstNow.getUTCHours();
const jstMin = jstNow.getUTCMinutes();
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dateLabel = `${jstNow.getUTCMonth() + 1}/${jstNow.getUTCDate()}(${WEEKDAYS[jstNow.getUTCDay()]})`;

// 投稿タイプ: schedule(出勤) / diary(写メ日記) / review(口コミ) / now(今から入れる)
function typeFromHour(h) {
  if (h < 11) return "schedule";
  if (h < 15) return "diary";
  if (h < 19) return "review";
  if (h < 21) return "now";
  return "diary";
}
const POST_TYPE = process.env.POST_TYPE || typeFromHour(jstHour);
console.log(`投稿タイプ: ${POST_TYPE}（JST ${jstHour}:${String(jstMin).padStart(2, "0")}）`);

// ---- 状態（写メ日記・口コミの投稿済みID） ----
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { diary_posted: [], review_posted: [] };

const saveState = () =>
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

// ---- happ-s.com スクレイピング ----
const fetchHtml = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`取得失敗 ${r.status}: ${url}`);
  return r.text();
};
const strip = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

// 出勤スケジュール（本日）。今から入れる判定にも使う。
async function fetchSchedule() {
  const html = await fetchHtml(`${SITE}${STORE}/schedule/`);
  const blocks = html.match(/<li class="listpage_style">[\s\S]*?<\/li>/g) || [];
  const list = [];
  for (const b of blocks) {
    const name = b.match(/alt="([^"]+)"/)?.[1];
    const store = b.match(/【(.+?)】/)?.[1];
    const time = b.match(/listpage_prof_schdule">\s*([\d:]+)～([\d:]+)/);
    if (!name || !time) continue;
    if (time[1] === time[2]) continue; // 開始＝終了は出勤時間未設定とみなす
    list.push({ name, store: store || "", start: time[1], end: time[2] });
  }
  return list;
}
const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
// 深夜跨ぎを考慮したソートキー（早朝開始は翌日扱い）
const sortKey = (t) => {
  const m = toMin(t);
  return m < 360 ? m + 1440 : m;
};

// 写メ日記一覧
async function fetchDiaries() {
  const html = await fetchHtml(`${SITE}${STORE}/diary/`);
  const blocks = html.match(/<li[^>]*class="post">[\s\S]*?<\/li>/g) || [];
  return blocks
    .map((b) => {
      const id = b.match(/diary\/view\/(\d+)\//)?.[1];
      const alt = b.match(/alt="([^"]+)"/)?.[1] || "";
      const name = b.match(/class="notranslate">\s*([^<]+?)\s*</)?.[1];
      const tid = b.match(/therapist\/(\d+)\//)?.[1];
      const store = b.match(/【(.+?)】/)?.[1] || "";
      const up = b.match(/(\d{2})\/(\d{2}) \d{2}:\d{2}\s*UP/);
      if (!id || !name) return null;
      // 「更新されました」と告知するので直近2日以内の日記だけ対象にする
      if (up) {
        const posted = new Date(Date.UTC(jstNow.getUTCFullYear(), Number(up[1]) - 1, Number(up[2])));
        if (posted > jstNow) posted.setUTCFullYear(posted.getUTCFullYear() - 1); // 年跨ぎ
        if (jstNow - posted > 2 * 86400 * 1000) return null;
      }
      const title = alt.startsWith(name) ? alt.slice(name.length).trim() : alt;
      return { id, name, tid, store, title };
    })
    .filter(Boolean);
}

// セラピスト名簿（年齢の紐付け用）
async function fetchRoster() {
  const html = await fetchHtml(`${SITE}${STORE}/therapist/`);
  const blocks = html.match(/<li class="listpage_style">[\s\S]*?<\/li>/g) || [];
  const map = {};
  for (const b of blocks) {
    const tid = b.match(/therapist\/(\d+)\//)?.[1];
    const age = b.match(/(\d+)歳/)?.[1];
    if (tid && age) map[tid] = age;
  }
  return map;
}

// 口コミ一覧（新着順）
async function fetchReviews() {
  const html = await fetchHtml(`${SITE}${STORE}/review/`);
  const blocks = html.match(/<div class="review_box">[\s\S]*?<\/div><!-- \.review_box -->[\s\S]*?toggleFavorite\(this,'review',(\d+)\)/g) || [];
  const items = [];
  const re = /<div class="review_box">([\s\S]*?)toggleFavorite\(this,'review',(\d+)\)/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    const id = m[2];
    const reviewer = b.match(/class="review_name">([^<]+)</)?.[1];
    const score = b.match(/class="review_score">([^<]+)</)?.[1];
    const text = b.match(/class="review_text">\s*([\s\S]*?)<\/p>/)?.[1];
    if (!id || !reviewer || !text) continue;
    items.push({ id, reviewer, score: score || "", text: strip(text) });
  }
  return items;
}

// ---- 投稿文の組み立て ----
let caption = null;
let imagePath = null; // ローカル画像パス（任意）

const downloadImage = async (url, file) => {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const p = path.join(DIR, file);
  fs.writeFileSync(p, buf);
  return p;
};

const scheduleLines = (list) => {
  const stores = ["横浜", "渋谷", "錦糸町"];
  const parts = [];
  for (const s of stores) {
    const members = list
      .filter((t) => t.store === s)
      .sort((a, b) => sortKey(a.start) - sortKey(b.start));
    if (!members.length) continue;
    parts.push(
      `【${s}】\n` + members.map((t) => `${t.name} ${t.start}～${t.end}`).join("\n")
    );
  }
  // 店舗タグが取れなかった分も漏らさない
  const rest = list
    .filter((t) => !stores.includes(t.store))
    .sort((a, b) => sortKey(a.start) - sortKey(b.start));
  if (rest.length)
    parts.push(rest.map((t) => `${t.name} ${t.start}～${t.end}`).join("\n"));
  return parts.join("\n\n");
};

if (POST_TYPE === "schedule" || POST_TYPE === "now") {
  let list = await fetchSchedule();
  let header;
  if (POST_TYPE === "now") {
    const nowMin = jstHour * 60 + jstMin;
    const cur = nowMin < 360 ? nowMin + 1440 : nowMin;
    list = list.filter((t) => {
      let s = toMin(t.start);
      let e = toMin(t.end);
      if (e <= s) e += 1440; // 深夜跨ぎ
      const s2 = s < 360 ? s + 1440 : s;
      const e2 = e <= s2 ? e + 1440 : e;
      return s2 <= cur && cur < e2;
    });
    header = `🌙 ${dateLabel} オアシスグループ 今から入れるセラピスト`;
  } else {
    header = `🌙 ${dateLabel} オアシスグループ 本日の出勤セラピスト`;
  }
  if (!list.length) {
    console.log("該当セラピストがいないため投稿をスキップします。");
    process.exit(0);
  }
  caption = `${header}\n\n${scheduleLines(list)}\n\n全員の出勤・写真はこちら\n${SITE}${STORE}/schedule/`;
}

if (POST_TYPE === "diary") {
  const [diaries, roster] = await Promise.all([fetchDiaries(), fetchRoster()]);
  const next = diaries.find((d) => !state.diary_posted.includes(d.id));
  if (!next) {
    console.log("新しい写メ日記がないため投稿をスキップします。");
    process.exit(0);
  }
  const age = next.tid && roster[next.tid] ? ` (${roster[next.tid]}歳)` : "";
  caption = `📸 ${next.name}${age} の写メ日記が更新されました\n\n「${next.title}」\n\n${SITE}${STORE}/diary/view/${next.id}/`;
  imagePath = await downloadImage(`${SITE}/photo/syame_${next.id}_01.jpg`, "tmp-diary.jpg");
  state.diary_posted.push(next.id);
  state.diary_posted = state.diary_posted.slice(-200);
}

if (POST_TYPE === "review") {
  const reviews = await fetchReviews();
  const next = reviews.find((r) => !state.review_posted.includes(r.id));
  if (!next) {
    console.log("新しい口コミがないため投稿をスキップします。");
    process.exit(0);
  }
  const excerpt =
    next.text.replace(/\s+/g, " ").slice(0, 80) + (next.text.length > 80 ? "…" : "");
  const score = next.score ? ` / ${next.score}` : "";
  caption = `💬 お客様からの声（${next.reviewer}様${score}）\n\n「${excerpt}」\n\nほかの口コミはこちら\n${SITE}${STORE}/review/`;
  state.review_posted.push(next.id);
  state.review_posted = state.review_posted.slice(-200);
}

if (!caption) {
  console.error(`不明な投稿タイプ: ${POST_TYPE}`);
  process.exit(1);
}

console.log("---- 投稿文 ----");
console.log(caption);
console.log("----------------");

// 生成のみモード（ローカル確認用）
if (process.env.DRY_RUN) {
  if (imagePath) fs.unlinkSync(imagePath);
  console.log("DRY_RUN のため投稿せず終了します。");
  process.exit(0);
}

// ---- Playwright で投稿 ----
const { chromium } = await import("playwright");
const browser = await chromium.launch();
const context = await browser.newContext({
  locale: "ja-JP",
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();

try {
  const dismissAgeGate = async () => {
    const btn = page.getByRole("button", { name: /はい/ });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log("年齢確認ダイアログを閉じました");
    }
  };

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await dismissAgeGate();
  await page.getByPlaceholder("メールアドレス または ID").fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page
    .waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45000 })
    .catch(() => {});
  await dismissAgeGate();
  if (page.url().includes("/login")) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error("ログインに失敗しました。画面の表示: " + bodyText.slice(0, 300));
  }
  console.log("ログイン成功");

  await page.goto(`${BASE}/posts/new`, { waitUntil: "networkidle" });
  await dismissAgeGate();
  if (page.url().includes("/login")) {
    throw new Error("投稿ページに入れませんでした（ログインが維持されていない）");
  }
  await page.locator('textarea[name="caption"]').fill(caption);

  if (imagePath) {
    await page.locator("#post-new-media-upload").setInputFiles(imagePath);
    await page.waitForFunction(
      () => document.querySelector('input[name="media_id"]')?.value !== "",
      { timeout: 60000 }
    );
    console.log("画像アップロード完了");
    await page.waitForTimeout(3000);
  }

  const getPostCount = () =>
    page.evaluate(async (pid) => {
      const r = await fetch(`/api/client/users/${pid}/profile`);
      const d = await r.json();
      return d?.data?.post_count ?? -1;
    }, PUBLIC_ID);
  const before = PUBLIC_ID ? await getPostCount() : -1;
  console.log("現在の投稿数:", before);

  await page.getByRole("button", { name: "投稿", exact: true }).click();

  let ok = !PUBLIC_ID; // public_id 未設定時は従来判定できないので待機のみ
  for (let i = 0; i < 20 && PUBLIC_ID; i++) {
    await page.waitForTimeout(3000);
    const now = await getPostCount().catch(() => -1);
    if (now > before) {
      ok = true;
      break;
    }
  }
  if (!PUBLIC_ID) await page.waitForTimeout(10000);
  if (!ok) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error(
      `投稿が反映されませんでした。URL: ${page.url()} 画面: ${bodyText.slice(0, 300)}`
    );
  }
  console.log("投稿完了");
  saveState();
} catch (err) {
  console.error("投稿に失敗しました:", err.message);
  await page.screenshot({ path: "error.png" }).catch(() => {});
  process.exit(1);
} finally {
  if (imagePath) fs.unlinkSync(imagePath);
  await browser.close();
}
