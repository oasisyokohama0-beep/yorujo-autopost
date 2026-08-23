// YORU女 自動投稿（オアシスグループ公式アカウント用）
// happ-s.com 全店舗の「写メ日記」「口コミ」「全国ポイントランキング」から投稿文を動的生成する。
// 認証情報は環境変数 YORUJO_GROUP_EMAIL / YORUJO_GROUP_PASSWORD から読む。
// 投稿タイプは JST の時刻から自動判定（POST_TYPE で上書き可）。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = "https://jofu-yorujo.com";
const SITE = "https://happ-s.com";
const STATE_PATH = fileURLToPath(new URL("./state-group.json", import.meta.url));
const DIR = path.dirname(STATE_PATH);

// オアシス全店舗（happ-s.com のパス → 表示名）
const STORES = {
  tokyo: "東京本店",
  shibuya: "渋谷店",
  shinjyuku: "新宿店",
  kabukicho: "歌舞伎町店",
  ikebukuro: "池袋店",
  akiba: "アキバ店",
  shinokubo: "新大久保店",
  kinshicho: "錦糸町店",
  roppongi: "六本木店",
  yokohama: "横浜店",
  omiya: "大宮店",
  osaka: "大阪店",
  nagoya: "名古屋店",
  fukuoka: "福岡店",
  global: "グローバル店",
  ueno: "上野店",
};

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
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dateLabel = `${jstNow.getUTCMonth() + 1}/${jstNow.getUTCDate()}(${WEEKDAYS[jstNow.getUTCDay()]})`;

// 投稿タイプ: schedule(全店出勤) / diary(写メ日記) / ranking(全国ポイントランキング)
// JST 10〜24時の毎正時に1本。10時=全店出勤、20時=ランキング、それ以外は写メ日記
function typeFromHour(h) {
  if (h === 10) return "schedule";
  if (h === 20) return "ranking";
  return "diary";
}
const POST_TYPE = process.env.POST_TYPE || typeFromHour(jstHour);
console.log(`投稿タイプ: ${POST_TYPE}（JST ${jstHour}時台）`);

// ---- 状態（写メ日記・口コミの投稿済みID） ----
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { diary_posted: [], review_posted: [] };
state.diary_posted ||= [];
state.review_posted ||= [];

const saveState = () =>
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

// ---- happ-s.com スクレイピング ----
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const fetchHtml = async (url) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "user-agent": UA } });
    if (r.ok) return r.text();
    if (i < 2) await sleep(15000); // レート制限らしき応答は待って再試行
  }
  throw new Error(`取得失敗: ${url}`);
};
const strip = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
// /s/yokohama/... → /yokohama/...（本店アカウントが使っている短い形に揃える）
const shortPath = (p) => p.replace(/^\/s\//, "/");

// 全店舗の本日の出勤（各店の schedule ページを巡回、therapist id で重複排除）
async function fetchAllSchedules() {
  const seen = new Set();
  const list = [];
  let fetched = 0;
  for (const [slug, storeName] of Object.entries(STORES)) {
    let html;
    try {
      html = await fetchHtml(`${SITE}/${slug}/schedule/`);
      fetched++;
      await sleep(1000);
    } catch {
      continue;
    }
    // ページにより2種類のマークアップがある（listpage_style / top_sch_li）
    const blocks = [
      ...(html.match(/<li class="listpage_style">[\s\S]*?<\/li>/g) || []),
      ...(html.match(/<li class="top_sch_li">[\s\S]*?<\/li>/g) || []),
    ];
    for (const b of blocks) {
      const tid = b.match(/therapist\/(\d+)\//)?.[1];
      const name = b.match(/alt="([^"]+)"/)?.[1];
      const store = b.match(/【(.+?)】/)?.[1] || storeName;
      const time = b.match(/(?:listpage_prof_schdule|list_prof_schdule)">\s*([\d:]+)～([\d:]+)/);
      if (!tid || !name || !time) continue;
      if (time[1] === time[2]) continue; // 開始＝終了は出勤時間未設定とみなす
      if (seen.has(tid)) continue;
      seen.add(tid);
      list.push({ tid, name, store, start: time[1], end: time[2] });
    }
  }
  if (fetched === 0) throw new Error("全店舗の出勤取得に失敗しました（レート制限の可能性）");
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

// 写メ日記一覧（このフィードは全店舗横断）
async function fetchDiaries() {
  const html = await fetchHtml(`${SITE}/s/yokohama/diary/`);
  const blocks = html.match(/<li[^>]*class="post">[\s\S]*?<\/li>/g) || [];
  return blocks
    .map((b) => {
      const href = b.match(/href="([^"]*diary\/view\/(\d+)\/)"/);
      const alt = b.match(/alt="([^"]+)"/)?.[1] || "";
      const name = b.match(/class="notranslate">\s*([^<]+?)\s*</)?.[1];
      const tHref = b.match(/href="([^"]*therapist\/\d+\/)"/)?.[1];
      const store = b.match(/【(.+?)】/)?.[1] || "";
      const up = b.match(/(\d{2})\/(\d{2}) \d{2}:\d{2}\s*UP/);
      if (!href || !name) return null;
      // 「更新されました」と告知するので直近2日以内の日記だけ対象にする
      if (up) {
        const posted = new Date(Date.UTC(jstNow.getUTCFullYear(), Number(up[1]) - 1, Number(up[2])));
        if (posted > jstNow) posted.setUTCFullYear(posted.getUTCFullYear() - 1); // 年跨ぎ
        if (jstNow - posted > 2 * 86400 * 1000) return null;
      }
      const title = alt.startsWith(name) ? alt.slice(name.length).trim() : alt;
      const tid = tHref?.match(/therapist\/(\d+)\//)?.[1];
      return { id: href[2], url: `${SITE}${shortPath(href[1])}`, name, tHref, tid, store, title };
    })
    .filter(Boolean);
}

// セラピスト個別ページから年齢を取る（取れなければ null）
async function fetchAge(tHref) {
  if (!tHref) return null;
  try {
    const html = await fetchHtml(`${SITE}${tHref}`);
    return html.match(/(\d{2})歳/)?.[1] || null;
  } catch {
    return null;
  }
}

// 口コミ（全店舗を巡回して新着順に集める）
async function fetchReviews() {
  const items = [];
  let fetched = 0;
  for (const [slug, storeName] of Object.entries(STORES)) {
    let html;
    try {
      html = await fetchHtml(`${SITE}/${slug}/review/`);
      fetched++;
      await sleep(1000); // 連続アクセスでレート制限を踏まないように間隔を空ける
    } catch {
      continue;
    }
    const re =
      /therapist\/(\d+)\/">([^<]+)<\/a>[\s\S]*?class="wr_data">([^<]+)<[\s\S]*?class="review_name">([^<]+)<[\s\S]*?(?:class="review_score">([^<]+)<[\s\S]*?)?class="review_text">\s*([\s\S]*?)<\/p>[\s\S]*?toggleFavorite\(this,'review',(\d+)\)/g;
    let m;
    while ((m = re.exec(html))) {
      items.push({
        tid: m[1],
        tname: m[2].trim(),
        date: m[3].trim(),
        reviewer: m[4].trim(),
        score: (m[5] || "").trim(),
        text: strip(m[6]),
        id: m[7],
        slug,
        storeName,
      });
    }
  }
  if (fetched === 0) throw new Error("全店舗の口コミ取得に失敗しました（レート制限の可能性）");
  return items.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// 全国ポイントランキング（デイリー）
async function fetchRanking() {
  const html = await fetchHtml(`${SITE}/s/yokohama/all_ranking/?range=daily`);
  const box = html.match(/<div class="ranking_box">[\s\S]*?<\/ul>/)?.[0] || html;
  const re =
    /class="ranking_number">(\d+)<[\s\S]*?<img src="([^"]+)"[\s\S]*?class="r_name">([^<]+)<[\s\S]*?totalranking_area">(?:<span[^>]*>)?([^<]*)<[\s\S]*?class="r_point">[\s\S]*?<\/i>([\d,]+)</g;
  const list = [];
  let m;
  while ((m = re.exec(box))) {
    list.push({ rank: m[1], img: m[2], name: m[3].trim(), store: m[4].trim(), point: m[5] });
  }
  return list;
}

// ---- 投稿文の組み立て ----
let caption = null;
let imagePath = null; // ローカル画像パス（任意）

const downloadImage = async (url, file) => {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const p = path.join(DIR, file);
    fs.writeFileSync(p, buf);
    return p;
  } catch {
    return null;
  }
};

if (POST_TYPE === "schedule") {
  const list = await fetchAllSchedules();
  if (!list.length) {
    console.log("出勤情報が取得できなかったため投稿をスキップします。");
    process.exit(0);
  }
  // 店舗の表示順（タグ表記ゆれも吸収）
  const ORDER = ["東京本店", "渋谷", "新宿", "歌舞伎町", "池袋", "アキバ", "新大久保", "錦糸町", "六本木", "横浜", "大宮", "大阪", "名古屋", "福岡", "Global", "グローバル", "上野"];
  const norm = (s) => (s.endsWith("本店") ? s : s.replace(/店$/, ""));
  const groups = new Map();
  for (const t of list) {
    const key = norm(t.store);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const header = `🌙 ${dateLabel} オアシス全店舗 本日の出勤セラピスト`;
  const footer = `全店の出勤・写真はこちら\n${SITE}/top/schedule/`;
  const build = (compact) =>
    keys
      .map((k) => {
        const members = groups.get(k).sort((a, b) => sortKey(a.start) - sortKey(b.start));
        const body = compact
          ? members.map((t) => t.name).join("・")
          : members.map((t) => `${t.name} ${t.start}～${t.end}`).join("\n");
        return `【${k}】\n${body}`;
      })
      .join("\n\n");
  let bodyText = build(false);
  if ((header + bodyText + footer).length > 1800) bodyText = build(true); // 長すぎる場合は名前だけの簡易表記
  caption = `${header}\n\n${bodyText}\n\n${footer}`;
  if (caption.length > 1950) caption = caption.slice(0, 1900) + "…\n\n" + footer;
}

if (POST_TYPE === "diary") {
  const diaries = await fetchDiaries();
  const next = diaries.find((d) => !state.diary_posted.includes(d.id));
  if (!next) {
    console.log("新しい写メ日記がないため投稿をスキップします。");
    process.exit(0);
  }
  const age = await fetchAge(next.tHref);
  const ageLabel = age ? ` (${age}歳)` : "";
  const storeLabel = next.store ? `【${next.store}】` : "";
  caption = `📸 ${storeLabel}${next.name}${ageLabel} の写メ日記が更新されました\n\n「${next.title}」\n\n${next.url}`;
  imagePath = await downloadImage(`${SITE}/photo/syame_${next.id}_01.jpg`, "tmp-diary.jpg");
  // 日記に写真がない場合は本人のプロフィール写真を添付する
  if (!imagePath && next.tid) {
    imagePath = await downloadImage(`${SITE}/photo/wid_${next.tid}_01.jpg`, "tmp-diary.jpg");
  }
  state.diary_posted.push(next.id);
  state.diary_posted = state.diary_posted.slice(-300);
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
  caption = `💬 お客様からの声（${next.reviewer}様${score} / ${next.storeName}）\n\n${next.tname}へ\n「${excerpt}」\n\nほかの口コミはこちら\n${SITE}/${next.slug}/review/`;
  imagePath = await downloadImage(`${SITE}/photo/wid_${next.tid}_01.jpg`, "tmp-diary.jpg");
  state.review_posted.push(next.id);
  state.review_posted = state.review_posted.slice(-300);
}

if (POST_TYPE === "ranking") {
  const list = await fetchRanking();
  if (list.length < 3) {
    console.log("ランキングが取得できなかったため投稿をスキップします。");
    process.exit(0);
  }
  const top = list.slice(0, 10);
  const lines = top
    .map((t) => `${t.rank}位 ${t.name}（${t.store}）${t.point}pt`)
    .join("\n");
  caption = `👑 ${dateLabel} オアシス全国ポイントランキング TOP10\n\n${lines}\n\nランキングの続きはこちら\n${SITE}/top/all_ranking/`;
  imagePath = await downloadImage(`${SITE}${top[0].img}`, "tmp-diary.jpg");
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

  let ok = !PUBLIC_ID; // public_id 未設定時は投稿数での判定ができないので待機のみ
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
