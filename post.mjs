// YORU女 自動投稿スクリプト
// キューから未投稿の1本を取り出し、Playwrightで投稿する。
// 認証情報は環境変数 YORUJO_EMAIL / YORUJO_PASSWORD から読む（コードには書かない）。

import { chromium } from "playwright";
import fs from "fs";

const QUEUE_PATH = new URL("./queue/posts.json", import.meta.url).pathname;
const BASE = "https://jofu-yorujo.com";

const email = process.env.YORUJO_EMAIL;
const password = process.env.YORUJO_PASSWORD;
if (!email || !password) {
  console.error("環境変数 YORUJO_EMAIL / YORUJO_PASSWORD が未設定です。");
  process.exit(1);
}

const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
const next = queue.find((p) => !p.posted);
if (!next) {
  console.log("キューが空です。新しい投稿ストックを補充してください。");
  process.exit(0);
}

console.log(`投稿します: #${next.id} [${next.type}]`);

const browser = await chromium.launch();
const context = await browser.newContext({
  locale: "ja-JP",
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();

try {
  // ---- ログイン ----
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("メールアドレス または ID").fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL("**/home", { timeout: 30000 });
  console.log("ログイン成功");

  // ---- 新規投稿 ----
  await page.goto(`${BASE}/posts/new`, { waitUntil: "networkidle" });
  await page.locator('textarea[name="caption"]').fill(next.text);

  // 画像付き投稿（queue に image: "images/xxx.jpg" がある場合）
  if (next.image) {
    const imgPath = new URL(`./${next.image}`, import.meta.url).pathname;
    await page.locator("#post-new-media-upload").setInputFiles(imgPath);
    // アップロード完了（hidden の media_id がセットされる）を待つ
    await page.waitForFunction(
      () => document.querySelector('input[name="media_id"]')?.value !== "",
      { timeout: 60000 }
    );
    console.log("画像アップロード完了");
  }

  // 投稿ボタン（ヘッダー右上）
  await page.getByRole("button", { name: "投稿" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/posts/new"), {
    timeout: 30000,
  });
  console.log("投稿完了");

  // ---- キューを更新 ----
  next.posted = true;
  next.posted_at = new Date().toISOString();
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");

  const remaining = queue.filter((p) => !p.posted).length;
  console.log(`残りストック: ${remaining}本`);
  if (remaining <= 3) {
    console.log("⚠️ ストックが残り3本以下です。補充してください。");
  }
} catch (err) {
  console.error("投稿に失敗しました:", err.message);
  await page.screenshot({ path: "error.png" }).catch(() => {});
  process.exit(1);
} finally {
  await browser.close();
}
