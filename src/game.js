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

export const DuelJudgement = Object.freeze({
  AI: "AI",
  HUMAN: "HUMAN"
});

export const DuelRole = Object.freeze({
  SPOTTER: "SPOTTER",
  PRETENDER: "PRETENDER",
  AI: "AI"
});

const TURN_MS = 30_000;
const VOTE_MS = 15_000;
const DUEL_MATCH_MS = 30_000;
const DUEL_AI_READY_MIN_MS = 1_000;
const DUEL_AI_READY_MAX_MS = 20_000;
const DUEL_CHAT_EXCHANGES = 3;
const MESSAGE_LIMIT = 30;

const AI_CONTEXT_HINTS = [
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
  const pretenderQueueEntry = store.pretenderQueue.find((entry) => entry.userId === user.id) ?? null;
  const spotterQueueEntry = store.duelQueue.find((entry) => entry.userId === user.id) ?? null;
  const duelQueueEntry = pretenderQueueEntry ?? spotterQueueEntry;
  const room = user.activeRoomId ? store.rooms.get(user.activeRoomId) : null;
  return {
    userId: user.id,
    displayName: user.displayName,
    activeRoomId: room && room.status !== RoomStatus.CLOSED ? room.id : null,
    queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
    queueCount: store.queue.length,
    duelQueue: duelQueueEntry
      ? {
          duelRole: duelQueueEntry.duelRole,
          resolveAt: duelQueueEntry.resolveAt ? toIso(duelQueueEntry.resolveAt) : null
        }
      : null,
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

  removeFromDuelQueue(user.id);
  removeFromPretenderQueue(user.id);
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

export function startPretenderMatch(guestToken) {
  const user = authenticate(guestToken);
  ensureNotBanned(user);
  clearFinishedRoom(user);

  if (user.activeRoomId) {
    const room = store.rooms.get(user.activeRoomId);
    return { status: "already_in_room", roomId: user.activeRoomId, mode: room?.mode ?? RoomMode.GROUP };
  }

  removeFromQueue(user.id);
  removeFromDuelQueue(user.id);
  const waitingSpotterEntry = firstQueuedSpotterEntry();
  if (waitingSpotterEntry) {
    user.queuedAt = Date.now();
    store.duelQueue.push(createDuelQueueEntry(user, DuelRole.PRETENDER, waitingSpotterEntry.resolveAt));
    ensureDuelQueueTimer(waitingSpotterEntry.resolveAt);
    emitChange();
    return {
      status: "queued",
      mode: RoomMode.DUEL,
      duelRole: DuelRole.PRETENDER,
      resolveAt: toIso(waitingSpotterEntry.resolveAt)
    };
  }

  const existingEntry = store.pretenderQueue.find((entry) => entry.userId === user.id);
  if (existingEntry) {
    return { status: "queued", mode: RoomMode.DUEL, duelRole: DuelRole.PRETENDER, resolveAt: null };
  }

  user.queuedAt = Date.now();
  store.pretenderQueue.push({
    id: id("pretender_queue"),
    userId: user.id,
    duelRole: DuelRole.PRETENDER,
    joinedAt: user.queuedAt,
    resolveAt: null
  });
  emitChange();
  return { status: "queued", mode: RoomMode.DUEL, duelRole: DuelRole.PRETENDER, resolveAt: null };
}

export function startSpotterMatch(guestToken) {
  const user = authenticate(guestToken);
  ensureNotBanned(user);
  clearFinishedRoom(user);

  if (user.activeRoomId) {
    const room = store.rooms.get(user.activeRoomId);
    return { status: "already_in_room", roomId: user.activeRoomId, mode: room?.mode ?? RoomMode.GROUP };
  }

  removeFromQueue(user.id);
  removeFromPretenderQueue(user.id);
  const waitingPretender = takeFirstQueuedPretender();
  if (waitingPretender) {
    const resolveAt = Date.now() + DUEL_MATCH_MS;
    user.queuedAt = Date.now();
    waitingPretender.queuedAt = waitingPretender.queuedAt ?? user.queuedAt;
    store.duelQueue.push(createDuelQueueEntry(user, DuelRole.SPOTTER, resolveAt));
    store.duelQueue.push(createDuelQueueEntry(waitingPretender, DuelRole.PRETENDER, resolveAt));
    ensureDuelQueueTimer(resolveAt);
    emitChange();
    return { status: "queued", mode: RoomMode.DUEL, duelRole: DuelRole.SPOTTER, resolveAt: toIso(resolveAt) };
  }

  const existingEntry = store.duelQueue.find((entry) => entry.userId === user.id);
  if (existingEntry) {
    return {
      status: "queued",
      mode: RoomMode.DUEL,
      duelRole: DuelRole.SPOTTER,
      resolveAt: toIso(existingEntry.resolveAt)
    };
  }

  const resolveAt = currentDuelQueueResolveAt() ?? Date.now() + DUEL_MATCH_MS;
  user.queuedAt = Date.now();
  store.duelQueue.push(createDuelQueueEntry(user, DuelRole.SPOTTER, resolveAt));
  ensureDuelQueueTimer(resolveAt);
  emitChange();
  return { status: "queued", mode: RoomMode.DUEL, duelRole: DuelRole.SPOTTER, resolveAt: toIso(resolveAt) };
}

export const startDuelMatch = startSpotterMatch;

export function cancelQueue(guestToken) {
  const user = authenticate(guestToken);
  removeFromQueue(user.id);
  removeFromPretenderQueue(user.id);
  removeFromDuelQueue(user.id);
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
    startRound1IfRoleReady(room);
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
  if (room.mode === RoomMode.DUEL) {
    throw publicError("1:1では投票はありません。");
  }
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
  removeFromPretenderQueue(user.id);
  removeFromDuelQueue(user.id);

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
  const duelRoleByUserId = options.duelRoleByUserId ?? new Map();
  const shouldAddAI = mode === RoomMode.GROUP || options.fillWithAI === true || (isDuel && users.length === 1);
  const voteThreshold = isDuel ? null : 2;
  const displayNames = shuffle(DISPLAY_NAMES).slice(0, users.length + (shouldAddAI ? 1 : 0));
  const collaboratorUser = isDuel ? null : sample(users);
  const humanBase = users.map((user, index) => ({
    id: id("participant"),
    roomId,
    userId: user.id,
    displayName: displayNames[index],
    isAI: false,
    role: collaboratorUser && user.id === collaboratorUser.id ? Role.AI_COLLABORATOR : Role.CITIZEN,
    team: collaboratorUser && user.id === collaboratorUser.id ? Team.AI : Team.HUMAN,
    duelRole: isDuel ? (duelRoleByUserId.get(user.id) ?? DuelRole.SPOTTER) : null,
    seatNumber: 0,
    connected: true,
    finalSuspectId: null,
    roleReady: false,
    createdAt: Date.now()
  }));
  const aiParticipants = shouldAddAI
    ? [
        {
          id: id("participant"),
          roomId,
          userId: null,
          displayName: displayNames[users.length],
          isAI: true,
          role: Role.AI,
          team: Team.AI,
          duelRole: isDuel ? DuelRole.AI : null,
          seatNumber: 0,
          persona: createPersona(),
          connected: true,
          finalSuspectId: null,
          roleReady: !isDuel,
          createdAt: Date.now()
        }
      ]
    : [];

  const participants = shuffle([...humanBase, ...aiParticipants]).map((participant, index) => ({
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
    duelJudgement: null,
    duelJudgements: [],
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
      ? duelOpeningMessage(room)
      : "3人が揃いました。AI参加者を追加して試合を開始します。"
  );
  store.rooms.set(room.id, room);
  scheduleDuelAIReady(room);
  return room;
}

function createDuelRoom(assignments, options = {}) {
  const duelRoleByUserId = new Map(assignments.map((assignment) => [assignment.user.id, assignment.duelRole]));
  return createRoomFromUsers(assignments.map((assignment) => assignment.user), {
    mode: RoomMode.DUEL,
    fillWithAI: Boolean(options.fillWithAI),
    duelRoleByUserId
  });
}

function startRound1IfRoleReady(room) {
  if (room.status !== RoomStatus.ROLE_REVEAL) {
    return;
  }
  if (roleReadyParticipants(room).every((participant) => participant.roleReady)) {
    startRound1(room);
  }
}

function roleReadyParticipants(room) {
  return room.mode === RoomMode.DUEL ? room.participants : humanParticipants(room);
}

function scheduleDuelAIReady(room) {
  if (room.mode !== RoomMode.DUEL) {
    return;
  }
  const aiParticipant = room.participants.find((participant) => participant.isAI && !participant.roleReady);
  if (!aiParticipant) {
    return;
  }

  const delay = randomInt(DUEL_AI_READY_MIN_MS, DUEL_AI_READY_MAX_MS);
  const timer = setTimeout(() => {
    store.timers.delete(timer);
    const currentRoom = store.rooms.get(room.id);
    currentRoom?.timers.delete(timer);
    if (currentRoom?.status !== RoomStatus.ROLE_REVEAL) {
      return;
    }
    const currentAI = participantById(currentRoom, aiParticipant.id);
    if (!currentAI || currentAI.roleReady) {
      return;
    }
    currentAI.roleReady = true;
    startRound1IfRoleReady(currentRoom);
    emitChange();
  }, delay);
  registerRoomTimer(room, timer);
}

function confirmDuelAIReady(room) {
  const aiParticipant = room.participants.find((participant) => participant.isAI);
  if (!aiParticipant) {
    return false;
  }
  aiParticipant.roleReady = true;
  startRound1IfRoleReady(room);
  emitChange();
  return true;
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function duelOpeningMessage(room) {
  const hasPretender = room.participants.some((participant) => participant.duelRole === DuelRole.PRETENDER);
  const hasAI = room.participants.some((participant) => participant.isAI);
  if (hasPretender) {
    return "AIのふりをする人間と、それを見破る人間の1:1試合です。";
  }
  if (hasAI) {
    return "相手がAIか人間かを見破る1:1試合です。";
  }
  return "相手がAIか人間かを互いに見破る1:1試合です。";
}

function startRound1(room) {
  clearRoomTimers(room);
  room.status = RoomStatus.ROUND_1;
  room.round = 1;
  room.turnType = room.mode === RoomMode.DUEL ? "FREE_CHAT" : "COMMON_ANSWER";
  room.turnOrder =
    room.mode === RoomMode.DUEL
      ? createDuelChatOrder(room)
      : shuffle(room.participants.map((participant) => participant.id));
  room.turnIndex = 0;
  room.currentQuestion = null;
  addSystemMessage(
    room,
    room.mode === RoomMode.DUEL
      ? `ラウンド1：テーマ「${room.topicPrompt}」で3往復チャットします。`
      : `ラウンド1：共通お題「${room.topicPrompt}」`
  );
  setTurn(room, room.turnOrder[0], room.turnType);
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
  setTurn(room, room.turnOrder[room.turnIndex], room.turnType);
}

function createDuelChatOrder(room) {
  const ai = room.participants.find((participant) => participant.isAI);
  const pretender = room.participants.find((participant) => participant.duelRole === DuelRole.PRETENDER);
  const spotter = room.participants.find((participant) => participant.duelRole === DuelRole.SPOTTER);
  const humans = humanParticipants(room);
  const baseOrder =
    ai && humans[0]
      ? [humans[0].id, ai.id]
      : pretender && spotter
        ? [pretender.id, spotter.id]
      : shuffle(humans.map((participant) => participant.id));
  return Array.from({ length: DUEL_CHAT_EXCHANGES }).flatMap(() => baseOrder);
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
  room.round3Order =
    room.mode === RoomMode.DUEL
      ? duelJudgementParticipants(room).map((participant) => participant.id)
      : shuffle(room.participants.map((participant) => participant.id));
  room.round3Index = 0;
  addSystemMessage(
    room,
    room.mode === RoomMode.DUEL ? "ラウンド2：正体判定を始めます。" : "ラウンド3：最終推理を始めます。"
  );
  if (!room.round3Order.length) {
    finalizeDuelJudgement(room);
    return;
  }
  setTurn(room, room.round3Order[0], "FINAL_SUSPICION");
}

function advanceRound3(room) {
  if (room.round3Index >= room.round3Order.length) {
    if (room.mode === RoomMode.DUEL) {
      finalizeDuelJudgement(room);
      return;
    }
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

  const chatMessages = room.messages.filter((message) => message.kind === "CHAT");
  const conversation = chatMessages.map((message) => ({
    displayName: participantById(room, message.participantId)?.displayName ?? "system",
    text: message.text
  }));
  const ownRecentMessages = chatMessages
    .filter((message) => message.participantId === aiParticipant.id)
    .slice(-3)
    .map((message) => message.text);
  const replyTo = createAIReplyTarget(room, aiParticipant, chatMessages);
  const replyToHints = replyTo?.hints ?? [];
  const replyToKind = replyTo?.kind ?? "casual";
  const unansweredQuestions = unansweredQuestionsForAI(chatMessages, aiParticipant);

  const input = {
    roomId,
    mode: room.mode,
    roomMode: room.mode === RoomMode.DUEL ? "two_player_ai_check" : "normal",
    phase: phaseForAI(room),
    aiParticipantId: aiParticipant.id,
    selfDisplayName: aiParticipant.displayName,
    round: room.round,
    actionType: room.turnType,
    persona: aiParticipant.persona,
    topicPrompt: room.topicPrompt,
    questionText: room.currentQuestion?.text,
    targetDisplayName: participantById(room, room.currentQuestion?.askerId)?.displayName,
    participants: publicParticipants(room),
    allowMinorSlip: Math.random() < 0.1,
    ownRecentMessages,
    replyTo,
    replyToKind,
    replyToHints,
    unansweredQuestions,
    gameContext: gameContextForAI(room, aiParticipant, replyTo),
    conversation
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

function createAIReplyTarget(room, aiParticipant, chatMessages) {
  if (room.currentQuestion?.text) {
    const asker = participantById(room, room.currentQuestion.askerId);
    return createAIReplyObject({
      participant: asker,
      text: room.currentQuestion.text,
      source: "current_question"
    });
  }

  const lastOtherMessage = [...chatMessages].reverse().find((message) => message.participantId !== aiParticipant.id);
  if (!lastOtherMessage) {
    return null;
  }
  return createAIReplyObject({
    participant: participantById(room, lastOtherMessage.participantId),
    text: lastOtherMessage.text,
    source: "last_message",
    messageId: lastOtherMessage.id
  });
}

function createAIReplyObject({ participant, text, source, messageId = null }) {
  const kind = classifyAIReplyKind(text);
  const hints = aiReplyHints(text, kind);
  return {
    participantId: participant?.id ?? null,
    speaker: participant?.displayName ?? "system",
    displayName: participant?.displayName ?? "system",
    text,
    kind,
    hints,
    source,
    messageId
  };
}

function unansweredQuestionsForAI(chatMessages, aiParticipant) {
  const lastOwnIndex = chatMessages.reduce((latest, message, index) => {
    return message.participantId === aiParticipant.id ? index : latest;
  }, -1);
  return chatMessages
    .slice(lastOwnIndex + 1)
    .filter((message) => message.participantId !== aiParticipant.id)
    .filter((message) => classifyAIReplyKind(message.text) === "question")
    .slice(-3)
    .map((message) => message.text);
}

function phaseForAI(room) {
  if (room.status === RoomStatus.ROUND_1) {
    return "round1";
  }
  if (room.status === RoomStatus.ROUND_2) {
    return "discussion";
  }
  if (room.status === RoomStatus.ROUND_3) {
    return "judgement";
  }
  return room.status.toLowerCase();
}

function gameContextForAI(room, aiParticipant, replyTo) {
  const isUnderSuspicion = replyTo?.kind === "accusation";
  return {
    isUnderSuspicion,
    suspicionReason: isUnderSuspicion ? replyTo.text : null,
    currentTopic: inferAITopic(room, replyTo),
    remainingHumanCount: humanParticipants(room).length,
    ownTurnCount: room.messages.filter((message) => message.kind === "CHAT" && message.participantId === aiParticipant.id)
      .length
  };
}

function inferAITopic(room, replyTo) {
  if (replyTo?.kind === "typo") {
    return "打ち間違い";
  }
  return replyTo?.hints?.[0] ?? room.currentQuestion?.text ?? room.topicPrompt ?? null;
}

function classifyAIReplyKind(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "casual";
  }
  if (/AI|bot|人工知能|怪しい|人間じゃ|機械|バレ|疑/.test(normalized)) {
    return "accusation";
  }
  if (looksLikeAIReplyTypo(normalized)) {
    return "typo";
  }
  if (/[?？]$|何|なに|誰|だれ|どこ|いつ|なんで|どう|食べた|好き|思う/.test(normalized)) {
    return "question";
  }
  return "casual";
}

function looksLikeAIReplyTypo(text) {
  const compact = normalizeAIContextText(text);
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

function aiReplyHints(text, kind = classifyAIReplyKind(text)) {
  if (kind === "typo") {
    return ["打ち間違"];
  }
  const normalized = normalizeAIContextText(text);
  return AI_CONTEXT_HINTS.filter((hint) => normalized.includes(hint)).slice(0, 4);
}

function normalizeAIContextText(text) {
  return stripControlChars(text ?? "").replace(/[。、！？!?「」\s]/g, "");
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
    duelJudgement: null,
    updatedAt: Date.now()
  };
}

function actionTypeForTurn(room, turnType) {
  if (turnType === "COMMON_ANSWER" || turnType === "FREE_CHAT") {
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

  const duelJudgement =
    room.mode === RoomMode.DUEL && payload.actionType === "FINAL_SUSPICION"
      ? normalizeDuelJudgement(payload.duelJudgement)
      : null;

  room.currentDraft = {
    participantId: participant.id,
    turnType: room.turnType,
    actionType: payload.actionType,
    text,
    targetParticipantId,
    duelJudgement,
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
    if (room.mode === RoomMode.DUEL) {
      const judgement = normalizeDuelJudgement(draft.duelJudgement);
      const judgementLabel =
        judgement === DuelJudgement.AI ? "AI" : judgement === DuelJudgement.HUMAN ? "人間" : "未選択";
      const finalDraft = {
        ...draft,
        text: `判定：相手は${judgementLabel}\n理由：${reason}`
      };
      await publishDraft(room, participant, finalDraft, {
        round: 3,
        targetParticipantId: target.id,
        skipLengthCheck: true
      });
      participant.finalSuspectId = target.id;
      saveDuelJudgement(room, createDuelJudgement(room, participant, target, judgement, reason));
      room.round3Index += 1;
      advanceRound3(room);
      emitChange();
      return;
    }
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

function normalizeDuelJudgement(value) {
  if (value == null || value === "") {
    return null;
  }
  if (Object.values(DuelJudgement).includes(value)) {
    return value;
  }
  throw publicError("正体判定を選び直してください。");
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

function createDuelJudgement(room, participant, target, judgement, reason, auto = false) {
  const expectedJudgement = target?.isAI ? DuelJudgement.AI : DuelJudgement.HUMAN;
  return {
    id: id("judgement"),
    participantId: participant?.id ?? null,
    targetParticipantId: target?.id ?? null,
    judgement,
    expectedJudgement,
    correct: Boolean(judgement && judgement === expectedJudgement),
    reason: reason || "理由なし",
    auto,
    createdAt: Date.now()
  };
}

function saveDuelJudgement(room, judgement) {
  room.duelJudgements = room.duelJudgements.filter((item) => item.participantId !== judgement.participantId);
  room.duelJudgements.push(judgement);
  room.duelJudgement = room.duelJudgements[0] ?? null;
}

function finalizeDuelJudgement(room) {
  clearRoomTimers(room);
  const ai = room.participants.find((participant) => participant.isAI) ?? null;
  for (const human of duelJudgementParticipants(room)) {
    const alreadyJudged = room.duelJudgements.some((judgement) => judgement.participantId === human.id);
    if (alreadyJudged) {
      continue;
    }
    const fallbackTarget = participantById(room, human.finalSuspectId) ?? chooseValidAITarget(room, human, null);
    saveDuelJudgement(room, createDuelJudgement(room, human, fallbackTarget, null, "理由なし", true));
  }

  const duelJudgements = room.duelJudgements.map((judgement) => ({ ...judgement }));
  const participantResults = createDuelParticipantResults(room, duelJudgements);
  room.status = RoomStatus.RESULT;
  room.round = 0;
  room.turnType = null;
  room.currentTurnParticipantId = null;
  room.phaseEndsAt = null;
  room.winnerTeam = null;
  room.endedAt = Date.now();
  room.result = {
    winnerTeam: null,
    aiParticipantId: ai?.id ?? null,
    collaboratorParticipantId: null,
    aiVotes: null,
    voteThreshold: null,
    votes: [],
    duelJudgement: duelJudgements[0] ?? null,
    duelJudgements,
    participantResults
  };
  updateStats(room);
  addSystemMessage(room, "判定が完了しました。");
}

function createDuelParticipantResults(room, duelJudgements) {
  return humanParticipants(room).map((participant) => {
    const ownJudgement = duelJudgements.find((judgement) => judgement.participantId === participant.id) ?? null;
    const judgementAboutMe = duelJudgements.find((judgement) => judgement.targetParticipantId === participant.id) ?? null;
    const won =
      participant.duelRole === DuelRole.PRETENDER
        ? !judgementAboutMe || judgementAboutMe.judgement !== DuelJudgement.HUMAN
        : Boolean(ownJudgement?.correct);
    return {
      participantId: participant.id,
      duelRole: participant.duelRole ?? DuelRole.SPOTTER,
      won,
      judgementId: ownJudgement?.id ?? judgementAboutMe?.id ?? null
    };
  });
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
    const duelJudgement =
      room.mode === RoomMode.DUEL
        ? (room.result?.duelJudgements ?? []).find((judgement) => judgement.participantId === participant.id) ??
          room.result?.duelJudgement
        : null;
    const duelResult =
      room.mode === RoomMode.DUEL
        ? (room.result?.participantResults ?? []).find((result) => result.participantId === participant.id)
        : null;
    const wonGame = room.mode === RoomMode.DUEL ? Boolean(duelResult?.won) : participant.team === room.winnerTeam;
    stats.gamesPlayed += 1;
    if (wonGame) {
      stats.gamesWon += 1;
    }
    if (participant.role === Role.CITIZEN) {
      stats.citizenGames += 1;
      if (wonGame) {
        stats.citizenWins += 1;
      }
      const vote = room.votes.find((item) => item.voterParticipantId === participant.id);
      if (
        (room.mode === RoomMode.DUEL && participant.duelRole === DuelRole.SPOTTER && duelJudgement?.correct) ||
        (room.mode !== RoomMode.DUEL && ai && vote?.targetParticipantId === ai.id)
      ) {
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
  const voteThreshold = room.mode === RoomMode.DUEL ? null : room.voteThreshold ?? 2;
  const duelJudgements = room.result?.duelJudgements ?? (room.result?.duelJudgement ? [room.result.duelJudgement] : []);
  const viewerDuelJudgement =
    duelJudgements.find((judgement) => judgement.participantId === viewer.id) ??
    duelJudgements.find((judgement) => judgement.targetParticipantId === viewer.id) ??
    duelJudgements[0] ??
    null;
  const participantResults = room.result?.participantResults ?? [];
  const viewerParticipantResult = participantResults.find((result) => result.participantId === viewer.id) ?? null;
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
    voteThreshold,
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
      duelRole: viewer.duelRole ?? null,
      roleReady: viewer.roleReady,
      hasVoted: room.mode !== RoomMode.DUEL && room.votes.some((vote) => vote.voterParticipantId === viewer.id)
    },
    readiness: readinessForParticipant(room, viewer),
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
          publicParticipant.duelRole = participant.duelRole ?? null;
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
          voteThreshold: room.result.voteThreshold ?? voteThreshold,
          duelJudgement: viewerDuelJudgement ? { ...viewerDuelJudgement } : null,
          duelJudgements: duelJudgements.map((judgement) => ({ ...judgement })),
          participantResult: viewerParticipantResult ? { ...viewerParticipantResult } : null,
          participantResults: participantResults.map((result) => ({ ...result }))
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

function duelJudgementParticipants(room) {
  return humanParticipants(room).filter((participant) => participant.duelRole !== DuelRole.PRETENDER);
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

function removeFromPretenderQueue(userId) {
  const index = store.pretenderQueue.findIndex((entry) => entry.userId === userId);
  if (index >= 0) {
    store.pretenderQueue.splice(index, 1);
  }
}

function removeFromDuelQueue(userId) {
  const index = store.duelQueue.findIndex((entry) => entry.userId === userId);
  if (index >= 0) {
    store.duelQueue.splice(index, 1);
  }
}

function takeFirstQueuedPretender() {
  while (store.pretenderQueue.length) {
    const entry = store.pretenderQueue.shift();
    const user = store.users.get(entry.userId);
    if (user && !user.activeRoomId) {
      user.queuedAt = null;
      return user;
    }
  }
  return null;
}

function createDuelQueueEntry(user, duelRole, resolveAt) {
  return {
    id: id("duel_queue"),
    userId: user.id,
    duelRole,
    joinedAt: user.queuedAt ?? Date.now(),
    resolveAt
  };
}

function firstQueuedSpotterEntry() {
  const now = Date.now();
  for (const entry of [...store.duelQueue]) {
    if (entry.duelRole !== DuelRole.SPOTTER || entry.resolveAt <= now) {
      continue;
    }
    const user = store.users.get(entry.userId);
    if (!user || user.activeRoomId) {
      removeFromDuelQueue(entry.userId);
      continue;
    }
    const sameWindowEntries = store.duelQueue.filter((item) => item.resolveAt === entry.resolveAt);
    const spotterCount = sameWindowEntries.filter((item) => item.duelRole === DuelRole.SPOTTER).length;
    const pretenderCount = sameWindowEntries.filter((item) => item.duelRole === DuelRole.PRETENDER).length;
    if (spotterCount > pretenderCount) {
      return entry;
    }
  }
  return null;
}

function currentDuelQueueResolveAt() {
  const now = Date.now();
  const activeEntry = store.duelQueue.find((entry) => entry.resolveAt > now);
  return activeEntry?.resolveAt ?? null;
}

function requeuePretender(user) {
  if (store.pretenderQueue.some((entry) => entry.userId === user.id)) {
    return;
  }
  user.queuedAt = Date.now();
  store.pretenderQueue.push({
    id: id("pretender_queue"),
    userId: user.id,
    duelRole: DuelRole.PRETENDER,
    joinedAt: user.queuedAt,
    resolveAt: null
  });
}

function ensureDuelQueueTimer(resolveAt) {
  const timer = setTimeout(() => {
    store.timers.delete(timer);
    resolveDuelQueue(resolveAt);
  }, Math.max(0, resolveAt - Date.now()) + 25);
  store.timers.add(timer);
}

function resolveDuelQueue(resolveAt, options = {}) {
  const now = Date.now();
  const dueEntries = store.duelQueue.filter((entry) => {
    if (resolveAt != null && entry.resolveAt !== resolveAt) {
      return false;
    }
    return options.force || entry.resolveAt <= now;
  });
  if (!dueEntries.length) {
    return [];
  }

  const dueIds = new Set(dueEntries.map((entry) => entry.id));
  store.duelQueue = store.duelQueue.filter((entry) => !dueIds.has(entry.id));
  const entries = dueEntries
    .map((entry) => ({ entry, user: store.users.get(entry.userId) }))
    .filter(({ user }) => user && !user.activeRoomId);
  const spotters = entries.filter(({ entry }) => entry.duelRole === DuelRole.SPOTTER);
  const pretenders = entries.filter(({ entry }) => entry.duelRole === DuelRole.PRETENDER);
  const rooms = [];

  while (spotters.length && pretenders.length) {
    const spotter = spotters.shift();
    const pretender = pretenders.shift();
    const room = createDuelRoom([
      { user: spotter.user, duelRole: DuelRole.SPOTTER },
      { user: pretender.user, duelRole: DuelRole.PRETENDER }
    ]);
    rooms.push(room);
  }

  for (let index = 0; index < spotters.length; index += 2) {
    const first = spotters[index];
    const second = spotters[index + 1];
    const assignments = second
      ? [
          { user: first.user, duelRole: DuelRole.SPOTTER },
          { user: second.user, duelRole: DuelRole.SPOTTER }
        ]
      : [{ user: first.user, duelRole: DuelRole.SPOTTER }];
    const room = createDuelRoom(assignments, { fillWithAI: !second });
    rooms.push(room);
  }

  for (const { user } of pretenders) {
    requeuePretender(user);
  }

  emitChange();
  return rooms;
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

function readinessForParticipant(room, viewer) {
  const humans = humanParticipants(room);
  const readyParticipants = roleReadyParticipants(room);
  const opponent = room.mode === RoomMode.DUEL ? room.participants.find((participant) => participant.id !== viewer.id) : null;
  return {
    humanCount: humans.length,
    roleReadyCount: humans.filter((participant) => participant.roleReady).length,
    totalCount: readyParticipants.length,
    totalReadyCount: readyParticipants.filter((participant) => participant.roleReady).length,
    opponentReady: opponent ? opponent.roleReady : null
  };
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
  resolveDuelQueue,
  confirmDuelAIReady,
  DUEL_MATCH_MS,
  DUEL_AI_READY_MIN_MS,
  DUEL_AI_READY_MAX_MS,
  startRound1,
  sanitizeRoomForParticipant
};
