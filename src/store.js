export const store = {
  users: new Map(),
  tokens: new Map(),
  queue: [],
  pretenderQueue: [],
  duelQueue: [],
  rooms: new Map(),
  reports: [],
  timers: new Set()
};

export function emptyStats(userId) {
  return {
    userId,
    gamesPlayed: 0,
    gamesWon: 0,
    winRate: 0,
    citizenGames: 0,
    citizenWins: 0,
    citizenWinRate: 0,
    correctAIVotes: 0,
    collaboratorGames: 0,
    collaboratorWins: 0,
    collaboratorWinRate: 0,
    disconnects: 0,
    reportsReceived: 0
  };
}

export function clearRegisteredTimers() {
  for (const timer of store.timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  store.timers.clear();
}

export function resetStore() {
  clearRegisteredTimers();
  store.users.clear();
  store.tokens.clear();
  store.queue.splice(0, store.queue.length);
  store.pretenderQueue.splice(0, store.pretenderQueue.length);
  store.duelQueue.splice(0, store.duelQueue.length);
  store.rooms.clear();
  store.reports.splice(0, store.reports.length);
}
