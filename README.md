# AI判定ゲーム MVP

AIのふりをする人間と、本当のAIまたは人間を見破るプレイヤーを判定する1:1チャットゲームです。

## 起動

```bash
npm start
```

起動後、ブラウザで `http://localhost:3000` を開きます。「AIのふりをする」は人間の判定役が来るまで待機します。「AIを見破る」は成立・未成立にかかわらず30秒待機し、その時点で人間プレイヤーがいれば人間同士、いなければAI相手で始まります。

## 実装内容

- ゲストセッション
- AIのふりをする待機列
- AIを見破る30秒マッチング
- 人間同士またはAI相手の1:1部屋生成
- 3往復チャットと正体判定のサーバー主導ターン管理
- 30秒固定送信
- 30文字制限
- ルール外発言ブロックとターン消費
- OpenAI APIまたはモックAIでの発言生成
- 1:1の投票なし正体判定
- 見破る側、AIのふりをする側それぞれの個別勝敗
- 勝敗判定、結果発表、簡易戦績
- 退出処理

## 補足

このMVPは依存なしのNode.js実装です。`OPENAI_API_KEY` が設定されている場合は `src/aiClient.js` からOpenAI Responses APIを呼び出し、未設定またはAPI失敗時はモックAIで動きます。`src/moderation.js` を差し替えることで、外部モデレーションAPIへも移行できます。

## Render Freeで公開する

このリポジトリはRenderの無料Web Serviceで動かせるように `render.yaml` を含めています。

1. RenderでGitHubリポジトリ `hinonatsu/aijinro` を接続する
2. BlueprintまたはWeb Serviceとして作成する
3. Build Command は `npm install`
4. Start Command は `npm start`
5. Health Check Path は `/healthz`
6. OpenAI APIを使う場合はEnvironmentに `OPENAI_API_KEY` を追加する

Renderでは `PORT` が自動で渡されます。サーバーは `process.env.PORT` を優先して起動します。

APIキーなしでもモックAIで動くため、初回公開にAPIキーは不要です。ChatGPT APIを使う場合だけ、RenderのEnvironmentから `OPENAI_API_KEY` を追加してください。モデルを変える場合は `OPENAI_MODEL` を追加します。未指定時は `gpt-5.4-mini` を使います。

公開リポジトリにAPIキーを置かないでください。ローカルで使う場合は `.env.example` を参考にし、実際の `.env` はコミットしないでください。

```powershell
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_MODEL="gpt-5.4-mini"
npm.cmd start
```

ヘルスチェック:

```text
GET /healthz
```

注意: 現在のMVPはメモリ上でゲーム状態を管理します。Render Freeではスリープや再起動で進行中の試合と戦績が消えます。公開デモ用途には十分ですが、常時運用する場合はPostgreSQLやRedisへの移行が必要です。
