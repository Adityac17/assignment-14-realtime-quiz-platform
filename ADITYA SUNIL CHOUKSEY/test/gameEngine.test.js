'use strict';

/**
 * Unit tests for gameEngine — no framework, plain Node assertions.
 * Run: node test/gameEngine.test.js  (or: npm test)
 */

const assert = require('assert');
const engine = require('../sockets/gameEngine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.error('  ✗ ' + name + '\n      ' + err.message);
  }
}

console.log('\ngameEngine unit tests');
console.log('---------------------');

// --- calculateScore ---------------------------------------------------------
test('correct + instant (0ms) = 1000 (max)', () => {
  assert.strictEqual(engine.calculateScore(true, 0, 15000), 1000);
});

test('correct + fast (1s) scores higher than correct + slow (10s)', () => {
  const fast = engine.calculateScore(true, 1000, 15000);
  const slow = engine.calculateScore(true, 10000, 15000);
  assert.ok(fast > slow, `expected ${fast} > ${slow}`);
});

test('wrong answer = 0 regardless of speed', () => {
  assert.strictEqual(engine.calculateScore(false, 0, 15000), 0);
  assert.strictEqual(engine.calculateScore(false, 5000, 15000), 0);
});

test('boundary: timeTaken >= limit -> 0 speed bonus (base only)', () => {
  assert.strictEqual(engine.calculateScore(true, 15000, 15000), 500);
  assert.strictEqual(engine.calculateScore(true, 20000, 15000), 500);
});

test('mid-time score is base + proportional bonus', () => {
  // 7500ms of 15000 -> half remaining -> 250 bonus -> 750
  assert.strictEqual(engine.calculateScore(true, 7500, 15000), 750);
});

// --- evaluateAnswer (anti-cheat) --------------------------------------------
test('evaluateAnswer rejects answers at/after the time limit', () => {
  const start = 1_000_000;
  const res = engine.evaluateAnswer({
    correctOption: 1,
    selectedOption: 1,
    questionStartTime: start,
    now: start + 15001, // past the 15s limit
    timeLimitMs: 15000,
  });
  assert.strictEqual(res.accepted, false);
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.reason, 'time_expired');
});

test('evaluateAnswer accepts a fast correct answer and scores it', () => {
  const start = 2_000_000;
  const res = engine.evaluateAnswer({
    correctOption: 2,
    selectedOption: 2,
    questionStartTime: start,
    now: start + 2000, // 2s elapsed
    timeLimitMs: 15000,
  });
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(res.isCorrect, true);
  // 2s -> 13000 remaining -> round(13000/15000*500)=433 -> 933
  assert.strictEqual(res.score, 933);
});

test('evaluateAnswer clamps a client time slower-than-claimed... i.e. larger than server elapsed', () => {
  // Client claims it took LONGER (9000ms) than the server measured (3000ms).
  // Per spec, use client time only if <= server elapsed, else clamp to server.
  const start = 3_000_000;
  const res = engine.evaluateAnswer({
    correctOption: 0,
    selectedOption: 0,
    questionStartTime: start,
    clientTimeTakenMs: 9000, // > server elapsed -> must clamp to 3000
    now: start + 3000,
    timeLimitMs: 15000,
  });
  // Must be scored on server elapsed (3000ms), not the client's 9000ms.
  assert.strictEqual(res.score, engine.calculateScore(true, 3000, 15000));
  assert.strictEqual(res.elapsedMs, 3000);
});

test('evaluateAnswer trusts a client time faster than server elapsed (per spec rule)', () => {
  // Spec: "use client timeTakenMs only if <= server elapsed". So a smaller
  // client time is trusted; scoring uses the client value.
  const start = 3_500_000;
  const res = engine.evaluateAnswer({
    correctOption: 0,
    selectedOption: 0,
    questionStartTime: start,
    clientTimeTakenMs: 100, // <= server elapsed 3000 -> trusted
    now: start + 3000,
    timeLimitMs: 15000,
  });
  assert.strictEqual(res.score, engine.calculateScore(true, 100, 15000));
});

test('evaluateAnswer trusts a client time slower than server elapsed', () => {
  const start = 4_000_000;
  const res = engine.evaluateAnswer({
    correctOption: 1,
    selectedOption: 1,
    questionStartTime: start,
    clientTimeTakenMs: 6000, // <= server elapsed 8000 -> trusted
    now: start + 8000,
    timeLimitMs: 15000,
  });
  assert.strictEqual(res.score, engine.calculateScore(true, 6000, 15000));
});

test('evaluateAnswer scores wrong selection as 0', () => {
  const start = 5_000_000;
  const res = engine.evaluateAnswer({
    correctOption: 3,
    selectedOption: 0,
    questionStartTime: start,
    now: start + 1000,
    timeLimitMs: 15000,
  });
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(res.isCorrect, false);
  assert.strictEqual(res.score, 0);
});

// --- buildLeaderboard -------------------------------------------------------
test('buildLeaderboard sorts by score desc and assigns ranks', () => {
  const players = new Map([
    ['s1', { name: 'Alice', score: 300 }],
    ['s2', { name: 'Bob', score: 900 }],
    ['s3', { name: 'Cara', score: 600 }],
  ]);
  const lb = engine.buildLeaderboard(players);
  assert.deepStrictEqual(
    lb.map((r) => [r.rank, r.name, r.score]),
    [
      [1, 'Bob', 900],
      [2, 'Cara', 600],
      [3, 'Alice', 300],
    ]
  );
});

test('buildLeaderboard tie-breaks by name for stable ranks', () => {
  const players = [
    { name: 'Zoe', score: 500 },
    { name: 'Amy', score: 500 },
  ];
  const lb = engine.buildLeaderboard(players);
  assert.strictEqual(lb[0].name, 'Amy'); // alphabetical tie-break
  assert.strictEqual(lb[1].name, 'Zoe');
});

// --- summary ----------------------------------------------------------------
console.log('---------------------');
console.log(`gameEngine: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
