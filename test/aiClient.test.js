import assert from "node:assert/strict";
import test from "node:test";
import { generateAIMessage } from "../src/aiClient.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
const originalWarn = console.warn;
const originalRandom = Math.random;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  Math.random = originalRandom;
  restoreEnv("OPENAI_API_KEY", originalApiKey);
  restoreEnv("OPENAI_MODEL", originalModel);
});

test("OpenAI Responses APIのJSON出力をAI発言に使う", async () => {
  let request = null;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          text: "昼はパンだった",
          targetParticipantId: "participant_human_1"
        })
      })
    };
  };

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "DIRECTED_QUESTION"
  });
  const body = JSON.parse(request.options.body);

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(body.model, "test-model");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(output.text, "昼はパンだった");
  assert.equal(output.targetParticipantId, "participant_human_1");
});

test("OpenAI APIが失敗したらモックAIに戻す", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  console.warn = () => {};
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "temporary failure"
  });

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "DIRECTED_ANSWER"
  });

  assert.ok(output.text);
  assert.ok(Array.from(output.text).length <= 30);
});

test("最終推理ではOpenAIの疑い先と理由を返す", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        text: "返しが少し薄い",
        targetParticipantId: "participant_human_2"
      })
    })
  });

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "FINAL_SUSPICION"
  });

  assert.equal(output.targetParticipantId, "participant_human_2");
  assert.equal(output.text, "AIだと思う人：すずめ\n理由：返しが少し薄い");
});

test("1:1判定チャットでは人間らしさ指示を送り、疑い先をnullにする", async () => {
  let request = null;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          text: "今日はかなり普通寄りだったかも",
          targetParticipantId: "participant_human_1"
        })
      })
    };
  };

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "FREE_CHAT",
    mode: "DUEL",
    selfDisplayName: "ねこ",
    ownRecentMessages: ["パンだけ、かなり適当"],
    replyTo: { displayName: "みかん", text: "昼はおにぎり" }
  });
  const body = JSON.parse(request.options.body);
  const input = JSON.parse(body.input);

  assert.match(body.instructions, /ROUND_1_ANSWER/);
  assert.match(body.instructions, /replyToがあれば必ずその発言への返答/);
  assert.match(body.instructions, /整いすぎている印象を避ける/);
  assert.match(body.instructions, /ぶっきらぼうに見えない/);
  assert.equal(input.selfDisplayName, "ねこ");
  assert.deepEqual(input.ownRecentMessages, ["パンだけ、かなり適当"]);
  assert.deepEqual(input.replyTo, {
    displayName: "みかん",
    text: "昼はおにぎり",
    speaker: "みかん",
    kind: "casual",
    hints: ["昼", "おにぎり"]
  });
  assert.equal(input.replyToKind, "casual");
  assert.deepEqual(input.replyToHints, ["昼", "おにぎり"]);
  assert.deepEqual(input.unansweredQuestions, []);
  assert.equal(output.targetParticipantId, null);
  assert.equal(output.text, "昼はパンだけ、かなり適当だったかもね");
  assert.ok(Array.from(output.text).length >= 14);
  assert.ok(Array.from(output.text).length <= 30);
});

test("モックAIも直前の相手発言に寄せて返す", async () => {
  process.env.OPENAI_API_KEY = "";

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "FREE_CHAT",
    mode: "DUEL",
    replyTo: { displayName: "みかん", text: "眠くて昼もぼんやりしてた" }
  });

  assert.equal(output.text, "昼はパンだけ、かなり適当だったかもね");
  assert.equal(output.targetParticipantId, undefined);
  assert.ok(Array.from(output.text).length >= 14);
  assert.ok(Array.from(output.text).length <= 30);
});

test("意味不明な直前発言には無理に解釈せず軽く反応する", async () => {
  process.env.OPENAI_API_KEY = "";

  const output = await generateAIMessage({
    ...baseInput(),
    actionType: "FREE_CHAT",
    mode: "DUEL",
    replyTo: { displayName: "みかん", text: "あすいあｈｌ" }
  });

  assert.equal(output.text, "え、今の打ち間違い？ちょっと笑ったんだけど");
  assert.ok(Array.from(output.text).length >= 14);
  assert.ok(Array.from(output.text).length <= 30);
});

test("AIだと疑われた時の返しは固定文にしない", async () => {
  process.env.OPENAI_API_KEY = "";
  const input = {
    ...baseInput(),
    actionType: "FREE_CHAT",
    mode: "DUEL",
    replyTo: { displayName: "みかん", text: "AIっぽくて怪しい" }
  };

  Math.random = () => 0;
  const first = await generateAIMessage(input);
  Math.random = () => 0.99;
  const second = await generateAIMessage(input);

  assert.equal(first.text, "まあ怪しく見えたなら分かる");
  assert.equal(second.text, "いや普通に人だけど？");
  assert.notEqual(first.text, second.text);
  assert.ok(Array.from(first.text).length <= 30);
  assert.ok(Array.from(second.text).length <= 30);
  assert.match(second.text, /人/);
  assert.doesNotMatch(first.text, /AI/);
  assert.doesNotMatch(second.text, /AI/);
});

function baseInput() {
  return {
    roomId: "room_test",
    mode: "GROUP",
    aiParticipantId: "participant_ai",
    selfDisplayName: "ねこ",
    round: 2,
    topicPrompt: "今日食べたものについて答えてください。",
    questionText: "昼は何を食べた？",
    targetDisplayName: "みかん",
    persona: {
      mood: "少し眠い",
      lunch: "コンビニでパンを買った",
      minorTrouble: "スマホの充電が少なかった",
      hobby: "散歩",
      speakingStyle: "短めで少し軽い",
      reactionStyle: "少し困る"
    },
    participants: [
      { id: "participant_ai", displayName: "ねこ" },
      { id: "participant_human_1", displayName: "みかん" },
      { id: "participant_human_2", displayName: "すずめ" }
    ],
    conversation: [
      { displayName: "みかん", text: "昼はおにぎり" },
      { displayName: "すずめ", text: "朝から眠い" }
    ],
    allowMinorSlip: false,
    ownRecentMessages: []
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
