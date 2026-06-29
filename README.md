# AI人狼 MVP

4人部屋のうち3人が人間、1人がモックAIとして参加するチャット人狼ゲームです。

## 起動

```bash
npm start
```

起動後、ブラウザで `http://localhost:3000` を開きます。3つのタブで「プレイ開始」を押すと、3人マッチングが成立してAI入りの4人部屋が作られます。

## 実装内容

- ゲストセッション
- 3人マッチング
- 4人部屋生成とAI参加者追加
- 市民2人、AI協力者1人、AI1体の役職割り当て
- AI協力者だけへのAI正体開示
- 設定カード配布
- 3ラウンド制のサーバー主導ターン管理
- 60字制限
- ルール外発言ブロックとターン消費
- モックAI発言生成
- 人間3人だけの投票
- 勝敗判定、結果発表、簡易戦績
- 通報、退出処理

## 補足

このMVPは依存なしのNode.js実装です。`src/aiClient.js` と `src/moderation.js` を差し替えることで、本番AI APIや外部モデレーションAPIへ移行できます。

## Render Freeで公開する

このリポジトリはRenderの無料Web Serviceで動かせるように `render.yaml` を含めています。

1. RenderでGitHubリポジトリ `hinonatsu/aijinro` を接続する
2. BlueprintまたはWeb Serviceとして作成する
3. Build Command は `npm install`
4. Start Command は `npm start`
5. Health Check Path は `/healthz`
6. 初回デプロイでは環境変数なしで作成できる

Renderでは `PORT` が自動で渡されます。サーバーは `process.env.PORT` を優先して起動します。

現在のMVPはモックAIで動くため、初回公開にAPIキーは不要です。本番AI APIへ差し替える時だけ、RenderのEnvironmentから `OPENAI_API_KEY` を追加してください。

公開リポジトリにAPIキーを置かないでください。ローカルで使う場合は `.env.example` を参考にし、実際の `.env` はコミットしないでください。

```powershell
$env:OPENAI_API_KEY="sk-..."
npm.cmd start
```

ヘルスチェック:

```text
GET /healthz
```

注意: 現在のMVPはメモリ上でゲーム状態を管理します。Render Freeではスリープや再起動で進行中の試合と戦績が消えます。公開デモ用途には十分ですが、常時運用する場合はPostgreSQLやRedisへの移行が必要です。
