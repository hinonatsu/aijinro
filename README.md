# AI人狼 MVP

4人部屋のうち3人が人間、1人がAIとして参加するチャット人狼ゲームです。待たずに遊べる1:1練習モードもあります。

## 起動

```bash
npm start
```

起動後、ブラウザで `http://localhost:3000` を開きます。「1:1で練習」を押すとすぐAI入りの2人部屋が作られます。3つのタブで「4人部屋で遊ぶ」を押すと、3人マッチングが成立してAI入りの4人部屋が作られます。

## 実装内容

- ゲストセッション
- 3人マッチング
- 1:1練習モード
- 4人部屋生成とAI参加者追加
- 市民2人、AI協力者1人、AI1体の役職割り当て
- AI協力者だけへのAI正体開示
- 3ラウンド制のサーバー主導ターン管理
- 30秒固定送信
- 30文字制限
- ルール外発言ブロックとターン消費
- OpenAI APIまたはモックAIでの発言生成
- 4人版の人間プレイヤーだけの投票
- 2人版の投票なしAI判定
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
