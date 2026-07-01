const state = {
  token: sessionStorage.getItem("aiWerewolfToken"),
  me: null,
  room: null,
  eventSource: null,
  timer: null,
  draftTimer: null,
  showRules: false
};

const MESSAGE_LIMIT = 30;
const TURN_SECONDS = 30;
const DUEL_MATCH_SECONDS = 30;
const TRANSITION_EDGE_MS = 200;
const TRANSITION_LOADER_CYCLE_MS = 800;

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let chatLayoutFrame = 0;
let fixedInputObserver = null;
let observedFixedInputPanel = null;
let currentViewKey = "";
let hasRenderedView = false;
let transitionQueue = Promise.resolve();

init().catch(showError);
window.addEventListener("resize", queueChatLayoutSync);

async function init() {
  await ensureSession();
  await refresh();
  connectEvents();
  state.timer = setInterval(updateCountdowns, 500);
}

async function ensureSession(force = false) {
  if (state.token && !force) {
    return;
  }
  const session = await api("/api/session", { method: "POST" });
  state.token = session.guestToken;
  sessionStorage.setItem("aiWerewolfToken", state.token);
}

async function resetSession() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  sessionStorage.removeItem("aiWerewolfToken");
  state.token = null;
  state.me = null;
  state.room = null;
  await ensureSession(true);
}

async function refresh(options = {}) {
  const recoverSession = options.recoverSession ?? true;
  try {
    state.me = await api(`/api/me?token=${encodeURIComponent(state.token)}`);
    if (state.me.activeRoomId) {
      state.room = await api(`/api/rooms/${state.me.activeRoomId}?token=${encodeURIComponent(state.token)}`);
    } else {
      state.room = null;
    }
    await renderWithTransition();
    updateCountdowns();
    queueChatLayoutSync();
  } catch (error) {
    if (recoverSession && isSessionError(error)) {
      await resetSession();
      await refresh({ recoverSession: false });
      connectEvents();
      showToast("セッションを作り直しました。もう一度開始してください。");
      return;
    }
    throw error;
  }
}

function connectEvents() {
  if (state.eventSource) {
    state.eventSource.close();
  }
  state.eventSource = new EventSource(`/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource.addEventListener("refresh", () => refresh().catch(showError));
  state.eventSource.onerror = () => {
    state.eventSource.close();
    setTimeout(connectEvents, 1600);
  };
}

function queueChatLayoutSync() {
  cancelAnimationFrame(chatLayoutFrame);
  chatLayoutFrame = requestAnimationFrame(() => {
    syncFixedInputSpace();
    observeFixedInputPanel();
    requestAnimationFrame(scrollChatToLatest);
  });
}

function syncFixedInputSpace() {
  const inputPanel = document.querySelector(".game-main > .input-panel");
  if (!document.body.classList.contains("game-view") || !inputPanel) {
    document.documentElement.style.removeProperty("--fixed-input-space");
    return;
  }
  const rect = inputPanel.getBoundingClientRect();
  const bottomSpace = Math.max(0, window.innerHeight - rect.bottom);
  const gap = window.matchMedia("(max-width: 540px)").matches ? 8 : 16;
  const fixedInputSpace = Math.ceil(rect.height + bottomSpace + gap);
  document.documentElement.style.setProperty("--fixed-input-space", `${fixedInputSpace}px`);
  document.documentElement.style.setProperty("--fixed-input-gap", `${gap}px`);
}

function observeFixedInputPanel() {
  const inputPanel = document.querySelector(".game-main > .input-panel");
  if (!("ResizeObserver" in window) || observedFixedInputPanel === inputPanel) {
    return;
  }
  if (fixedInputObserver) {
    fixedInputObserver.disconnect();
  }
  observedFixedInputPanel = inputPanel;
  fixedInputObserver = null;
  if (!inputPanel) {
    return;
  }
  fixedInputObserver = new ResizeObserver(() => {
    syncFixedInputSpace();
    scrollChatToLatest();
  });
  fixedInputObserver.observe(inputPanel);
}

function scrollChatToLatest() {
  for (const chatLog of document.querySelectorAll("[data-chat-log]")) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

async function renderWithTransition() {
  transitionQueue = transitionQueue
    .catch(() => {})
    .then(async () => {
      const nextViewKey = viewKey();
      const shouldTransition = hasRenderedView && nextViewKey !== currentViewKey;

      if (!shouldTransition || shouldReduceMotion()) {
        render();
        currentViewKey = nextViewKey;
        hasRenderedView = true;
        return;
      }

      document.body.classList.add("is-transitioning");
      document.body.classList.remove("is-transition-opening");
      await delay(TRANSITION_EDGE_MS + TRANSITION_LOADER_CYCLE_MS);

      render();
      currentViewKey = nextViewKey;
      hasRenderedView = true;
      updateCountdowns();
      queueChatLayoutSync();

      document.body.classList.add("is-transition-opening");
      await delay(TRANSITION_EDGE_MS);
      document.body.classList.remove("is-transitioning", "is-transition-opening");
    });

  await transitionQueue;
}

function viewKey() {
  if (!state.me) {
    return "loading";
  }
  if (!state.room) {
    if (state.me.duelQueue) {
      return "queue:duel";
    }
    if (state.me.queuePosition) {
      return "queue:match";
    }
    return "home";
  }
  return `room:${state.room.mode ?? "MATCH"}:${state.room.status}`;
}

function shouldReduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function render() {
  syncViewMode();
  if (!state.me) {
    app.innerHTML = `<section class="intro-panel"><h2>接続中</h2></section>`;
    return;
  }
  if (state.room) {
    renderRoom();
    return;
  }
  if (state.me.duelQueue) {
    renderDuelQueue();
    return;
  }
  if (state.me.queuePosition) {
    renderQueue();
    return;
  }
  renderHome();
}

function syncViewMode() {
  const fixedActionStatuses = new Set(["PERSONA_REVEAL", "ROUND_1", "ROUND_2", "ROUND_3", "VOTING"]);
  const isHome = Boolean(state.me && !state.room && !state.me.queuePosition && !state.me.duelQueue);
  const isQueue = Boolean(state.me?.queuePosition || state.me?.duelQueue);
  document.body.classList.toggle("home-view", isHome);
  document.body.classList.toggle("queue-view", isQueue);
  document.body.classList.toggle("room-view", Boolean(state.room));
  document.body.classList.toggle("game-view", Boolean(state.room && fixedActionStatuses.has(state.room.status)));
  document.body.classList.toggle("duel-view", Boolean(state.room?.mode === "DUEL"));
}

function renderHome() {
  app.innerHTML = `
    <section class="home-menu" aria-label="遊ぶモードを選択">
      <button class="home-button home-button-primary" data-action="start">AIのふりをする</button>
      <button class="home-button home-button-secondary" data-action="start-duel">AIを見破る</button>
    </section>
  `;
}

function renderQueue() {
  const count = state.me.queueCount ?? state.me.queuePosition ?? 1;
  app.innerHTML = `
    ${queueDashboardHtml({
      phase: "マッチング中",
      mode: "3人対戦",
      detail: `${Math.min(count, 3)} / 3 人`,
      progress: Math.min(100, (count / 3) * 100)
    })}
    <div class="home-layout">
      <section class="intro-panel">
        ${queuePulseHtml()}
        <div class="home-copy">
          <h2>人間プレイヤーを探しています</h2>
          <p>現在 ${Math.min(count, 3)} / 3 人。3人集まるとAIを追加してゲームが始まります。</p>
          <div class="queue-meter"><span style="width:${Math.min(100, (count / 3) * 100)}%"></span></div>
          <div class="action-row">
            <button class="danger" data-action="cancel-match">キャンセル</button>
            <button class="ghost" data-action="copy-invite">招待URLコピー</button>
          </div>
        </div>
      </section>
      <aside class="side-panel">
        <h2>待機中のヒント</h2>
        <p class="muted">このMVPでは、同じブラウザの別タブでもゲストを作成できます。別タブでプレイ開始を押すと人数が揃います。</p>
      </aside>
    </div>
  `;
}

function renderDuelQueue() {
  const isPretender = state.me.duelQueue?.duelRole === "PRETENDER";
  const queueResolveAt = state.me.duelQueue?.resolveAt;
  if (isPretender && !queueResolveAt) {
    app.innerHTML = `
      ${queueDashboardHtml({
        phase: "待機中",
        mode: "AIのふり",
        detail: "判定役待ち",
        progress: 55
      })}
      <div class="home-layout">
        <section class="intro-panel">
          ${queuePulseHtml()}
          <div class="home-copy">
            <h2>判定役を待っています</h2>
            <p>人間プレイヤーが「AIを見破る」を選ぶと、1:1の試合が始まります。</p>
            <div class="queue-meter"><span style="width:55%"></span></div>
            <div class="action-row">
              <span class="phase-chip">待機中</span>
              <button class="danger" data-action="cancel-match">キャンセル</button>
            </div>
          </div>
        </section>
        <aside class="side-panel">
          <h2>AIのふりをする</h2>
          <p class="muted">あなたは人間です。会話で相手にAIだと思わせたら勝ちです。</p>
        </aside>
      </div>
    `;
    return;
  }

  const seconds = remainingSeconds(queueResolveAt);
  const numericSeconds = Number.isFinite(seconds) ? seconds : DUEL_MATCH_SECONDS;
  const progress = Math.min(100, Math.max(0, ((DUEL_MATCH_SECONDS - numericSeconds) / DUEL_MATCH_SECONDS) * 100));
  const queueTitle = isPretender ? "開始まで待機中" : "相手を探しています";
  const queueDescription = isPretender
    ? "判定役が見つかりました。開始時刻まで待機しています。"
    : "30秒後に試合が始まります。";
  const sideTitle = isPretender ? "AIのふりをする" : "AIを見破る";
  const sideDescription = isPretender
    ? "あなたは人間です。会話で相手にAIだと思わせたら勝ちです。"
    : "テーマに沿って3往復チャットした後、相手がAIか人間かを判定します。";
  app.innerHTML = `
    ${queueDashboardHtml({
      phase: queueTitle,
      mode: sideTitle,
      detail: "開始まで",
      countdown: seconds,
      progress
    })}
    <div class="home-layout">
      <section class="intro-panel">
        ${queuePulseHtml()}
        <div class="home-copy">
          <h2>相手を探しています</h2>
          <p>人間プレイヤーが見つからなければ、30秒後にAIと試合が始まります。</p>
          <div class="queue-meter"><span style="width:${progress.toFixed(1)}%"></span></div>
          <div class="action-row">
            <span class="phase-chip">開始まで <span data-countdown>${seconds}秒</span></span>
            <button class="danger" data-action="cancel-match">キャンセル</button>
          </div>
        </div>
      </section>
      <aside class="side-panel">
        <h2>AIを見破る</h2>
        <p class="muted">テーマに沿って3往復チャットした後、相手がAIか人間かを判定します。</p>
      </aside>
    </div>
  `;
  app.querySelector(".home-copy h2").textContent = queueTitle;
  app.querySelector(".home-copy p").textContent = queueDescription;
  app.querySelector(".side-panel h2").textContent = sideTitle;
  app.querySelector(".side-panel .muted").textContent = sideDescription;
}

function renderRoom() {
  const room = state.room;
  if (room.status === "ROLE_REVEAL") {
    renderRoleReveal();
    return;
  }
  if (room.status === "VOTING" && !isDuelRoom(room)) {
    renderGameShell(votePanel());
    return;
  }
  if (room.status === "RESULT" || room.status === "CLOSED") {
    renderResult();
    return;
  }
  renderGameShell(turnPanel());
}

function renderRoleReveal() {
  const isDuel = state.room.mode === "DUEL";
  if (isDuel) {
    renderDuelRoleReveal();
    return;
  }

  const voteThreshold = state.room.voteThreshold ?? 2;
  const roleText =
    state.room.myParticipant.role === "AI_COLLABORATOR"
      ? `AIは「${state.room.knownAI?.displayName ?? "不明"}」です。AIに${voteThreshold}票以上入らないよう議論を誘導してください。`
      : "この4人の中にAIが1体います。会話からAIを見抜いてください。";
  const ready = state.room.myParticipant.roleReady;
  const readyText = `${state.room.readiness?.roleReadyCount ?? 0} / ${state.room.readiness?.humanCount ?? 3}`;
  const roleHeaderHtml = `<p class="role-title">${roleLabel(state.room.myParticipant.role)}</p>
      <h2>${roleLabel(state.room.myParticipant.role)}として参加します</h2>`;
  const waitingText = "全員が確認すると、ラウンド1が始まります。";
  const participantListHtml = `<div class="participant-list">${participantsHtml()}</div>`;
  const actionButtonsHtml = `<button class="primary" data-action="role-ack" ${ready ? "disabled" : ""}>${ready ? "ほかのプレイヤー待ち" : "確認して待つ"}</button>
        <button class="ghost" data-action="leave">退出</button>`;
  app.innerHTML = `
    <div class="room-stack">
      ${roomDashboardHtml(state.room, {
        title: roleLabel(state.room.myParticipant.role),
        detail: `確認済み ${readyText}`,
        showParticipants: false,
        showLeave: true
      })}
    <section class="stage-panel">
      ${roleHeaderHtml}
      <p>${escapeHtml(roleText)}</p>
      ${ready ? `<p class="phase-chip">確認済み。ほかのプレイヤー待ち ${readyText}</p>` : `<p class="muted">${waitingText}</p>`}
      ${participantListHtml}
      <div class="action-row">
        ${actionButtonsHtml}
      </div>
    </section>
    </div>
  `;
}

function renderDuelRoleReveal() {
  const ready = state.room.myParticipant.roleReady;
  const opponentReady = Boolean(state.room.readiness?.opponentReady);
  const duelRole = state.room.myParticipant.duelRole;
  const statusTitle = ready
    ? opponentReady
      ? "まもなく始まります"
      : "相手の確認を待っています"
    : "開始前の確認";
  const statusText = ready
    ? opponentReady
      ? "準備がそろいました。ラウンド1へ進みます。"
      : "あなたは確認済みです。相手が確認するとラウンド1が始まります。"
    : duelRoleIntroText(duelRole);
  const buttonLabel = ready
    ? `${opponentReady ? "開始準備中" : "相手の確認待ち"}<span class="wait-dot" aria-hidden="true"></span>`
    : "確認して待つ";

  app.innerHTML = `
    <div class="room-stack">
      ${roomDashboardHtml(state.room, {
        title: duelRoleLabel(duelRole),
        detail: statusTitle,
        showParticipants: false,
        showLeave: false
      })}
    <section class="stage-panel duel-role-panel">
      <button class="ghost duel-leave-button duel-role-leave" data-action="leave">退出</button>
      <div class="duel-stepper" aria-label="進行">
        <span class="duel-step is-active">確認</span>
        <span class="duel-step">会話</span>
        <span class="duel-step">正体判定</span>
        <span class="duel-step">結果</span>
      </div>
      <div class="duel-role-copy" aria-live="polite">
        <p class="phase-chip">${duelRoleLabel(duelRole)}</p>
        <h2>${statusTitle}</h2>
        <p class="muted">${statusText}</p>
        <p class="muted">2人が確認すると、ラウンド1が始まります。</p>
      </div>
      <div class="duel-ready-list" aria-label="確認状況">
        ${duelReadyRowHtml("あなた", ready ? "確認済み" : "未確認", ready)}
        ${duelReadyRowHtml("相手", opponentReady ? "確認済み" : "確認待ち", opponentReady)}
      </div>
      <div class="action-row duel-role-actions">
        <button class="primary" data-action="role-ack" ${ready ? "disabled" : ""}>${buttonLabel}</button>
      </div>
    </section>
    </div>
  `;
}

function duelReadyRowHtml(label, status, isReady) {
  return `
    <div class="duel-ready-row ${isReady ? "is-ready" : ""}">
      <span class="duel-ready-name">${label}</span>
      <span class="duel-ready-status">
        <span class="duel-ready-icon" aria-hidden="true">${isReady ? "✓" : ""}</span>
        ${status}
      </span>
    </div>
  `;
}

function duelRoleIntroText(duelRole) {
  if (duelRole === "PRETENDER") {
    return "あなたは人間です。相手にAIだと思わせたら勝ちです。";
  }
  return "相手がAIか人間かを見破ったら勝ちです。";
}

function renderGameShell(panelHtml) {
  const room = state.room;
  if (isDuelRoom(room)) {
    renderDuelGameShell(panelHtml);
    return;
  }
  app.innerHTML = `
    <div class="room-stack">
      ${roomDashboardHtml(room, {
        title: turnHeadline(room),
        detail: turnDescription(room),
        showParticipants: false,
        showLeave: true
      })}
    <div class="game-layout">
      <aside class="side-panel">
        <p class="phase-chip">${phaseLabel(room)}</p>
        <div class="meta-grid">
          <div class="meta"><strong>残り時間</strong><span data-countdown>${remainingSeconds(room.phaseEndsAt)}秒</span></div>
          <div class="meta"><strong>役職</strong><span>${roleLabel(room.myParticipant.role)}</span></div>
        </div>
        ${room.knownAI ? `<p class="role-title">AIは「${escapeHtml(room.knownAI.displayName)}」</p>` : ""}
        <h3>参加者</h3>
        <div class="participant-list">${participantsHtml()}</div>
        <div class="action-row">
          <button class="ghost" data-action="leave">退出</button>
        </div>
      </aside>
      <section class="game-main">
        <div class="stage-panel">
          <h2>${turnHeadline(room)}</h2>
          <p class="muted">${turnDescription(room)}</p>
        </div>
        <section class="chat-panel">
          <h2>チャットログ</h2>
          <div class="chat-log" data-chat-log>${messagesHtml()}</div>
        </section>
        ${panelHtml}
      </section>
    </div>
    </div>
  `;
}

function renderDuelGameShell(panelHtml) {
  const room = state.room;
  const description = turnDescription(room);
  app.innerHTML = `
    <div class="duel-game-layout">
      ${roomDashboardHtml(room, {
        title: duelStageTitle(room),
        detail: description,
        showParticipants: true,
        showLeave: true
      })}
      <div class="duel-game-top">
        <div class="duel-round-status">
          <p class="phase-chip">${phaseLabel(room)}</p>
          ${duelTurnStatusHtml(room)}
        </div>
        <button class="danger duel-leave-button" data-action="leave">退出</button>
      </div>
      <section class="game-main">
        <div class="stage-panel duel-stage-panel">
          <h2>${duelStageTitle(room)}</h2>
          ${description ? `<p class="muted">${description}</p>` : ""}
        </div>
        <section class="chat-panel">
          <h2>チャットログ</h2>
          <div class="chat-log" data-chat-log>${messagesHtml()}</div>
        </section>
        ${panelHtml}
      </section>
    </div>
  `;
}

function turnPanel() {
  const room = state.room;
  const isMyTurn = room.currentTurn?.participantId === room.myParticipant.id;
  if (!isMyTurn) {
    const currentTurnLabel = participantLabelById(room.currentTurn?.participantId, room.currentTurn?.displayName ?? "相手");
    return `
      <section class="input-panel">
        <strong>待機中</strong>
        <p class="muted">現在は ${escapeHtml(currentTurnLabel)} のターンです。</p>
        ${isDuelRoom(room) ? `<div class="compact-row input-meta-row">${turnCountdownHtml(room)}</div>` : ""}
      </section>
    `;
  }

  if (room.status === "ROUND_2" && room.currentTurn.turnType === "DIRECTED_QUESTION") {
    return `
      <section class="input-panel">
        <label>質問する相手${targetSelectHtml()}</label>
        <label>質問<textarea id="turnText" maxlength="${MESSAGE_LIMIT}" placeholder="${MESSAGE_LIMIT}文字以内で質問"></textarea></label>
        <div class="compact-row input-meta-row"><span id="counter" class="counter">0 / ${MESSAGE_LIMIT}</span>${turnTimingHtml(room)}</div>
      </section>
    `;
  }

  if (room.status === "ROUND_3") {
    const isDuel = isDuelRoom(room);
    const judgementField = isDuel ? duelJudgementFieldHtml() : "";
    const targetField = isDuel ? "" : `<label>AIだと思う人${targetSelectHtml()}</label>`;
    return `
      <section class="input-panel">
        ${judgementField}
        ${targetField}
        <div class="compact-row input-meta-row">${turnTimingHtml(room)}</div>
      </section>
    `;
  }

  const defaultLabel =
    isDuelRoom(room) && room.status === "ROUND_1"
      ? ""
      : room.status === "ROUND_1"
        ? "お題への回答"
        : "回答";
  const defaultPlaceholder =
    isDuelRoom(room) && room.status === "ROUND_1"
      ? `${MESSAGE_LIMIT}文字以内で返信`
      : `${MESSAGE_LIMIT}文字以内で入力`;
  return `
    <section class="input-panel">
      <label>${defaultLabel}<textarea id="turnText" maxlength="${MESSAGE_LIMIT}" aria-label="${defaultLabel || "回答"}" placeholder="${defaultPlaceholder}"></textarea></label>
      <div class="compact-row input-meta-row"><span id="counter" class="counter">0 / ${MESSAGE_LIMIT}</span>${turnTimingHtml(room)}</div>
    </section>
  `;
}

function votePanel() {
  const room = state.room;
  const voted = room.myParticipant.hasVoted;
  const buttons = room.participants
    .map((participant) => {
      const disabled = participant.id === room.myParticipant.id || voted ? "disabled" : "";
      const label = participantLabel(participant);
      return `<button class="vote-button" ${disabled} data-vote="${participant.id}">${escapeHtml(label)}</button>`;
    })
    .join("");
  return `
    <section class="input-panel">
      <h2>誰がAIだと思う？</h2>
      <p class="muted">${voted ? "投票済みです。結果を待っています。" : "自分以外の参加者に投票できます。"}</p>
      ${isDuelRoom(room) ? `<div class="compact-row input-meta-row">${turnCountdownHtml(room)}</div>` : ""}
      <div class="vote-list">${buttons}</div>
    </section>
  `;
}

function renderResult() {
  const room = state.room;
  const ai = room.participants.find((participant) => participant.id === room.result?.aiParticipantId);
  const collaborator = room.participants.find((participant) => participant.id === room.result?.collaboratorParticipantId);
  const voteThreshold = room.result?.voteThreshold ?? room.voteThreshold ?? 2;
  const isDuel = isDuelRoom(room);
  const aiText = `AIは「${escapeHtml(ai?.displayName ?? "")}」でした。`;
  const collaboratorText = !isDuel && collaborator ? `AI協力者は「${escapeHtml(collaborator.displayName)}」でした。` : "";
  const winner =
    room.status === "CLOSED"
      ? "試合は無効です"
      : isDuel
        ? duelOutcomeTitle(room)
        : room.result?.winnerTeam === "HUMAN"
          ? "人間陣営の勝利"
          : "AI陣営の勝利";
  const resultSummaryHtml = room.result
    ? isDuel
      ? duelResultSummaryHtml(room)
      : `<p>${aiText}${collaboratorText}</p>
         <p>AIに入った票：${room.result.aiVotes}票 / 必要：${voteThreshold}票</p>`
    : "";
  const resultDetailsHtml = isDuel
    ? duelJudgementResultHtml(room)
    : `<h3>投票結果</h3>
       <div class="participant-list">
         ${room.votes.map((vote) => `<div class="participant"><span></span><span>${escapeHtml(voteLabel(vote))}</span><span class="badge">${vote.auto ? "自動" : "投票"}</span></div>`).join("")}
       </div>`;
  app.innerHTML = `
    <div class="room-stack">
      ${resultDashboardHtml(room, winner, ai, voteThreshold)}
    <section class="result-panel">
      <p class="phase-chip">結果発表</p>
      <h2>${winner}</h2>
      ${resultSummaryHtml}
      <div class="participant-list">${participantsHtml()}</div>
      ${resultDetailsHtml}
      <section class="chat-panel">
        <h3>チャットログ</h3>
        <div class="chat-log" data-chat-log>${messagesHtml()}</div>
      </section>
      <div class="action-row">
        <button class="primary" data-action="play-again">もう一度遊ぶ</button>
        <button class="ghost" data-action="copy-result">結果を共有</button>
        <button class="ghost" data-action="leave">トップへ戻る</button>
      </div>
    </section>
    </div>
  `;
}

function queueDashboardHtml({ phase, mode, detail, countdown, progress }) {
  const detailHtml =
    countdown == null
      ? escapeHtml(detail)
      : `${escapeHtml(detail)} <span data-countdown>${escapeHtml(`${countdown}秒`)}</span>`;
  return `
    <section class="room-dashboard queue-dashboard" aria-label="待機情報">
      <div class="dashboard-main">
        <p class="phase-chip">${escapeHtml(phase)}</p>
        <div class="dashboard-title">
          <h2>${escapeHtml(mode)}</h2>
          <p class="muted">${detailHtml}</p>
        </div>
      </div>
      <div class="dashboard-meter" aria-hidden="true">
        <span style="width:${Math.min(100, Math.max(0, progress)).toFixed(1)}%"></span>
      </div>
    </section>
  `;
}

function roomDashboardHtml(room, options = {}) {
  const roleText = isDuelRoom(room)
    ? duelRoleLabel(room.myParticipant.duelRole)
    : roleLabel(room.myParticipant.role);
  const metrics = [
    dashboardMetricHtml("フェーズ", phaseLabel(room), "wide"),
    dashboardMetricHtml("残り時間", `${remainingSeconds(room.phaseEndsAt)}秒`, "timer"),
    dashboardMetricHtml("役割", roleText),
    dashboardMetricHtml("ターン", dashboardTurnLabel(room))
  ];
  if (room.knownAI) {
    metrics.push(dashboardMetricHtml("判明AI", room.knownAI.displayName));
  }

  return `
    <section class="room-dashboard" aria-label="試合情報">
      <div class="dashboard-main">
        <p class="phase-chip">${phaseLabel(room)}</p>
        <div class="dashboard-title">
          <h2>${escapeHtml(options.title ?? phaseLabel(room))}</h2>
          ${options.detail ? `<p class="muted">${escapeHtml(options.detail)}</p>` : ""}
        </div>
      </div>
      <div class="dashboard-meta">
        ${metrics.join("")}
      </div>
      ${options.showParticipants ? `<div class="dashboard-participants">${dashboardParticipantsHtml(room)}</div>` : ""}
      ${options.showLeave ? `<div class="dashboard-actions"><button class="ghost" data-action="leave">退出</button></div>` : ""}
    </section>
  `;
}

function resultDashboardHtml(room, winner, ai, voteThreshold) {
  const resultMetrics = isDuelRoom(room)
    ? [
        dashboardMetricHtml("勝敗", room.result?.participantResult?.won ? "勝利" : "敗北"),
        dashboardMetricHtml("役割", duelRoleLabel(room.myParticipant.duelRole)),
        dashboardMetricHtml("判定", duelJudgementLabel(room.result?.duelJudgement?.judgement))
      ]
    : [
        dashboardMetricHtml("勝利陣営", room.result?.winnerTeam === "HUMAN" ? "人間" : "AI"),
        dashboardMetricHtml("AI", ai?.displayName ?? ""),
        dashboardMetricHtml("AI票", `${room.result?.aiVotes ?? 0} / ${voteThreshold}`)
      ];
  return `
    <section class="room-dashboard result-dashboard" aria-label="結果サマリー">
      <div class="dashboard-main">
        <p class="phase-chip">結果</p>
        <div class="dashboard-title">
          <h2>${escapeHtml(winner)}</h2>
          <p class="muted">${isDuelRoom(room) ? "1:1判定の結果" : "投票結果のサマリー"}</p>
        </div>
      </div>
      <div class="dashboard-meta">${resultMetrics.join("")}</div>
      <div class="dashboard-participants">${dashboardParticipantsHtml(room)}</div>
    </section>
  `;
}

function dashboardMetricHtml(label, value, tone = "") {
  const valueHtml =
    tone === "timer"
      ? `<span data-countdown>${escapeHtml(value ?? "-")}</span>`
      : `<span>${escapeHtml(value ?? "-")}</span>`;
  return `
    <div class="dashboard-metric ${tone ? `is-${tone}` : ""}">
      <strong>${escapeHtml(label)}</strong>
      ${valueHtml}
    </div>
  `;
}

function dashboardTurnLabel(room) {
  if (room.currentTurn) {
    return participantLabelById(room.currentTurn.participantId, room.currentTurn.displayName);
  }
  if (room.status === "ROLE_REVEAL") {
    return "確認中";
  }
  if (room.status === "RESULT" || room.status === "CLOSED") {
    return "終了";
  }
  return "-";
}

function dashboardParticipantsHtml(room) {
  return room.participants
    .map((participant) => {
      const label = participantLabel(participant);
      const isMe = participant.id === room.myParticipant.id;
      const isCurrent = participant.id === room.currentTurn?.participantId;
      const badges = [
        isMe ? "自分" : "",
        isCurrent ? "発言中" : "",
        participant.hasVoted ? "投票済" : ""
      ]
        .filter(Boolean)
        .map((badge) => `<span class="dashboard-badge">${escapeHtml(badge)}</span>`)
        .join("");
      return `
        <span class="dashboard-participant">
          ${avatar(label)}
          <span>${escapeHtml(label)}</span>
          ${badges}
        </span>
      `;
    })
    .join("");
}

function queuePulseHtml() {
  return `
    <div class="queue-pulse" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
}

function statsGrid(stats) {
  return `
    <div class="stat-grid">
      <div class="stat"><strong>総プレイ数</strong>${stats.gamesPlayed}</div>
      <div class="stat"><strong>勝率</strong>${stats.winRate}%</div>
      <div class="stat"><strong>市民勝率</strong>${stats.citizenWinRate}%</div>
      <div class="stat"><strong>AI見抜き</strong>${stats.correctAIVotes}回</div>
    </div>
  `;
}

function participantsHtml() {
  return state.room.participants
    .map((participant) => {
      const role =
        isDuelRoom() && participant.duelRole
          ? `<span class="badge">${duelRoleLabel(participant.duelRole)}</span>`
          : participant.role
            ? `<span class="badge">${roleLabel(participant.role)}</span>`
            : "";
      const label = participantLabel(participant);
      return `
        <div class="participant">
          ${avatar(label)}
          <span>${escapeHtml(label)}</span>
          ${role}
        </div>
      `;
    })
    .join("");
}

function messagesHtml() {
  if (!state.room.messages.length) {
    return `<p class="muted">まだ発言はありません。</p>`;
  }
  return state.room.messages
    .map((message) => {
      const messageSide =
        message.kind === "SYSTEM"
          ? ""
          : message.participantId === state.room.myParticipant.id
            ? "own"
            : "other";
      const cls = [
        message.kind === "SYSTEM" ? "system" : "",
        messageSide,
        message.isBlocked ? "blocked" : ""
      ]
        .filter(Boolean)
        .join(" ");
      return `
        <article class="message ${cls}">
          <div class="message-head">
            <strong>${escapeHtml(messageSpeaker(message))}</strong>
          </div>
          <p>${escapeHtml(scrubDuelNames(message.text))}</p>
        </article>
      `;
    })
    .join("");
}

function targetSelectHtml() {
  return `
    <select id="targetSelect">
      ${state.room.participants
        .filter((participant) => participant.id !== state.room.myParticipant.id)
        .map((participant) => `<option value="${participant.id}">${escapeHtml(participantLabel(participant))}</option>`)
        .join("")}
    </select>
  `;
}

function duelJudgementFieldHtml() {
  return `
    <fieldset class="judgement-field">
      <legend>相手の正体</legend>
      <div class="judgement-options">
        <label class="judgement-option">
          <input type="radio" name="duelJudgement" value="AI" />
          <span>AIだと思う</span>
        </label>
        <label class="judgement-option">
          <input type="radio" name="duelJudgement" value="HUMAN" />
          <span>人間だと思う</span>
        </label>
      </div>
    </fieldset>
  `;
}

function isDuelRoom(room = state.room) {
  return room?.mode === "DUEL";
}

function participantLabel(participant) {
  if (!participant) {
    return isDuelRoom() ? "相手" : "";
  }
  return participantLabelById(participant.id, participant.displayName);
}

function participantLabelById(participantId, fallback = "") {
  if (!isDuelRoom()) {
    const participant = state.room?.participants.find((item) => item.id === participantId);
    return participant?.displayName ?? fallback;
  }
  if (!participantId) {
    return fallback || "相手";
  }
  return participantId === state.room.myParticipant.id ? "自分" : "相手";
}

function messageSpeaker(message) {
  if (message.kind === "SYSTEM") {
    return message.displayName;
  }
  return participantLabelById(message.participantId, message.displayName);
}

function scrubDuelNames(text) {
  if (!isDuelRoom()) {
    return text;
  }
  return state.room.participants.reduce((current, participant) => {
    if (!participant.displayName) {
      return current;
    }
    return current.replaceAll(participant.displayName, participantLabel(participant));
  }, String(text ?? ""));
}

function voteLabel(vote) {
  const voter = participantLabelById(vote.voterParticipantId, vote.voterDisplayName);
  const target = participantLabelById(vote.targetParticipantId, vote.targetDisplayName);
  return `${voter} → ${target}`;
}

function duelOutcomeTitle(room) {
  const won = Boolean(room.result?.participantResult?.won);
  if (room.myParticipant.duelRole === "PRETENDER") {
    return won ? "AIのふり成功" : "人間だと見破られました";
  }
  return won ? "見破り成功" : "見破り失敗";
}

function duelResultSummaryHtml(room) {
  const judgement = room.result?.duelJudgement;
  const won = Boolean(room.result?.participantResult?.won);
  if (room.myParticipant.duelRole === "PRETENDER") {
    const judgementText = duelJudgementValueLabel(judgement?.judgement);
    return `
      <p>あなたは人間でした。</p>
      <p>${won ? "相手にAIだと思わせました。" : "相手に人間だと見破られました。"}</p>
      <p>相手の判定：${escapeHtml(judgementText)}</p>
    `;
  }

  const target =
    room.participants.find((participant) => participant.id === judgement?.targetParticipantId) ??
    room.participants.find((participant) => participant.id !== room.myParticipant.id);
  const truth = target?.isAI ? "AI" : "人間";
  return `
    <p>相手は${truth}でした。</p>
    <p>${won ? "正体を見破りました。" : "正体を見破れませんでした。"}</p>
  `;
}

function duelJudgementResultHtml(room) {
  const judgements = room.result?.duelJudgements?.length
    ? room.result.duelJudgements
    : room.result?.duelJudgement
      ? [room.result.duelJudgement]
      : [];
  if (!judgements.length) {
    return "";
  }
  return `
    <h3>判定結果</h3>
    <div class="participant-list">
      ${judgements
        .map((judgement) => {
          const voter = participantLabelById(judgement.participantId);
          const target = participantLabelById(judgement.targetParticipantId);
          const judgementText = `${voter}の判定：${target}は${duelJudgementValueLabel(judgement.judgement)}`;
          return `
            <div class="participant">
              <span></span>
              <span>${escapeHtml(judgementText)}</span>
              <span class="badge">${judgement.correct ? "成功" : "失敗"}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function duelJudgementValueLabel(value) {
  if (value === "AI") {
    return "AI";
  }
  if (value === "HUMAN") {
    return "人間";
  }
  return "未判定";
}

function duelJudgementLabel(value) {
  if (value === "AI") {
    return "相手はAI";
  }
  if (value === "HUMAN") {
    return "相手は人間";
  }
  return "未判定";
}

function avatar(label) {
  return `<span class="avatar">${escapeHtml(Array.from(label)[0] ?? "?")}</span>`;
}

function phaseLabel(room) {
  if (isDuelRoom(room)) {
    const duelLabels = {
      ROUND_1: "ラウンド1 / 2：3往復チャット",
      ROUND_3: "ラウンド2 / 2：正体判定",
      RESULT: "結果",
      CLOSED: "無効試合"
    };
    return duelLabels[room.status] ?? room.status;
  }
  const labels = {
    ROUND_1: "ラウンド1 / 3：共通お題",
    ROUND_2: "ラウンド2 / 3：指名質問",
    ROUND_3: "ラウンド3 / 3：最終推理",
    VOTING: "投票",
    RESULT: "結果",
    CLOSED: "無効試合"
  };
  return labels[room.status] ?? room.status;
}

function duelTurnStatusHtml(room) {
  const label = duelTurnLabel(room);
  return label ? `<span class="turn-status">${label}</span>` : "";
}

function duelTurnLabel(room) {
  if (!room.currentTurn) {
    return "";
  }
  return room.currentTurn.participantId === room.myParticipant.id ? "自分のターン" : "相手のターン";
}

function duelStageTitle(room) {
  if (room.status === "ROUND_1") {
    return `お題：${escapeHtml(room.topicPrompt)}`;
  }
  const labels = {
    ROUND_2: room.currentTurn?.turnType === "DIRECTED_ANSWER" ? "質問への回答" : "質問",
    ROUND_3: "正体判定"
  };
  return labels[room.status] ?? phaseLabel(room);
}

function turnHeadline(room) {
  if (!room.currentTurn) {
    return phaseLabel(room);
  }
  const currentTurnLabel = participantLabelById(room.currentTurn.participantId, room.currentTurn.displayName);
  if (room.currentTurn.turnType === "DIRECTED_ANSWER") {
    return `${currentTurnLabel} が回答`;
  }
  return `${currentTurnLabel} のターン`;
}

function turnDescription(room) {
  if (room.status === "ROUND_1") {
    if (isDuelRoom(room)) {
      return "";
    }
    return `お題：${room.topicPrompt}`;
  }
  if (room.status === "ROUND_2" && room.currentTurn?.turnType === "DIRECTED_ANSWER") {
    const askerLabel = participantLabelById(room.currentTurn.askerParticipantId, room.currentTurn.askerDisplayName);
    return `${askerLabel} からの質問に答えます。`;
  }
  if (room.status === "ROUND_2") {
    return `相手を1人選んで、${MESSAGE_LIMIT}文字以内で質問します。入力済みでも${TURN_SECONDS}秒ちょうどで送信されます。`;
  }
  if (room.status === "ROUND_3") {
    if (isDuelRoom(room)) {
      return `相手がAIか人間かを選びます。入力済みでも${TURN_SECONDS}秒ちょうどで送信されます。`;
    }
    return `AIだと思う相手を選びます。入力済みでも${TURN_SECONDS}秒ちょうどで送信されます。`;
  }
  return "";
}

function roleLabel(role) {
  const labels = {
    CITIZEN: "市民",
    AI_COLLABORATOR: "AI協力者",
    AI: "AI"
  };
  return labels[role] ?? role;
}

function duelRoleLabel(duelRole) {
  const labels = {
    SPOTTER: "見破る側",
    PRETENDER: "AIのふり",
    AI: "AI"
  };
  return labels[duelRole] ?? duelRole ?? "1:1";
}

function turnTimingHtml(room) {
  const seconds = remainingSeconds(room.phaseEndsAt);
  return `
    <span class="turn-input-timer" role="timer" aria-label="残り時間">
      <span class="turn-timer-head">
        <span class="turn-countdown"><strong>残り時間</strong><span data-countdown>${seconds}秒</span></span>
        <span class="auto-send-label">自動送信</span>
      </span>
      <span class="turn-progress" role="progressbar" aria-label="残り時間" aria-valuemin="0" aria-valuemax="${TURN_SECONDS}" aria-valuenow="${seconds}" data-turn-progressbar>
        <span data-turn-progress></span>
      </span>
    </span>
  `;
}

function turnCountdownHtml(room) {
  return `<span class="turn-countdown"><strong>残り時間</strong><span data-countdown>${remainingSeconds(room.phaseEndsAt)}秒</span></span>`;
}

function remainingSeconds(iso) {
  if (!iso) {
    return "-";
  }
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

function updateCountdowns() {
  const seconds = remainingSeconds(state.room?.phaseEndsAt ?? state.me?.duelQueue?.resolveAt);
  const countdowns = document.querySelectorAll("[data-countdown]");
  for (const countdown of countdowns) {
    countdown.textContent = `${seconds}秒`;
  }
  updateTurnProgress(seconds);
}

function updateTurnProgress(seconds) {
  const progressBars = document.querySelectorAll("[data-turn-progress]");
  if (!progressBars.length) {
    return;
  }
  const endsAt = new Date(state.room?.phaseEndsAt).getTime();
  const remainingMs = Number.isFinite(endsAt) ? Math.max(0, endsAt - Date.now()) : TURN_SECONDS * 1000;
  const remainingPercent = Math.min(100, Math.max(0, (remainingMs / (TURN_SECONDS * 1000)) * 100));
  const remainingSecondsValue = typeof seconds === "number" ? seconds : TURN_SECONDS;
  for (const progressBar of progressBars) {
    progressBar.style.width = `${remainingPercent.toFixed(1)}%`;
  }
  for (const progressWrap of document.querySelectorAll("[data-turn-progressbar]")) {
    progressWrap.setAttribute("aria-valuenow", String(remainingSecondsValue));
  }
}

async function goHome() {
  state.showRules = false;
  if (state.room) {
    await roomAction("leave", {});
    return;
  }
  if (state.me?.queuePosition || state.me?.duelQueue) {
    await api("/api/match/cancel", { method: "POST", body: { guestToken: state.token } });
    await refresh();
    return;
  }
  await refresh();
}

document.addEventListener("input", (event) => {
  if (event.target.id !== "turnText") {
    return;
  }
  const counter = document.querySelector("#counter");
  if (!counter) {
    return;
  }
  const count = Array.from(event.target.value.trim()).length;
  counter.textContent = `${count} / ${MESSAGE_LIMIT}`;
  counter.classList.toggle("over", count > MESSAGE_LIMIT);
  scheduleDraftSave(0);
});

document.addEventListener("change", (event) => {
  if (event.target.id === "targetSelect" || event.target.name === "duelJudgement") {
    scheduleDraftSave(0);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  const action = button.dataset.action;
    const voteTarget = button.dataset.vote;
  try {
    if (action === "start") {
      await api("/api/pretend", { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "start-duel") {
      await api("/api/duel", { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "go-home") {
      await goHome();
    } else if (action === "toggle-rules") {
      state.showRules = !state.showRules;
      render();
    } else if (action === "cancel-match") {
      await api("/api/match/cancel", { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "copy-invite") {
      await navigator.clipboard.writeText(location.href);
      showToast("招待URLをコピーしました。");
    } else if (action === "role-ack") {
      await roomAction("action", { actionType: "ROLE_ACK" });
    } else if (action === "leave") {
      await roomAction("leave", {});
      await refresh();
    } else if (action === "play-again") {
      const nextMatchPath =
        state.room?.mode === "DUEL"
          ? state.room?.myParticipant?.duelRole === "PRETENDER"
            ? "/api/pretend"
            : "/api/duel"
          : "/api/match";
      await roomAction("leave", {});
      await api(nextMatchPath, { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "copy-result") {
      await navigator.clipboard.writeText(resultShareText());
      showToast("結果をコピーしました。");
    } else if (voteTarget) {
      await roomAction("vote", { targetParticipantId: voteTarget });
    }
  } catch (error) {
    showError(error);
  }
});

function selectedTargetParticipantId() {
  return document.querySelector("#targetSelect")?.value ?? null;
}

function selectedDuelJudgement() {
  return document.querySelector('input[name="duelJudgement"]:checked')?.value ?? null;
}

function scheduleDraftSave(delay = 180) {
  if (!state.room || state.room.currentTurn?.participantId !== state.room.myParticipant.id) {
    return;
  }
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    const actionType = currentActionType();
    if (!actionType) {
      return;
    }
    const targetParticipantId = selectedTargetParticipantId();
    saveDraftAction(actionType, targetParticipantId, true).catch(() => {});
  }, delay);
}

function currentActionType() {
  if (!state.room || state.room.currentTurn?.participantId !== state.room.myParticipant.id) {
    return null;
  }
  if (state.room.status === "ROUND_1") {
    return "ROUND_1_ANSWER";
  }
  if (state.room.status === "ROUND_2" && state.room.currentTurn.turnType === "DIRECTED_QUESTION") {
    return "DIRECTED_QUESTION";
  }
  if (state.room.status === "ROUND_2" && state.room.currentTurn.turnType === "DIRECTED_ANSWER") {
    return "DIRECTED_ANSWER";
  }
  if (state.room.status === "ROUND_3") {
    return "FINAL_SUSPICION";
  }
  return null;
}

async function saveDraftAction(actionType, targetParticipantId = null, silent = true) {
  const text = document.querySelector("#turnText")?.value ?? "";
  await api(`/api/rooms/${state.room.id}/action`, {
    method: "POST",
    body: {
      guestToken: state.token,
      actionType,
      targetParticipantId,
      duelJudgement: selectedDuelJudgement(),
      text
    }
  });
  if (!silent) {
    await refresh();
  }
}

async function roomAction(action, body) {
  await api(`/api/rooms/${state.room.id}/${action}`, {
    method: "POST",
    body: { guestToken: state.token, ...body }
  });
  await refresh();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? "通信に失敗しました。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function isSessionError(error) {
  return error?.status === 401 || /セッションが無効|セッションが必要/.test(error?.message ?? "");
}

function resultShareText() {
  const room = state.room;
  if (!room?.result) {
    return "AI判定ゲームの試合結果";
  }
  const ai = room.participants.find((participant) => participant.id === room.result.aiParticipantId);
  const winner = room.result.winnerTeam === "HUMAN" ? "人間陣営" : "AI陣営";
  if (isDuelRoom(room)) {
    const judgement = room.result.duelJudgement;
    const outcome = room.result.participantResult?.won ? "勝利" : "敗北";
    const role = duelRoleLabel(room.myParticipant.duelRole);
    const truth = room.myParticipant.duelRole === "PRETENDER" ? "自分は人間" : ai ? "相手はAI" : "相手は人間";
    return `1:1判定 結果：${outcome}。役割は${role}。${truth}。判定は${duelJudgementLabel(judgement?.judgement)}でした。`;
  }
  const voteThreshold = room.result.voteThreshold ?? room.voteThreshold ?? 2;
  const aiText = isDuelRoom(room) ? participantLabel(ai) : `「${ai?.displayName}」`;
  return `AI判定ゲーム 結果：${winner}の勝利。AIは${aiText}。AIへの票は${room.result.aiVotes}/${voteThreshold}票でした。`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2400);
}

function showError(error) {
  console.error(error);
  if (isSessionError(error)) {
    resetSession()
      .then(() => refresh({ recoverSession: false }))
      .then(() => connectEvents())
      .then(() => showToast("セッションを作り直しました。もう一度開始してください。"))
      .catch((sessionError) => showToast(sessionError.message ?? "セッション更新に失敗しました。"));
    return;
  }
  showToast(error.message ?? "エラーが発生しました。");
}
