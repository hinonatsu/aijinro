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

const app = document.querySelector("#app");
const sessionPill = document.querySelector("#sessionPill");
const toast = document.querySelector("#toast");

init().catch(showError);

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
    sessionPill.textContent = state.me.displayName;
    if (state.me.activeRoomId) {
      state.room = await api(`/api/rooms/${state.me.activeRoomId}?token=${encodeURIComponent(state.token)}`);
    } else {
      state.room = null;
    }
    render();
    updateCountdowns();
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
  if (state.me.queuePosition) {
    renderQueue();
    return;
  }
  renderHome();
}

function syncViewMode() {
  const fixedActionStatuses = new Set(["PERSONA_REVEAL", "ROUND_1", "ROUND_2", "ROUND_3", "VOTING"]);
  document.body.classList.toggle("room-view", Boolean(state.room));
  document.body.classList.toggle("game-view", Boolean(state.room && fixedActionStatuses.has(state.room.status)));
}

function renderHome() {
  app.innerHTML = `
    <div class="home-layout">
      <section class="intro-panel">
        ${signalGrid()}
        <div class="home-copy">
          <h2>遊ぶ人数を選ぶ</h2>
          <p>4人部屋では人間3人とAI1体で対戦します。1:1練習では待たずにAIとすぐ遊べます。</p>
          <div class="action-row">
            <button class="primary" data-action="start">4人部屋で遊ぶ</button>
            <button class="secondary" data-action="start-duel">1:1で練習</button>
            <button class="ghost" data-action="toggle-rules">ルールを見る</button>
          </div>
        </div>
      </section>
      <aside class="side-panel">
        <h2>戦績</h2>
        ${statsGrid(state.me.stats)}
        ${state.showRules ? document.querySelector("#rulesTemplate").innerHTML : ""}
      </aside>
    </div>
  `;
}

function renderQueue() {
  const count = state.me.queueCount ?? state.me.queuePosition ?? 1;
  app.innerHTML = `
    <div class="home-layout">
      <section class="intro-panel">
        ${signalGrid(count)}
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

function renderRoom() {
  const room = state.room;
  if (room.status === "ROLE_REVEAL") {
    renderRoleReveal();
    return;
  }
  if (room.status === "VOTING") {
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
  const voteThreshold = state.room.voteThreshold ?? 2;
  const roleText =
    state.room.myParticipant.role === "AI_COLLABORATOR"
      ? `AIは「${state.room.knownAI?.displayName ?? "不明"}」です。AIに${voteThreshold}票以上入らないよう議論を誘導してください。`
      : isDuel
        ? "1:1練習です。相手はAIです。3ラウンド話して最後に投票します。"
        : "この4人の中にAIが1体います。会話からAIを見抜いてください。";
  const ready = state.room.myParticipant.roleReady;
  const readyText = `${state.room.readiness?.roleReadyCount ?? 0} / ${state.room.readiness?.humanCount ?? 3}`;
  app.innerHTML = `
    <section class="stage-panel">
      <p class="role-title">${roleLabel(state.room.myParticipant.role)}</p>
      <h2>${roleLabel(state.room.myParticipant.role)}として参加します</h2>
      <p>${escapeHtml(roleText)}</p>
      ${ready ? `<p class="phase-chip">確認済み。ほかのプレイヤー待ち ${readyText}</p>` : `<p class="muted">全員が確認すると、ラウンド1が始まります。</p>`}
      <div class="participant-list">${participantsHtml()}</div>
      <div class="action-row">
        <button class="primary" data-action="role-ack" ${ready ? "disabled" : ""}>${ready ? "ほかのプレイヤー待ち" : "確認して待つ"}</button>
        <button class="ghost" data-action="leave">退出</button>
      </div>
    </section>
  `;
}

function renderGameShell(panelHtml) {
  const room = state.room;
  app.innerHTML = `
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
          <div class="chat-log">${messagesHtml()}</div>
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
    return `
      <section class="input-panel">
        <strong>待機中</strong>
        <p class="muted">現在は ${escapeHtml(room.currentTurn?.displayName ?? "相手")} のターンです。</p>
      </section>
    `;
  }

  if (room.status === "ROUND_2" && room.currentTurn.turnType === "DIRECTED_QUESTION") {
    return `
      <section class="input-panel">
        <label>質問する相手${targetSelectHtml()}</label>
        <label>質問<textarea id="turnText" maxlength="${MESSAGE_LIMIT}" placeholder="${MESSAGE_LIMIT}文字以内で質問"></textarea></label>
        <div class="compact-row"><span id="counter" class="counter">0 / ${MESSAGE_LIMIT}</span><span class="muted">${TURN_SECONDS}秒ちょうどで送信されます</span></div>
        <button class="primary turn-save-button" data-action="send-question">下書きを保存</button>
      </section>
    `;
  }

  if (room.status === "ROUND_3") {
    return `
      <section class="input-panel">
        <label>AIだと思う人${targetSelectHtml()}</label>
        <label>理由<textarea id="turnText" maxlength="${MESSAGE_LIMIT}" placeholder="${MESSAGE_LIMIT}文字以内で理由を書く"></textarea></label>
        <div class="compact-row"><span id="counter" class="counter">0 / ${MESSAGE_LIMIT}</span><span class="muted">${TURN_SECONDS}秒ちょうどで送信されます</span></div>
        <button class="primary turn-save-button" data-action="send-final">下書きを保存</button>
      </section>
    `;
  }

  return `
    <section class="input-panel">
      <label>${room.status === "ROUND_1" ? "お題への回答" : "回答"}<textarea id="turnText" maxlength="${MESSAGE_LIMIT}" placeholder="${MESSAGE_LIMIT}文字以内で入力"></textarea></label>
      <div class="compact-row"><span id="counter" class="counter">0 / ${MESSAGE_LIMIT}</span><span class="muted">${TURN_SECONDS}秒ちょうどで送信されます</span></div>
      <button class="primary turn-save-button" data-action="${room.status === "ROUND_1" ? "send-round1" : "send-answer"}">下書きを保存</button>
    </section>
  `;
}

function votePanel() {
  const room = state.room;
  const voted = room.myParticipant.hasVoted;
  const buttons = room.participants
    .map((participant) => {
      const disabled = participant.id === room.myParticipant.id || voted ? "disabled" : "";
      return `<button class="vote-button" ${disabled} data-vote="${participant.id}">${avatar(participant.displayName)}${escapeHtml(participant.displayName)}</button>`;
    })
    .join("");
  return `
    <section class="input-panel">
      <h2>誰がAIだと思う？</h2>
      <p class="muted">${voted ? "投票済みです。結果を待っています。" : "自分以外の参加者に投票できます。"}</p>
      <div class="vote-list">${buttons}</div>
    </section>
  `;
}

function renderResult() {
  const room = state.room;
  const ai = room.participants.find((participant) => participant.id === room.result?.aiParticipantId);
  const collaborator = room.participants.find((participant) => participant.id === room.result?.collaboratorParticipantId);
  const voteThreshold = room.result?.voteThreshold ?? room.voteThreshold ?? 2;
  const collaboratorText = collaborator ? `AI協力者は「${escapeHtml(collaborator.displayName)}」でした。` : "";
  const winner =
    room.status === "CLOSED"
      ? "試合は無効です"
      : room.result?.winnerTeam === "HUMAN"
        ? "人間陣営の勝利"
        : "AI陣営の勝利";
  app.innerHTML = `
    <section class="result-panel">
      <p class="phase-chip">結果発表</p>
      <h2>${winner}</h2>
      ${
        room.result
          ? `<p>AIは「${escapeHtml(ai?.displayName ?? "")}」でした。${collaboratorText}</p>
             <p>AIに入った票：${room.result.aiVotes}票 / 必要：${voteThreshold}票</p>`
          : ""
      }
      <div class="participant-list">${participantsHtml()}</div>
      <h3>投票結果</h3>
      <div class="participant-list">
        ${room.votes.map((vote) => `<div class="participant"><span></span><span>${escapeHtml(vote.voterDisplayName)} → ${escapeHtml(vote.targetDisplayName)}</span><span class="badge">${vote.auto ? "自動" : "投票"}</span></div>`).join("")}
      </div>
      <section class="chat-panel">
        <h3>チャットログ</h3>
        <div class="chat-log">${messagesHtml()}</div>
      </section>
      <div class="action-row">
        <button class="primary" data-action="play-again">もう一度遊ぶ</button>
        <button class="ghost" data-action="copy-result">結果を共有</button>
        <button class="ghost" data-action="leave">トップへ戻る</button>
      </div>
    </section>
  `;
}

function signalGrid(active = 1) {
  return `
    <div class="signal-grid" aria-hidden="true">
      ${[0, 1, 2, 3]
        .map((index) => {
          const isAi = index === 3;
          const opacity = index < active ? "1" : "0.36";
          return `
            <div class="signal-tile ${isAi ? "ai" : ""}" style="opacity:${opacity}">
              <svg viewBox="0 0 48 48">
                <rect x="8" y="10" width="32" height="26" rx="7" fill="${isAi ? "#f7f2e8" : "#15171c"}" />
                <circle cx="18" cy="23" r="3" fill="${isAi ? "#ff6b57" : "#14b8a6"}" />
                <circle cx="30" cy="23" r="3" fill="${isAi ? "#ff6b57" : "#14b8a6"}" />
                <path d="M17 31h14" stroke="${isAi ? "#15171c" : "#f7f2e8"}" stroke-width="3" stroke-linecap="round" />
              </svg>
            </div>
          `;
        })
        .join("")}
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
      const role = participant.role ? `<span class="badge">${roleLabel(participant.role)}</span>` : `<button class="ghost" data-report-participant="${participant.id}">通報</button>`;
      return `
        <div class="participant">
          ${avatar(participant.displayName)}
          <span>${escapeHtml(participant.displayName)}</span>
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
      const cls = message.kind === "SYSTEM" ? "system" : message.isBlocked ? "blocked" : "";
      const report =
        message.kind === "CHAT"
          ? `<button class="ghost" data-report-message="${message.id}" data-report-participant="${message.participantId}">通報</button>`
          : "";
      return `
        <article class="message ${cls}">
          <div class="message-head">
            <strong>${escapeHtml(message.displayName)}</strong>
            ${report}
          </div>
          <p>${escapeHtml(message.text)}</p>
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
        .map((participant) => `<option value="${participant.id}">${escapeHtml(participant.displayName)}</option>`)
        .join("")}
    </select>
  `;
}

function avatar(name) {
  return `<span class="avatar">${escapeHtml(Array.from(name)[0] ?? "?")}</span>`;
}

function phaseLabel(room) {
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

function turnHeadline(room) {
  if (!room.currentTurn) {
    return phaseLabel(room);
  }
  if (room.currentTurn.turnType === "DIRECTED_ANSWER") {
    return `${room.currentTurn.displayName} が回答`;
  }
  return `${room.currentTurn.displayName} のターン`;
}

function turnDescription(room) {
  if (room.status === "ROUND_1") {
    return `お題：${room.topicPrompt}`;
  }
  if (room.status === "ROUND_2" && room.currentTurn?.turnType === "DIRECTED_ANSWER") {
    return `${room.currentTurn.askerDisplayName} からの質問に答えます。`;
  }
  if (room.status === "ROUND_2") {
    return `相手を1人選んで、${MESSAGE_LIMIT}文字以内で質問します。入力済みでも${TURN_SECONDS}秒ちょうどで送信されます。`;
  }
  if (room.status === "ROUND_3") {
    return `AIだと思う相手と理由を${MESSAGE_LIMIT}文字以内で出します。入力済みでも${TURN_SECONDS}秒ちょうどで送信されます。`;
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

function remainingSeconds(iso) {
  if (!iso) {
    return "-";
  }
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

function updateCountdowns() {
  const seconds = remainingSeconds(state.room?.phaseEndsAt);
  const countdowns = document.querySelectorAll("[data-countdown]");
  for (const countdown of countdowns) {
    countdown.textContent = `${seconds}秒`;
  }
  updateTurnSaveButtons(seconds);
}

function updateTurnSaveButtons(seconds) {
  const buttons = document.querySelectorAll(".turn-save-button");
  if (!buttons.length) {
    return;
  }
  const endsAt = new Date(state.room?.phaseEndsAt).getTime();
  const remainingMs = Number.isFinite(endsAt) ? Math.max(0, endsAt - Date.now()) : TURN_SECONDS * 1000;
  const progress = Math.min(100, Math.max(0, (1 - remainingMs / (TURN_SECONDS * 1000)) * 100));
  const remaining = typeof seconds === "number" ? seconds : TURN_SECONDS;
  const label = `下書きを保存。残り${remaining}秒で送信されます。`;
  for (const button of buttons) {
    button.style.setProperty("--turn-progress", `${progress.toFixed(1)}%`);
    button.setAttribute("aria-label", label);
    button.title = label;
  }
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
  if (event.target.id === "targetSelect") {
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
  const messageId = button.dataset.reportMessage;
  const participantId = button.dataset.reportParticipant;
  try {
    if (action === "start") {
      await api("/api/match", { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "start-duel") {
      await api("/api/duel", { method: "POST", body: { guestToken: state.token } });
      await refresh();
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
    } else if (action === "send-round1") {
      await sendTextAction("ROUND_1_ANSWER");
    } else if (action === "send-answer") {
      await sendTextAction("DIRECTED_ANSWER");
    } else if (action === "send-question") {
      await sendTextAction("DIRECTED_QUESTION", document.querySelector("#targetSelect").value);
    } else if (action === "send-final") {
      await sendTextAction("FINAL_SUSPICION", document.querySelector("#targetSelect").value);
    } else if (action === "leave") {
      await roomAction("leave", {});
      await refresh();
    } else if (action === "play-again") {
      const nextMatchPath = state.room?.mode === "DUEL" ? "/api/duel" : "/api/match";
      await roomAction("leave", {});
      await api(nextMatchPath, { method: "POST", body: { guestToken: state.token } });
      await refresh();
    } else if (action === "copy-result") {
      await navigator.clipboard.writeText(resultShareText());
      showToast("結果をコピーしました。");
    } else if (voteTarget) {
      await roomAction("vote", { targetParticipantId: voteTarget });
    } else if (messageId || participantId) {
      const reason = prompt("通報理由を入力してください", "ルール違反");
      if (reason) {
        await roomAction("report", {
          messageId,
          targetParticipantId: participantId,
          reason
        });
        showToast("通報を受け付けました。");
      }
    }
  } catch (error) {
    showError(error);
  }
});

async function sendTextAction(actionType, targetParticipantId = null) {
  await saveDraftAction(actionType, targetParticipantId, true);
  showToast(`下書きを保存しました。${TURN_SECONDS}秒で送信されます。`);
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
    const targetParticipantId = document.querySelector("#targetSelect")?.value ?? null;
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
    return "AI人狼の試合結果";
  }
  const ai = room.participants.find((participant) => participant.id === room.result.aiParticipantId);
  const winner = room.result.winnerTeam === "HUMAN" ? "人間陣営" : "AI陣営";
  const voteThreshold = room.result.voteThreshold ?? room.voteThreshold ?? 2;
  return `AI人狼 結果：${winner}の勝利。AIは「${ai?.displayName}」。AIへの票は${room.result.aiVotes}/${voteThreshold}票でした。`;
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
