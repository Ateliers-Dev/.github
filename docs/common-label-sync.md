# Ateliers-Dev 共通ラベル同期

> 作成日: 2026-11-24  
> 更新日: 2026-11-24  
> 作成者: Codex

## 正本と同期定義

Issue の分類方針と共通ラベルの用途の正本は、[ateliers-website の Issue Type と共通ラベル運用方針](https://github.com/Ateliers-Dev/ateliers-website/blob/main/docs/development-guidelines/technical-policies/issue-classification-and-label-policy.md)です。このリポジトリの [`labels.json`](../labels.json) は同期に必要な名前・説明・色を機械可読にしたものです。同期前に正本の「共通ラベル」表を取得し、名前と説明が一致しなければ処理を失敗させます。色は運用設定値として本PRで提案しています。

| ラベル | 説明 | 色 |
| --- | --- | --- |
| `accessibility` | アクセシビリティの改善や対応 | `0075ca` |
| `bug` | 不具合に関する Issue | `d73a4a` |
| `documentation` | ドキュメントの追加・修正・改善 | `0075ca` |
| `duplicate` | 既存の Issue と重複しているもの | `cfd3d7` |
| `enhancement` | 機能や既存の成果物の追加・改善 | `a2eeef` |
| `good first issue` | 初めて参加する人が取り組みやすい Issue | `7057ff` |
| `help wanted` | 追加の協力を求める Issue | `008672` |
| `invalid` | Issue として有効な報告・提案に当たらないもの | `e4e669` |
| `question` | 質問や追加確認を扱う Issue | `d876e3` |
| `wontfix` | 対応しないと決定した Issue | `ffffff` |

## 実行方法

- 定期実行は設定しません。
- `workflow_dispatch` は1つのリポジトリまたは組織内すべての有効なリポジトリを指定できます。dry-run が既定値です。実際に反映するには手動で dry-run を解除します。
- `repository_dispatch` の `repository-created` は、組織 webhook 受信処理が検証済みの新規リポジトリ ID と正式名を渡し、その1リポジトリだけを同期します。write 権限のトークン発行前に共有鍵の HMAC を確認します。
- 既存ラベルの名前・説明・色を定義に合わせて追加・更新します。定義にないラベルは削除せず、Issue へのラベル付けや付け替えもしません。
- Issue Type とラベルの併用、該当するラベルがない Issue はそのまま許容します。
- 同時に同じラベルを作成する実行があっても、競合後に現在値を読み直して定義へ合わせます。イベント実行をまとめてキャンセルする同時実行グループは設けません。その他のAPIエラーで同期が部分的に終わる場合は、ログの失敗リポジトリを確認して再実行してください。同期操作は冪等なので、再実行で不足や差異だけを処理します。

## テスト

- 共通ラベルの名前・説明が方針文書と一致すること、同期計画が既存の独自ラベルを変更・削除しないことを `node --test tests/*.test.js` で確認します。
- Worker の組織・リポジトリ検証は `node --test webhook-worker/src/*.test.js` で確認します。
- GitHub API、Worker デプロイ、Organization Webhook の実資格情報を用いる接続テストは、このPRでは行いません。

## 実環境での検証記録（2026-11-24）

以下は利用者が実環境で確認した観測結果です。設定画面の確認結果は利用者からの報告であり、この変更作業から GitHub App や Cloudflare の設定を独立に読み取ったものではありません。

- 通知用 `Ateliers Repository Dispatcher` は `Contents: read/write`、`Metadata: read`、対象リポジトリ `.github` のみ、権限変更の承認待ちなし、Installation は停止されていない状態を画面で確認済みです。権限は拡大しません。
- 共通ラベル同期の実行で、短縮リポジトリ名を指定した際に署名検証と対象リポジトリ検証の両方で失敗しました。
- 全18リポジトリへの apply 再試行は成功しました。
- Webhook の404は URL を修正して再送信した後に解消し、ping は成功しました。
- `repository.created` は Worker まで到達し、署名・組織・リポジトリ検証を通過しましたが、Webhook 応答は502、内部ログでは scoped installation token 発行が403でした。
- 403 の原因は未確定です。User-Agent の不足、App の設定、権限など、いずれも原因と断定しません。

この PR は API リクエストに明示的な User-Agent と安全なエラー診断を追加し、短縮名検証と正本取得時の一時的な503を改善します。GitHub API のエラー診断は HTTP ステータス、許可された汎用エラー情報、request ID に限定し、生の応答本文・署名・JWT・トークン・秘密鍵・Webhook payload は記録しません。

## 設定状態と必要な設定

同期用 GitHub App、Actions Secrets、Cloudflare Worker、Organization Webhook の実環境設定をこの PR で変更しません。画面確認済みの項目、実環境で動作した項目、未検証の項目を分けて記録し、未検証の設定を完了扱いしません。

### 1. 同期用 GitHub App

組織 `Ateliers-Dev` に同期専用 GitHub App を作成し、Repository permissions は `Issues: write` のみを付与して全組織リポジトリにインストールします。`Metadata: read` は GitHub App の基本権限です。Webhook event の購読は不要です。GitHub App の Client ID と秘密鍵を `.github` リポジトリの Actions Secrets `COMMON_LABEL_SYNC_APP_CLIENT_ID` と `COMMON_LABEL_SYNC_APP_PRIVATE_KEY` に登録します。

この App はラベル API だけに使います。Actions のトークン作成ステップは同期ワークフロー内で短期インストールトークンを発行し、`Issues: write` だけを要求します。既存の Ateliers-Dev 向け GitHub App インストールは確認できましたが、Codex 用の接続であり、制御する webhook endpoint やこの用途の資格情報として利用できないため流用しません。

### 2. 新規リポジトリ通知用 Worker と GitHub App

新規リポジトリへの通知は Organization Webhook の `repository` イベントを使います。Worker は `repository.created` を受け取り、署名・組織・所有者・リポジトリ ID を確認してから `.github` の `repository_dispatch` API を呼びます。

通知専用 GitHub App は `Contents: read/write` と基本権限の `Metadata: read` を使い、`.github` リポジトリだけにインストールします。Worker は scoped installation token の対象を `.github` のリポジトリ ID に限定します。この App に `Issues: write` は付与しません。必要な Worker Secrets は次の7つです: `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET`、`COMMON_LABEL_DISPATCH_SECRET`、`DISPATCH_REPOSITORY_ID`、`DISPATCH_REPOSITORY_NAME`（値は `.github`）。`COMMON_LABEL_DISPATCH_SECRET` は `.github` リポジトリの Actions Secret にも同じ値を登録します。Worker は GitHub 署名を検証した後、dispatch 内容に共有鍵の HMAC を付けます。Actions 側は専用の guard job で HMAC と組織名を確認してから、Issues:write のインストールトークンを発行します。署名のない直接 dispatch は同期前に拒否します。秘密鍵・Webhook secret は Git に置きません。

Wrangler コマンドはリポジトリ内の `webhook-worker` ディレクトリで実行します。Organization Webhook の Payload URL は Worker の HTTPS URL に `/github/webhook` を付けた完全な URL です。Webhook は `repository` イベントを選び、secret は `GITHUB_WEBHOOK_SECRET` と同じ値にします。Worker の `GET /health` は疎通確認用で、`{"status":"ok"}` を返します。受信イベントの重複は同期処理の冪等性で安全に処理します。

設定済みと報告された通知用 GitHub App の画面項目、および Worker の health/ping とイベント到達は観測済みです。Cloudflare 上の現在のデプロイ内容と7 Secrets の個々の値、組織 Webhook URL の最終保存状態、scoped token 発行後の dispatch、GitHub Actions 側の同期成功はこの変更作業からは未検証です。

### 再デプロイと障害調査

この PR のマージ後、利用者がローカルで main の最新版を取得し、次のコマンドを `webhook-worker` ディレクトリで実行します。

```powershell
git pull
npx wrangler deploy
npx wrangler secret list
npx wrangler tail ateliers-common-label-webhook
```

`secret list` は名前の確認に使い、Secret の値は表示・共有しません。Worker の到達確認には `GET https://<Workerのホスト>/health` を使います。GitHub Organization の Webhooks → Recent deliveries から既存の ping または失敗した `repository` 配信を選び、`Redeliver` で再試験します。新しい試験リポジトリは作らず、既存の試験リポジトリも削除しません。

再び失敗した場合は `wrangler tail` の時刻、delivery ID、HTTP status、許可された GitHub エラー情報、request ID を確認します。403 の原因をログだけで断定せず、表示されたエラー項目と request ID を添えて GitHub 側の診断に進みます。秘密鍵・JWT・token・署名・生の Webhook payload や Secret 値はログや報告に含めません。

## 今回の範囲外

既存 Issue の分類・再分類、GitHub Projects への集約、Issue Type の更新、ラベルの実リポジトリへの同期は行いません。リポジトリ初期化へ広げられる配置にはしていますが、今回実装する処理は共通ラベル同期だけです。

