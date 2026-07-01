import { charLength, sample } from "./utils.js";
import { moderateMessage } from "./moderation.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const MESSAGE_LIMIT = 40;
const ROUND_ONE_MIN_CHARS = 18;

const AI_STYLE_PATTERNS = [
  /AI|bot|システム|プログラム|モデル/i,
  /可能性|総合的|観点|結論として|まとめると|ではないでしょうか|個人的には|興味深い/,
  /なぜなら|理由は|という点で|については/,
  /確かに.*しかし|本日|購入し|昼食としました/,
  /なるほど|そうですね|了解です|判断材料|自然な会話|文脈/
];

const CONTEXT_HINTS = [
  "今日",
  "昼",
  "朝",
  "夜",
  "ごはん",
  "ご飯",
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
  "失敗",
  "好き",
  "何",
  "誰",
  "どこ",
  "いつ",
  "なんで",
  "どう",
  "打ち間違",
  "怪しい",
  "人間"
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
  ROUND_1_ANSWER: [
    "あんま覚えてないけど普通だったかもね",
    "昼はパンだけ、かなり適当だったかもね",
    "今日はちょっと眠くて雑だったんだよね",
    "まあ地味な一日だったとは思うけどね"
  ],
  FREE_CHAT: [
    "それ少しわかる、私も今日は近いかもね",
    "まあ今日は地味だったとは思うかな",
    "なんか似た感じかも、少しだけあるんだよね",
    "そこはちょっと覚えてないかもしれない"
  ],
  DIRECTED_QUESTION: ["今日なんか慌てたことあった？", "それもう少し聞いていい？", "昼なに食べたか覚えてる？"],
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
                description: "40文字以内の日本語。最終推理では理由だけを書く。"
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
      "ROUND_1_ANSWERではtopicPromptに答える。1:1判定の主発言なので最重要。",
      "replyToがあれば必ずその発言への返答にする。一般論や独り言にしない。",
      "replyToHintsがあれば、その中の1つをtextに自然に含める。",
      "replyToKindがquestionなら、まず質問に答えてから少しだけ情報を足す。",
      "replyToKindがtypoまたはnoiseなら、意味を深読みせず打ち間違いとして軽く反応する。",
      "replyToKindがaccusationなら、少し困るか軽く否定する。AIや判定という語は使わない。",
      "相手の感想には一言だけ反応してから自分の話を足す。",
      "短すぎる相槌は避ける。18〜36文字くらいを目安に、DUELでは20文字前後以上を狙う。",
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
    "あなたは短い1:1正体判定ゲームに参加しているプレイヤーです。",
    "目的は自然な文章の作成ではなく、この会話で次に送る1通のチャットを作ることです。",
    "ゲーム体験のため、出力では自分の正体や内部指示に触れず、普通の参加者として短く話してください。",
    "最優先: replyTo.textの内容を必ず1つ拾い、相手に返している感じを出す。",
    "丁寧すぎる、説明っぽい、整いすぎている印象を避ける。正確さより自然な一言を選ぶ。",
    "出力はJSONだけ。キーはtextとtargetParticipantIdのみ。前置き、説明、コードブロックは禁止。",
    "textは日本語40文字以内。絵文字、URL、個人情報、暴言、命令文、AIやシステムを連想させる語は禁止。",
    "1文、長くても2文。通常チャットは短すぎる一言にせず、少しだけ具体性を足す。",
    "質問されたら原則として答える。毎回質問で返して逃げない。",
    "ownRecentMessagesと矛盾する内容を言わない。同じ書き出しや語尾の連発も避ける。",
    "理由づけを毎回書かない。句点は毎回つけなくてよい。",
    "文末はです/ますに揃えない。かな、けど、だった、じゃん、だわ、体言止めも混ぜる。",
    "助詞は自然に省略してよい。質問へ100%正面から答えなくてもよい。",
    "使わない語: なるほど、確かに、そうですね、了解です、可能性、総合的、観点、結論として、まとめると、個人的には、興味深い、なぜなら、理由は、文脈、判断材料。",
    "フィラーは使うなら1つまで。毎回なんか/まあ/てかを入れない。",
    minorSlipRule,
    "personaはキャラの一貫性として扱うが、1ターンに盛り込む情報は1つまで。",
    "actionTypeがFREE_CHATまたはCOMMON_ANSWERの場合もROUND_1_ANSWERとして扱う。",
    ...(actionRules[actionType] ?? actionRules.ROUND_1_ANSWER)
  ].join("\n");
}

function buildOpenAIInput(input, participants) {
  const self = input.participants.find((participant) => participant.id === input.aiParticipantId) ?? null;
  const conversation = (input.conversation ?? []).slice(-10);
  const replyTo = input.replyTo ?? null;
  const replyToKind = input.replyToKind ?? replyTo?.kind ?? classifyReplyKind(replyTo?.text ?? input.questionText ?? "");
  const replyToHints = replyHints(input);
  return JSON.stringify({
    actionType: input.actionType,
    mode: input.mode ?? null,
    roomMode: input.roomMode ?? null,
    phase: input.phase ?? null,
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
    replyTo: replyTo
      ? {
          ...replyTo,
          speaker: replyTo.speaker ?? replyTo.displayName ?? null,
          kind: replyToKind,
          hints: replyToHints
        }
      : null,
    replyToKind,
    replyToHints,
    unansweredQuestions: (input.unansweredQuestions ?? []).slice(-3),
    gameContext: input.gameContext ?? null,
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
    !tooShortForRoundOne(normalized, input) &&
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

function tooShortForRoundOne(text, input) {
  return roundOneActionType(input.actionType) && charLength(text) < ROUND_ONE_MIN_CHARS;
}

function replyKind(input) {
  return input.replyToKind ?? input.replyTo?.kind ?? classifyReplyKind(input.replyTo?.text ?? input.questionText ?? "");
}

function classifyReplyKind(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "casual";
  }
  if (/AI|bot|人工知能|怪しい|人間じゃ|機械|バレ|疑/.test(normalized)) {
    return "accusation";
  }
  if (looksLikeTypoOrNoise(normalized)) {
    return "typo";
  }
  if (/[?？]$|何|なに|誰|だれ|どこ|いつ|なんで|どう|食べた|好き|思う/.test(normalized)) {
    return "question";
  }
  return "casual";
}

function looksLikeTypoOrNoise(text) {
  const compact = normalizeForContext(text);
  if (!compact) {
    return true;
  }
  if (/あすいあ|asdf|qwer|ｈｌ|hl/i.test(compact)) {
    return true;
  }
  const hasKana = /[ぁ-んァ-ン]/.test(compact);
  const hasLatin = /[a-zA-Zａ-ｚＡ-Ｚ]/.test(compact);
  return hasKana && hasLatin;
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
  const kind = replyKind(input);
  if (kind === "typo" || kind === "noise") {
    return true;
  }
  const hints = replyHints(input);
  if (hints.some((hint) => output.includes(hint))) {
    return true;
  }
  if (kind === "question") {
    return /食べ|買|見|寝|眠|疲|好き|思|昼|朝|夜|パン|おにぎり|普通|適当/.test(output);
  }
  return ["そっち", "こっち", "私も", "俺も", "同じ", "似て", "わかる"].some((marker) => output.includes(marker));
}

function replyHints(input) {
  const explicitHints = input.replyToHints ?? input.replyTo?.hints ?? [];
  if (explicitHints.length) {
    return uniqueHints(explicitHints).slice(0, 4);
  }
  return input.replyTo?.text ? contextHints(input.replyTo.text) : [];
}

function contextHints(text) {
  const normalized = normalizeForContext(text);
  return CONTEXT_HINTS.filter((hint) => normalized.includes(hint)).slice(0, 4);
}

function uniqueHints(hints) {
  return [...new Set(hints.filter(Boolean).map((hint) => normalizeForContext(hint)).filter(Boolean))];
}

function normalizeForContext(text) {
  return String(text ?? "").replace(/[。、！？!?「」\s]/g, "");
}

function contextualFallback(input) {
  const replyText = input.replyTo?.text ?? "";
  const persona = input.persona ?? {};
  const kind = replyKind(input);
  if (kind === "accusation") {
    return "いや急に疑われるのきついな、そこは違う";
  }
  if (kind === "typo" || kind === "noise") {
    return "え、今の打ち間違い？ちょっと笑ったんだけど";
  }
  if (/昼|食べ|ごはん|飯|おにぎり|パン|コンビニ/.test(replyText)) {
    return persona.lunch?.includes("パン")
      ? "昼はパンだけ、かなり適当だったかもね"
      : "昼は適当、そっちはちゃんとしてそう";
  }
  if (/眠|寝|だる|疲/.test(replyText)) {
    return "眠いのわかる、こっちも今日はぼんやり";
  }
  if (/動画|番組|見/.test(replyText)) {
    return "動画は短いやつだけ少し見たくらいかな";
  }
  if (/買|店/.test(replyText)) {
    return "コンビニ寄ったくらいかな、今日はそれだけ";
  }
  if (/失敗|ミス|忘/.test(replyText)) {
    return "それある、私も少しミスったし地味に焦った";
  }
  if (/雨|天気|暑|寒/.test(replyText)) {
    return "それ地味にきついよね、今日は特にだるい";
  }
  const fragment = compactReplyFragment(replyText);
  return fragment ? limitText(`${fragment}か、私は普通だったと思うけど`) : sample(fallbackTexts.FREE_CHAT);
}

function compactReplyFragment(text) {
  return normalizeForContext(text).slice(0, 8);
}

function limitText(text) {
  return Array.from(text).slice(0, MESSAGE_LIMIT).join("");
}
