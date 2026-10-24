# MakuServer Bulletin Board

Discordサーバー紹介を投稿し、管理者が審査してから公開する Web 掲示板 + Discord Bot です。Railway での運用を想定しています。

## 機能

- サーバー名・紹介文・招待リンク・カテゴリ・タグを使った掲載申請
- 審査待ちの投稿は公開されず、承認後に Web 一覧へ掲載
- カテゴリ、キーワード、タグでの検索
- Discord招待リンクへの参加ボタン
- Discord Bot の `/pending`、`/approve id:`、`/reject id:`、`/remove id:` による管理
- PostgreSQL 永続化、`/api/health` ヘルスチェック

## Railway へのデプロイ

### 1. PostgreSQL を用意する

Railway でプロジェクトを作り、PostgreSQL データベースを追加します。Web/Bot サービスの Variables に、Postgres サービスへの参照として次を設定してください。

- `DATABASE_URL=${{Postgres.DATABASE_URL}}`

Postgres サービス名が異なる場合は、変数参照内の `Postgres` を実際のサービス名に変更してください。アプリ起動時にテーブルとインデックスが自動作成されます。

### 2. Discord Bot を作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) で Application を作成し、Bot を追加します。
2. Bot Token を取得し、Railway の Variables に `DISCORD_TOKEN` として設定します。Token を GitHub にコミットしないでください。
3. OAuth2 の URL Generator または Installation 設定で、Bot を対象の Discord サーバーに招待します。Bot のスラッシュコマンド登録には `applications.commands` スコープが必要です。サーバー内で Bot がメッセージを送信できるよう、必要なチャンネル権限を付けます。
4. `ADMIN_USER_IDS` に、審査を行う Discord ユーザー ID をカンマ区切りで設定します。Discord サーバー管理者権限を持つユーザーも管理コマンドを実行できます。
5. 審査申請の通知を受けたい場合は `DISCORD_REVIEW_CHANNEL_ID` に審査チャンネル ID を設定します。

Bot Token はパスワード同様に扱い、公開しないでください。

### 3. デプロイする

GitHub リポジトリ `yajuusennpai631-dotcom/MakuServer-Bulletin-Board` を Railway のサービスに接続します。Railway は `npm install` と `npm start` を使い、`PORT` は Railway から渡されます。Healthcheck は `/api/health` です。

GitHub の main ブランチへの push で自動デプロイする設定を有効にしてください。デプロイ後に Railway の Networking から公開ドメインを発行します。

### 4. 動作確認

- `https://<公開ドメイン>/api/health` が `{"ok":true,...}` を返す
- Web サイトから掲載申請すると「審査待ち」になる
- Discord で `/pending` を実行し、投稿を確認できる
- `/approve id:<ID>` で承認すると Web 一覧に掲載される
- `/reject id:<ID>` で却下、`/remove id:<ID>` で完全削除できる

## ローカル開発

Node.js 20 以上と PostgreSQL が必要です。

```bash
npm install
cp .env.example .env
# .env の DATABASE_URL と必要な Discord 設定を埋める
npm start
```

## API 概要

- `GET /api/health` — ヘルスチェック
- `GET /api/categories` — カテゴリ一覧
- `GET /api/servers?q=...&category=...&tag=...` — 承認済み投稿の検索
- `POST /api/servers` — 掲載申請
- `GET /api/admin/pending` — 管理 API（`x-admin-token: ADMIN_TOKEN`）
- `POST /api/admin/servers/:id/approve` — 掲載承認
- `POST /api/admin/servers/:id/reject` — 却下
- `POST /api/admin/servers/:id/delete` — 削除

管理 API は `ADMIN_TOKEN` が設定されている場合のみ利用できます。管理 API を利用する際は、長いランダムな `ADMIN_TOKEN` を Railway Variables に設定してください。Discord スラッシュコマンドの管理には別途 `ADMIN_USER_IDS` または Discord サーバー管理者権限が使われます。

## 運用上の注意

- 公開前に招待リンクが有効であること、掲載内容が Discord の規約および掲示板ルールに沿っていることを管理者が確認してください。
- 申請 API には公開前提の基本的な入力検証があります。大規模運用の前に、IP 単位のレート制限、スパム対策、招待リンクの有効性確認、プライバシーポリシー、通報機能を追加することを推奨します。
- PostgreSQL の接続文字列や Bot Token、管理トークンは GitHub にコミットせず、Railway Variables で管理してください。
- グローバルスラッシュコマンドの反映には少し時間がかかることがあります。
