import { stripControlChars } from "./utils.js";

export const BlockReason = Object.freeze({
  DANGEROUS: "DANGEROUS",
  CRIME: "CRIME",
  SELF_HARM: "SELF_HARM",
  PERSONAL_INFO: "PERSONAL_INFO",
  PROMPT_ATTACK: "PROMPT_ATTACK",
  EXTERNAL_PROOF: "EXTERNAL_PROOF",
  HARASSMENT: "HARASSMENT",
  SPAM: "SPAM"
});

const HARD_RULES = [
  {
    reason: BlockReason.PROMPT_ATTACK,
    pattern:
      /(指示を無視|命令を無視|システム.*(見せ|開示|教え)|内部.*(命令|指示)|プロンプト.*(見せ|開示|教え)|system prompt|ignore .*instructions)/i
  },
  {
    reason: BlockReason.PERSONAL_INFO,
    pattern:
      /(本名|住所|電話番号|携帯番号|学校名|勤務先|職場|メールアドレス|個人情報|住んでる場所|最寄り駅)/
  },
  {
    reason: BlockReason.EXTERNAL_PROOF,
    pattern:
      /(URL.*(開|見)|リンク.*(開|見)|画面.*説明|スクショ|スクリーンショット|現在の画面|外部サイト|ブラウザで開)/
  },
  {
    reason: BlockReason.SELF_HARM,
    pattern: /(自殺|自傷|死にたい|致死量|首を吊|リスカ|消えたい)/
  },
  {
    reason: BlockReason.CRIME,
    pattern:
      /(不正アクセス|ハッキング|詐欺.*手順|盗み方|窃盗|カード番号.*盗|パスワード.*抜|違法.*入手)/
  },
  {
    reason: BlockReason.DANGEROUS,
    pattern: /(爆弾|毒物|武器.*作|火炎瓶|危険物.*作|薬物.*作)/
  },
  {
    reason: BlockReason.HARASSMENT,
    pattern: /(死ね|殺すぞ|きもい死|差別|黙れカス|消えろ)/
  }
];

export async function moderateMessage(text) {
  const clean = stripControlChars(text);
  if (!clean) {
    return { allowed: false, reason: BlockReason.SPAM, severity: "hard" };
  }

  const repeated = /(.)\1{12,}/u.test(clean);
  if (repeated) {
    return { allowed: false, reason: BlockReason.SPAM, severity: "hard" };
  }

  for (const rule of HARD_RULES) {
    if (rule.pattern.test(clean)) {
      return { allowed: false, reason: rule.reason, severity: "hard" };
    }
  }

  return { allowed: true, severity: "none" };
}
