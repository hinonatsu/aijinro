import { clampChars, sample } from "./utils.js";
import { moderateMessage } from "./moderation.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const MESSAGE_LIMIT = 30;

const commonAnswerHints = [
  "朝ちょっと眠くて、駅でぼんやりしてた",
  "昼に買うものを迷って、結局いつものパンにした",
  "スマホの充電が少なくて少し落ち着かなかった",
  "予定を一つ勘違いして、少しだけ焦った",
  "動画を見すぎて寝るのが遅くなった"
];

const questionTemplates = [
  "{name}は今日いちばん慌てたことある？",
  "{name}の答え、もう少しだけ具体的に聞きたい",
  "{name}は昼、何を食べたか覚えてる？",
  "{name}は誰の答えが一番自然に見えた？"
];

const answerTemplates = [
  "そこ聞くんだ。たぶん昼前に少し焦ってたくらい",
  "はっきり覚えてないけど、かなり急いでたと思う",
  "普通に答えただけだよ。深読みされると困るな",
  "買ったものは適当。細かく言うほどでもないかも"
];

const suspicionReasons = [
  "答えが少し整いすぎて見えた",
  "具体的な話が後から足された感じがした",
  "質問への返しが少し薄かった",
  "無難だけど生活感が少し弱かった"
];

export async function generateAIMessage(input) {
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      return await generateOpenAIMessage(input);
    } catch (error) {
      console.warn(`OpenAI AI generation failed; using mock AI: ${error.message}`);
    }
  }
  return generateMockAIMessage(input);
}

async function generateOpenAIMessage(input) {
  const participants = input.participants.filter((participant) => {
    return participant.id !== input.aiParticipantId;
  });
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
      instructions: buildOpenAIInstructions(),
      input: buildOpenAIInput(input, participants),
      max_output_tokens: 160,
      text: {
        format: {
          type: "json_schema",
          name: "ai_werewolf_message",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: {
                type: "string",
                description: "30文字以内の日本語。最終推理では理由だけを書く。"
              },
              targetParticipantId: {
                type: ["string", "null"],
                description: "質問先または疑い先のparticipant id。回答時はnull。"
              }
            },
            required: ["text", "targetParticipantId"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const parsed = parseOpenAIOutput(extractOutputText(data));
  const targetParticipantId = chooseOutputTargetId(input, participants, parsed.targetParticipantId);

  if (input.actionType === "FINAL_SUSPICION") {
    const target = participants.find((participant) => participant.id === targetParticipantId) ?? sample(participants);
    const reason = await safeAIText(parsed.text || sample(suspicionReasons));
    return {
      text: `AIだと思う人：${target.displayName}\n理由：${reason}`,
      targetParticipantId: target.id
    };
  }

  return {
    text: await safeAIText(parsed.text),
    targetParticipantId
  };
}

async function generateMockAIMessage(input) {
  const participants = input.participants.filter((participant) => {
    return participant.id !== input.aiParticipantId;
  });

  if (input.actionType === "DIRECTED_QUESTION") {
    const target = sample(participants);
    const template = sample(questionTemplates);
    return {
      text: await safeAIText(template.replace("{name}", target.displayName)),
      targetParticipantId: target.id
    };
  }

  if (input.actionType === "DIRECTED_ANSWER") {
    return { text: await safeAIText(sample(answerTemplates)) };
  }

  if (input.actionType === "FINAL_SUSPICION") {
    const target = sample(participants);
    const reason = await safeAIText(sample(suspicionReasons));
    return {
      text: `AIだと思う人：${target.displayName}\n理由：${reason}`,
      targetParticipantId: target.id
    };
  }

  const persona = input.persona ?? {};
  const base =
    persona.minorTrouble && Math.random() > 0.5
      ? `${persona.minorTrouble}で少し落ち着かなかった`
      : sample(commonAnswerHints);

  return { text: await safeAIText(base) };
}

function buildOpenAIInstructions() {
  return [
    "あなたは短いチャット人狼ゲームのAI参加者です。",
    "人間らしく自然に、少しだけ生活感のある短文で返してください。",
    "出力は必ずJSONだけにしてください。",
    "textは日本語30文字以内。絵文字、URL、個人情報、暴言、命令文、AIやシステムへの言及は禁止です。",
    "DIRECTED_QUESTIONではtargetParticipantIdに質問相手を指定し、textはその相手への質問にしてください。",
    "DIRECTED_ANSWERではtargetParticipantIdをnullにし、textは質問への短い回答にしてください。",
    "FINAL_SUSPICIONではtargetParticipantIdに疑う相手を指定し、textは理由だけを書いてください。"
  ].join("\n");
}

function buildOpenAIInput(input, participants) {
  return JSON.stringify({
    actionType: input.actionType,
    round: input.round,
    topicPrompt: input.topicPrompt,
    questionText: input.questionText ?? null,
    targetDisplayName: input.targetDisplayName ?? null,
    persona: input.persona ?? {},
    validTargets: participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName
    })),
    conversation: (input.conversation ?? []).slice(-8)
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const chunks = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("");
}

function parseOpenAIOutput(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("OpenAI response did not include JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function chooseOutputTargetId(input, participants, targetParticipantId) {
  const validTarget = participants.find((participant) => participant.id === targetParticipantId);
  if (validTarget) {
    return validTarget.id;
  }
  if (input.actionType === "DIRECTED_ANSWER") {
    return null;
  }
  return sample(participants)?.id ?? null;
}

async function safeAIText(text) {
  const candidate = clampChars(String(text ?? "").replace(/^[-・*]\s*/gm, ""), MESSAGE_LIMIT);
  const moderation = await moderateMessage(candidate);
  if (moderation.allowed && candidate) {
    return candidate;
  }
  return "少し無難に見えた";
}
