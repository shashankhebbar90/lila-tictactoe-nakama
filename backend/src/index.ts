import { createTicTacToeMatch } from "./tictactoe";

type CreateMatchPayload = {
  mode?: "classic" | "timed";
  turnTimeSec?: number;
};

const RPC_CREATE_MATCH = "create-match";

function parseJson<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

const CreateMatchRpc: nkruntime.RpcFunction = (ctx, logger, nk, payload) => {
  const req = parseJson<CreateMatchPayload>(payload) ?? {};
  const mode = req.mode === "timed" ? "timed" : "classic";
  const turnTimeSec = typeof req.turnTimeSec === "number" ? req.turnTimeSec : undefined;

  const matchId = nk.matchCreate("tictactoe", { mode, turnTimeSec });
  return JSON.stringify({ matchId });
};

const OnMatchmakerMatched: nkruntime.MatchmakerMatchedFunction = (ctx, logger, nk, matches) => {
  // This callback is invoked when the matchmaker finds a set of users.
  // Create a fresh authoritative match instance and return its matchId.
  const matchId = nk.matchCreate("tictactoe", { mode: "classic" });
  return matchId;
};

const beforeMatchmakerAdd: nkruntime.RtBeforeHookFunction = (ctx, logger, nk, envelope) => {
  // Ensure clients can't bypass server expectations. We keep it simple:
  // - Force min/max to 2 for TicTacToe.
  // - Allow optional "mode" stringProperty.
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
};

function validateEnv(logger: nkruntime.Logger, nk: nkruntime.Nakama) {
  try {
    // no-op placeholder: keeps a spot for future config checks
    nk.time();
  } catch (e) {
    logger.warn("runtime sanity check failed: %v", e);
  }
}

const InitModule: nkruntime.InitModule = (ctx, logger, nk, initializer) => {
  validateEnv(logger, nk);

  initializer.registerMatch("tictactoe", createTicTacToeMatch());
  initializer.registerRpc(RPC_CREATE_MATCH, CreateMatchRpc);
  initializer.registerMatchmakerMatched(OnMatchmakerMatched);
  initializer.registerRtBefore("MatchmakerAdd", beforeMatchmakerAdd);

  logger.info("Lila TicTacToe module loaded.");
};

export { InitModule };

