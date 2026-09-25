'use strict';

/**
 * Integration test — real Socket.io server + socket.io-client.
 *
 * Flow:
 *   1. Host creates a room (quiz:created -> PIN).
 *   2. Two players join; lobby:update reflects both.
 *   3. Host starts; question:start is received WITHOUT correctOption (anti-cheat).
 *   4. Player A answers fast, Player B answers slow -> A's score > B's.
 *   5. A late answer (past the time window) is rejected.
 *   6. quiz:ended emits a winner.
 *
 * A short time limit + the QUIZ_DISABLE_AUTO_TIMER hook make timing
 * deterministic: rounds advance only when the host sends quiz:next.
 */

// Configure the server BEFORE requiring it (values read at module load).
process.env.PORT = process.env.TEST_PORT || '5199';
process.env.QUIZ_TIME_LIMIT_MS = '800';
process.env.QUIZ_DISABLE_AUTO_TIMER = '1';

const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server } = require('../server');

const PORT = process.env.PORT;
const URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.error('  ✗ ' + name);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function once(sock, event) {
  return new Promise((resolve) => sock.once(event, resolve));
}

async function run() {
  console.log('\nSocket.io integration test');
  console.log('--------------------------');

  // Start listening explicitly (the server module only auto-listens when run
  // directly, not when required into this test).
  await new Promise((resolve) => server.listen(PORT, resolve));

  const host = Client(URL, { transports: ['websocket'] });
  const A = Client(URL, { transports: ['websocket'] });
  const B = Client(URL, { transports: ['websocket'] });

  await Promise.all([once(host, 'connect'), once(A, 'connect'), once(B, 'connect')]);

  // 1. Host creates a room.
  host.emit('quiz:create', { hostName: 'HostMaster', category: 'Test Cup' });
  const created = await once(host, 'quiz:created');
  const pin = created.pin;
  check('host received a 4-digit PIN', /^\d{4}$/.test(pin));

  // 2. Players join; track the final lobby roster the host sees.
  let lobbyPlayers = [];
  host.on('lobby:update', ({ players }) => { lobbyPlayers = players; });

  A.emit('quiz:join', { pin, playerName: 'Ada' });
  await once(A, 'quiz:joined');
  B.emit('quiz:join', { pin, playerName: 'Ben' });
  await once(B, 'quiz:joined');
  await wait(80);
  check('lobby:update reflects both players', lobbyPlayers.length === 2 &&
    lobbyPlayers.some((p) => p.name === 'Ada') &&
    lobbyPlayers.some((p) => p.name === 'Ben'));

  // Bad PIN handling.
  const bad = Client(URL, { transports: ['websocket'] });
  await once(bad, 'connect');
  bad.emit('quiz:join', { pin: '0000', playerName: 'Ghost' });
  const err = await once(bad, 'quiz:error');
  check('joining a bad PIN yields quiz:error', !!err && !!err.message);
  bad.close();

  // Collect leaderboards as they arrive.
  let latestLeaderboard = [];
  A.on('leaderboard:update', ({ leaderboard }) => { latestLeaderboard = leaderboard; });

  // 3. Host starts the game.
  const qStartA = once(A, 'question:start');
  const qStartB = once(B, 'question:start');
  host.emit('quiz:start', { pin });
  const startPayload = await qStartA;
  await qStartB;
  check('question:start OMITS correctOption (anti-cheat)',
    !Object.prototype.hasOwnProperty.call(startPayload, 'correctOption'));
  check('question:start includes options + timeLimitSeconds',
    Array.isArray(startPayload.options) && startPayload.timeLimitSeconds === 1);

  // 4. Round 1: A answers fast (correct), B answers slower (correct).
  //    Correct option for Q1 (index 0) in the bank is 2.
  const correctIndex = 2;
  A.emit('answer:submit', { pin, selectedOption: correctIndex, timeTakenMs: 20 });
  await once(A, 'answer:ack');
  await wait(300); // B is slower but still within the 800ms window
  B.emit('answer:submit', { pin, selectedOption: correctIndex, timeTakenMs: 320 });
  await once(B, 'answer:ack');

  // Both answered -> round ends early -> leaderboard:update fires.
  await wait(120);
  const adaR1 = latestLeaderboard.find((r) => r.name === 'Ada');
  const benR1 = latestLeaderboard.find((r) => r.name === 'Ben');
  check('fast correct (Ada) scores higher than slow correct (Ben)',
    adaR1 && benR1 && adaR1.score > benR1.score);

  // Advance to Round 2 (phase is 'reveal' after early end).
  const q2A = once(A, 'question:start');
  host.emit('quiz:next', { pin });
  await q2A;

  // 5. Late-answer rejection: B answers in time, A submits AFTER the window.
  //    Auto-timer is disabled, so the round stays open (phase 'question').
  B.emit('answer:submit', { pin, selectedOption: 0, timeTakenMs: 30 });
  await once(B, 'answer:ack');
  await wait(950); // exceed the 800ms limit on the server clock
  const rejectP = once(A, 'answer:rejected');
  A.emit('answer:submit', { pin, selectedOption: 1, timeTakenMs: 40 });
  const rejected = await rejectP;
  check('answer past the time window is rejected (anti-cheat)',
    !!rejected && rejected.reason === 'time_expired');

  // 6. Drive remaining rounds to the end and capture the winner.
  const endedP = once(host, 'quiz:ended');
  let ended = null;
  const spam = setInterval(() => host.emit('quiz:next', { pin }), 60);
  ended = await endedP;
  clearInterval(spam);
  check('quiz:ended emits a winner', !!ended && !!ended.winner && !!ended.winner.name);
  check('quiz:ended winner is the overall top scorer',
    ended.finalRanks[0].name === ended.winner.name && ended.winner.score >= 0);

  host.close(); A.close(); B.close();
  await wait(60);

  console.log('--------------------------');
  console.log(`integration: ${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Integration test crashed:', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
