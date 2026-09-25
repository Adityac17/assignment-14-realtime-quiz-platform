'use strict';

/**
 * gameEngine.js
 * -----------------------------------------------------------------------------
 * Pure, server-authoritative game logic: scoring, leaderboard sorting and the
 * per-question round lifecycle (timers + phase transitions).
 *
 * Everything here is deterministic and side-effect free where possible so it
 * can be unit-tested without a live socket connection. The one stateful helper
 * (`runQuestion`) takes an `io` emitter and a `room` object and drives the
 * 15-second countdown using the server clock only.
 */

const TIME_LIMIT_MS = 15000; // 15 seconds per question, authoritative.

/**
 * Scoring algorithm — used EXACTLY as specified in the assignment.
 *
 * Correct + fast  -> up to 1000 points (500 base + 500 speed bonus).
 * Correct + slow  -> fewer points as time elapses.
 * Wrong           -> 0.
 * Late (>= limit) -> 0 speed bonus (and, per anti-cheat, late answers are
 *                    rejected upstream so they never reach scoring at all).
 *
 * @param {boolean} isCorrect
 * @param {number} timeTakenMs        Server-measured elapsed time (ms).
 * @param {number} [totalTimeLimitMs] Round time limit (ms), default 15000.
 * @returns {number} score between 0 and 1000.
 */
function calculateScore(isCorrect, timeTakenMs, totalTimeLimitMs = 15000) {
  if (!isCorrect) return 0;
  const timeRemaining = Math.max(0, totalTimeLimitMs - timeTakenMs);
  const speedBonus = Math.round((timeRemaining / totalTimeLimitMs) * 500);
  const baseScore = 500;
  return baseScore + speedBonus; // max 1000
}

/**
 * Build a leaderboard array sorted by score (descending) with 1-based ranks.
 * Ties keep a stable order and share the earlier rank position via index+1
 * ordering (standard competition-style ranking is not required by the spec;
 * we use sequential ranks after a stable sort by score desc, then name asc).
 *
 * @param {Map<string,{name:string,score:number}>|Array} players
 * @returns {Array<{rank:number,name:string,score:number}>}
 */
function buildLeaderboard(players) {
  const list = Array.isArray(players)
    ? players.slice()
    : Array.from(players.values());

  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // higher score first
    return String(a.name).localeCompare(String(b.name)); // stable tie-break
  });

  return list.map((p, i) => ({
    rank: i + 1,
    name: p.name,
    score: p.score,
  }));
}

/**
 * Determine the correct score for a submitted answer, applying anti-cheat.
 *
 * The server computes elapsed time from its own `questionStartTime`. The
 * client-supplied `timeTakenMs` is trusted ONLY if it is <= the server-measured
 * elapsed time; otherwise it is clamped to the server value. Answers that
 * arrive at or after the time limit are rejected (accepted:false).
 *
 * @param {Object} params
 * @param {number} params.correctOption      Correct answer index.
 * @param {number} params.selectedOption     Player's chosen index.
 * @param {number} params.questionStartTime  Server timestamp (ms) round began.
 * @param {number} [params.clientTimeTakenMs] Client-reported elapsed (ms).
 * @param {number} [params.now]              Injected clock for tests (ms).
 * @param {number} [params.timeLimitMs]      Round limit (ms), default 15000.
 * @returns {{accepted:boolean, reason?:string, isCorrect:boolean, score:number, elapsedMs:number}}
 */
function evaluateAnswer({
  correctOption,
  selectedOption,
  questionStartTime,
  clientTimeTakenMs,
  now = Date.now(),
  timeLimitMs = TIME_LIMIT_MS,
}) {
  const serverElapsed = now - questionStartTime;

  // Anti-cheat: reject answers that land at/after the time limit.
  if (serverElapsed >= timeLimitMs) {
    return {
      accepted: false,
      reason: 'time_expired',
      isCorrect: false,
      score: 0,
      elapsedMs: serverElapsed,
    };
  }

  // Use the client's timing only if it is not faster than the server clock;
  // otherwise clamp to the server-measured elapsed time.
  let effectiveElapsed = serverElapsed;
  if (
    typeof clientTimeTakenMs === 'number' &&
    clientTimeTakenMs >= 0 &&
    clientTimeTakenMs <= serverElapsed
  ) {
    effectiveElapsed = clientTimeTakenMs;
  }

  const isCorrect = Number(selectedOption) === Number(correctOption);
  const score = calculateScore(isCorrect, effectiveElapsed, timeLimitMs);

  return {
    accepted: true,
    isCorrect,
    score,
    elapsedMs: effectiveElapsed,
  };
}

/**
 * Emit the payload for the start of a question WITHOUT the correct answer.
 * (Anti-cheat: clients must never receive correctOption before reveal.)
 *
 * @param {Object} q  A question object from the bank.
 * @param {number} index
 * @param {number} total
 * @param {number} [timeLimitMs]
 */
function buildQuestionStartPayload(q, index, total, timeLimitMs = TIME_LIMIT_MS) {
  return {
    questionIndex: index,
    totalQuestions: total,
    question: q.question,
    options: q.options,
    timeLimitSeconds: Math.round(timeLimitMs / 1000),
  };
}

/**
 * Reset every player's per-round flags before a new question.
 * @param {Map} players
 */
function resetRoundFlags(players) {
  for (const p of players.values()) {
    p.hasAnswered = false;
    p.lastAnswerCorrect = null;
    p.lastAnswerScore = 0;
  }
}

/**
 * Advance a room to its next question, or end the game if none remain.
 * Handles all timer + phase transitions. Depends only on an `io`-like emitter
 * with `.to(room).emit(event, payload)`.
 *
 * @param {Object} io    Socket.io server (or compatible emitter).
 * @param {Object} room  Authoritative room object.
 * @param {number} [timeLimitMs]
 */
function startNextQuestion(io, room, timeLimitMs = TIME_LIMIT_MS, opts = {}) {
  const { autoTimer = true } = opts;
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  room.currentQuestionIndex += 1;

  // No more questions -> end the game.
  if (room.currentQuestionIndex >= room.questions.length) {
    return endGame(io, room);
  }

  const q = room.questions[room.currentQuestionIndex];
  resetRoundFlags(room.players);
  room.phase = 'question';
  room.questionStartTime = Date.now();

  io.to(room.pin).emit(
    'question:start',
    buildQuestionStartPayload(
      q,
      room.currentQuestionIndex,
      room.questions.length,
      timeLimitMs
    )
  );

  // Authoritative server-side countdown. When it fires, reveal the answer.
  // `autoTimer:false` is a test hook that keeps the round open so the
  // late-answer rejection path can be exercised deterministically; the round
  // is then advanced manually via the host's quiz:next control.
  if (autoTimer) {
    room.timer = setTimeout(() => {
      revealAnswer(io, room);
    }, timeLimitMs);
  }
}

/**
 * Reveal the correct answer for the current question and push the leaderboard.
 * Safe to call once per round (guards against double-reveal via phase check).
 *
 * @param {Object} io
 * @param {Object} room
 */
function revealAnswer(io, room) {
  if (room.phase !== 'question') return; // already revealed / not in a round
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.phase = 'reveal';

  const q = room.questions[room.currentQuestionIndex];
  io.to(room.pin).emit('question:time_up', {
    correctOption: q.correctOption,
    explanation: q.explanation,
  });

  io.to(room.pin).emit('leaderboard:update', {
    leaderboard: buildLeaderboard(room.players),
  });
}

/**
 * If every connected player has answered, end the round early.
 * @param {Object} io
 * @param {Object} room
 * @returns {boolean} true if the round was ended early.
 */
function maybeEndRoundEarly(io, room) {
  if (room.phase !== 'question') return false;
  if (room.players.size === 0) return false;
  for (const p of room.players.values()) {
    if (!p.hasAnswered) return false;
  }
  revealAnswer(io, room);
  return true;
}

/**
 * End the game: compute winner + final ranks and broadcast quiz:ended.
 * @param {Object} io
 * @param {Object} room
 */
function endGame(io, room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  room.phase = 'ended';
  const finalRanks = buildLeaderboard(room.players);
  const winner = finalRanks.length ? finalRanks[0] : null;
  io.to(room.pin).emit('quiz:ended', {
    winner: winner ? { name: winner.name, score: winner.score } : null,
    finalRanks,
  });
}

module.exports = {
  TIME_LIMIT_MS,
  calculateScore,
  buildLeaderboard,
  evaluateAnswer,
  buildQuestionStartPayload,
  resetRoundFlags,
  startNextQuestion,
  revealAnswer,
  maybeEndRoundEarly,
  endGame,
};
