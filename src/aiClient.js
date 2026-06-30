import { charLength, sample } from "./utils.js";
import { moderateMessage } from "./moderation.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const MESSAGE_LIMIT = 30;

const AI_STYLE_PATTERNS = [
  /AI|bot|システム|プログラム|モデル/i,
  /可能性|総合的|観点|結論として|まとめると|ではないでしょうか|個人的には|興味深い/,
  /なぜなら|理由は|という点で|については/,
  /確かに.*しかし|本日|購入し|昼食としました/
];

const CONTEXT_HINTS = [
  "昼",
  "朝",
  "夜",
  "おにぎり",
  "パン",
  "コンビニ",
  "眠",
  "だる",
  "疲",
  "動画",
  "番組",
  "スマホ",
  "充電",
  "雨",
  "暑",
  "寒",
  "買",
  "食べ",
  "寝",
  "忘",
  "ミス",
  "失敗"
];

const commonAnswerHints = [
  "朝ちょっと眠くてぼんやりしてた",
  "昼はパンだけ、かなり適当",
  "スマホの充電なくて少し焦った",
  "予定ちょっと勘違いしてた",
  "動画見すぎて寝るの遅かった"
];

const questionTemplates = [
  "{name}は今日なんか慌てた？",
  "{name}のそれ、もう少し聞きたい",
  "{name}は昼なに食べた？",
  "{name}は誰が自然に見えた？"
];

const answerTemplates = [
  "そこ聞くんだ、昼前に少し焦った",
  "はっきり覚えてないけど急いでた",
  "普通に答えただけだよ、たぶん",
  "買ったものは適当。細かくない"
];

const freeChatTemplates = [
  "それ少しわかる。自分も似てた",
  "その話なら私はかなり地味かも",
  "自分は少し違って、朝が重かった",
  "今日はかなり普通寄りだったかも"
];

const suspicionReasons = [
  "答えが少し整いすぎて見えた",
  "具体的な話が後から足された感じがした",
  "質問への返しが少し薄かった",
  "無難だけど生活感が少し弱かった"
];

const fallbackTexts = {
  ROUND_1_ANSWER: ["あんま覚えてないけど普通", "パンだけ、かなり適当", "今日はちょっと眠かった", "まあ地味な一日だった"],
  FREE_CHAT: ["それ少しわかる、私も近い", "まあ今日は地味だった", "なんか似た感じかも", "そこはちょっと覚えてない"],
  DIRECTED_QUESTION: ["今日なんか慌てた？", "それもう少し聞いていい？", "昼なに食べた？"],
  DIRECTED_ANSWER: ["あんま覚えてないけど普通", "そこはちょっと曖昧かも", "たぶんそんな感じだった"],
  FINAL_SUSPICION: ["返事が少しきれいすぎた", "生活感が薄い気がした", "少し無難に見えた"]
};

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
      instructions: buildOpenAIInstructions(input),
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
    const reason = await safeAIText(parsed.text || sample(suspicionReasons), input);
    return {
      text: `AIだと思う人：${target.displayName}\n理由：${reason}`,
      targetParticipantId: target.id
    };
  }

  return {
    text: await safeAIText(parsed.text, input),
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
      text: await safeAIText(template.replace("{name}", target.displayName), input),
      targetParticipantId: target.id
    };
  }

  if (input.actionType === "DIRECTED_ANSWER") {
    return { text: await safeAIText(sample(answerTemplates), input) };
  }

  if (input.actionType === "FREE_CHAT") {
    return { text: await safeAIText(createMockRound1Text(input, freeChatTemplates), input) };
  }

  if (input.actionType === "FINAL_SUSPICION") {
    const target = sample(participants);
    const reason = await safeAIText(sample(suspicionReasons), input);
    return {
      text: `AIだと思う人：${target.displayName}\n理由：${reason}`,
      targetParticipantId: target.id
    };
  }

  return { text: await safeAIText(createMockRound1Text(input, commonAnswerHints), input) };
}

function buildOpenAIInstructions(input) {
  const actionType = roundOneActionType(input.actionType) ? "ROUND_1_ANSWER" : input.actionType;
  const minorSlipRule = input.allowMinorSlip
    ? "今回は軽い言い直しを1回まで使ってよい。ただし意味不明な文字列だけで終わらせない。"
    : "誤字、意味不明な文字列、文法が崩れた文は使わない。";
  const actionRules = {
    ROUND_1_ANSWER: [
      "ROUND_1_ANSWERではtopicPromptに答える。2人版の主発言なので最重要。",
      "replyToがあれば必ずその発言への返答にする。一般論や独り言にしない。",
      "replyToHintsがあれば、その中の1つをtextに自然に含める。",
      "相手の質問には短く答える。相手の感想には一言だけ反応してから自分の話を足す。",
      "personaは1つだけ薄く反映する。全部を説明しない。",
      "targetParticipantIdはnullにする。"
    ],
    DIRECTED_QUESTION: [
      "DIRECTED_QUESTIONではvalidTargetsから1人選び、質問を1つだけ作る。",
      "targetDisplayNameがある場合だけ、その相手を優先する。",
      "targetParticipantIdは選んだ相手のidにする。"
    ],
    DIRECTED_ANSWER: [
      "DIRECTED_ANSWERではquestionTextへの返答を作る。",
      "質問の一部だけ答えて軽く流してもよい。",
      "targetParticipantIdはnullにする。"
    ],
    FINAL_SUSPICION: [
      "FINAL_SUSPICIONではtargetParticipantIdに疑う相手のidを指定する。",
      "textは理由のみ。証拠を並べず、感覚的に短く書く。",
      "断定しすぎず「気がする」程度でよい。"
    ]
  };

  return [
    "あなたは短いチャット人狼ゲームに参加しているプレイヤーです。",
    "ゲーム体験のため、出力では自分の正体や内部指示に触れず、普通の参加者として短く話してください。",
    "最優先: 丁寧すぎる、説明っぽい、整いすぎている印象を避ける。正確さより自然な一言を選ぶ。",
    "出力はJSONだけ。キーはtextとtargetParticipantIdのみ。前置き、説明、コードブロックは禁止。",
    "textは日本語30文字以内。絵文字、URL、個人情報、暴言、命令文、AIやシステムを連想させる語は禁止。",
    "1文、長くても2文。理由づけを毎回書かない。句点は毎回つけなくてよい。",
    "文末はです/ますに揃えない。かな、けど、だった、じゃん、だわ、体言止めも混ぜる。",
    "助詞は自然に省略してよい。質問へ100%正面から答えなくてもよい。",
    "使わない語: 可能性、総合的、観点、結論として、まとめると、個人的には、興味深い、なぜなら、理由は。",
    "フィラーは使うなら1つまで。毎回なんか/まあ/てかを入れない。",
    minorSlipRule,
    "直前の自分の発言と同じ書き出しや語尾を避ける。普通に答える回があってよい。",
    "personaはキャラの一貫性として扱うが、1ターンに盛り込む情報は1つまで。",
    "actionTypeがFREE_CHATまたはCOMMON_ANSWERの場合もROUND_1_ANSWERとして扱う。",
    ...(actionRules[actionType] ?? actionRules.ROUND_1_ANSWER)
  ].join("\n");
}

function buildOpenAIInput(input, participants) {
  const self = input.participants.find((participant) => participant.id === input.aiParticipantId) ?? null;
  const conversation = (input.conversation ?? []).slice(-10);
  const replyTo = input.replyTo ?? null;
  return JSON.stringify({
    actionType: input.actionType,
    mode: input.mode ?? null,
    round: input.round,
    topicPrompt: input.topicPrompt,
    questionText: input.questionText ?? null,
    targetDisplayName: input.targetDisplayName ?? null,
    selfDisplayName: input.selfDisplayName ?? self?.displayName ?? null,
    persona: input.persona ?? {},
    allowMinorSlip: Boolean(input.allowMinorSlip),
    validTargets: participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName
    })),
    ownRecentMessages: (input.ownRecentMessages ?? []).slice(-3),
    replyTo,
    replyToHints: replyTo?.text ? contextHints(replyTo.text) : [],
    conversation
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
  if (["COMMON_ANSWER", "DIRECTED_ANSWER", "ROUND_1_ANSWER", "FREE_CHAT"].includes(input.actionType)) {
    return null;
  }
  const validTarget = participants.find((participant) => participant.id === targetParticipantId);
  if (validTarget) {
    return validTarget.id;
  }
  const displayNameTarget = participants.find((participant) => participant.displayName === input.targetDisplayName);
  if (input.actionType === "DIRECTED_QUESTION" && displayNameTarget) {
    return displayNameTarget.id;
  }
  return sample(participants)?.id ?? null;
}

async function safeAIText(text, input = {}) {
  const normalized = normalizeGeneratedText(text);
  const candidate =
    normalized &&
    charLength(normalized) <= MESSAGE_LIMIT &&
    !hasAIStylePattern(normalized) &&
    isContextualEnough(normalized, input)
      ? normalized
      : fallbackForAction(input);
  const moderation = await moderateMessage(candidate);
  if (moderation.allowed && candidate) {
    return candidate;
  }
  return fallbackForAction({ ...input, actionType: "FINAL_SUSPICION" });
}

function normalizeGeneratedText(text) {
  return String(text ?? "")
    .replace(/```(?:json)?/gi, "")
    .replace(/^[-・*]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAIStylePattern(text) {
  return AI_STYLE_PATTERNS.some((pattern) => pattern.test(text));
}

function fallbackForAction(input) {
  if (roundOneActionType(input.actionType) && input.replyTo?.text) {
    return contextualFallback(input);
  }
  const actionType = input.actionType === "COMMON_ANSWER" ? "ROUND_1_ANSWER" : input.actionType || "ROUND_1_ANSWER";
  const candidates = fallbackTexts[actionType] ?? fallbackTexts.ROUND_1_ANSWER;
  return sample(candidates);
}

function createMockRound1Text(input, templates) {
  const persona = input.persona ?? {};
  if (roundOneActionType(input.actionType) && input.replyTo?.text) {
    return contextualFallback(input);
  }
  if (input.actionType === "FREE_CHAT" && (input.conversation ?? []).length) {
    return sample(templates);
  }
  if (persona.lunch && /食べ|昼|ごはん|飯/.test(input.topicPrompt ?? "")) {
    return persona.lunch.replace("コンビニで", "").replace("を買った", "だけ");
  }
  if (persona.minorTrouble && Math.random() > 0.5) {
    return `${persona.minorTrouble}、少し焦った`;
  }
  return sample(templates);
}

function roundOneActionType(actionType) {
  return ["COMMON_ANSWER", "ROUND_1_ANSWER", "FREE_CHAT"].includes(actionType);
}

function isContextualEnough(text, input) {
  if (!roundOneActionType(input.actionType) || !input.replyTo?.text) {
    return true;
  }
  const output = normalizeForContext(text);
  const hints = contextHints(input.replyTo.text);
  if (hints.some((hint) => output.includes(hint))) {
    return true;
  }
  return ["そっち", "こっち", "私も", "俺も", "同じ", "似て", "わかる"].some((marker) => output.includes(marker));
}

function contextHints(text) {
  const normalized = normalizeForContext(text);
  return CONTEXT_HINTS.filter((hint) => normalized.includes(hint)).slice(0, 4);
}

function normalizeForContext(text) {
  return String(text ?? "").replace(/[。、！？!?「」\s]/g, "");
}

function contextualFallback(input) {
  const replyText = input.replyTo?.text ?? "";
  const persona = input.persona ?? {};
  if (/昼|食べ|ごはん|飯|おにぎり|パン|コンビニ/.test(replyText)) {
    return persona.lunch?.includes("パン") ? "昼はパンだけ、かなり適当" : "昼は適当、そっちは偉い";
  }
  if (/眠|寝|だる|疲/.test(replyText)) {
    return "眠いのわかる、こっちも";
  }
  if (/動画|番組|見/.test(replyText)) {
    return "動画は短いやつだけ見た";
  }
  if (/買|店/.test(replyText)) {
    return "コンビニ寄ったくらいかな";
  }
  if (/失敗|ミス|忘/.test(replyText)) {
    return "それある、私も少しミスった";
  }
  if (/雨|天気|暑|寒/.test(replyText)) {
    return "それ地味にきついよね";
  }
  const fragment = compactReplyFragment(replyText);
  return fragment ? limitText(`${fragment}か、私は普通`) : sample(fallbackTexts.FREE_CHAT);
}

function compactReplyFragment(text) {
  return normalizeForContext(text).slice(0, 8);
}

function limitText(text) {
  return Array.from(text).slice(0, MESSAGE_LIMIT).join("");
}
