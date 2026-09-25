/*
 * app.js — shared client-side Socket.io helpers.
 * -----------------------------------------------------------------------------
 * DESIGN CHOICE: host.html and player.html each contain their own page-specific
 * UI logic inline (they are small, self-contained screens). This shared file
 * provides the connection factory and a couple of tiny DOM helpers reused by
 * both pages, keeping duplication low without a build step.
 */

/* global io */

// Create/return a Socket.io connection to the same origin that served the page.
function connectSocket() {
  return io({ transports: ['websocket', 'polling'] });
}

// Tiny DOM helpers.
function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function show(el) {
  if (el) el.classList.remove('hidden');
}
function hide(el) {
  if (el) el.classList.add('hidden');
}
function setText(el, text) {
  if (el) el.textContent = text;
}

// Render a leaderboard list into a container element.
function renderLeaderboard(container, leaderboard) {
  if (!container) return;
  container.innerHTML = '';
  leaderboard.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'lb-row';
    li.innerHTML =
      '<span class="lb-rank">#' + row.rank + '</span>' +
      '<span class="lb-name">' + escapeHtml(row.name) + '</span>' +
      '<span class="lb-score">' + row.score + '</span>';
    container.appendChild(li);
  });
}

// Basic HTML escaping for user-supplied names.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Expose helpers globally for the inline page scripts.
window.QuizClient = {
  connectSocket,
  $,
  $all,
  show,
  hide,
  setText,
  renderLeaderboard,
  escapeHtml,
};
