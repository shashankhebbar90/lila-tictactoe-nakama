import { OPCODE } from "./opcodes";

type Mark = "X" | "O";
type GameStatus = "waiting" | "active" | "finished";

export interface MatchLabel {
  open: boolean;
  mode: "classic" | "timed";
}

export interface PlayerInfo {
  userId: string;
  username: string;
  mark: Mark;
  presence: nkruntime.Presence;
  connected: boolean;
}

export interface MatchState {
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
}

const WIN_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
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

function broadcastState(
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  state: MatchState
) {
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

export function createTicTacToeMatch(): nkruntime.MatchHandler<MatchState> {
  return {
    matchInit: (ctx, logger, nk, params) => {
      const mode = (params?.mode === "timed" ? "timed" : "classic") as MatchLabel["mode"];
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
        turnDeadlineMs: null
      };

      const label = JSON.stringify(state.label);
      return { state, tickRate, label };
    },

    matchJoinAttempt: (ctx, logger, nk, dispatcher, tick, state, presence, metadata) => {
      if (Object.keys(state.players).length >= 2 && !state.players[presence.userId]) {
        return { state, accept: false, reason: "match full" };
      }
      if (state.status === "finished" && !state.players[presence.userId]) {
        return { state, accept: false, reason: "match finished" };
      }
      return { state, accept: true };
    },

    matchJoin: (ctx, logger, nk, dispatcher, tick, state, presences) => {
      for (const p of presences) {
        if (!state.players[p.userId]) {
          assignMarks(state, p.userId);
        }

        const mark = state.marksByUserId[p.userId] ?? "X";
        state.players[p.userId] = {
          userId: p.userId,
          username: p.username,
          mark,
          presence: p,
          connected: true
        };
      }

      const count = Object.keys(state.players).length;
      if (count >= 2 && state.status === "waiting") {
        state.status = "active";
        state.label.open = false;
        chooseFirstTurn(state);
      } else {
        state.label.open = count < 2;
      }

      broadcastState(nk, dispatcher, state);
      return { state };
    },

    matchLeave: (ctx, logger, nk, dispatcher, tick, state, presences) => {
      for (const p of presences) {
        const existing = state.players[p.userId];
        if (existing) {
          existing.connected = false;
          existing.presence = p;
        }
      }

      // If game is active and someone leaves, forfeit.
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

      broadcastState(nk, dispatcher, state);
      return { state };
    },

    matchLoop: (ctx, logger, nk, dispatcher, tick, state, messages) => {
      // Timed mode: auto-forfeit on timeout.
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
          broadcastState(nk, dispatcher, state);
        }
      }

      for (const m of messages) {
        if (m.opCode === OPCODE.PING) continue;

        if (m.opCode !== OPCODE.MOVE) continue;
        if (state.status !== "active") continue;
        if (!state.turnUserId) continue;
        if (m.sender.userId !== state.turnUserId) continue;

        let payload: any;
        try {
          payload = JSON.parse(nk.binaryToString(m.data));
        } catch {
          continue;
        }
        const index = Number(payload?.index);
        if (!Number.isInteger(index) || index < 0 || index > 8) continue;
        if (state.board[index] !== "") continue;

        const mark = state.marksByUserId[m.sender.userId];
        if (!mark) continue;

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
          state.winnerUserId = null; // draw
          state.winningLine = null;
          state.turnUserId = null;
          state.turnDeadlineMs = null;
          state.label.open = false;
        } else {
          setNextTurn(state);
        }

        broadcastState(nk, dispatcher, state);
      }

      return { state };
    },

    matchTerminate: (ctx, logger, nk, dispatcher, tick, state, graceSeconds) => {
      return { state };
    }
  };
}

