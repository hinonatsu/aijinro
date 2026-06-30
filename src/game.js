import EventEmitter from "node:events";
import { generateAIMessage } from "./aiClient.js";
import { BlockReason, moderateMessage } from "./moderation.js";
import { emptyStats, resetStore, store } from "./store.js";
import {
  charLength,
  clampChars,
  id,
  publicError,
  sample,
  shuffle,
  stripControlChars,
  toIso,
  token
} from "./utils.js";

export const gameEvents = new EventEmitter();

export const RoomStatus = Object.freeze({
  WAITING: "WAITING",
  ROLE_REVEAL: "ROLE_REVEAL",
  ROUND_1: "ROUND_1",
  ROUND_2: "ROUND_2",
  ROUND_3: "ROUND_3",
  VOTING: "VOTING",
  RESULT: "RESULT",
  CLOSED: "CLOSED"
});

export const Role = Object.freeze({
  CITIZEN: "CITIZEN",
  AI_COLLABORATOR: "AI_COLLABORATOR",
  AI: "AI"
});

export const Team = Object.freeze({
  HUMAN: "HUMAN",
  AI: "AI"
});

export const RoomMode = Object.freeze({
  GROUP: "GROUP",
  DUEL: "DUEL"
});

const TURN_MS = 30_000;
const VOTE_MS = 15_000;
const MESSAGE_LIMIT = 30;

const DISPLAY_NAMES = [
  "みかん",
  "すずめ",
  "たぬき",
  "こあら",
  "ぺんぎん",
  "きつね",
  "うさぎ",
  "いるか",
  "ねこ",
  "からす"
];

const TOPICS = [
  "今日ちょっと面倒だったことを答えてください。",
  "最近見た動画や番組について短く答えてください。",
  "今日食べたものについて答えてください。",
  "最近少しイラッとしたことを答えてください。",
  "今日スマホで見たものを一つ答えてください。",
  "最近買ったものについて答えてください。",
  "今の気分を天気で例えてください。",
  "最近ちょっと失敗したことを答えてください。",
  "休日の過ごし方を短く答えてください。",
  "自分の変な癖を一つ答えてください。"
];

const PERSONA_PARTS = {
  mood: ["少し眠い", "妙に元気", "落ち着いている", "少し焦り気味", "ぼんやりしている"],
  lunch: [
    "コンビニでパンを買った",
    "昨日の残りを食べた",
    "おにぎりとお茶にした",
    "カレーを急いで食べた",
    "昼は軽く済ませた"
  ],
  minorTrouble: [
    "スマホの充電が少なかった",
    "傘を忘れた",
    "レジが混んでいた",
    "予定を少し勘違いした",
    "イヤホンが片方だけ見つからなかった"
  ],
  hobby: ["動画を見ること", "散歩", "音楽を聞くこと", "短いゲーム", "喫茶店でぼんやりすること"],
  speakingStyle: ["短めで少し軽い", "ゆっくりめ", "少し茶化す", "あまり断定しない", "具体例を一つ入れる"],
  reactionStyle: ["疑われると茶化す", "少し困る", "理由を聞き返す", "軽く流す", "冗談っぽく返す"]
};

export function resetGame() {
  resetStore();
}

export function createGuestSession() {
  const userId = id("user");
  const guestToken = token();
  const displayName = sample(DISPLAY_NAMES);
  const user = {
    id: userId,
    guestToken,
    displayName,
    activeRoomId: null,
    queuedAt: null,
    banUntil: null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    stats: emptyStats(userId)
  };
  store.users.set(userId, user);
  store.tokens.set(guestToken, userId);
  emitChange();
  return { userId, displayName, guestToken, stats: presentStats(user.stats) };
}

export function authenticate(guestToken) {
  const userId = store.tokens.get(guestToken);
  if (!userId) {
    throw publicError("セッションが無効です。", 401);
  }
  const user = store.users.get(userId);
  user.lastSeenAt = Date.now();
  return user;
}

export function getMe(guestToken) {
  const user = authenticate(guestToken);
  const queueIndex = store.queue.indexOf(user.id);
  const room = user.activeRoomId ? store.rooms.get(user.activeRoomId) : null;
  return {
    userId: user.id,
    displayName: user.displayName,
    activeRoomId: room && room.status !== RoomStatus.CLOSED ? room.id : null,
    queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
    queueCount: store.queue.length,
    stats: presentStats(user.stats)
  };
}

export function joinQueue(guestToken) {
  const user = authenticate(guestToken);
  ensureNotBanned(user);
  clearFinishedRoom(user);

  if (user.activeRoomId) {
    return { status: "already_in_room", roomId: user.activeRoomId };
  }

  if (!store.queue.includes(user.id)) {
    user.queuedAt = Date.now();
    store.queue.push(user.id);
  }

  let room = null;
  if (store.queue.length >= 3) {
    const userIds = store.queue.splice(0, 3);
    room = createRoomFromUsers(userIds.map((userId) => store.users.get(userId)), { mode: RoomMode.GROUP });
  }

  emitChange();
  return room
    ? { status: "matched", roomId: room.id, mode: room.mode }
    : { status: "queued", queueCount: store.queue.length };
}

export function startDuelMatch(guestToken) {
  const user = authenticate(guestToken);
  ensureNotBanned(user);
  clearFinishedRoom(user);

  if (user.activeRoomId) {
    const room = store.rooms.get(user.activeRoomId);
    return { status: "already_in_room", roomId: user.activeRoomId, mode: room?.mode ?? RoomMode.GROUP };
  }

  removeFromQueue(user.id);
  user.queuedAt = null;
  const room = createRoomFromUsers([user], { mode: RoomMode.DUEL });

  emitChange();
  return { status: "matched", roomId: room.id, mode: room.mode };
}

export function cancelQueue(guestToken) {
  const user = authenticate(guestToken);
  removeFromQueue(user.id);
  user.queuedAt = null;
  emitChange();
  return { status: "cancelled" };
}

export function getRoomState(guestToken, roomId) {
  const user = authenticate(guestToken);
  const room = assertRoom(roomId);
  const participant = assertParticipant(room, user.id);
  return sanitizeRoomForParticipant(room, participant);
}

export async function submitAction(guestToken, roomId, payload) {
  const user = authenticate(guestToken);
  const room = assertRoom(roomId);
  const participant = assertParticipant(room, user.id);

  if (room.status === RoomStatus.ROLE_REVEAL) {
    if (payload.actionType !== "ROLE_ACK") {
      throw publicError("役職確認を完了してください。");
    }
    participant.roleReady = true;
    if (humanParticipants(room).every((item) => item.roleReady)) {
      startRound1(room);
    }
    emitChange();
    return { ok: true };
  }

  if (room.status === RoomStatus.ROUND_1) {
    assertCurrentTurn(room, participant);
    if (payload.actionType !== "ROUND_1_ANSWER") {
      throw publicError("現在は共通お題への回答ターンです。");
    }
    saveTurnDraft(room, participant, payload);
    return { ok: true, saved: true, sendsAt: toIso(room.phaseEndsAt) };
  }

  if (room.status === RoomStatus.ROUND_2) {
    assertCurrentTurn(room, participant);
    if (room.turnType === "DIRECTED_QUESTION") {
      if (payload.actionType !== "DIRECTED_QUESTION") {
        throw publicError("質問を送ってください。");
      }
      const target = assertTarget(room, payload.targetParticipantId);
      if (target.id === participant.id) {
        throw publicError("自分自身には質問できません。");
      }
      saveTurnDraft(room, participant, payload);
      return { ok: true, saved: true, sendsAt: toIso(room.phaseEndsAt) };
    }

    if (room.turnType === "DIRECTED_ANSWER") {
      if (payload.actionType !== "DIRECTED_ANSWER") {
        throw publicError("回答を送ってください。");
      }
      saveTurnDraft(room, participant, payload);
      return { ok: true, saved: true, sendsAt: toIso(room.phaseEndsAt) };
    }
  }

  if (room.status === RoomStatus.ROUND_3) {
    assertCurrentTurn(room, participant);
    if (payload.actionType !== "FINAL_SUSPICION") {
      throw publicError("最終推理を送ってください。");
    }
    const target = resolveTurnTarget(room, participant, payload.targetParticipantId, {
      allowDuelFallback: true
    });
    saveTurnDraft(room, participant, {
      ...payload,
      targetParticipantId: target.id
    });
    return { ok: true, saved: true, sendsAt: toIso(room.phaseEndsAt) };
  }

  throw publicError("現在は発言できません。");
}

export function submitVote(guestToken, roomId, targetParticipantId) {
  const user = authenticate(guestToken);
  const room = assertRoom(roomId);
  const voter = assertParticipant(room, user.id);
  if (room.status !== RoomStatus.VOTING) {
    throw publicError("現在は投票時間ではありません。");
  }
  if (voter.isAI) {
    throw publicError("AIは投票しません。");
  }
  if (voter.id === targetParticipantId) {
    throw publicError("自分自身には投票できません。");
  }
  const target = assertTarget(room, targetParticipantId);
  if (!room.votes.some((vote) => vote.voterParticipantId === voter.id)) {
    room.votes.push({
      id: id("vote"),
      voterParticipantId: voter.id,
      targetParticipantId: target.id,
      auto: false,
      createdAt: Date.now()
    });
  }

  if (humanParticipants(room).every((participant) => {
    return room.votes.some((vote) => vote.voterParticipantId === participant.id);
  })) {
    finalizeVotes(room);
  }

  emitChange();
  return { ok: true };
}

export function reportTarget(guestToken, roomId, payload) {
  const user = authenticate(guestToken);
  const room = assertRoom(roomId);
  assertParticipant(room, user.id);
  const report = {
    id: id("report"),
    roomId,
    reporterUserId: user.id,
    targetParticipantId: payload.targetParticipantId ?? null,
    messageId: payload.messageId ?? null,
    reason: stripControlChars(payload.reason || "その他"),
    createdAt: Date.now()
  };
  store.reports.push(report);
  room.reports.push(report);

  if (payload.targetParticipantId) {
    const target = room.participants.find((participant) => {
      return participant.id === payload.targetParticipantId && participant.userId;
    });
    if (target) {
      const targetUser = store.users.get(target.userId);
      targetUser.stats.reportsReceived += 1;
    }
  }

  emitChange();
  return { ok: true };
}

export function leaveRoom(guestToken, roomId) {
  const user = authenticate(guestToken);
  const room = assertRoom(roomId);
  const participant = assertParticipant(room, user.id);
  participant.connected = false;
  user.activeRoomId = null;
  removeFromQueue(user.id);

  if (![RoomStatus.RESULT, RoomStatus.CLOSED].includes(room.status)) {
    clearRoomTimers(room);
    room.status = RoomStatus.CLOSED;
    room.endedAt = Date.now();
    user.stats.disconnects += 1;
    addSystemMessage(room, `${participant.displayName} が退出したため、この試合は無効になりました。`);
  }

  emitChange();
  return { ok: true };
}

export function getStats(guestToken) {
  const user = authenticate(guestToken);
  return presentStats(user.stats);
}

function createRoomFromUsers(users, options = {}) {
  const roomId = id("room");
  const mode = options.mode ?? RoomMode.GROUP;
  const isDuel = mode === RoomMode.DUEL;
  const voteThreshold = isDuel ? 1 : 2;
  const displayNames = shuffle(DISPLAY_NAMES).slice(0, users.length + 1);
  const collaboratorUser = isDuel ? null : sample(users);
  const humanBase = users.map((user, index) => ({
    id: id("participant"),
    roomId,
    userId: user.id,
    displayName: displayNames[index],
    isAI: false,
    role: collaboratorUser && user.id === collaboratorUser.id ? Role.AI_COLLABORATOR : Role.CITIZEN,
    team: collaboratorUser && user.id === collaboratorUser.id ? Team.AI : Team.HUMAN,
    seatNumber: 0,
    connected: true,
    finalSuspectId: null,
    roleReady: false,
    createdAt: Date.now()
  }));
  const aiParticipant = {
    id: id("participant"),
    roomId,
    userId: null,
    displayName: displayNames[users.length],
    isAI: true,
    role: Role.AI,
    team: Team.AI,
    seatNumber: 0,
    persona: createPersona(),
    connected: true,
    finalSuspectId: null,
    roleReady: true,
    createdAt: Date.now()
  };

  const participants = shuffle([...humanBase, aiParticipant]).map((participant, index) => ({
    ...participant,
    seatNumber: index + 1
  }));

  const room = {
    id: roomId,
    mode,
    voteThreshold,
    status: RoomStatus.ROLE_REVEAL,
    topicPrompt: sample(TOPICS),
    participants,
    messages: [],
    votes: [],
    reports: [],
    round: 0,
    turnType: null,
    currentTurnParticipantId: null,
    currentQuestion: null,
    phaseEndsAt: null,
    winnerTeam: null,
    result: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    turnOrder: [],
    turnIndex: 0,
    round2Order: [],
    round2Index: 0,
    round3Order: [],
    round3Index: 0,
    timers: new Set()
  };

  for (const user of users) {
    user.activeRoomId = room.id;
    user.queuedAt = null;
  }
  addSystemMessage(
    room,
    isDuel
      ? "相手と共通お題で話し、AI判定をして最後に投票します。"
      : "3人が揃いました。AI参加者を追加して試合を開始します。"
  );
  store.rooms.set(room.id, room);
  return room;
}

function startRound1(room) {
  clearRoomTimers(room);
  room.status = RoomStatus.ROUND_1;
  room.round = 1;
  room.turnType = "COMMON_ANSWER";
  room.turnOrder = shuffle(room.participants.map((participant) => participant.id));
  room.turnIndex = 0;
  room.currentQuestion = null;
  addSystemMessage(room, `ラウンド1：共通お題「${room.topicPrompt}」`);
  setTurn(room, room.turnOrder[0], "COMMON_ANSWER");
}

function advanceRound1(room) {
  room.turnIndex += 1;
  if (room.turnIndex >= room.turnOrder.length) {
    if (room.mode === RoomMode.DUEL) {
      startRound3(room);
    } else {
      startRound2(room);
    }
    return;
  }
  setTurn(room, room.turnOrder[room.turnIndex], "COMMON_ANSWER");
}

function startRound2(room) {
  if (room.mode === RoomMode.DUEL) {
    startRound3(room);
    return;
  }
  clearRoomTimers(room);
  room.status = RoomStatus.ROUND_2;
  room.round = 2;
  room.round2Order = shuffle(room.participants.map((participant) => participant.id));
  room.round2Index = 0;
  addSystemMessage(room, "ラウンド2：指名質問を始めます。");
  startRound2Question(room);
}

function startRound2Question(room) {
  if (room.round2Index >= room.round2Order.length) {
    startRound3(room);
    return;
  }
  const askerId = room.round2Order[room.round2Index];
  setTurn(room, askerId, "DIRECTED_QUESTION");
}

function startRound3(room) {
  clearRoomTimers(room);
  room.status = RoomStatus.ROUND_3;
  room.round = 3;
  room.round3Order = shuffle(room.participants.map((participant) => participant.id));
  room.round3Index = 0;
  addSystemMessage(
    room,
    room.mode === RoomMode.DUEL ? "ラウンド2：AI判定を始めます。" : "ラウンド3：最終推理を始めます。"
  );
  setTurn(room, room.round3Order[0], "FINAL_SUSPICION");
}

function advanceRound3(room) {
  if (room.round3Index >= room.round3Order.length) {
    startVoting(room);
    return;
  }
  setTurn(room, room.round3Order[room.round3Index], "FINAL_SUSPICION");
}

function startVoting(room) {
  clearRoomTimers(room);
  room.status = RoomStatus.VOTING;
  room.round = 0;
  room.turnType = null;
  room.currentTurnParticipantId = null;
  room.phaseEndsAt = Date.now() + VOTE_MS;
  addSystemMessage(room, `投票を開始しました。人間ユーザー${humanParticipants(room).length}人が投票します。`);
  const timer = setTimeout(() => {
    const currentRoom = store.rooms.get(room.id);
    if (currentRoom?.status === RoomStatus.VOTING) {
      autoFillVotes(currentRoom);
      finalizeVotes(currentRoom);
      emitChange();
    }
  }, VOTE_MS + 25);
  registerRoomTimer(room, timer);
  emitChange();
}

function setTurn(room, participantId, turnType) {
  clearRoomTimers(room);
  room.currentTurnParticipantId = participantId;
  room.turnType = turnType;
  room.phaseEndsAt = Date.now() + TURN_MS;
  room.currentDraft = createEmptyDraft(room, participantId, turnType);

  const timeout = setTimeout(() => {
    const currentRoom = store.rooms.get(room.id);
    if (!currentRoom || currentRoom.currentTurnParticipantId !== participantId) {
      return;
    }
    finalizeCurrentTurn(currentRoom).catch((error) => {
      const participant = currentRoom.participants.find((item) => item.id === participantId);
      addSystemMessage(currentRoom, `${participant.displayName} の送信処理でエラーが発生しました。`);
      addSystemMessage(currentRoom, error.message);
      consumeCurrentTurn(currentRoom);
      emitChange();
    });
  }, TURN_MS);
  registerRoomTimer(room, timeout);

  const participant = room.participants.find((item) => item.id === participantId);
  if (participant.isAI) {
    const aiTimer = setTimeout(() => {
      performAITurn(room.id).catch((error) => {
        const currentRoom = store.rooms.get(room.id);
        if (currentRoom && currentRoom.status !== RoomStatus.CLOSED) {
          addSystemMessage(currentRoom, `AI発言生成に失敗しました: ${error.message}`);
          emitChange();
        }
      });
    }, 650);
    registerRoomTimer(room, aiTimer);
  }
  emitChange();
}

async function performAITurn(roomId) {
  const room = store.rooms.get(roomId);
  if (!room || room.status === RoomStatus.CLOSED || room.status === RoomStatus.RESULT) {
    return;
  }
  const aiParticipant = room.participants.find((participant) => {
    return participant.id === room.currentTurnParticipantId && participant.isAI;
  });
  if (!aiParticipant) {
    return;
  }

  const input = {
    roomId,
    aiParticipantId: aiParticipant.id,
    round: room.round,
    actionType: room.turnType,
    persona: aiParticipant.persona,
    topicPrompt: room.topicPrompt,
    questionText: room.currentQuestion?.text,
    targetDisplayName: participantById(room, room.currentQuestion?.askerId)?.displayName,
    participants: publicParticipants(room),
    conversation: room.messages
      .filter((message) => message.kind === "CHAT")
      .map((message) => ({
        displayName: participantById(room, message.participantId)?.displayName ?? "system",
        text: message.text
      }))
  };

  const output = await generateAIMessage(input);

  if (room.status === RoomStatus.ROUND_2 && room.turnType === "DIRECTED_QUESTION") {
    const target = chooseValidAITarget(room, aiParticipant, output.targetParticipantId);
    saveTurnDraft(room, aiParticipant, {
      actionType: "DIRECTED_QUESTION",
      text: output.text,
      targetParticipantId: target.id
    });
    return;
  }

  if (room.status === RoomStatus.ROUND_3) {
    const target = chooseValidAITarget(room, aiParticipant, output.targetParticipantId);
    const reason =
      output.text.includes("理由：")
        ? output.text.split("理由：").at(-1).trim()
        : "答えが少し整いすぎて見えた";
    saveTurnDraft(room, aiParticipant, {
      actionType: "FINAL_SUSPICION",
      text: reason,
      targetParticipantId: target.id
    });
    return;
  }

  saveTurnDraft(room, aiParticipant, {
    actionType: room.turnType === "DIRECTED_ANSWER" ? "DIRECTED_ANSWER" : "ROUND_1_ANSWER",
    text: output.text,
    targetParticipantId: room.currentQuestion?.askerId ?? null
  });
}

function createEmptyDraft(room, participantId, turnType) {
  const participant = participantById(room, participantId);
  const target = chooseValidAITarget(room, participant, null);
  return {
    participantId,
    turnType,
    actionType: actionTypeForTurn(room, turnType),
    text: "",
    targetParticipantId: target?.id ?? null,
    updatedAt: Date.now()
  };
}

function actionTypeForTurn(room, turnType) {
  if (turnType === "COMMON_ANSWER") {
    return "ROUND_1_ANSWER";
  }
  if (turnType === "DIRECTED_QUESTION") {
    return "DIRECTED_QUESTION";
  }
  if (turnType === "DIRECTED_ANSWER") {
    return "DIRECTED_ANSWER";
  }
  if (turnType === "FINAL_SUSPICION") {
    return "FINAL_SUSPICION";
  }
  return room.status;
}

function saveTurnDraft(room, participant, payload) {
  assertCurrentTurn(room, participant);
  const text = participant.isAI
    ? clampChars(stripControlChars(payload.text ?? ""), MESSAGE_LIMIT)
    : normalizeDraftText(payload.text ?? "");
  const expectedActionType = actionTypeForTurn(room, room.turnType);
  if (payload.actionType !== expectedActionType) {
    throw publicError("現在のターンと下書き種別が一致しません。");
  }

  let targetParticipantId = null;
  if (payload.actionType === "DIRECTED_QUESTION") {
    const target = assertTarget(room, payload.targetParticipantId);
    if (target.id === participant.id) {
      throw publicError("自分自身は選べません。");
    }
    targetParticipantId = target.id;
  } else if (payload.actionType === "FINAL_SUSPICION") {
    const target = resolveTurnTarget(room, participant, payload.targetParticipantId, {
      allowDuelFallback: true
    });
    targetParticipantId = target.id;
  } else if (payload.actionType === "DIRECTED_ANSWER") {
    targetParticipantId = room.currentQuestion?.askerId ?? null;
  }

  room.currentDraft = {
    participantId: participant.id,
    turnType: room.turnType,
    actionType: payload.actionType,
    text,
    targetParticipantId,
    updatedAt: Date.now()
  };
}

async function finalizeCurrentTurn(room) {
  const participant = participantById(room, room.currentTurnParticipantId);
  const draft = room.currentDraft?.participantId === participant?.id
    ? room.currentDraft
    : createEmptyDraft(room, room.currentTurnParticipantId, room.turnType);

  if (room.status === RoomStatus.ROUND_1) {
    await publishDraft(room, participant, draft, {
      round: 1,
      targetParticipantId: null
    });
    advanceRound1(room);
    emitChange();
    return;
  }

  if (room.status === RoomStatus.ROUND_2 && room.turnType === "DIRECTED_QUESTION") {
    const target = participantById(room, draft.targetParticipantId) ?? chooseValidAITarget(room, participant, null);
    const published = await publishDraft(room, participant, draft, {
      round: 2,
      targetParticipantId: target.id
    });
    if (published) {
      room.currentQuestion = {
        askerId: participant.id,
        targetParticipantId: target.id,
        text: draft.text
      };
      setTurn(room, target.id, "DIRECTED_ANSWER");
    } else {
      room.currentQuestion = null;
      room.round2Index += 1;
      startRound2Question(room);
    }
    emitChange();
    return;
  }

  if (room.status === RoomStatus.ROUND_2 && room.turnType === "DIRECTED_ANSWER") {
    await publishDraft(room, participant, draft, {
      round: 2,
      targetParticipantId: room.currentQuestion?.askerId ?? null
    });
    room.currentQuestion = null;
    room.round2Index += 1;
    startRound2Question(room);
    emitChange();
    return;
  }

  if (room.status === RoomStatus.ROUND_3) {
    const target = participantById(room, draft.targetParticipantId) ?? chooseValidAITarget(room, participant, null);
    const reason = draft.text || "理由なし";
    const targetLabel = room.mode === RoomMode.DUEL ? "相手" : target.displayName;
    const finalDraft = {
      ...draft,
      text: `AIだと思う人：${targetLabel}\n理由：${reason}`
    };
    await publishDraft(room, participant, finalDraft, {
      round: 3,
      targetParticipantId: target.id,
      skipLengthCheck: true
    });
    participant.finalSuspectId = target.id;
    room.round3Index += 1;
    advanceRound3(room);
    emitChange();
  }
}

async function publishDraft(room, participant, draft, options) {
  const text = options.skipLengthCheck ? stripControlChars(draft.text) : normalizeFinalText(draft.text);
  if (!text) {
    addSystemMessage(room, `${participant.displayName} は未入力のため、このターンを消費しました。`);
    return false;
  }
  const moderation = await moderateMessage(text);
  if (!moderation.allowed) {
    addBlockedMessage(room, participant, moderation.reason);
    return false;
  }
  addChatMessage(room, participant, text, options);
  return true;
}

function normalizeDraftText(rawText) {
  const text = stripControlChars(rawText);
  if (charLength(text) > MESSAGE_LIMIT) {
    throw publicError(`発言は${MESSAGE_LIMIT}文字以内で入力してください。`);
  }
  return text;
}

function normalizeFinalText(rawText) {
  const text = normalizeDraftText(rawText);
  return text;
}

function consumeCurrentTurn(room) {
  if (room.status === RoomStatus.ROUND_1) {
    advanceRound1(room);
    return;
  }
  if (room.status === RoomStatus.ROUND_2 && room.turnType === "DIRECTED_QUESTION") {
    const asker = participantById(room, room.currentTurnParticipantId);
    const target = chooseValidAITarget(room, asker, null);
    room.currentQuestion = {
      askerId: asker.id,
      targetParticipantId: target.id,
      text: ""
    };
    setTurn(room, target.id, "DIRECTED_ANSWER");
    return;
  }
  if (room.status === RoomStatus.ROUND_2 && room.turnType === "DIRECTED_ANSWER") {
    room.currentQuestion = null;
    room.round2Index += 1;
    startRound2Question(room);
    return;
  }
  if (room.status === RoomStatus.ROUND_3) {
    const participant = participantById(room, room.currentTurnParticipantId);
    participant.finalSuspectId = chooseValidAITarget(room, participant, null).id;
    room.round3Index += 1;
    advanceRound3(room);
  }
}

function finalizeVotes(room) {
  clearRoomTimers(room);
  autoFillVotes(room);
  const ai = room.participants.find((participant) => participant.isAI);
  const collaborator = room.participants.find((participant) => participant.role === Role.AI_COLLABORATOR);
  const voteThreshold = room.voteThreshold ?? 2;
  const aiVotes = room.votes.filter((vote) => vote.targetParticipantId === ai.id).length;
  const winnerTeam = aiVotes >= voteThreshold ? Team.HUMAN : Team.AI;
  room.status = RoomStatus.RESULT;
  room.winnerTeam = winnerTeam;
  room.endedAt = Date.now();
  room.result = {
    winnerTeam,
    aiParticipantId: ai.id,
    collaboratorParticipantId: collaborator?.id ?? null,
    aiVotes,
    voteThreshold,
    votes: room.votes.map((vote) => ({ ...vote }))
  };
  updateStats(room);
  addSystemMessage(
    room,
    winnerTeam === Team.HUMAN
      ? `AIに${voteThreshold}票以上入り、人間陣営の勝利です。`
      : `AIに${voteThreshold}票入らなかったため、AI陣営の勝利です。`
  );
}

function autoFillVotes(room) {
  for (const voter of humanParticipants(room)) {
    const alreadyVoted = room.votes.some((vote) => vote.voterParticipantId === voter.id);
    if (alreadyVoted) {
      continue;
    }
    const target =
      participantById(room, voter.finalSuspectId) ??
      sample(room.participants.filter((participant) => participant.id !== voter.id));
    room.votes.push({
      id: id("vote"),
      voterParticipantId: voter.id,
      targetParticipantId: target.id,
      auto: true,
      createdAt: Date.now()
    });
  }
}

function updateStats(room) {
  const ai = room.participants.find((participant) => participant.isAI);
  for (const participant of humanParticipants(room)) {
    const user = store.users.get(participant.userId);
    const stats = user.stats;
    stats.gamesPlayed += 1;
    if (participant.team === room.winnerTeam) {
      stats.gamesWon += 1;
    }
    if (participant.role === Role.CITIZEN) {
      stats.citizenGames += 1;
      if (room.winnerTeam === Team.HUMAN) {
        stats.citizenWins += 1;
      }
      const vote = room.votes.find((item) => item.voterParticipantId === participant.id);
      if (vote?.targetParticipantId === ai.id) {
        stats.correctAIVotes += 1;
      }
    }
    if (participant.role === Role.AI_COLLABORATOR) {
      stats.collaboratorGames += 1;
      if (room.winnerTeam === Team.AI) {
        stats.collaboratorWins += 1;
      }
    }
  }
}

function sanitizeRoomForParticipant(room, viewer) {
  const resultVisible = [RoomStatus.RESULT, RoomStatus.CLOSED].includes(room.status);
  const knownAI =
    viewer.role === Role.AI_COLLABORATOR && !resultVisible
      ? room.participants.find((participant) => participant.isAI)
      : null;
  const currentTurn = room.currentTurnParticipantId
    ? {
        participantId: room.currentTurnParticipantId,
        displayName: participantById(room, room.currentTurnParticipantId)?.displayName,
        turnType: room.turnType,
        targetParticipantId: room.currentQuestion?.targetParticipantId ?? null,
        targetDisplayName: participantById(room, room.currentQuestion?.targetParticipantId)?.displayName ?? null,
        askerParticipantId: room.currentQuestion?.askerId ?? null,
        askerDisplayName: participantById(room, room.currentQuestion?.askerId)?.displayName ?? null
      }
    : null;

  return {
    id: room.id,
    mode: room.mode ?? RoomMode.GROUP,
    voteThreshold: room.voteThreshold ?? 2,
    status: room.status,
    topicPrompt: room.topicPrompt,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt ? toIso(room.phaseEndsAt) : null,
    currentTurn,
    myParticipant: {
      id: viewer.id,
      displayName: viewer.displayName,
      role: viewer.role,
      team: viewer.team,
      roleReady: viewer.roleReady,
      hasVoted: room.votes.some((vote) => vote.voterParticipantId === viewer.id)
    },
    readiness: {
      humanCount: humanParticipants(room).length,
      roleReadyCount: humanParticipants(room).filter((participant) => participant.roleReady).length
    },
    knownAI: knownAI
      ? {
          participantId: knownAI.id,
          displayName: knownAI.displayName
        }
      : null,
    participants: room.participants
      .slice()
      .sort((a, b) => a.seatNumber - b.seatNumber)
      .map((participant) => {
        const publicParticipant = {
          id: participant.id,
          displayName: participant.displayName,
          connected: participant.connected,
          seatNumber: participant.seatNumber
        };
        if (resultVisible) {
          publicParticipant.role = participant.role;
          publicParticipant.team = participant.team;
          publicParticipant.isAI = participant.isAI;
        }
        return publicParticipant;
      }),
    messages: room.messages.map((message) => ({
      id: message.id,
      participantId: message.participantId,
      displayName: participantById(room, message.participantId)?.displayName ?? "システム",
      round: message.round,
      kind: message.kind,
      text: message.text,
      isBlocked: message.isBlocked,
      targetParticipantId: message.targetParticipantId,
      targetDisplayName: participantById(room, message.targetParticipantId)?.displayName ?? null,
      createdAt: toIso(message.createdAt)
    })),
    votes: resultVisible
      ? room.votes.map((vote) => ({
          id: vote.id,
          voterParticipantId: vote.voterParticipantId,
          voterDisplayName: participantById(room, vote.voterParticipantId)?.displayName,
          targetParticipantId: vote.targetParticipantId,
          targetDisplayName: participantById(room, vote.targetParticipantId)?.displayName,
          auto: vote.auto
        }))
      : [],
    result: resultVisible && room.result
      ? {
          winnerTeam: room.result.winnerTeam,
          aiParticipantId: room.result.aiParticipantId,
          collaboratorParticipantId: room.result.collaboratorParticipantId,
          aiVotes: room.result.aiVotes,
          voteThreshold: room.result.voteThreshold ?? room.voteThreshold ?? 2
        }
      : null,
    reportsCount: room.reports.length
  };
}

function addChatMessage(room, participant, text, options = {}) {
  room.messages.push({
    id: id("message"),
    roomId: room.id,
    participantId: participant.id,
    round: options.round ?? room.round,
    kind: "CHAT",
    text,
    isBlocked: false,
    blockReason: null,
    targetParticipantId: options.targetParticipantId ?? null,
    createdAt: Date.now()
  });
  emitChange();
}

function addBlockedMessage(room, participant, reason = BlockReason.SPAM) {
  room.messages.push({
    id: id("message"),
    roomId: room.id,
    participantId: participant.id,
    round: room.round,
    kind: "BLOCKED",
    text: `${participant.displayName} はルール外発言により、このターンを消費しました。`,
    isBlocked: true,
    blockReason: reason,
    targetParticipantId: null,
    createdAt: Date.now()
  });
  emitChange();
}

function addSystemMessage(room, text) {
  room.messages.push({
    id: id("message"),
    roomId: room.id,
    participantId: null,
    round: room.round,
    kind: "SYSTEM",
    text,
    isBlocked: false,
    blockReason: null,
    targetParticipantId: null,
    createdAt: Date.now()
  });
}

function publicParticipants(room) {
  return room.participants.map((participant) => ({
    id: participant.id,
    displayName: participant.displayName
  }));
}

function createPersona() {
  return {
    mood: sample(PERSONA_PARTS.mood),
    lunch: sample(PERSONA_PARTS.lunch),
    minorTrouble: sample(PERSONA_PARTS.minorTrouble),
    hobby: sample(PERSONA_PARTS.hobby),
    speakingStyle: sample(PERSONA_PARTS.speakingStyle),
    reactionStyle: sample(PERSONA_PARTS.reactionStyle)
  };
}

function assertCurrentTurn(room, participant) {
  if (room.currentTurnParticipantId !== participant.id) {
    throw publicError("現在はあなたのターンではありません。", 409);
  }
}

function assertRoom(roomId) {
  const room = store.rooms.get(roomId);
  if (!room) {
    throw publicError("ルームが見つかりません。", 404);
  }
  return room;
}

function assertParticipant(room, userId) {
  const participant = room.participants.find((item) => item.userId === userId);
  if (!participant) {
    throw publicError("このルームには参加していません。", 403);
  }
  return participant;
}

function assertTarget(room, participantId) {
  const target = room.participants.find((participant) => participant.id === participantId);
  if (!target) {
    throw publicError("対象の参加者が見つかりません。");
  }
  return target;
}

function resolveTurnTarget(room, participant, participantId, options = {}) {
  if (options.allowDuelFallback && room.mode === RoomMode.DUEL && !participantId) {
    const target = chooseValidAITarget(room, participant, null);
    if (!target) {
      throw publicError("対象の参加者が見つかりません。");
    }
    return target;
  }
  const target = assertTarget(room, participantId);
  if (target.id === participant.id) {
    throw publicError("自分自身は選べません。");
  }
  return target;
}

function chooseValidAITarget(room, participant, preferredId) {
  const preferred = preferredId ? participantById(room, preferredId) : null;
  if (preferred && preferred.id !== participant.id) {
    return preferred;
  }
  return sample(room.participants.filter((item) => item.id !== participant.id));
}

function participantById(room, participantId) {
  if (!participantId) {
    return null;
  }
  return room.participants.find((participant) => participant.id === participantId) ?? null;
}

function humanParticipants(room) {
  return room.participants.filter((participant) => !participant.isAI);
}

function ensureNotBanned(user) {
  if (user.banUntil && user.banUntil > Date.now()) {
    throw publicError("一時的にマッチングできません。", 403);
  }
}

function removeFromQueue(userId) {
  const index = store.queue.indexOf(userId);
  if (index >= 0) {
    store.queue.splice(index, 1);
  }
}

function clearFinishedRoom(user) {
  if (!user.activeRoomId) {
    return;
  }
  const room = store.rooms.get(user.activeRoomId);
  if (!room || [RoomStatus.RESULT, RoomStatus.CLOSED].includes(room.status)) {
    user.activeRoomId = null;
  }
}

function clearRoomTimers(room) {
  for (const timer of room.timers) {
    clearTimeout(timer);
    store.timers.delete(timer);
  }
  room.timers.clear();
}

function registerRoomTimer(room, timer) {
  room.timers.add(timer);
  store.timers.add(timer);
}

function presentStats(stats) {
  const winRate = stats.gamesPlayed ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) : 0;
  const citizenWinRate = stats.citizenGames ? Math.round((stats.citizenWins / stats.citizenGames) * 100) : 0;
  const collaboratorWinRate = stats.collaboratorGames
    ? Math.round((stats.collaboratorWins / stats.collaboratorGames) * 100)
    : 0;
  return {
    ...stats,
    winRate,
    citizenWinRate,
    collaboratorWinRate
  };
}

function emitChange() {
  gameEvents.emit("change", { at: Date.now() });
}

export const testOnly = {
  store,
  createRoomFromUsers,
  setTurn,
  finalizeCurrentTurn,
  finalizeVotes,
  startRound1,
  sanitizeRoomForParticipant
};
