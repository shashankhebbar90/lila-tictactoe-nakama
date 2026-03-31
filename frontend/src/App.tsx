import { useEffect, useMemo, useRef, useState } from "react";
import { Client } from "@heroiclabs/nakama-js";
import type { Match, MatchData, MatchmakerTicket, Session, Socket } from "@heroiclabs/nakama-js";
import "./App.css";

type Mode = "classic" | "timed";
type Mark = "X" | "O";
const CLIENT_MODE: Mode = "classic";

const OPCODE = {
  STATE: 1,
  MOVE: 2,
  PING: 3,
} as const;

type PublicPlayer = { userId: string; username: string; mark: Mark; connected: boolean };
type PublicState = {
  board: (Mark | "")[];
  players: PublicPlayer[];
  turnUserId: string | null;
  status: "waiting" | "active" | "finished";
  winnerUserId: string | null;
  winningLine: number[] | null;
  moveCount: number;
  label: { open: boolean; mode: Mode };
  turnDeadlineMs: number | null;
};

type Room = { matchId: string; label: { open: boolean; mode: Mode } | null; size: number };
type LeaderboardRow = { username: string; isMe: boolean; wld: string; score: number };

function shortId(id: string) {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function formatMsLeft(deadlineMs: number | null) {
  if (!deadlineMs) return null;
  const left = Math.max(0, deadlineMs - Date.now());
  return Math.ceil(left / 1000);
}

function normalizeBoard(raw: unknown): (Mark | "")[] {
  if (Array.isArray(raw)) {
    return Array.from({ length: 9 }, (_, i) => {
      const c = raw[i];
      return c === "X" || c === "O" ? c : "";
    });
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return Array.from({ length: 9 }, (_, i) => {
      const c = o[String(i)];
      return c === "X" || c === "O" ? c : "";
    });
  }
  return ["", "", "", "", "", "", "", "", ""];
}

function normalizeWinLine(raw: unknown): number[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  return raw.map((n) => Number(n));
}

const API_HOST = "lila-tictactoe-nakama-production.up.railway.app";
const API_PORT = "";
const USE_SSL = true;
const SERVER_KEY = "defaultkey";

function App() {
  const client = useMemo(() => new Client(SERVER_KEY, API_HOST, API_PORT, USE_SSL), []);
  const socketRef = useRef<Socket | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [username, setUsername] = useState<string>(() => {
    const saved = localStorage.getItem("ttt.username");
    return saved ?? `player_${Math.floor(Math.random() * 10000)}`;
  });
  const [deviceId] = useState<string>(() => {
    const saved = localStorage.getItem("ttt.deviceId");
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem("ttt.deviceId", id);
    return id;
  });

  const [statusText, setStatusText] = useState<string>("Not connected");
  const [socketReady, setSocketReady] = useState<boolean>(false);
  const [rooms, setRooms] = useState<Array<Room>>([]);
  const [match, setMatch] = useState<Match | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [ticket, setTicket] = useState<MatchmakerTicket | null>(null);

  useEffect(() => {
    localStorage.setItem("ttt.username", username);
  }, [username]);

  async function connect() {
    const desiredUsername = username.trim();
    if (!desiredUsername) return;
    if (desiredUsername !== username) setUsername(desiredUsername);

    setStatusText("Authenticating…");
    const s = await client.authenticateDevice(deviceId, true, desiredUsername);
    try {
      await client.updateAccount(s, { username: desiredUsername });
    } catch (error) {
      console.error("Failed to update username:", error);
    }
    setSession(s);

    setStatusText("Opening realtime socket…");
    setSocketReady(false);
    const sock = client.createSocket(USE_SSL, false);
    socketRef.current = sock;

    sock.ondisconnect = () => {
      setSocketReady(false);
      setStatusText("Socket disconnected");
    };

    sock.onerror = (error) => {
      console.error("Socket error:", error);
      setSocketReady(false);
      setStatusText("Socket error");
    };

    sock.onmatchdata = (md: MatchData) => {
      if (md.op_code !== OPCODE.STATE) return;
      try {
        const next = JSON.parse(new TextDecoder().decode(md.data)) as PublicState;
        setState({
          ...next,
          board: normalizeBoard(next.board as unknown),
          winningLine: normalizeWinLine(next.winningLine),
        });
      } catch (err) {
        console.error("Error parsing state update:", err);
      }
    };

    sock.onmatchmakermatched = async (mm) => {
      setTicket(null);
      setStatusText("Match found. Joining…");
      const m = await sock.joinMatch(mm.match_id);
      setMatch(m);
      setStatusText("In match");
    };

    try {
      await sock.connect(s, true);
      setSocketReady(true);
      setStatusText("Connected");
      await refreshRooms(s);
    } catch (error) {
      console.error("Failed to connect socket:", error);
      setStatusText("Connection failed");
      setSocketReady(false);
    }
  }

  async function disconnect() {
    setTicket(null);
    setMatch(null);
    setState(null);
    setRooms([]);
    if (socketRef.current) {
      try {
        await socketRef.current.disconnect(false);
      } catch {
        // ignore
      }
    }
    socketRef.current = null;
    setSocketReady(false);
    setSession(null);
    setStatusText("Disconnected");
  }

  async function refreshRooms(s: Session) {
    let res = await client.listMatches(s, 20, true, "", 0, 1, "+label.open:1 +label.mode:classic");
    let rows = res.matches ?? [];
    if (rows.length === 0) {
      res = await client.listMatches(s, 20, true, "", 0, 2, "+label.open:1 +label.mode:classic");
      rows = res.matches ?? [];
    }
    const mapped = rows
      .filter((m) => m.match_id && m.size !== undefined)
      .map((m) => ({
        matchId: m.match_id!,
        label: m.label ? safeJson(m.label) : null,
        size: m.size!,
      }))
      .filter((r) => {
        const o = r.label?.open;
        return o === 1 || o === true;
      })
      .filter((r) => r.matchId !== undefined && r.size !== undefined);
    setRooms(mapped as { matchId: string; label: any; size: number }[]);
  }

  function safeJson(s: string) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }

  async function createRoom() {
    if (!session) return;
    const sock = socketRef.current;
    if (!sock) return;
    setStatusText("Creating room…");
    try {
      const payload = { mode: CLIENT_MODE };
      const res = await client.rpc(session, "create-match", payload);
      const { matchId } = res.payload as { matchId: string };
      const m = await sock.joinMatch(matchId);
      setMatch(m);
      setStatusText("Room created");
      await refreshRooms(session);
    } catch (e) {
      console.error(e);
      setStatusText(e instanceof Error ? e.message : "Create room failed");
    }
  }

  async function joinRoom(matchId: string) {
    if (!session) return;
    const sock = socketRef.current;
    if (!sock) return;
    setStatusText("Joining room…");
    const m = await sock.joinMatch(matchId);
    setMatch(m);
    setStatusText("In match");
  }

  async function leaveMatch() {
    if (!match) return;
    const sock = socketRef.current;
    if (!sock) return;
    try {
      await sock.leaveMatch(match.match_id);
    } catch {
      // ignore
    }
    setMatch(null);
    setState(null);
    setStatusText("Left match");
    if (session) await refreshRooms(session);
  }

  async function findMatch() {
    if (!session) return;
    const sock = socketRef.current;
    if (!sock) return;
    if (ticket) return;
    setStatusText("Searching…");
    const t = await sock.addMatchmaker("*", 2, 2, { mode: CLIENT_MODE }, {});
    setTicket(t);
    setStatusText("In matchmaking queue");
  }

  async function cancelFindMatch() {
    if (!ticket) return;
    const sock = socketRef.current;
    if (!sock) return;
    try {
      await sock.removeMatchmaker(ticket.ticket);
    } catch {
      // ignore
    }
    setTicket(null);
    setStatusText("Matchmaking cancelled");
  }

  async function play(index: number) {
    if (!match || !state || !socketRef.current || !socketReady || !isMyTurn) return;
    try {
      await socketRef.current.sendMatchState(match.match_id, OPCODE.MOVE, JSON.stringify({ index }));
    } catch {
      // ignore
    }
  }

  const me = session?.user_id ?? null;
  const secondsLeft = state?.turnDeadlineMs ? formatMsLeft(state.turnDeadlineMs) : null;
  const isMyTurn = !!(state && me && state.turnUserId === me && state.status === "active");
  const oppPlayer = state?.players.find((p) => p.userId !== me) ?? null;
  const winnerPlayer = state?.winnerUserId ? state.players.find((p) => p.userId === state.winnerUserId) : null;
  const winnerName = winnerPlayer?.username ?? (state?.winnerUserId ? shortId(state.winnerUserId) : "Draw");
  const leaderboardRows: LeaderboardRow[] = state
    ? state.players
        .map((p) => {
          const isDraw = state.winnerUserId === null;
          const isWinner = state.winnerUserId === p.userId;
          const wins = isWinner ? 1 : 0;
          const draws = isDraw ? 1 : 0;
          const losses = !isWinner && !isDraw ? 1 : 0;
          // Simple deterministic scoring for current match.
          const score = wins * 100 + draws * 50;
          return {
            username: p.username || shortId(p.userId),
            isMe: p.userId === me,
            wld: `${wins}/${losses}/${draws}`,
            score,
          };
        })
        .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
    : [];

  return (
    <div className="page">
      <div className="phoneShell">
        {!session ? (
          <section className="screen screen-dark">
            <div className="prompt">Who are you?</div>
            <div className="inputRow">
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Nickname" />
              <button className="primary" onClick={connect} disabled={!username.trim()}>
                Continue
              </button>
            </div>
            <p className="hint">{statusText}</p>
          </section>
        ) : ticket && !match ? (
          <section className="screen screen-dark center">
            <h2 className="findingTitle">Finding a random player...</h2>
            <p className="hint">It usually takes 2-10 seconds.</p>
            <button className="ghostBtn" onClick={cancelFindMatch}>
              Cancel
            </button>
          </section>
        ) : match && state ? (
          state.status === "finished" ? (
            <section className="screen screen-dark winnerScreen">
              <div className="winnerMark">✕</div>
              <div className="winnerText">WINNER! {winnerName}</div>
              <div className="leaderTitle">Leaderboard</div>
              <div className="leaderHead">
                <span>Player (W/L/D)</span>
                <span>Score</span>
              </div>
              {leaderboardRows.map((row, idx) => (
                <div className="leaderRow" key={`${row.username}-${idx}`}>
                  <span>
                    {idx + 1}. {row.username}
                    {row.isMe ? " (you)" : ""}
                    {" "}
                    [{row.wld}]
                  </span>
                  <span>{row.score}</span>
                </div>
              ))}
              <button className="ghostBtn" onClick={leaveMatch}>
                Play Again
              </button>
            </section>
          ) : (
            <section className="screen screen-teal">
              <div className="duo">
                <div>
                  <div className="duoName">{username}</div>
                  <div className="duoSub">(you)</div>
                </div>
                <div>
                  <div className="duoName">{oppPlayer?.username ?? "Waiting..."}</div>
                  <div className="duoSub">(opp)</div>
                </div>
              </div>
              <div className="turnText">
                {isMyTurn ? "Your Turn" : "Opponent Turn"} {secondsLeft !== null ? `• ${secondsLeft}s` : ""}
              </div>
              <Board board={state.board} winningLine={state.winningLine} disabled={!isMyTurn} onCellClick={play} />
              <button className="ghostBtn tealBtn" onClick={leaveMatch}>
                Leave Match
              </button>
            </section>
          )
        ) : (
          <section className="screen screen-dark">
            <h2 className="lobbyTitle">Multiplayer Lobby</h2>
            <div className="row">
              <button className="primary" onClick={findMatch} disabled={!!match || !!ticket}>
                Play Random
              </button>
              <button onClick={createRoom} disabled={!!match || !!ticket}>
                Create Room
              </button>
              <button onClick={disconnect}>Logout</button>
            </div>
            <div className="roomsWrap">
              <div className="hint">Open rooms</div>
              {rooms.length === 0 ? (
                <p className="hint">No open rooms right now.</p>
              ) : (
                <ul className="rooms">
                  {rooms.map((r) => (
                    <li key={r.matchId}>
                      <div className="roomMeta">
                        <div className="roomId">{shortId(r.matchId)}</div>
                        <div className="muted">size {r.size}</div>
                      </div>
                      <button onClick={() => joinRoom(r.matchId)}>Join</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Board({
  board,
  winningLine,
  disabled,
  onCellClick,
}: {
  board: (Mark | "")[];
  winningLine: number[] | null;
  disabled: boolean;
  onCellClick: (index: number) => void;
}) {
  const win = new Set(winningLine ?? []);

  return (
    <div className="board" aria-disabled={disabled}>
      {board.map((cell, idx) => {
        const isWin = win.has(idx);
        const cellDisabled = disabled || cell !== "";
        return (
          <button
            key={idx}
            className={`cell ${isWin ? "win" : ""} ${cellDisabled ? "cell-disabled" : ""}`}
            disabled={cellDisabled}
            onClick={() => {
              if (!cellDisabled) onCellClick(idx);
            }}
            aria-label={`cell ${idx}`}
          >
            {cell}
          </button>
        );
      })}
    </div>
  );
}

export default App;

