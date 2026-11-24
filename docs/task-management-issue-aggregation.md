# Ateliers Task Management への Issue 集約

> 作成日: 2026-11-25
>
> 更新日: 2026-11-25
>
> 作成者: Codex

## 目的と対象

Ateliers-Dev Organization の各リポジトリで作成された Issue を、組織 Project [Ateliers Task Management](https://github.com/orgs/Ateliers-Dev/projects/1) に追加します。リポジトリ単位の `Auto-add to project` 設定に依存せず、今後作成されるリポジトリも Organization Webhook の対象にします。

- 自動イベント: `issues.opened`
- Pull Request: Issue payload に `pull_request` がある場合は除外
- `issues.reopened` と transfer: 自動イベント対象外。手動監査で不足を検出し、必要な場合は手動取込で追加
- 初期 Status、close 時の Done、reopen 時の Todo: Project の標準 Workflow に委ねる
- `Issue Type`、Labels、Priority、Assignee Type: この同期では変更しない
- 既に Project にある項目: Project API の冪等性を利用して重複を作らず、既存フィールドを更新しない

## 処理経路

1. Organization Webhook が `repository` と `issues` イベントを Cloudflare Worker に送ります。
2. Worker は HMAC 署名を確認し、組織・リポジトリ・Issue を検証します。ラベル同期の `repository.created` と Issue 追加を別の `repository_dispatch` event type に分けます。
3. `issue-opened` Workflow は共有鍵で dispatch の署名を検証してから、Project 操作用トークンを発行します。
4. 専用 `Ateliers Task Manager` GitHub App のトークンで REST APIから対象リポジトリと Issue を再取得し、ID・正式名・Issue番号・node ID を照合します。PRはここでも拒否します。
5. GraphQL `addProjectV2ItemById` で Project #1 に追加します。既存項目の場合は既存の item ID が返るため、Statusなどの既存値を上書きしません。

既存の `Ateliers Repository Dispatcher` は `.github` リポジトリに対する Contents write のままです。Worker のinstallation token もこのDispatcher専用に発行し、Task Manager App の権限は付与しません。

## 専用 App の最小権限

`Ateliers Task Manager` を Ateliers-Dev Organization にインストールします。

| 対象 | 権限 | 用途 |
| --- | --- | --- |
| Organization Projects | Read and write | Project #1 の参照と Issue の追加 |
| Repository Issues | Read-only | 全リポジトリの Issue 検証・既存 Issue の手動取込・漏れ監査 |
| Repository Metadata | Read-only | Organization リポジトリ一覧と正式なリポジトリ情報の参照 |
| Repository access | All repositories | Webhookをリポジトリごとの設定なしで処理し、既存Issueを全体確認 |

`actions/create-github-app-token` ではこの3権限だけを指定します。`owner: Ateliers-Dev` とリポジトリ一覧の省略により、そのInstallationで選択した全リポジトリを対象にします。App の作成・インストールと Organization による権限承認は別途必要です。

## 設定手順

1. GitHub Organization の Developer settings で `Ateliers Task Manager` App を作成し、上表の権限を設定します。Webhook subscription は不要です。
2. App を Ateliers-Dev にインストールし、`All repositories` を選びます。
3. `.github` Repository または Organization Actions Variables に `TASK_MANAGER_APP_CLIENT_ID`、Actions Secret に `TASK_MANAGER_APP_PRIVATE_KEY` を登録します。
4. Organization Webhook で `issues` イベントを追加します。既存の `repository` イベントは残します。URLとWebhook secretは現在のWorker設定を再利用します。
5. Workerを `.github/webhook-worker` から再デプロイします。既存の `GITHUB_APP_*`、`GITHUB_WEBHOOK_SECRET`、`COMMON_LABEL_DISPATCH_SECRET`、Dispatcher用 Repository ID/name を再利用します。
6. Project Workflowで `Item added to project -> Status: Todo`、`Item closed -> Done`、`Item reopened -> Todo` を設定します。既存Statusを再送時にリセットしないよう、独自コードからStatusフィールドを更新しません。
7. `Sync Ateliers Task Management project` Workflow の `workflow_dispatch` で `audit-open-issues` を実行し、不足件数を確認します。必要に応じて `import-open-issues` をdry-runのまま確認し、問題がなければdry-runを解除して既存の未完了Issueを取り込みます。

手順5まではこのリポジトリの変更をマージしただけでは実施されません。設定後に新しいIssueを作成し、Webhook Recent deliveries、Worker logs、Actions run、Project item を個別に確認します。実イベント確認が完了するまで、実環境で稼働したとは扱いません。

## 手動監査・取込

`workflow_dispatch` は既定で `audit-open-issues` を選びます。監査は全ての有効なOrganizationリポジトリからopen Issueを読み、ProjectにないIssue URLをログへ出します。PRは除外します。

`import-open-issues` は同じ対象を計画し、dry-run既定で追加予定を出します。dry-runを解除した場合のみ不足項目を逐次追加します。Projectにある項目は変更しません。API失敗後は同じ手動処理を再実行できます。

Closed Issue、`reopened` のみで作られたイベント、Project移動に伴うtransferなどは自動登録されません。必要な範囲を現在のopen Issue監査と手動importで補います。監査は現時点のopen Issueを対象とし、履歴全体の完全性を保証するものではありません。

## 検証

- Worker の署名・組織/リポジトリ/Issue検証をユニットテストで確認します。
- PR用Workflow jobで新旧両方のテストを実行します。
- GitHub App、Actions Secrets、Organization Webhook、Cloudflare Worker、Project workflow の設定状態は、コード上の検証からは確認できません。
- 実GitHub APIへの書込みやCloudflare再デプロイはPR準備中に行いません。

## 公式仕様

- [GitHub Projects API: item を追加し、既存itemの再追加時は既存IDを返す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GitHub App permission の選び方](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App installation token のRepository scopeと権限指定](https://github.com/actions/create-github-app-token)
- [Webhook events and payloads: issues](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues)

