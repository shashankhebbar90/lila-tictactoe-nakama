# Lila Multiplayer Tic-Tac-Toe (Nakama)

A server-authoritative multiplayer Tic-Tac-Toe game built using Nakama, featuring real-time gameplay, matchmaking, and secure server-side validation.

##  Live Demo

- **Frontend:** https://lila-tictactoe-orcin.vercel.app/
- **Backend (Nakama):** https://lila-tictactoe-nakama-production.up.railway.app/
- **GitHub Repo:** https://github.com/shashankhebbar90/lila-tictactoe-nakama


##  Tech Stack

### Backend
- Nakama (TypeScript runtime)

###  Frontend
- React + Vite + TypeScript

### Database
- PostgreSQL

### Infrastructure
- Docker

## Project Overview
This project demonstrates a production-style multiplayer game architecture where all game logic is handled on the server to prevent cheating and ensure consistency.

### Key Highlights:
- Real-time multiplayer using WebSockets
- Server-authoritative game logic (anti-cheat)
- Matchmaking and custom room system
- Graceful player disconnection handling


##  Setup and installation

### Prerequisites
- Docker Desktop
- Node.js 18+ (20+ recommended)

### Install and build backend runtime
```bash
cd backend
npm install
npm run build
```

This generates the Nakama runtime bundle at:
- `backend/modules/build/index.js`

### Start Nakama and Postgres
```bash
cd ..
docker compose up -d
```

### Run frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend runs at Vite local URL (typically `http://localhost:5173`).

## Architecture and design decisions

- **Server-authoritative game loop**: all move validation and state transitions happen in Nakama match handler (`backend/src/tictactoe.ts`).
- **Client sends intent only**: frontend sends `{ index }` with `OPCODE.MOVE`; server validates and broadcasts full public state with `OPCODE.STATE`.
- **Matchmaking + custom room flows**:
  - Quick play via Nakama matchmaker (`addMatchmaker`)
  - Manual room creation via RPC `create-match`
  - Room discovery via `listMatches` and join via `joinMatch`
- **Disconnection handling**: if one active player disconnects, server marks game finished and awards forfeit win to the remaining connected player.

##  API/server configuration details

### Nakama runtime registrations
Defined in `backend/src/index.ts`:
- Match handler: `registerMatch("tictactoe", ...)`
- RPC: `registerRpc("create-match", ...)`
- Matchmaker callback: `registerMatchmakerMatched(...)`
- RT before-hook: `registerRtBefore("MatchmakerAdd", ...)` (forces valid 2-player queue settings)

### Opcodes
- `STATE = 1`
- `MOVE = 2`
- `PING = 3`

Defined in `backend/src/opcodes.ts` and used by frontend/backend.

### Local endpoints
- API: `http://127.0.0.1:7350`
- Realtime WebSocket: `ws://127.0.0.1:7352`
- Server key: `defaultkey`

Configured in:
- `backend/config/config.yml`
- `frontend/src/App.tsx`

##  Deployment process documentation

Current repository is prepared for local development and is cloud-deployable with the same container setup:

1. Provision VM/container host (AWS/GCP/Azure/DigitalOcean).
2. Copy project and run backend build:
   - `cd backend && npm ci && npm run build`
3. Start services:
   - `docker compose up -d`
4. Open firewall/security group ports:
   - `7350` (HTTP API)
   - `7352` (Realtime WebSocket)
5. Update frontend host/port in `frontend/src/App.tsx` (`API_HOST`, `API_PORT`, `USE_SSL`) to public Nakama endpoint.
6. Build and deploy frontend:
   - `cd frontend && npm ci && npm run build`
   - serve `frontend/dist` via static hosting (Nginx, Vercel, Netlify, etc.)

##  How to test multiplayer functionality

1. Open two browser windows (or one regular + one incognito).
2. Enter different usernames and connect both clients.
3. Flow A (matchmaker):
   - Click `Play Random` in both clients.
   - Verify both users join same match and receive real-time board updates.
4. Flow B (room):
   - Client A creates room.
   - Client B joins from `Open rooms`.
5. Validate server-authoritative behavior:
   - Try clicking out of turn; board should not change.
   - Try selecting an occupied cell; move should be ignored.
6. Validate disconnect behavior:
   - Close one client during active match.
   - Remaining player should receive finished state/win.
