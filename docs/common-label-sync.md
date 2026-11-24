# Ateliers-Dev 共通ラベル同期の運用と検証記録

> 作成日: 2026-11-24  
> 更新日: 2026-11-24  
> 作成者: Codex

## 目的と配置

この文書は、Ateliers-Dev の共通ラベル同期について、日常の確認・変更手順、これまでの技術検証、将来の活用候補をまとめます。現時点の実装と運用文書は [Ateliers-Dev/.github](https://github.com/Ateliers-Dev/.github) に置きます。

ラベルの意味と Issue Type との使い分けの正本は、[ateliers-website の Issue Type と共通ラベル運用方針](https://github.com/Ateliers-Dev/ateliers-website/blob/main/docs/development-guidelines/technical-policies/issue-classification-and-label-policy.md)です。.github/labels.json は同期用の機械可読定義で、正本にある共通ラベルの名前・説明と一致する必要があります。色は labels.json で管理します。同期スクリプトは実行時に正本を読み、名前と説明の不一致をエラーにします。文書作成時には正本のURLと実装上の照合方法を確認しましたが、GitHubの取得口から正本文面を直接取得できなかったため、本文の独立した再照合は未確認です。

この仕組みは、決定的なラベル同期を行うもので、Issue Type の変更や Issue へのラベル付け、既存ラベルの削除はしません。Issue Type とラベルは併用でき、該当する共通ラベルがない Issue も許容します。

## App・Secret・Worker設定の参照

GitHub App の設定と Secret は、それぞれの実行責務に分けます。以下は設定名と必要権限の参照情報です。Secret の値・秘密鍵・Webhook secret は文書やログに記録しません。

- 同期用 GitHub App: Ateliers-Dev の対象リポジトリにインストールし、Repository permission は Issues: write と GitHub App 基本権限の Metadata: read に限ります。Webhook event の購読は不要です。.github の Actions Secrets は COMMON_LABEL_SYNC_APP_CLIENT_ID と COMMON_LABEL_SYNC_APP_PRIVATE_KEY です。
- 通知用 GitHub App: .github リポジトリだけにインストールし、Contents: read/write と Metadata: read を使います。Worker が発行する installation token の対象も .github の Repository ID に限定します。Issues: write は付与しません。
- Worker の Secret 名: GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEY、GITHUB_WEBHOOK_SECRET、COMMON_LABEL_DISPATCH_SECRET、DISPATCH_REPOSITORY_ID、DISPATCH_REPOSITORY_NAME（設定値は .github）。Organization Webhook の secret は GITHUB_WEBHOOK_SECRET と同じ値にします。COMMON_LABEL_DISPATCH_SECRET は Worker と .github の Actions Secrets の両方に設定します。
- Webhook の Payload URL は Worker の HTTPS URL に /github/webhook を付けたものです。購読するイベントは repository です。Worker の GET /health は疎通確認用です。

Worker を再デプロイする場合は、最新版を取得してから webhook-worker ディレクトリで実行します。secret list は名前だけを確認し、値を出力・共有しません。

    git pull
    npx wrangler deploy
    npx wrangler secret list
    npx wrangler tail ateliers-common-label-webhook

## ラベル同期の監視・確認手順

### 実行方式と定期監視

同期は GitHub Actions の手動実行、または新規リポジトリ作成イベントによる実行です。定期実行や常時巡回による監視は導入していません。必要なときに次の確認を行います。

- 既存リポジトリの状態確認・同期: Actions の workflow_dispatch
- 新規リポジトリ: Organization Webhook → Cloudflare Worker → repository_dispatch → Actions

### 全リポジトリの dry-run

1. .github リポジトリの **Actions** を開き、**Sync common issue labels** ワークフローを選びます。
2. **Run workflow** を開き、repository は空欄、dry_run は true のまま実行します。
3. 実行された workflow run の synchronize job を開き、各リポジトリの would create / would update / already synchronized と最後の確認件数・モードを確認します。
4. 対象外のリポジトリや想定外の変更が出た場合は apply せず、正本と labels.json、実行入力を確認します。

全体実行は、同期用 App が参照できる Ateliers-Dev の有効な（アーカイブされていない）リポジトリを対象にします。

### 個別リポジトリの dry-run

同じ **Run workflow** で repository にリポジトリ名（例: ateliers-website）または Ateliers-Dev/リポジトリ名 を指定し、dry_run を true にして実行します。変更内容と対象を確認してから apply に進みます。ワークフローのPR検証は同期処理を行わず、手動実行の dry-run と apply は別の実行です。

### Actions のログ確認

対象 run の結論と各 job を確認します。

- guard-dispatch: Webhook 由来のイベントでは、書き込みトークン発行前に共有鍵による HMAC を検証します。
- synchronize: 対象、dry-run/apply の別、各ラベルの追加・更新または同期済み表示、最後の確認件数を確認します。
- 失敗したリポジトリがあれば、ログに出た名前とエラーを記録し、そのリポジトリだけを指定して dry-run から再確認します。同期は冪等なので、不足や差異を修正して再実行できます。

ログや共有する報告に、秘密鍵、JWT、installation token、Webhook署名、Secretの値、生のWebhook payloadを含めないでください。

### Organization Webhook と Worker の確認・再送信

Organization Webhook の配信履歴は、GitHub の **Organization Settings → Webhooks → 対象Webhook → Recent deliveries** で確認します。対象イベントが repository、動作が created であること、応答 status と時刻を確認します。Worker の受信先は /github/webhook です。URLの誤りやパス不足による404では、保存済み Payload URL を確認します。

Worker のヘルス確認とログ監視は、Wrangler を使える端末で、リポジトリの webhook-worker ディレクトリから行います。例:

    Set-Location C:\Projects\GitHub\Ateliers-Dev\.github\webhook-worker
    curl.exe -i https://ateliers-common-label-webhook.ateliers-dev.workers.dev/health
    npx wrangler tail ateliers-common-label-webhook

GET /health の正常応答は HTTP 200 と {"status":"ok"} です。wrangler tail を実行した状態で、Recent deliveries から失敗した既存の repository.created 配信を選び、**Redeliver** で再送信します。Worker が受理・dispatch した場合は HTTP 202 になります。その後、Worker tail の該当時刻・delivery ID と、GitHub Actions に起動した run の結果を照合し、対象リポジトリに共通ラベルが存在することを確認します。再送信は同一イベントの再処理です。必要に応じて、修正版 Worker の再デプロイ後に既存配信を再送できます。

Worker の診断ログには処理段階、HTTP status、許可された汎用エラー情報、GitHub request ID が含まれます。403 の原因を推測で断定せず、これらを用いて調査します。Worker の Secrets を確認する必要がある場合は npx wrangler secret list で名前だけを確認し、値を表示・共有しません。再送信が再び失敗したときは、delivery ID、時刻、status、処理段階、request ID を記録して、Webhook URL・Worker・GitHub App のインストール対象・権限・Actions run を順に切り分けます。GitHub App の権限を調査目的で拡大しないでください。

## 共通ラベルを変更する手順

1. 変更理由と Issue Type / 共通ラベル方針への影響を確認し、必要なら先に正本の変更をレビュー・マージします。正本の Issue Type 方針やラベルの意味を、同期用ファイルだけで変更しません。
2. .github/labels.json の名前・説明を正本の「共通ラベル」表に合わせます。色は同じ項目の color に6桁の16進数（# なし）で設定し、レビューで意図を確認します。
3. 変更をPRでレビューします。PRの Actions 検証で定義と回帰テストの結果を確認します。ラベル同期 workflow のPR検証は実ラベルを変更しません。
4. 変更が main に入ったら、まず対象リポジトリ（必要に応じて全体）の workflow_dispatch を dry_run: true で実行し、予定内容・対象・件数を確認します。
5. 問題がなければ同じ対象を dry_run: false で実行し、ログが成功したことを確認します。対象の GitHub リポジトリの **Issues → Labels** で共通ラベルの名前・説明・色を再確認します。
6. 定義にないラベルは削除しません。同期は管理対象の追加・属性更新のみを行い、Issue に付いたラベルや Issue Type を変更しません。

正本取得の失敗や内容の不一致で同期が停止した場合は、apply を繰り返さず、正本のURL・変更のマージ状態・labels.json の内容を先に確認します。GitHub API エラーで一部リポジトリだけ失敗した場合は、失敗対象を特定し、個別 dry-run の後に再実行します。

## 実施したこと・検証記録

以下の実環境結果は利用者から共有・確認された記録です。GitHub AppやCloudflareの管理画面を本作業から独立に再確認したものとは区別します。

### 基盤と権限

- [PR #4](https://github.com/Ateliers-Dev/.github/pull/4) で共通ラベル同期の基盤を追加し、既存リポジトリへの手動同期と、新規リポジトリ作成イベントからの同期経路を用意しました。
- ラベル方針の正本を ateliers-website に置き、名前・説明を実行時に照合する構成にしました。Issue Type と共通ラベルは役割を分け、併用を許容します。
- 同期用 GitHub App は Issues: write（GitHub App の基本権限 Metadata: read を除く）でラベルを同期します。通知用 GitHub App は .github リポジトリに対象を限定し、Contents: read/write と Metadata: read を使って dispatch を行います。両者を分離し、通知用 App に Issue 書き込み権限を与えません。
- Organization Webhook は repository イベントを Worker に送り、Cloudflare Worker は署名・イベント・Organization・Repository を検証してから通知します。Worker と Actions の間も HMAC で dispatch を検証し、検証後に同期用の書き込みトークンを使います。
- Actions は手動の全体・個別 dry-run/apply と、署名検証済みの新規リポジトリイベントによる個別 apply を処理します。定期実行はありません。

### 実環境で見つけた問題と対応

- 既存18リポジトリへの apply が成功しました。
- 短縮リポジトリ名指定で署名検証・対象リポジトリ検証に失敗しました。PR #5 で正式名へ正規化する処理を追加しました。修正版の短縮名を実環境で再試験した結果は未確認です。
- Webhook の404は受信URLを修正して再送信した後に解消し、ping は成功しました。
- repository.created は Worker で署名・Organization・Repository の検証を通過しましたが、初回は Worker が502を返し、内部の installation token 発行が403となりました。403の原因は未確定です。PR #5 で両 GitHub API 呼び出しに明示的な User-Agent と、情報を制限した診断ログを追加しましたが、User-Agent追加との因果関係は確定していません。
- 正本取得時の一時的なHTTP 503には、最大3回のバックオフ付き再試行を追加しました。再試行後も取得できない場合は同期を中止します。
- PR #5 の回帰テストは同期テスト14件と Worker テスト6件、計20件が成功し、PR の validate workflow も成功したと報告されています。[PR #5](https://github.com/Ateliers-Dev/.github/pull/5) は main にマージ済みです。
- 修正版 Worker の再デプロイ後、2026-11-24 18:15 JST 頃に既存の repository.created 配信を再送信して成功し、試験リポジトリに日本語の共通ラベルが反映されたことを利用者が確認しました。Worker tail では /health のGETとWebhookのPOSTが Ok と観測されました。403の原因は解明されていません。
- 新規イベントを作成直後に再送信なしで処理した場合の初回成功、短縮名指定の実環境での再試験、試験リポジトリの削除は未確認です。試験リポジトリは削除済みと扱いません。

秘密値、鍵、token、署名値はこの記録に含めません。

## 将来の活用候補（未実装）

今後の拡張候補を記録します。以下は決定済み計画ではなく、必要性と責任分担を検討するための案です。

- **リポジトリ初期化**: 共通ラベルに加え、テンプレート、規約、標準設定の適用・不足検出。
- **Issue / Projects の整合**: Issue Type や必須情報の確認、Projects との整合、登録漏れの検出。単純な自動追加は GitHub Projects の標準機能を先に評価します。
- **公開方針・品質監査**: 公開範囲、レビュー記録、必要な開発文書やリポジトリ設定の適合確認と通知。
- **PR / Release 通知**: 組織内の重要な変更を集約し、関係者へ知らせる。
- **証跡蓄積とAIによる改善支援**: Actions・PR・Issue 等の実績を必要最小限の証跡として蓄積し、AIが傾向分析や改善案を提示する。自動変更は人の承認を含む段階設計にする。
- **Ateliers AI Orchestrator 連携**: 判断・計画を伴う課題だけを連携し、イベント基盤からの起動、権限、監査、失敗時の扱いを別途設計する。

拡張時は、GitHubの標準機能を先に評価し、決定的なルール処理とAIの判断を分離します。イベント購読と権限は用途ごとに段階的に増やし、重複イベント、再送信、順序逆転、部分失敗、再試行、冪等性、監査可能性を設計・検証してから対象を広げます。

## 文書と実装の将来配置

現時点では実装と本運用文書を .github に置きます。将来、Ateliers全体の運用方針やタスク管理の記録を集約する段階で、運用文書を共通ワークスペース ateliers-workspace に移す案を再検討します。

文書の所有責務と実行基盤の配置は別の判断です。文書だけを移管しても、Worker・Actions・GitHub Apps が自動的に移るわけではありません。実装を移す場合は、Webhookの受け口、Secretの保管、App権限、デプロイ、障害対応、責任者を別途評価し、移行計画と切替手順を決めます。今回、実装配置や実行基盤の移行は行っていません。





