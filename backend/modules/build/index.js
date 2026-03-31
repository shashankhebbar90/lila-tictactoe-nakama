const OPCODE = {
  STATE: 1,
  MOVE: 2,
  PING: 3
};
const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];
function nowMs() {
  return Date.now();
}
function computeWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return { mark: v, line };
  }
  return null;
}
function isBoardFull(board) {
  return board.every((c) => c !== "");
}
function otherMark(mark) {
  return mark === "X" ? "O" : "X";
}
function buildPublicState(state) {
  const players = Object.values(state.players).map((p) => ({
    userId: p.userId,
    username: p.username,
    mark: p.mark,
    connected: p.connected
  }));
  return {
    board: state.board,
    players,
    turnUserId: state.turnUserId,
    status: state.status,
    winnerUserId: state.winnerUserId,
    winningLine: state.winningLine,
    moveCount: state.moveCount,
    label: state.label,
    turnDeadlineMs: state.turnDeadlineMs
  };
}
function broadcastState(dispatcher, state) {
  dispatcher.broadcastMessage(OPCODE.STATE, JSON.stringify(buildPublicState(state)), null, null, true);
}
function assignMarks(state, joiningUserId) {
  const usedMarks = new Set(Object.values(state.marksByUserId));
  const mark = usedMarks.has("X") ? "O" : "X";
  state.marksByUserId[joiningUserId] = mark;
}
function chooseFirstTurn(state) {
  var _a, _b;
  const userIds = Object.keys(state.players).sort();
  const xUser = userIds.find((u) => state.marksByUserId[u] === "X");
  state.turnUserId = xUser != null ? xUser : (_a = userIds[0]) != null ? _a : null;
  if (state.label.mode === "timed") {
    state.turnDeadlineMs = nowMs() + ((_b = state.turnTimeSec) != null ? _b : 30) * 1e3;
  } else {
    state.turnDeadlineMs = null;
  }
}
function setNextTurn(state) {
  var _a, _b;
  if (!state.turnUserId) return;
  const current = state.turnUserId;
  const currentMark = state.marksByUserId[current];
  if (!currentMark) return;
  const nextMark = otherMark(currentMark);
  const nextUser = (_a = Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === nextMark)) != null ? _a : null;
  state.turnUserId = nextUser;
  if (state.label.mode === "timed") {
    state.turnDeadlineMs = nowMs() + ((_b = state.turnTimeSec) != null ? _b : 30) * 1e3;
  } else {
    state.turnDeadlineMs = null;
  }
}
let matchInit = function(ctx, logger, nk, params) {
  const mode = (params == null ? void 0 : params.mode) === "timed" ? "timed" : "classic";
  const turnTimeSecRaw = typeof (params == null ? void 0 : params.turnTimeSec) === "number" ? params.turnTimeSec : 30;
  const turnTimeSec = mode === "timed" ? Math.max(5, Math.min(120, Math.floor(turnTimeSecRaw))) : null;
  const tickRate = 5;
  const state = {
    board: Array(9).fill(""),
    players: {},
    marksByUserId: {},
    turnUserId: null,
    status: "waiting",
    winnerUserId: null,
    winningLine: null,
    moveCount: 0,
    lastMoveAtMs: 0,
    createdAtMs: nowMs(),
    label: { open: true, mode },
    tickRate,
    turnTimeSec,
    turnDeadlineMs: null
  };
  const label = JSON.stringify(state.label);
  return { state, tickRate, label };
};
let matchJoinAttempt = function(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  if (Object.keys(state.players).length >= 2 && !state.players[presence.userId]) {
    return { state, accept: false, reason: "match full" };
  }
  if (state.status === "finished" && !state.players[presence.userId]) {
    return { state, accept: false, reason: "match finished" };
  }
  return { state, accept: true };
};
let matchJoin = function(ctx, logger, nk, dispatcher, tick, state, presences) {
  var _a;
  for (const p of presences) {
    if (!state.players[p.userId]) assignMarks(state, p.userId);
    const mark = (_a = state.marksByUserId[p.userId]) != null ? _a : "X";
    state.players[p.userId] = { userId: p.userId, username: p.username, mark, presence: p, connected: true };
  }
  const count = Object.keys(state.players).length;
  if (count >= 2 && state.status === "waiting") {
    state.status = "active";
    state.label.open = false;
    chooseFirstTurn(state);
  } else {
    state.label.open = count < 2;
  }
  broadcastState(dispatcher, state);
  return { state };
};
let matchLeave = function(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (const p of presences) {
    const existing = state.players[p.userId];
    if (existing) {
      existing.connected = false;
      existing.presence = p;
    }
  }
  if (state.status === "active") {
    const connectedUsers = Object.values(state.players).filter((pl) => pl.connected).map((pl) => pl.userId);
    if (connectedUsers.length === 1) {
      state.status = "finished";
      state.winnerUserId = connectedUsers[0];
      state.winningLine = null;
      state.turnUserId = null;
      state.label.open = false;
      state.turnDeadlineMs = null;
    }
  }
  broadcastState(dispatcher, state);
  return { state };
};
let matchLoop = function(ctx, logger, nk, dispatcher, tick, state, messages) {
  var _a, _b;
  if (state.status === "active" && state.label.mode === "timed" && state.turnUserId && state.turnDeadlineMs) {
    if (nowMs() > state.turnDeadlineMs) {
      const loser = state.turnUserId;
      const loserMark = state.marksByUserId[loser];
      const winner = (_a = loserMark && Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === otherMark(loserMark))) != null ? _a : null;
      state.status = "finished";
      state.winnerUserId = winner;
      state.winningLine = null;
      state.turnUserId = null;
      state.label.open = false;
      state.turnDeadlineMs = null;
      broadcastState(dispatcher, state);
    }
  }
  for (const m of messages) {
    if (m.opCode === OPCODE.PING) continue;
    if (m.opCode !== OPCODE.MOVE) {
      logger.info(`[MATCHLOOP] Skipping non-MOVE opCode: ${m.opCode}`);
      continue;
    }
    logger.info(`[MATCHLOOP] Received MOVE from ${m.sender.userId}`);
    logger.info(`[MATCHLOOP] Game status: ${state.status}, turnUserId: ${state.turnUserId}`);
    if (state.status !== "active") {
      logger.warn(`[MATCHLOOP] Game not active, status: ${state.status}`);
      continue;
    }
    if (!state.turnUserId) {
      logger.warn(`[MATCHLOOP] No turn user ID set`);
      continue;
    }
    if (m.sender.userId !== state.turnUserId) {
      logger.warn(`[MATCHLOOP] Wrong player. Sender: ${m.sender.userId}, Expected: ${state.turnUserId}`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(nk.binaryToString(m.data));
    } catch (e) {
      logger.warn(`[MATCHLOOP] Failed to parse payload: ${e}`);
      continue;
    }
    const index = Number(payload == null ? void 0 : payload.index);
    logger.info(`[MATCHLOOP] Move index: ${index}`);
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      logger.warn(`[MATCHLOOP] Invalid index: ${index}`);
      continue;
    }
    if (state.board[index] !== "") {
      logger.warn(`[MATCHLOOP] Cell ${index} already occupied: ${state.board[index]}`);
      continue;
    }
    const mark = state.marksByUserId[m.sender.userId];
    logger.info(`[MATCHLOOP] Player mark: ${mark}`);
    if (!mark) {
      logger.warn(`[MATCHLOOP] No mark assigned for player ${m.sender.userId}`);
      logger.info(`[MATCHLOOP] Available marks: ${JSON.stringify(state.marksByUserId)}`);
      continue;
    }
    logger.info(`[MATCHLOOP] \u2705 MOVE ACCEPTED! Placing ${mark} at index ${index}`);
    state.board[index] = mark;
    state.moveCount += 1;
    state.lastMoveAtMs = nowMs();
    const winner = computeWinner(state.board);
    if (winner) {
      state.status = "finished";
      state.winnerUserId = (_b = Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === winner.mark)) != null ? _b : null;
      state.winningLine = winner.line;
      state.turnUserId = null;
      state.turnDeadlineMs = null;
      state.label.open = false;
    } else if (isBoardFull(state.board)) {
      state.status = "finished";
      state.winnerUserId = null;
      state.winningLine = null;
      state.turnUserId = null;
      state.turnDeadlineMs = null;
      state.label.open = false;
    } else {
      setNextTurn(state);
    }
    broadcastState(dispatcher, state);
  }
  return { state };
};
let matchTerminate = function(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  return { state };
};
let matchSignal = function(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state, data: "" };
};
const RPC_CREATE_MATCH = "create-match";
function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function CreateMatchRpc(ctx, logger, nk, payload) {
  var _a;
  const req = (_a = parseJson(payload)) != null ? _a : {};
  const mode = req.mode === "timed" ? "timed" : "classic";
  const turnTimeSec = typeof req.turnTimeSec === "number" ? req.turnTimeSec : void 0;
  const matchId = nk.matchCreate("tictactoe", { mode, turnTimeSec });
  return JSON.stringify({ matchId });
}
function OnMatchmakerMatched(ctx, logger, nk) {
  const matchId = nk.matchCreate("tictactoe", { mode: "classic" });
  return matchId;
}
function beforeMatchmakerAdd(ctx, logger, nk, envelope) {
  var _a;
  if (envelope.matchmakerAdd) {
    envelope.matchmakerAdd.minCount = 2;
    envelope.matchmakerAdd.maxCount = 2;
    const mode = (_a = envelope.matchmakerAdd.stringProperties) == null ? void 0 : _a["mode"];
    if (mode !== "timed" && mode !== "classic") {
      if (!envelope.matchmakerAdd.stringProperties) envelope.matchmakerAdd.stringProperties = {};
      envelope.matchmakerAdd.stringProperties["mode"] = "classic";
    }
  }
  return envelope;
}
function InitModule(ctx, logger, nk, initializer) {
  initializer.registerMatch("tictactoe", {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchSignal,
    matchTerminate
  });
  initializer.registerRpc(RPC_CREATE_MATCH, CreateMatchRpc);
  initializer.registerMatchmakerMatched(OnMatchmakerMatched);
  initializer.registerRtBefore("MatchmakerAdd", beforeMatchmakerAdd);
  logger.info("Lila TicTacToe module loaded.");
}
!InitModule && InitModule.bind(null);
