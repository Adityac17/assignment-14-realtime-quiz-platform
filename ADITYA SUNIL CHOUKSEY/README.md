# Live Quiz Battle — Real-Time Multiplayer Quiz (Kahoot/Quizizz-style)

A real-time, multiplayer live quiz game built with **Node.js + Express + Socket.io**.
One player hosts a room and gets a **4-digit PIN**; others join on their phones,
answer with a **classic 4-color button grid**, and race for the top of a live
**leaderboard**. Scoring rewards both **correctness and speed**, and the server
is **fully authoritative** for timing and scoring (anti-cheat).

> Assignment 14 · Author: **Aditya S Chouksey**

---

## Tech Stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Runtime    | Node.js                                            |
| HTTP server| Express 4                                          |
| Realtime   | Socket.io 4                                        |
| Middleware | cors, dotenv                                       |
| Dev        | nodemon (auto-reload), socket.io-client (tests)    |
| Frontend   | Vanilla HTML/CSS/JS (no build step), Socket.io CDN served from `/socket.io/socket.io.js` |

---

## Features

- **Host/Player portal** with dedicated host console and mobile-friendly player screen.
- **4-digit PIN** rooms; unique, collision-checked PIN generation.
- **Live lobby roster** that updates as players join/leave.
- **15-second server-timed rounds** with a synced countdown on every screen.
- **Kahoot-style color grid** (red triangle / blue diamond / yellow circle / green square).
- **Speed-based scoring** — faster correct answers score higher (max 1000).
- **Server-authoritative anti-cheat**:
  - `correctOption` is **never** sent to clients before the reveal.
  - Elapsed time is measured from the server's own `questionStartTime`.
  - Late answers (past the 15s window) are **rejected**, not scored.
  - Client-reported `timeTakenMs` is trusted only if `<= server elapsed`, else clamped.
- **Reveal phase** with the correct answer + explanation.
- **Live leaderboard** between rounds and a **final winner screen**.
- **Graceful disconnects**: players are removed and the roster/leaderboard refresh;
  if the host disconnects, the room ends gracefully for everyone.

---

## Project Structure

```
assignment-14-quiz-socket/
├── public/
│   ├── index.html        # Host/Player entry portal
│   ├── host.html         # Host control screen (PIN, lobby, live question, leaderboard, winner)
│   ├── player.html       # Mobile-friendly 4-color answer grid
│   └── app.js            # Shared client Socket.io connection + DOM helpers
├── data/
│   └── questions.json    # Question bank (7 questions, correctOption + explanation)
├── sockets/
│   ├── gameEngine.js     # Timers, round transitions, scoring, leaderboard sorting, anti-cheat eval
│   └── lobbyHandler.js   # PIN generation, room creation, player join/leave
├── test/
│   ├── gameEngine.test.js  # Unit tests (scoring, anti-cheat eval, leaderboard sort)
│   └── integration.test.js # End-to-end socket flow with socket.io-client
├── server.js             # Express + Socket.io wiring, authoritative game state
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

**Client-code choice:** `public/app.js` holds the shared connection factory and
small DOM helpers; each page (`host.html`, `player.html`) keeps its own
page-specific UI logic **inline**. The screens are small and self-contained, so
this avoids a build step while keeping shared logic in one place.

---

## Install & Run

```bash
cd assignment-14-quiz-socket
npm install

# Development (auto-reload):
npm run dev
# Production style:
npm start
```

Then open **http://localhost:5000** in your browser.

### ⚠️ macOS AirPlay port note

On macOS, **port 5000 is often occupied by the AirPlay Receiver** (it answers
with `HTTP 403`). If the app doesn't load on 5000, either:

- disable **System Settings → General → AirDrop & Handoff → AirPlay Receiver**, or
- run on another port:

```bash
PORT=5050 npm run dev     # then open http://localhost:5050
```

The port is configurable via the `PORT` environment variable (see `.env.example`).

---

## How to Test with 3 Tabs (1 Host + 2 Players)

1. Start the server (`npm run dev`) and open **3 browser tabs** at the app URL.
2. **Tab 1 (Host):** open `/host.html` → enter a name → **Create Quiz Room**.
   A big **PIN** appears.
3. **Tabs 2 & 3 (Players):** open `/player.html` → enter the **PIN** + a nickname → **Join**.
   The host's lobby roster updates live.
4. On the host tab, click **Start Game**. Each round:
   - all screens show the question + a 15s countdown,
   - players tap a colored button (answer locks in),
   - the host sees the answered count,
   - when time is up (or everyone answered), the correct answer + explanation reveal,
   - the leaderboard updates.
5. After the last question, the **winner screen** shows the champion and final ranks.

> Tip: answer faster on one player tab than the other to see the speed bonus in action.

---

## Socket Event Protocol

### Client → Server

| Event           | Sender | Payload                                        | Description |
| --------------- | ------ | ---------------------------------------------- | ----------- |
| `quiz:create`   | Host   | `{ hostName, category }`                       | Create a room; server replies `quiz:created`. |
| `quiz:join`     | Player | `{ pin, playerName }`                           | Join a room (validates PIN + lobby phase + unique name). |
| `quiz:start`    | Host   | `{ pin }`                                       | Host-only; begins the question sequence. |
| `answer:submit` | Player | `{ pin, selectedOption, timeTakenMs }`          | Submit an answer; server validates timing & scores it. |
| `quiz:next`     | Host   | `{ pin }`                                       | Host control: force reveal, or advance to the next question. |

### Server → Room / Client

| Event                | Target      | Payload                                                              | Description |
| -------------------- | ----------- | ------------------------------------------------------------------- | ----------- |
| `quiz:created`       | Host        | `{ pin, roomId }`                                                    | Room created. |
| `quiz:joined`        | Player      | `{ pin, roomId, category, hostName }`                               | Join accepted. |
| `quiz:error`         | Client      | `{ message }`                                                        | Bad PIN, game already started, not host, etc. |
| `lobby:update`       | Room        | `{ players: [{ name, score }] }`                                    | Roster changed (join/leave). |
| `question:start`     | Room        | `{ questionIndex, totalQuestions, question, options, timeLimitSeconds }` | New round. **Omits `correctOption`** (anti-cheat). |
| `answer:ack`         | Player      | `{ received, pointsEarned }`                                        | Answer accepted (provisional points; correctness not revealed yet). |
| `answer:rejected`    | Player      | `{ reason, message }`                                               | Answer past the time window — not counted. |
| `answer:count`       | Host        | `{ answered, total }`                                               | Live "N of M answered" for the host. |
| `question:time_up`   | Room        | `{ correctOption, explanation }`                                   | Reveal (timer expired or all answered). |
| `leaderboard:update` | Room        | `{ leaderboard: [{ rank, name, score }] }`                        | Sorted desc after each round. |
| `quiz:ended`         | Room        | `{ winner: { name, score }, finalRanks: [...] }`                  | After the last question. |
| `quiz:aborted`       | Room        | `{ message }`                                                       | Host disconnected; room ended. |

---

## Scoring Algorithm

Implemented **server-side** in `sockets/gameEngine.js`:

```js
function calculateScore(isCorrect, timeTakenMs, totalTimeLimitMs = 15000) {
  if (!isCorrect) return 0;
  const timeRemaining = Math.max(0, totalTimeLimitMs - timeTakenMs);
  const speedBonus = Math.round((timeRemaining / totalTimeLimitMs) * 500);
  const baseScore = 500;
  return baseScore + speedBonus; // max 1000
}
```

- **Correct** = 500 base points + a **speed bonus** up to 500 (so **max 1000**).
- **Faster correct answers score higher** (more time remaining → bigger bonus).
- **Wrong** = 0.
- **Late** (at/after the limit) = **rejected** and scored 0 (never reaches this function).

Example: at a 15s limit, a correct answer in 0ms → 1000; in 7.5s → 750; in 15s → 500 (but by
then the round has ended, so this is the reveal boundary).

---

## Anti-Cheat (Server-Authoritative Timing)

The client is never trusted for correctness or timing:

1. **No answer leak** — `question:start` deliberately excludes `correctOption`;
   the correct answer is only sent at reveal in `question:time_up`.
2. **Server clock** — the server records `questionStartTime = Date.now()` when it
   emits `question:start` and computes `elapsed = now - questionStartTime` on every
   `answer:submit`.
3. **Window enforcement** — if `elapsed >= 15000ms`, the answer is **rejected**
   (`answer:rejected`) and not scored.
4. **Client-time clamping** — the client sends `timeTakenMs`, but the server uses it
   **only if `timeTakenMs <= server elapsed`**; otherwise it clamps to the server value.
   This prevents a client from claiming an impossibly slow (or inconsistent) time to
   game the bonus in its favor.
5. **One answer per round** — `hasAnswered` is enforced server-side.

This logic lives in `evaluateAnswer()` in `gameEngine.js` and is covered by unit tests.

---

## Testing

Run everything:

```bash
npm test
```

### Unit tests — `test/gameEngine.test.js` (13 checks)
- `calculateScore`: correct+fast **>** correct+slow; wrong = 0; boundary
  (`timeTaken >= limit` → 0 speed bonus / base only); instant = 1000; mid-time proportional.
- `evaluateAnswer` anti-cheat: rejects late answers; clamps client time larger than
  server elapsed; trusts client time `<=` server elapsed; wrong = 0.
- `buildLeaderboard`: sorts by score desc with correct 1-based ranks; stable tie-break.

### Integration test — `test/integration.test.js` (9 checks)
Uses a real Socket.io server + `socket.io-client`:
- host creates a room (4-digit PIN),
- **2 players join** → `lobby:update` reflects both,
- bad PIN → `quiz:error`,
- host starts → `question:start` received **without `correctOption`**,
- **player A answers fast, player B answers slow → A's score > B's** after `leaderboard:update`,
- an answer submitted **after the time window is rejected**,
- `quiz:ended` emits a **winner** who is the overall top scorer.

> The integration test uses two safe test hooks via env vars —
> `QUIZ_TIME_LIMIT_MS` (short round) and `QUIZ_DISABLE_AUTO_TIMER` (manual round
> advance) — purely to make timing deterministic. They are never used in normal
> operation.

**Latest run:** 13/13 unit + 9/9 integration passing; server boots and serves
`GET /` (200) and `/socket.io/socket.io.js` (200).

---

## Design Choices & Assumptions

- **In-memory state** — rooms live in a `Map` keyed by PIN. No database, per the
  assignment's "authoritative in-memory game-state engine" requirement. State resets
  on restart.
- **Category** — the host can name their session; the question bank is a single shared
  set (`data/questions.json`, 7 tech/general questions). The host's category is used as
  a display label.
- **Host-driven pacing** — after a reveal the host clicks **Next** to advance. Rounds
  also auto-reveal when the 15s timer expires or when all players have answered.
- **Unique nicknames** per room (case-insensitive) so the leaderboard is unambiguous.
- **Leaderboard tie-break** — equal scores are ordered alphabetically for stable ranks.
- **No build step** — plain static assets served by Express; Socket.io client is loaded
  from the server-provided `/socket.io/socket.io.js`.
- **Port 5000** default with `PORT` override, documented for the macOS AirPlay conflict.

---

## Author

**Aditya S Chouksey**
