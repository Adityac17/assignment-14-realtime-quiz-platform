'use strict';

/**
 * lobbyHandler.js
 * -----------------------------------------------------------------------------
 * Room lifecycle helpers: 4-digit PIN generation, room creation, player join
 * and player/host removal. Keeps the authoritative `rooms` map here so the
 * socket wiring in server.js stays thin.
 */

/**
 * Generate a unique 4-digit PIN (1000-9999) that is not already in use.
 * @param {Map} rooms
 * @returns {string} a 4-character numeric PIN.
 */
function generatePin(rooms) {
  let pin;
  let guard = 0;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
    guard += 1;
    // With <9000 possible PINs this loop is effectively instant; the guard is
    // a defensive cap so we never spin forever in a (theoretical) full map.
    if (guard > 20000) {
      throw new Error('Unable to allocate a free PIN (server at capacity).');
    }
  } while (rooms.has(pin));
  return pin;
}

/**
 * Create a new room keyed by a fresh PIN.
 *
 * @param {Map} rooms
 * @param {Object} params
 * @param {string} params.hostSocketId
 * @param {string} params.hostName
 * @param {string} params.category
 * @param {Array}  params.questions   Loaded question bank.
 * @returns {{pin:string, room:Object}}
 */
function createRoom(rooms, { hostSocketId, hostName, category, questions }) {
  const pin = generatePin(rooms);
  const room = {
    roomId: `room_${pin}`,
    pin,
    hostSocketId,
    hostName: hostName || 'Host',
    category: category || 'General',
    players: new Map(), // socketId -> { name, score, hasAnswered, ... }
    questions,
    currentQuestionIndex: -1,
    questionStartTime: null,
    timer: null,
    phase: 'lobby', // lobby | question | reveal | ended
  };
  rooms.set(pin, room);
  return { pin, room };
}

/**
 * Add a player to a room after validating PIN + phase + name.
 *
 * @param {Map} rooms
 * @param {Object} params
 * @param {string} params.pin
 * @param {string} params.socketId
 * @param {string} params.playerName
 * @returns {{ok:boolean, error?:string, room?:Object}}
 */
function addPlayer(rooms, { pin, socketId, playerName }) {
  const room = rooms.get(String(pin));
  if (!room) {
    return { ok: false, error: 'Invalid PIN. No game found with that code.' };
  }
  if (room.phase !== 'lobby') {
    return { ok: false, error: 'This game has already started.' };
  }
  const name = String(playerName || '').trim();
  if (!name) {
    return { ok: false, error: 'Please enter a name.' };
  }
  // Reject duplicate names (case-insensitive) so the leaderboard is readable.
  for (const p of room.players.values()) {
    if (p.name.toLowerCase() === name.toLowerCase()) {
      return { ok: false, error: 'That name is already taken in this room.' };
    }
  }

  room.players.set(socketId, {
    name,
    score: 0,
    hasAnswered: false,
    lastAnswerCorrect: null,
    lastAnswerScore: 0,
  });
  return { ok: true, room };
}

/**
 * Snapshot of the roster for lobby:update payloads.
 * @param {Object} room
 * @returns {Array<{name:string, score:number}>}
 */
function roster(room) {
  return Array.from(room.players.values()).map((p) => ({
    name: p.name,
    score: p.score,
  }));
}

/**
 * Remove a player by socket id. Returns whether the socket was a player.
 * @param {Object} room
 * @param {string} socketId
 * @returns {boolean}
 */
function removePlayer(room, socketId) {
  return room.players.delete(socketId);
}

/**
 * Find the room a given socket belongs to (as host or player).
 * @param {Map} rooms
 * @param {string} socketId
 * @returns {{pin:string, room:Object, isHost:boolean}|null}
 */
function findRoomBySocket(rooms, socketId) {
  for (const [pin, room] of rooms.entries()) {
    if (room.hostSocketId === socketId) {
      return { pin, room, isHost: true };
    }
    if (room.players.has(socketId)) {
      return { pin, room, isHost: false };
    }
  }
  return null;
}

module.exports = {
  generatePin,
  createRoom,
  addPlayer,
  roster,
  removePlayer,
  findRoomBySocket,
};
