// YORU女 自動投稿（湊あおいアカウント用・ストックレス版）
// happ-s.com（横浜/渋谷/錦糸町）のセラピスト一覧・口コミから、投稿のたびに文面を動的生成する。
// 事前ストック（queue/posts.json）は使わない。
// 認証情報は環境変数 YORUJO_EMAIL / YORUJO_PASSWORD から読む。
// 投稿タイプは JST の時刻から自動判定（POST_TYPE=therapist|review で上書き可）。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = "https://jofu-yorujo.com";
const SITE = "https://happ-s.com";
const STATE_PATH = fileURLToPath(new URL("./state-aoi.json", import.meta.url));
const GROUP_STATE_PATH = fileURLToPath(
  new URL("./state-group.json", import.meta.url)
);
const DIR = path.dirname(STATE_PATH);

const PUBLIC_ID = "minatoaoi";
const SELF_TID = "35"; // 湊あおい本人。紹介ローテから除外する
const COOLDOWN_DAYS = 10; // 同じセラピストを再紹介するまでの間隔

const email = process.env.YORUJO_EMAIL;
const password = process.env.YORUJO_PASSWORD;
if (!email || !password) {
  console.error("環境変数 YORUJO_EMAIL / YORUJO_PASSWORD が未設定です。");
  process.exit(1);
}

// ---- JST 時刻 ----
const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
const jstHour = jstNow.getUTCHours();

// 投稿タイプ: therapist(紹介) / review(口コミ)
// JST 6,10,14,18,22時 → 紹介優先 / 8,12,16,20,24時 → 口コミ優先。
// 優先タイプにネタが無ければもう片方、それも無ければスキップ。
const therapistFirst = jstHour % 4 === 2;
const FORCED = process.env.POST_TYPE || "";
console.log(
  `JST ${jstHour}時台 / 優先タイプ: ${FORCED || (therapistFirst ? "therapist" : "review")}`
);

// ---- 状態 ----
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { review_posted: [], therapist_posted: {} };
state.review_posted ||= [];
state.therapist_posted ||= {};
const groupState = fs.existsSync(GROUP_STATE_PATH)
  ? JSON.parse(fs.readFileSync(GROUP_STATE_PATH, "utf8"))
  : { review_posted: [] };
const saveState = () =>
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

// ---- happ-s.com 取得 ----
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const fetchHtml = async (url) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "user-agent": UA } });
    if (r.ok) return r.text();
    if (i < 2) await sleep(15000);
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

// セラピスト一覧（横浜/渋谷/錦糸町の全員が1ページに載っている）
async function fetchTherapists() {
  const html = await fetchHtml(`${SITE}/s/yokohama/therapist/`);
  const blocks = html.match(/<li class="listpage_style">[\s\S]*?<\/li>/g) || [];
  return blocks
    .map((b) => {
      const id = b.match(/therapist\/(\d+)\//)?.[1];
      const rawName = b
        .match(/listpage_profile_name notranslate">([^<]+)</)?.[1]
        ?.trim();
      if (!id || !rawName) return null;
      const name = rawName.replace(/[(（].*$/, "").trim();
      const rank =
        b.match(/listpage_profile_rank[^>]*>([^<]+)</)?.[1]?.trim() || "";
      const store = b.match(/【(.+?)】/)?.[1] || "";
      const age = b.match(/(\d{2})歳/)?.[1] || "";
      const height = b.match(/身長:(\d{3})cm/)?.[1] || "";
      const reviews = b.match(/口コミ（(\d+)件）/)?.[1] || "";
      const ps = [...b.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => strip(m[1]));
      const catchcopy =
        ps.find((t) => t && !t.includes("歳") && !t.includes("口コミ")) || "";
      return { id, name, rank, store, age, height, reviews, catchcopy };
    })
    .filter(Boolean);
}

// 口コミ一覧（横浜サイト＝3店舗分）
async function fetchReviews() {
  const html = await fetchHtml(`${SITE}/yokohama/review/`);
  const re =
    /therapist\/(\d+)\/">([^<]+)<\/a>[\s\S]*?class="wr_data">([^<]+)<[\s\S]*?class="review_name">([^<]+)<[\s\S]*?(?:class="review_score">([^<]+)<[\s\S]*?)?class="review_text">\s*([\s\S]*?)<\/p>[\s\S]*?toggleFavorite\(this,'review',(\d+)\)/g;
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    items.push({
      tid: m[1],
      tname: m[2].trim().replace(/[(（].*$/, ""),
      date: m[3].trim(),
      reviewer: m[4].trim(),
      score: (m[5] || "").trim(),
      text: strip(m[6]),
      id: m[7],
    });
  }
  return items.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---- 投稿文テンプレート（湊あおい＝代表の声。乱暴な呼び方・ハッシュタグは使わない） ----
const tUrl = (id) => `${SITE}/s/yokohama/therapist/${id}/`;

function therapistCaption(t) {
  const rankLine = t.rank ? `${t.rank}ランク。` : "";
  const catchLine = t.catchcopy ? `\n「${t.catchcopy}」\n` : "\n";
  const reviewLine = t.reviews
    ? `口コミも${t.reviews}件いただいています。`
    : "";
  const templates = [
    `${t.store}店の${t.name}を紹介します。\n\n${t.age}歳・${t.height}cm。${rankLine}${catchLine}\n${reviewLine}\nプロフィールはこちら🌿\n${tUrl(t.id)}`,
    `うちの自慢のメンバー紹介。\n\n${t.name}（${t.store}）です。\n${t.age}歳・${t.height}cm。${catchLine}\n気になった方はプロフィールをどうぞ✨\n${tUrl(t.id)}`,
    `本日のピックアップは${t.store}店の${t.name}。\n\n${t.age}歳・${t.height}cm。${rankLine}${catchLine}\n${reviewLine}\n${tUrl(t.id)}`,
    `${t.name}、${t.store}店にいます。\n\n${t.age}歳・${t.height}cm。${catchLine}\n代表として自信を持っておすすめできるメンバーです☺️\n${tUrl(t.id)}`,
  ];
  return templates[Number(t.id) % templates.length];
}

function reviewCaption(r) {
  const excerpt =
    r.text.replace(/\s+/g, " ").slice(0, 90) + (r.text.length > 90 ? "…" : "");
  const templates = [
    `${r.tname}にこんな口コミが届きました。\n\n「${excerpt}」\n\nこういう声が一番嬉しいです🙇\n${r.reviewer}様、ありがとうございます。\n\n${r.tname}のプロフィール👇\n${tUrl(r.tid)}`,
    `お客様の声を紹介します。\n\n${r.tname}へ\n「${excerpt}」\n\n嬉しい口コミは、セラピスト本人にも必ず共有しています☺️\n\n${tUrl(r.tid)}`,
    `口コミをチェックしていたら、${r.tname}に嬉しい声が。\n\n「${excerpt}」\n\n代表として鼻が高いです。\n${r.reviewer}様、ありがとうございました🌿\n\n${tUrl(r.tid)}`,
  ];
  return templates[Number(r.id) % templates.length];
}

// ---- ネタ選定 ----
let caption = null;
let imageTid = null; // 添付する宣材写真のセラピストID
let onPosted = () => {};

async function pickTherapist() {
  const list = (await fetchTherapists()).filter((t) => t.id !== SELF_TID);
  console.log(`セラピスト一覧: ${list.length}名`);
  const now = jstNow.getTime();
  const eligible = list.filter((t) => {
    const last = state.therapist_posted[t.id];
    return !last || now - new Date(last).getTime() > COOLDOWN_DAYS * 86400 * 1000;
  });
  if (!eligible.length) return false;
  // 紹介が一番昔（未紹介が最優先）のメンバーから
  eligible.sort((a, b) => {
    const la = state.therapist_posted[a.id] || "";
    const lb = state.therapist_posted[b.id] || "";
    return la < lb ? -1 : 1;
  });
  const t = eligible[0];
  caption = therapistCaption(t);
  imageTid = t.id;
  onPosted = () => {
    state.therapist_posted[t.id] = jstNow.toISOString();
  };
  return true;
}

async function pickReview() {
  const reviews = await fetchReviews();
  console.log(`口コミ取得: ${reviews.length}件`);
  const next = reviews.find(
    (r) =>
      !state.review_posted.includes(r.id) &&
      !(groupState.review_posted || []).includes(r.id) // グループ公式と同じ口コミを重複投稿しない
  );
  if (!next) return false;
  caption = reviewCaption(next);
  imageTid = next.tid;
  onPosted = () => {
    state.review_posted.push(next.id);
    state.review_posted = state.review_posted.slice(-300);
  };
  return true;
}

const order = FORCED
  ? [FORCED]
  : therapistFirst
    ? ["therapist", "review"]
    : ["review", "therapist"];
for (const type of order) {
  const ok = type === "therapist" ? await pickTherapist() : await pickReview();
  if (ok) {
    console.log(`投稿タイプ確定: ${type}`);
    break;
  }
  console.log(`${type}: 投稿できるネタがありません`);
}

if (!caption) {
  console.log("投稿ネタがないため今回はスキップします。");
  process.exit(0);
}

console.log("---- 投稿文 ----");
console.log(caption);
console.log("----------------");

// 宣材写真をダウンロード（404なら画像なしで投稿）
let imagePath = null;
if (imageTid) {
  try {
    const r = await fetch(`${SITE}/photo/wid_${imageTid}_01.jpg`, {
      headers: { "user-agent": UA },
    });
    if (r.ok) {
      const p = path.join(DIR, "tmp-aoi.jpg");
      fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      imagePath = p;
      console.log("宣材写真を取得しました");
    } else {
      console.log("宣材写真がないため画像なしで投稿します");
    }
  } catch {
    console.log("写真取得に失敗したため画像なしで投稿します");
  }
}

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
    throw new Error(
      "ログインに失敗しました。画面の表示: " + bodyText.slice(0, 300)
    );
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
  const before = await getPostCount();
  console.log("現在の投稿数:", before);

  await page.getByRole("button", { name: "投稿", exact: true }).click();

  let ok = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const now = await getPostCount().catch(() => -1);
    if (now > before) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error(
      `投稿が反映されませんでした。URL: ${page.url()} 画面: ${bodyText.slice(0, 300)}`
    );
  }
  console.log("投稿完了");
  onPosted();
  saveState();
} catch (err) {
  console.error("投稿に失敗しました:", err.message);
  await page.screenshot({ path: "error.png" }).catch(() => {});
  process.exit(1);
} finally {
  if (imagePath) fs.unlinkSync(imagePath);
  await browser.close();
}
