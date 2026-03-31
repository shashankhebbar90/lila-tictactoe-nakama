/* eslint-disable @typescript-eslint/no-explicit-any */

const OPCODE = {
  STATE: 1,
  MOVE: 2,
  PING: 3,
} as const;

type Mode = "classic" | "timed";
type Mark = "X" | "O";
type GameStatus = "waiting" | "active" | "finished";

type MatchLabel = {
  open: boolean;
  mode: Mode;
};

type PlayerInfo = {
  userId: string;
  username: string;
  mark: Mark;
  presence: nkruntime.Presence;
  connected: boolean;
};

type MatchState = {
  board: (Mark | "")[];
  players: Record<string, PlayerInfo>;
  marksByUserId: Record<string, Mark>;
  turnUserId: string | null;
  status: GameStatus;
  winnerUserId: string | null;
  winningLine: number[] | null;
  moveCount: number;
  lastMoveAtMs: number;
  createdAtMs: number;
  label: MatchLabel;
  tickRate: number;
  turnTimeSec: number | null;
  turnDeadlineMs: number | null;
};

const WIN_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function nowMs(): number {
  return Date.now();
}

function computeWinner(board: (Mark | "")[]): { mark: Mark; line: number[] } | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    const v = board[a];
    if (v && v === board[b] && v === board[c]) return { mark: v, line };
  }
  return null;
}

function isBoardFull(board: (Mark | "")[]): boolean {
  return board.every((c) => c !== "");
}

function otherMark(mark: Mark): Mark {
  return mark === "X" ? "O" : "X";
}

function buildPublicState(state: MatchState) {
  const players = Object.values(state.players).map((p) => ({
    userId: p.userId,
    username: p.username,
    mark: p.mark,
    connected: p.connected,
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
    turnDeadlineMs: state.turnDeadlineMs,
  };
}

function broadcastState(dispatcher: nkruntime.MatchDispatcher, state: MatchState) {
  dispatcher.broadcastMessage(OPCODE.STATE, JSON.stringify(buildPublicState(state)), null, null, true);
}

function assignMarks(state: MatchState, joiningUserId: string): void {
  const usedMarks = new Set(Object.values(state.marksByUserId));
  const mark: Mark = usedMarks.has("X") ? "O" : "X";
  state.marksByUserId[joiningUserId] = mark;
}

function chooseFirstTurn(state: MatchState): void {
  const userIds = Object.keys(state.players).sort();
  const xUser = userIds.find((u) => state.marksByUserId[u] === "X");
  state.turnUserId = xUser ?? (userIds[0] ?? null);
  if (state.label.mode === "timed") {
    state.turnDeadlineMs = nowMs() + (state.turnTimeSec ?? 30) * 1000;
  } else {
    state.turnDeadlineMs = null;
  }
}

function setNextTurn(state: MatchState): void {
  if (!state.turnUserId) return;
  const current = state.turnUserId;
  const currentMark = state.marksByUserId[current];
  if (!currentMark) return;
  const nextMark = otherMark(currentMark);
  const nextUser = Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === nextMark) ?? null;
  state.turnUserId = nextUser;
  if (state.label.mode === "timed") {
    state.turnDeadlineMs = nowMs() + (state.turnTimeSec ?? 30) * 1000;
  } else {
    state.turnDeadlineMs = null;
  }
}

let matchInit: nkruntime.MatchInitFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: Record<string, any> | null
) {
    const mode: Mode = params?.mode === "timed" ? "timed" : "classic";
    const turnTimeSecRaw = typeof params?.turnTimeSec === "number" ? params.turnTimeSec : 30;
    const turnTimeSec = mode === "timed" ? Math.max(5, Math.min(120, Math.floor(turnTimeSecRaw))) : null;
    const tickRate = 5;

    const state: MatchState = {
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
      turnDeadlineMs: null,
    };

    const label = JSON.stringify(state.label);
    return { state, tickRate, label };
  };

let matchJoinAttempt: nkruntime.MatchJoinAttemptFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presence: nkruntime.Presence,
  metadata: Record<string, any> | null
) {
    if (Object.keys(state.players).length >= 2 && !state.players[presence.userId]) {
      return { state, accept: false, reason: "match full" };
    }
    if (state.status === "finished" && !state.players[presence.userId]) {
      return { state, accept: false, reason: "match finished" };
    }
    return { state, accept: true };
  };

let matchJoin: nkruntime.MatchJoinFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
    for (const p of presences) {
      if (!state.players[p.userId]) assignMarks(state, p.userId);
      const mark = state.marksByUserId[p.userId] ?? "X";
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

let matchLeave: nkruntime.MatchLeaveFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
) {
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

let matchLoop: nkruntime.MatchLoopFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  messages: nkruntime.MatchMessage[]
) {
    if (state.status === "active" && state.label.mode === "timed" && state.turnUserId && state.turnDeadlineMs) {
      if (nowMs() > state.turnDeadlineMs) {
        const loser = state.turnUserId;
        const loserMark = state.marksByUserId[loser];
        const winner =
          (loserMark &&
            Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === otherMark(loserMark))) ??
          null;
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

      let payload: any;
      try {
        payload = JSON.parse(nk.binaryToString(m.data));
      } catch (e) {
        logger.warn(`[MATCHLOOP] Failed to parse payload: ${e}`);
        continue;
      }

      const index = Number(payload?.index);
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

      logger.info(`[MATCHLOOP] ✅ MOVE ACCEPTED! Placing ${mark} at index ${index}`);
      state.board[index] = mark;
      state.moveCount += 1;
      state.lastMoveAtMs = nowMs();

      const winner = computeWinner(state.board);
      if (winner) {
        state.status = "finished";
        state.winnerUserId =
          Object.keys(state.marksByUserId).find((uid) => state.marksByUserId[uid] === winner.mark) ?? null;
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

let matchTerminate: nkruntime.MatchTerminateFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  graceSeconds: number
) {
    return { state };
  };

let matchSignal: nkruntime.MatchSignalFunction = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  data: string
) {
    // Not used in this implementation, but required by some Nakama versions to avoid crashes
    // during match registration/introspection.
    return { state, data: "" };
  };

const RPC_CREATE_MATCH = "create-match";

type CreateMatchPayload = {
  mode?: Mode;
  turnTimeSec?: number;
};

function parseJson<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function CreateMatchRpc(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) {
  const req = parseJson<CreateMatchPayload>(payload) ?? {};
  const mode: Mode = req.mode === "timed" ? "timed" : "classic";
  const turnTimeSec = typeof req.turnTimeSec === "number" ? req.turnTimeSec : undefined;
  const matchId = nk.matchCreate("tictactoe", { mode, turnTimeSec });
  return JSON.stringify({ matchId });
}

function OnMatchmakerMatched(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama) {
  const matchId = nk.matchCreate("tictactoe", { mode: "classic" });
  return matchId;
}

function beforeMatchmakerAdd(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.Envelope
) {
  if (envelope.matchmakerAdd) {
    envelope.matchmakerAdd.minCount = 2;
    envelope.matchmakerAdd.maxCount = 2;
    const mode = envelope.matchmakerAdd.stringProperties?.["mode"];
    if (mode !== "timed" && mode !== "classic") {
      if (!envelope.matchmakerAdd.stringProperties) envelope.matchmakerAdd.stringProperties = {};
      envelope.matchmakerAdd.stringProperties["mode"] = "classic";
    }
  }
  return envelope;
}

function InitModule(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, initializer: nkruntime.Initializer) {
  initializer.registerMatch("tictactoe", {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchSignal,
    matchTerminate,
  });
  initializer.registerRpc(RPC_CREATE_MATCH, CreateMatchRpc);
  initializer.registerMatchmakerMatched(OnMatchmakerMatched);
  initializer.registerRtBefore("MatchmakerAdd", beforeMatchmakerAdd);
  logger.info("Lila TicTacToe module loaded.");
}

// Reference InitModule so build tools don't remove it
!InitModule && InitModule.bind(null);

