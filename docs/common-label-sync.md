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

## 必要な設定（このPRでは未設定）

本PRはコードと設定手順を追加します。GitHubラベル、GitHub Actions Secrets、GitHub App、Cloudflare Worker、組織 webhook は変更・作成・実行していません。設定完了と別途承認があるまで同期は稼働しません。

### 1. 同期用 GitHub App

組織 `Ateliers-Dev` に同期専用 GitHub App を作成し、Repository permissions は `Issues: write` のみを付与して全組織リポジトリにインストールします。`Metadata: read` は GitHub App の基本権限です。Webhook event の購読は不要です。GitHub App の Client ID と秘密鍵を `.github` リポジトリの Actions Secrets `COMMON_LABEL_SYNC_APP_CLIENT_ID` と `COMMON_LABEL_SYNC_APP_PRIVATE_KEY` に登録します。

この App はラベル API だけに使います。Actions のトークン作成ステップは同期ワークフロー内で短期インストールトークンを発行し、`Issues: write` だけを要求します。既存の Ateliers-Dev 向け GitHub App インストールは確認できましたが、Codex 用の接続であり、制御する webhook endpoint やこの用途の資格情報として利用できないため流用しません。

### 2. 新規リポジトリ通知用 Worker と GitHub App

新規リポジトリへの通知は Organization Webhook の `repository` イベントを使います。Worker は `repository.created` を受け取り、署名・組織・所有者・リポジトリ ID を確認してから `.github` の `repository_dispatch` API を呼びます。

通知専用 GitHub App を別に作り、`Contents: write` を付与して `.github` リポジトリだけにインストールします。Worker はインストールトークンを `.github` のリポジトリ ID に限定して発行します。この App に `Issues: write` は付与しません。Worker Secrets に `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET`、`COMMON_LABEL_DISPATCH_SECRET`、`DISPATCH_REPOSITORY_ID`、`DISPATCH_REPOSITORY_NAME=.github` を設定します。`COMMON_LABEL_DISPATCH_SECRET` は `.github` リポジトリの Actions Secret にも同じ値を登録します。Worker はGitHub署名を検証した後、dispatch内容に共有鍵の HMAC を付けます。Actions 側は専用の guard job でHMACと組織名を確認してから、Issues:write のインストールトークンを発行します。署名のない直接dispatchは同期前に拒否します。秘密鍵・webhook secret は Git に置きません。

Worker を `webhook-worker` からデプロイして HTTPS URL を得た後、組織の Settings → Webhooks でその URL に `repository` イベント（secret は `GITHUB_WEBHOOK_SECRET` と同じ値）を送信する Organization Webhook を設定します。受信イベントの重複は同期処理の冪等性で安全に処理します。

Cloudflare アカウント、Worker のデプロイ先、GitHub App の登録権限、Organization Webhook の管理権限はこの環境から確認できませんでした。これらの実設定は未完了で、PR 作成後の組織権限・資格情報・色の確認対象です。

## 今回の範囲外

既存 Issue の分類・再分類、GitHub Projects への集約、Issue Type の更新、ラベルの実リポジトリへの同期は行いません。リポジトリ初期化へ広げられる配置にはしていますが、今回実装する処理は共通ラベル同期だけです。
