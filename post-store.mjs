// YORU女 自動投稿（店舗アカウント用・横浜／渋谷／錦糸町）
// happ-s.com の店舗ページから「写メ日記」「口コミ」「在籍セラピスト紹介」「月間ポイントランキング」を
// 取得して投稿文を動的生成する。1本のスクリプトを環境変数で店舗切り替えして使う。
//
//   STORE           … yokohama / shibuya / kinshicho
//   YORUJO_EMAIL    … その店舗アカウントのログインメール
//   YORUJO_PASSWORD … そのパスワード
//   YORUJO_ID       … 公開ID（投稿成功判定に使う。未設定でも動くが判定は甘くなる）
//   POST_TYPE       … diary / review / therapist / ranking（空なら JST 時刻から自動判定）
//   DRY_RUN         … 1 なら投稿せず本文だけ表示

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = "https://jofu-yorujo.com";
const SITE = "https://happ-s.com";
const DIR = path.dirname(fileURLToPath(import.meta.url));

// 店舗定義（slug → 表示名 / 日記フィードの絞り込みID /【店舗】タグ）
const STORES = {
  yokohama: { name: "オアシス横浜店", shopId: 15, tag: "横浜" },
  shibuya: { name: "オアシス渋谷店", shopId: 16, tag: "渋谷" },
  kinshicho: { name: "オアシス錦糸町店", shopId: 19, tag: "錦糸町" },
};

const SLUG = process.env.STORE || "";
const STORE = STORES[SLUG];
if (!STORE) {
  console.error(`STORE が不正です: "${SLUG}"（${Object.keys(STORES).join(" / ")}）`);
  process.exit(1);
}

const email = process.env.YORUJO_EMAIL;
const password = process.env.YORUJO_PASSWORD;
const PUBLIC_ID = process.env.YORUJO_ID || "";
if (!email || !password) {
  console.log(`${STORE.name}: YORUJO_EMAIL / YORUJO_PASSWORD が未設定のためスキップします。`);
  process.exit(0);
}

// ---- JST 時刻 ----
const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
const jstHour = jstNow.getUTCHours();
const todayStr = jstNow.toISOString().slice(0, 10);
const monthLabel = `${jstNow.getUTCMonth() + 1}月`;

// 投稿タイプ: JST 11時 日記 / 13時 口コミ / 19時 在籍紹介 / 21時 ランキング（5日に1回）
function typeFromHour(h) {
  if (h < 12) return "diary";
  if (h < 16) return "review";
  if (h < 20) return "therapist";
  return "ranking";
}

// ---- 状態（投稿済みID・前回ランキング投稿日） ----
const STATE_PATH = path.join(DIR, `state-${SLUG}.json`);
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : {};
state.diary_posted ||= [];
state.review_posted ||= [];
state.therapist_posted ||= [];
state.ranking_last ||= "";
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
// 「KANEKI(ｶﾈｷ)」→「KANEKI」。半角カナの読み仮名は投稿文では落とす
const cleanName = (s) => s.replace(/\s*\([ｦ-ﾟ\s]+\)\s*$/, "").trim();
// /s/yokohama/... → /yokohama/...（共有しやすい短いURLに揃える）
const shortPath = (p) => p.replace(/^\/s\//, "/");

// 写メ日記（店舗で絞り込んだフィード）
async function fetchDiaries() {
  const html = await fetchHtml(
    `${SITE}/s/${SLUG}/diary/?select_shop_id=${STORE.shopId}`
  );
  const blocks = html.match(/<li[^>]*class="post">[\s\S]*?<\/li>/g) || [];
  return blocks
    .map((b) => {
      const href = b.match(/href="([^"]*diary\/view\/(\d+)\/)"/);
      const name = b.match(/class="notranslate">\s*([^<]+?)\s*</)?.[1];
      // h3 の見出しは途中で切れるので、alt（「名前 タイトル」形式）からフルタイトルを取る
      const alt = b.match(/alt="([^"]*)"/)?.[1] || "";
      const title =
        (name && alt.startsWith(name) ? alt.slice(name.length).trim() : alt) ||
        b.match(/<h3><a[^>]*>([^<]+)<\/a><\/h3>/)?.[1]?.trim();
      const age = b.match(/<span>\((\d+)歳\)<\/span>/)?.[1];
      const store = b.match(/【(.+?)】/)?.[1] || "";
      const up = b.match(/(\d{2})\/(\d{2}) \d{2}:\d{2}\s*UP/);
      if (!href || !name || store !== STORE.tag) return null;
      let daysAgo = null;
      if (up) {
        const posted = new Date(
          Date.UTC(jstNow.getUTCFullYear(), Number(up[1]) - 1, Number(up[2]))
        );
        if (posted > jstNow) posted.setUTCFullYear(posted.getUTCFullYear() - 1); // 年跨ぎ
        daysAgo = Math.floor((jstNow - posted) / 86400000);
      }
      return {
        id: href[2],
        url: `${SITE}${shortPath(href[1])}`,
        name: cleanName(name),
        age,
        title: title || "",
        daysAgo,
      };
    })
    .filter(Boolean);
}

// 「2026/07/17」「2026年05月12日(火)」→「2026-07-17」（並べ替え用に揃える）
const normDate = (s) => {
  const m = s.match(/(\d{4})[/年](\d{1,2})[/月](\d{1,2})/);
  return m
    ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`
    : s;
};

// 口コミ一覧ページ。店舗別ページでも他店セラピストの口コミが混ざるので、呼び出し側で在籍名簿と突き合わせる
async function fetchReviewList() {
  const html = await fetchHtml(`${SITE}/${SLUG}/review/`);
  const re =
    /therapist\/(\d+)\/">([^<]+)<\/a>[\s\S]*?class="wr_data">([^<]+)<[\s\S]*?class="review_name">([^<]+)<[\s\S]*?(?:class="review_score">([^<]+)<[\s\S]*?)?class="review_text">\s*([\s\S]*?)<\/p>[\s\S]*?toggleFavorite\(this,'review',(\d+)\)/g;
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    items.push({
      tid: m[1],
      tname: cleanName(m[2].trim()),
      date: normDate(m[3].trim()),
      reviewer: m[4].trim(),
      score: (m[5] || "").trim(),
      text: strip(m[6]),
      id: m[7],
    });
  }
  return items;
}

// セラピスト個別の口コミページ（一覧に自店舗の新着が無いときの補充用）
async function fetchTherapistReviews(t) {
  const html = await fetchHtml(`${SITE}/s/${SLUG}/review/therapist/${t.id}/`);
  const blocks = html.match(/<li class="review_therapist_li">[\s\S]*?<\/li>/g) || [];
  return blocks
    .map((b) => {
      const id = b.match(/toggleFavorite\(this,'review',(\d+)\)/)?.[1];
      if (!id) return null;
      return {
        tid: t.id,
        tname: t.name,
        date: normDate(b.match(/class="wr_data">([^<]+)</)?.[1] || ""),
        reviewer: (b.match(/class="review_name">([^<]+)</)?.[1] || "").trim(),
        score: (b.match(/class="review_score">([^<]+)</)?.[1] || "").trim(),
        text: strip(b.match(/class="review_text">\s*([\s\S]*?)<\/p>/)?.[1] || ""),
        id,
      };
    })
    .filter((r) => r && r.text);
}

// 在籍セラピスト（このページは系列3店舗まとめて載るので【店舗】タグで絞る）
let therapistCache = null;
async function fetchTherapists() {
  if (therapistCache) return therapistCache;
  const html = await fetchHtml(`${SITE}/s/${SLUG}/therapist/`);
  const cards = html.match(/<li class="listpage_style">[\s\S]*?<\/li>/g) || [];
  therapistCache = cards
    .map((c) => ({
      id: c.match(/therapist\/(\d+)\//)?.[1],
      name: cleanName(c.match(/listpage_profile_name notranslate">([^<]+)</)?.[1] || ""),
      rank: c.match(/listpage_profile_rank[^>]*>([^<]+)</)?.[1]?.trim() || "",
      store: c.match(/【(.+?)】/)?.[1] || "",
      age: c.match(/(\d+)歳/)?.[1] || "",
      height: c.match(/身長:(\d+)cm/)?.[1] || "",
      reviews: c.match(/口コミ（(\d+)件）/)?.[1] || "0",
      copy: c.match(/口コミ（[\s\S]*?<\/p>\s*<p>([^<]*)<\/p>/)?.[1]?.trim() || "",
    }))
    .filter((t) => t.id && t.store === STORE.tag);
  return therapistCache;
}

// 月間ポイントランキング（店舗別）
async function fetchRanking() {
  const html = await fetchHtml(`${SITE}/s/${SLUG}/point_ranking/?range=monthly`);
  const box = html.match(/<div class="ranking_box">[\s\S]*?<\/ul>/)?.[0] || html;
  const re =
    /ranking_number">(\d+)<[\s\S]*?therapist\/(\d+)\/[\s\S]*?r_name">([^<]+)<[\s\S]*?r_point">[\s\S]*?<\/i>([\d,]+)</g;
  const list = [];
  let m;
  while ((m = re.exec(box))) {
    list.push({ rank: m[1], id: m[2], name: cleanName(m[3].trim()), point: m[4] });
  }
  return list;
}

// ---- 投稿文の組み立て ----
const downloadImage = async (url, file) => {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const p = path.join(DIR, file);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    return p;
  } catch {
    return null;
  }
};

async function buildDiary() {
  const diaries = await fetchDiaries();
  const next = diaries.find((d) => !state.diary_posted.includes(d.id));
  if (!next) return null;
  const ageLabel = next.age ? `（${next.age}歳）` : "";
  // 3日以内なら「更新されました」、それより古いものは「ピックアップ」として紹介する
  const fresh = next.daysAgo === null || next.daysAgo <= 3;
  const head = fresh
    ? `📸【${STORE.name}】${next.name}${ageLabel} の写メ日記が更新されました`
    : `📸【${STORE.name}】写メ日記ピックアップ｜${next.name}${ageLabel}`;
  const body = next.title ? `\n\n「${next.title}」` : "";
  state.diary_posted.push(next.id);
  state.diary_posted = state.diary_posted.slice(-300);
  return {
    caption: `${head}${body}\n\n${next.url}`,
    image: await downloadImage(`${SITE}/photo/syame_${next.id}_01.jpg`, "tmp-media.jpg"),
  };
}

async function buildReview() {
  const roster = await fetchTherapists();
  const ids = new Set(roster.map((t) => t.id));
  const unposted = (r) => !state.review_posted.includes(r.id);
  const newest = (a, b) => (a.date < b.date ? 1 : -1);

  // まずは口コミ一覧から自店舗セラピストの分だけを拾う
  let candidates = (await fetchReviewList())
    .filter((r) => ids.has(r.tid))
    .sort(newest);
  let next = candidates.find(unposted);

  // 一覧に無ければ、口コミの多い在籍メンバーの個別ページを何人か見に行く
  if (!next) {
    const targets = roster
      .filter((t) => Number(t.reviews) > 0)
      .sort((a, b) => Number(b.reviews) - Number(a.reviews))
      .slice(0, 4);
    const collected = [];
    for (const t of targets) {
      collected.push(...(await fetchTherapistReviews(t).catch(() => [])));
      await sleep(1000); // 連続アクセスでレート制限を踏まないように間隔を空ける
    }
    next = collected.sort(newest).find(unposted);
  }
  if (!next) return null;
  const excerpt =
    next.text.replace(/\s+/g, " ").slice(0, 80) + (next.text.length > 80 ? "…" : "");
  const score = next.score ? ` / ${next.score}` : "";
  state.review_posted.push(next.id);
  state.review_posted = state.review_posted.slice(-300);
  return {
    caption:
      `💬【${STORE.name}】お客様からの声（${next.reviewer}様${score}）\n\n` +
      `${next.tname} へ\n「${excerpt}」\n\n` +
      `ほかの口コミはこちら\n${SITE}/${SLUG}/review/`,
    image: await downloadImage(`${SITE}/photo/wid_${next.tid}_01.jpg`, "tmp-media.jpg"),
  };
}

async function buildTherapist() {
  const list = await fetchTherapists();
  if (!list.length) return null;
  // 全員を一巡したら履歴をリセットして次の周へ（直近3人は続けて出さない）
  let next = list.find((t) => !state.therapist_posted.includes(t.id));
  if (!next) {
    state.therapist_posted = state.therapist_posted.slice(-3);
    next = list.find((t) => !state.therapist_posted.includes(t.id)) || list[0];
  }
  const spec = [next.age && `${next.age}歳`, next.height && `${next.height}cm`, next.rank]
    .filter(Boolean)
    .join(" / ");
  const copy = next.copy ? `\n「${next.copy}」` : "";
  const reviews = Number(next.reviews) > 0 ? `\n口コミ ${next.reviews}件` : "";
  state.therapist_posted.push(next.id);
  state.therapist_posted = state.therapist_posted.slice(-100);
  return {
    caption:
      `✨【${STORE.name}】在籍セラピストのご紹介\n\n` +
      `${next.name}（${spec}）${copy}${reviews}\n\n` +
      `プロフィール・ご予約はこちら\n${SITE}/${SLUG}/therapist/${next.id}/`,
    image: await downloadImage(`${SITE}/photo/wid_${next.id}_01.jpg`, "tmp-media.jpg"),
  };
}

async function buildRanking() {
  const list = await fetchRanking();
  if (list.length < 3) return null;
  const top = list.slice(0, 5);
  const lines = top.map((t) => `${t.rank}位 ${t.name} ${t.point}pt`).join("\n");
  state.ranking_last = todayStr;
  return {
    caption:
      `👑【${STORE.name}】${monthLabel} 月間ポイントランキング TOP${top.length}\n\n` +
      `${lines}\n\nいつも応援ありがとうございます。\n` +
      `${SITE}/${SLUG}/point_ranking/?range=monthly`,
    image: await downloadImage(`${SITE}/photo/wid_${top[0].id}_01.jpg`, "tmp-media.jpg"),
  };
}

const BUILDERS = {
  diary: buildDiary,
  review: buildReview,
  therapist: buildTherapist,
  ranking: buildRanking,
};

// ランキングは5日に1回だけ。間隔が空いていなければ通常のネタに回す
const daysSinceRanking = state.ranking_last
  ? Math.floor((Date.parse(todayStr) - Date.parse(state.ranking_last)) / 86400000)
  : 999;
let wanted = process.env.POST_TYPE || typeFromHour(jstHour);
if (wanted === "ranking" && !process.env.POST_TYPE && daysSinceRanking < 5) {
  console.log(`ランキングは前回から${daysSinceRanking}日なので今回は別のネタにします。`);
  wanted = "diary";
}

// 希望のネタが無ければ順に切り替える（在籍紹介は必ず出せるので最後の砦）
const order = [wanted, "diary", "review", "therapist"].filter(
  (t, i, a) => a.indexOf(t) === i
);
let post = null;
let usedType = null;
for (const type of order) {
  console.log(`ネタを探しています: ${type}`);
  post = await BUILDERS[type]().catch((e) => {
    console.log(`  ${type} の取得に失敗: ${e.message}`);
    return null;
  });
  if (post) {
    usedType = type;
    break;
  }
  console.log(`  ${type} は新しいものがないので次を試します`);
}

if (!post) {
  console.log("投稿できるネタが見つからなかったため終了します。");
  process.exit(0);
}

console.log(`---- ${STORE.name} / ${usedType} ----`);
console.log(post.caption);
console.log("----------------");

if (process.env.DRY_RUN) {
  if (post.image) fs.unlinkSync(post.image);
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
  await page.locator('textarea[name="caption"]').fill(post.caption);

  if (post.image) {
    await page.locator("#post-new-media-upload").setInputFiles(post.image);
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

  let ok = !PUBLIC_ID; // 公開ID未設定時は投稿数での判定ができないので待機のみ
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
  await page.screenshot({ path: `error-${SLUG}.png` }).catch(() => {});
  process.exit(1);
} finally {
  if (post.image) fs.unlinkSync(post.image);
  await browser.close();
}
