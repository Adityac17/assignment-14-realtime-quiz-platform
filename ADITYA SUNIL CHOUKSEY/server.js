'use strict';

/**
 * server.js
 * -----------------------------------------------------------------------------
 * Real-Time Multiplayer Live Quiz Battle — Express + Socket.io entry point.
 *
 * The server is AUTHORITATIVE for timing and scoring:
 *   - It never sends correctOption to clients before the reveal.
 *   - It measures elapsed time from its own questionStartTime timestamp.
 *   - It rejects/clamps answers based on the server clock (anti-cheat).
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const engine = require('./sockets/gameEngine');
const lobby = require('./sockets/lobbyHandler');

const PORT = process.env.PORT || 5000;

// ---------------------------------------------------------------------------
// Load the question bank once at boot.
// ---------------------------------------------------------------------------
const questionsPath = path.join(__dirname, 'data', 'questions.json');
const questionBank = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));

// ---------------------------------------------------------------------------
// Express app.
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight health check for tests / monitoring.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------------------
// Authoritative in-memory game state: pin -> room.
// ---------------------------------------------------------------------------
const rooms = new Map();

// Allow tests to override the round time limit via env (default 15s).
const TIME_LIMIT_MS = Number(process.env.QUIZ_TIME_LIMIT_MS) || engine.TIME_LIMIT_MS;

// Test hook: when set, the server does NOT auto-reveal on a timer, so the
// integration test can drive rounds via quiz:next and exercise late-answer
// rejection deterministically. Never set in normal operation.
const AUTO_TIMER = !process.env.QUIZ_DISABLE_AUTO_TIMER;

io.on('connection', (socket) => {
  // ----- Host creates a quiz -------------------------------------------------
  socket.on('quiz:create', ({ hostName, category } = {}) => {
    const { pin, room } = lobby.createRoom(rooms, {
      hostSocketId: socket.id,
      hostName,
      category: category || questionBank.category,
      questions: questionBank.questions,
    });
    socket.join(pin);
    socket.emit('quiz:created', { pin, roomId: room.roomId });
  });

  // ----- Player joins a quiz -------------------------------------------------
  socket.on('quiz:join', ({ pin, playerName } = {}) => {
    const result = lobby.addPlayer(rooms, {
      pin,
      socketId: socket.id,
      playerName,
    });
    if (!result.ok) {
      socket.emit('quiz:error', { message: result.error });
      return;
    }
    const room = result.room;
    socket.join(room.pin);
    // Tell the joining player they are in (with room meta).
    socket.emit('quiz:joined', {
      pin: room.pin,
      roomId: room.roomId,
      category: room.category,
      hostName: room.hostName,
    });
    // Broadcast the updated roster to the whole room.
    io.to(room.pin).emit('lobby:update', { players: lobby.roster(room) });
  });

  // ----- Host starts the quiz ------------------------------------------------
  socket.on('quiz:start', ({ pin } = {}) => {
    const room = rooms.get(String(pin));
    if (!room) {
      socket.emit('quiz:error', { message: 'Room not found.' });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      socket.emit('quiz:error', { message: 'Only the host can start the game.' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('quiz:error', { message: 'Game already started.' });
      return;
    }
    if (room.players.size === 0) {
      socket.emit('quiz:error', { message: 'Wait for at least one player to join.' });
      return;
    }
    engine.startNextQuestion(io, room, TIME_LIMIT_MS, { autoTimer: AUTO_TIMER });
  });

  // ----- Player submits an answer -------------------------------------------
  socket.on('answer:submit', ({ pin, selectedOption, timeTakenMs } = {}) => {
    const room = rooms.get(String(pin));
    if (!room || room.phase !== 'question') return; // no active round
    const player = room.players.get(socket.id);
    if (!player) return; // not a member of this room
    if (player.hasAnswered) return; // one answer per round

    const q = room.questions[room.currentQuestionIndex];
    const verdict = engine.evaluateAnswer({
      correctOption: q.correctOption,
      selectedOption,
      questionStartTime: room.questionStartTime,
      clientTimeTakenMs: timeTakenMs,
      timeLimitMs: TIME_LIMIT_MS,
    });

    if (!verdict.accepted) {
      // Late answer -> rejected, not scored (anti-cheat).
      player.hasAnswered = true;
      player.lastAnswerCorrect = false;
      player.lastAnswerScore = 0;
      socket.emit('answer:rejected', {
        reason: verdict.reason,
        message: 'Time expired — your answer was not counted.',
      });
    } else {
      player.hasAnswered = true;
      player.lastAnswerCorrect = verdict.isCorrect;
      player.lastAnswerScore = verdict.score;
      player.score += verdict.score;
      socket.emit('answer:ack', {
        received: true,
        // Correctness is intentionally NOT revealed yet (anti-cheat); only the
        // player's provisional points are echoed back to them.
        pointsEarned: verdict.score,
      });
    }

    // Let the host UI know how many have answered.
    io.to(room.hostSocketId).emit('answer:count', {
      answered: Array.from(room.players.values()).filter((p) => p.hasAnswered).length,
      total: room.players.size,
    });

    // End the round early if everyone has answered.
    engine.maybeEndRoundEarly(io, room);
  });

  // ----- Host advances to the next question / reveal --------------------------
  socket.on('quiz:next', ({ pin } = {}) => {
    const room = rooms.get(String(pin));
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.phase === 'question') {
      engine.revealAnswer(io, room); // force reveal
    } else if (room.phase === 'reveal') {
      engine.startNextQuestion(io, room, TIME_LIMIT_MS, { autoTimer: AUTO_TIMER });
    }
  });

  // ----- Disconnect handling -------------------------------------------------
  socket.on('disconnect', () => {
    const found = lobby.findRoomBySocket(rooms, socket.id);
    if (!found) return;
    const { pin, room, isHost } = found;

    if (isHost) {
      // Host left -> end the room gracefully.
      if (room.timer) clearTimeout(room.timer);
      io.to(pin).emit('quiz:aborted', {
        message: 'The host disconnected. The game has ended.',
      });
      rooms.delete(pin);
      return;
    }

    // A player left -> remove and refresh roster / leaderboard.
    lobby.removePlayer(room, socket.id);
    io.to(pin).emit('lobby:update', { players: lobby.roster(room) });
    if (room.phase === 'question') {
      io.to(pin).emit('leaderboard:update', {
        leaderboard: engine.buildLeaderboard(room.players),
      });
      // Their departure might mean everyone remaining has answered.
      engine.maybeEndRoundEarly(io, room);
    }
  });
});

// Only start listening when run directly (so tests can import if needed).
if (require.main === module) {
  server.listen(PORT, () => {
    /* eslint-disable no-console */
    console.log(`\n  Live Quiz Battle server running on http://localhost:${PORT}`);
    console.log(`  Open the portal at http://localhost:${PORT}\n`);
    console.log('  Note: on macOS, port 5000 may be used by AirPlay Receiver.');
    console.log('  Override with:  PORT=5050 npm run dev\n');
    /* eslint-enable no-console */
  });
}

module.exports = { app, server, io, rooms };
