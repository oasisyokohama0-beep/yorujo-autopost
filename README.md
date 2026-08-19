# YORU女 自動投稿システム

PCの電源を切っていても、GitHub Actions（クラウド・無料枠）が定時に起動して
YORU女に自動投稿する仕組み。**投稿文はストック不要**で、公式サイト（happ-s.com）の
実データから投稿のたびに自動生成される。

## アカウント構成

| アカウント | スクリプト | スケジュール（JST） | 内容 |
|---|---|---|---|
| 湊あおい（minatoaoi） | `post.mjs` | 6〜24時の2時間おき（1日10枠） | セラピスト紹介ローテ＋口コミ紹介（代表の声） |
| オアシスグループ公式 | `post-group.mjs` | 10/15/22時=写メ日記、12時=口コミ、20時=ランキング | 全16店舗の写メ日記・口コミ・全国ランキング |

## 湊あおい側の仕組み（post.mjs）

- 偶数枠（6,10,14,18,22時）＝**セラピスト紹介**優先、それ以外＝**口コミ紹介**優先。
  優先タイプにネタが無ければもう片方、それも無ければその回はスキップ（エラーではない）
- セラピスト紹介：横浜/渋谷/錦糸町の在籍一覧から、**10日間のクールダウン**付きローテーション。
  年齢・身長・ランク・キャッチコピー・口コミ件数を実データで反映。宣材写真つき
- 口コミ紹介：最新口コミから未投稿のものを1件。**グループ公式が投稿済みの口コミは重複させない**
- 文面は複数テンプレートを自動で使い分け（湊あおい＝代表の口調。乱暴な呼称・ハッシュタグなし）
- 状態は `state-aoi.json`（紹介済みセラピスト・投稿済み口コミID）に自動保存

## 日々の運用

**何もしなくてOK。ストック補充も不要。**

- 新セラピストが公式サイトに載れば自動で紹介対象に入る
- 新しい口コミが書かれれば自動で拾われる

## 手動テスト・タイプ指定実行

Actions → autopost → Run workflow で「post_type」を指定可能（空なら時刻から自動判定）。

## ローカルで文面だけ確認（投稿しない）

```bash
YORUJO_EMAIL=dummy YORUJO_PASSWORD=dummy DRY_RUN=1 POST_TYPE=therapist node post.mjs
```

## 注意

- happ-s.com はデータセンターIPを403で弾くことがある（15秒間隔で3回リトライ実装済み。それでも失敗した回はスキップ扱い）
- サイトのデザイン変更でスクリプトが止まったら、ActionsのログとArtifactsの error.png をClaudeに見せる
- パスワード変更時は Secrets（YORUJO_EMAIL/PASSWORD、YORUJO_GROUP_EMAIL/PASSWORD）も更新
- `queue/posts.json` は旧ストック方式のアーカイブ（現在は未使用）

---

# 店舗アカウント自動投稿（横浜／渋谷／錦糸町）

`post-store.mjs` が happ-s.com の店舗ページを読んで投稿文を自動生成する。
ストック（posts.json）は不要で、ネタはサイトから毎回取ってくる。

## 投稿するもの

| JST | 内容 | 取得元 |
|---|---|---|
| 11時 | 写メ日記の紹介 | `/s/{店舗}/diary/?select_shop_id=…`（自店舗のみ） |
| 13時 | 口コミの紹介 | `/{店舗}/review/` ＋ セラピスト個別の口コミページ |
| 19時 | 在籍セラピスト紹介 | `/s/{店舗}/therapist/`（自店舗のみ・全員を順番に一巡） |
| 21時 | 月間ポイントランキング TOP5 | `/s/{店舗}/point_ranking/?range=monthly` |

- ランキングは **5日に1回**だけ投稿し、間隔が空いていない日は別のネタに切り替わる
- ネタが尽きたときは 日記 → 口コミ → 在籍紹介 の順で自動フォールバックするので、投稿が空振りしにくい
- 写メ日記は投稿から3日以内なら「更新されました」、それより古ければ「ピックアップ」という言い方に変わる

## セットアップ（GitHubのSecrets／Variables）

Settings → Secrets and variables → Actions で登録する。

**Secrets（必須）**

| 名前 | 中身 |
|---|---|
| `YORUJO_YOKOHAMA_EMAIL` / `YORUJO_YOKOHAMA_PASSWORD` | 横浜店アカウントのログイン情報 |
| `YORUJO_SHIBUYA_EMAIL` / `YORUJO_SHIBUYA_PASSWORD` | 渋谷店アカウント |
| `YORUJO_KINSHICHO_EMAIL` / `YORUJO_KINSHICHO_PASSWORD` | 錦糸町店アカウント |

**Variables（推奨）** … 投稿が本当に反映されたかの確認に使う公開ID（プロフィールURLの末尾）

| 名前 | 例 |
|---|---|
| `YORUJO_YOKOHAMA_ID` | `oasisyokohama` |
| `YORUJO_SHIBUYA_ID` | `oasisshibuya` |
| `YORUJO_KINSHICHO_ID` | `oasiskinshicho` |

未登録の店舗は「未設定のためスキップ」とログに出るだけで、他の店舗の投稿は続行される。

## 手動テスト

Actions タブ →「autopost-store」→ Run workflow。
店舗と投稿タイプを選べる（空なら3店舗すべて・時刻から自動判定）。

## 手元で本文だけ確認する

```
STORE=yokohama YORUJO_EMAIL=x YORUJO_PASSWORD=x DRY_RUN=1 POST_TYPE=therapist node post-store.mjs
```

`STORE` は `yokohama` / `shibuya` / `kinshicho`、`POST_TYPE` は `diary` / `review` / `therapist` / `ranking`。

## 状態ファイル

`state-yokohama.json` などに、投稿済みの日記ID・口コミID・紹介済みセラピストID・前回ランキング投稿日が入る。
同じネタを二度投稿しないための記録なので、消すと最初からやり直しになる。
