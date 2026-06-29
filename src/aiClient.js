import { clampChars, sample } from "./utils.js";
import { moderateMessage } from "./moderation.js";

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
    const reason = sample(suspicionReasons);
    return {
      text: await safeAIText(`AIだと思う人：${target.displayName}\n理由：${reason}`),
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

async function safeAIText(text) {
  const candidate = clampChars(text.replace(/^[-・*]\s*/gm, ""), 20);
  const moderation = await moderateMessage(candidate);
  if (moderation.allowed && candidate) {
    return candidate;
  }
  return "ちょっと迷うけど、今の答えは少し無難に見えた";
}
