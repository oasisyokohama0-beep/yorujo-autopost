# YORU女 自動投稿システム

PCの電源を切っていても、GitHubのクラウド（GitHub Actions）が定時に起動して、
`queue/posts.json` の投稿ストックから1本ずつ YORU女（湊あおいアカウント）に自動投稿する仕組み。

## 仕組み

```
queue/posts.json（承認済み投稿ストック）
        ↓  定時起動（初期設定：JST 9時/15時/21時の1日3回）
GitHub Actions（クラウド・無料枠）
        ↓
Playwright がログイン → /posts/new に本文入力 →（画像あれば添付）→ 投稿
        ↓
投稿済みマークを付けて保存。残り3本以下になると警告ログ
```

## 初回セットアップ（1回だけ・約15分）

1. GitHubアカウントを作る → https://github.com/signup
2. 新しい **Private** リポジトリを作成（名前例：`yorujo-autopost`）
   ※必ずPrivateにすること。投稿ストックが公開されないように。
3. この `autopost` フォルダの中身を全部アップロード
   （`.github` フォルダも含む。Webの「Add file → Upload files」でOK）
4. リポジトリの Settings → Secrets and variables → Actions → New repository secret で2つ登録：
   - `YORUJO_EMAIL` … YORU女のログインメールアドレス
   - `YORUJO_PASSWORD` … YORU女のパスワード
   ※ここに入れた値は暗号化され、本人以外（Claudeも）見られない
5. Actions タブ → 「autopost」→「Run workflow」で手動テスト実行
6. YORU女のプロフィールに投稿が増えていれば完成 🎉

## 日々の運用

- **何もしなくてOK**。定時に自動投稿される
- ストックが減ってきたら（残り3本以下でログに警告）、Claudeに「投稿ストックを補充して」と言う
  → 新しい投稿案を生成 → 内容を確認 → `queue/posts.json` に追記してGitHubへアップロード

## 投稿頻度の変更

`.github/workflows/autopost.yml` の `cron` 行を編集：

| 頻度 | cron設定（UTC） |
|---|---|
| 1日1回（JST 12時） | `"0 3 * * *"` |
| 1日3回（JST 9/15/21時）※初期設定 | `"0 0,6,12 * * *"` |
| 3時間ごと（JST 9〜24時） | `"0 0,3,6,9,12,15 * * *"` |

## 画像付き投稿

1. `images/` フォルダを作って写真を入れる
2. `queue/posts.json` の投稿に `"image": "images/ファイル名.jpg"` を追加

## 注意

- サイトのデザイン変更でスクリプトが止まったら、Claudeに「自動投稿が失敗してる」と伝える（error.png のスクリーンショットが手がかりになる）
- パスワードを変更したら Secrets も更新すること
