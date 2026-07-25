import {
  TILE, DIRECTIONS, LEVEL, createGame, chooseGhostDirection, hasCollision,
  moveGhost, movePlayer,
} from '/shared/game-core.js';

const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const dotsEl = document.querySelector('#dots');
const statusEl = document.querySelector('#status');
const messageEl = document.querySelector('#game-message');
const modeButtons = document.querySelectorAll('[data-mode]');
const multiplayerPanel = document.querySelector('#multiplayer-panel');
const roomCodeInput = document.querySelector('#room-code-input');
const roomSummary = document.querySelector('#room-summary');
const createRoomButton = document.querySelector('#create-room-button');
const roomVisibility = document.querySelector('#room-visibility');
const joinRoomButton = document.querySelector('#join-room-button');
const refreshRoomsButton = document.querySelector('#refresh-rooms-button');
const publicRoomList = document.querySelector('#public-room-list');
const claimPacmanButton = document.querySelector('#claim-pacman-button');
const claimGhostButton = document.querySelector('#claim-ghost-button');
const startMatchButton = document.querySelector('#start-match-button');
const lobbyMessage = document.querySelector('#lobby-message');
const joystick = document.querySelector('#joystick');
const joystickKnob = document.querySelector('#joystick-knob');
const gameAudio = new Audio('/assets/pacman-soundtrack.mp3');
const caughtAudio = new Audio('/assets/pacman-die.mp3');

const KEY_TO_DIRECTION = { w: 'up', a: 'left', s: 'down', d: 'right', ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right' };
let mode = 'single';
let localGame = createGame();
let remoteGame = null;
let socket;
let room;
let playerId;
let myRole;
let lastTime = 0;
let localPlayerClock = 0;
let localGhostClock = 0;
let localPending = 'left';
let audioPlaying = false;
let publicRooms = [];
let joystickPointerId = null;

function currentGame() { return mode === 'multiplayer' ? remoteGame : localGame; }
function send(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}
function setStatus(value) { statusEl.textContent = value; }
function showMessage(kicker, title, body, buttonText, action) {
  messageEl.innerHTML = `<p class="message-kicker">${kicker}</p><h2>${title}</h2><p>${body}</p>${buttonText ? `<button id="overlay-action" type="button">${buttonText}</button>` : ''}`;
  messageEl.classList.remove('is-hidden');
  messageEl.querySelector('#overlay-action')?.addEventListener('click', action);
}
function hideMessage() { messageEl.classList.add('is-hidden'); }
function stopAudio() { gameAudio.pause(); audioPlaying = false; }
function playAudio() { if (!audioPlaying) { gameAudio.currentTime = 6; gameAudio.play().catch(() => {}); audioPlaying = true; } }
function updateHud(game) { dotsEl.textContent = game ? `${game.totalDots - game.dots.length ?? 0} / ${game.totalDots}` : '0 / 0'; }
function dotsCount(game) { return game.dots instanceof Set ? game.dots.size : game.dots.length; }
function refreshHud() { const game = currentGame(); dotsEl.textContent = game ? `${game.totalDots - dotsCount(game)} / ${game.totalDots}` : '0 / 0'; }

function enterSinglePlayer() {
  mode = 'single'; remoteGame = null; room = null; myRole = null; localGame = createGame();
  multiplayerPanel.hidden = true;
  modeButtons.forEach(button => button.classList.toggle('is-active', button.dataset.mode === mode));
  setStatus('READY'); stopAudio(); refreshHud();
  showMessage('SINGLE PLAYER', 'COLLECT EVERY DOT', 'Use WASD or arrow keys to guide Pac-Man through the neon maze.', 'START GAME', startSinglePlayer);
}
function startSinglePlayer() {
  if (localGame.state === 'won' || localGame.state === 'over') localGame = createGame();
  localGame.state = 'playing'; hideMessage(); setStatus('RUN!'); playAudio();
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => { lobbyMessage.textContent = 'Connected. Create a room or enter a room code.'; send('rooms:list'); });
  socket.addEventListener('close', () => { lobbyMessage.textContent = 'Connection closed. Switch modes to reconnect.'; room = null; renderLobby(); });
  socket.addEventListener('message', event => handleServerEvent(JSON.parse(event.data)));
}
function enterMultiplayer() {
  mode = 'multiplayer'; localGame.state = 'ready'; stopAudio();
  multiplayerPanel.hidden = false;
  modeButtons.forEach(button => button.classList.toggle('is-active', button.dataset.mode === mode));
  setStatus('LOBBY'); refreshHud(); connect(); renderLobby();
  showMessage('MULTIPLAYER', 'JOIN A ROOM', 'Join an open public room or create a private code to share with friends.', null);
}
function myMember() { return room?.players.find(player => player.id === playerId); }
function renderLobby() {
  const member = myMember();
  const isPlaying = room?.phase === 'playing';
  roomSummary.innerHTML = room
    ? `<strong>ROOM ${room.code}</strong><span>${room.players.length}/5 connected</span><ul>${room.players.map(player => `<li>${player.host ? 'HOST · ' : ''}${player.role === 'pacman' ? 'PAC-MAN' : player.role === 'ghost' ? `GHOST ${player.ghostIndex + 1}` : 'SPECTATOR'}</li>`).join('')}</ul>`
    : '<span>No room yet.</span>';
  claimPacmanButton.disabled = !room || isPlaying || !room.availability.pacman && member?.role !== 'pacman';
  claimGhostButton.disabled = !room || isPlaying || !room.availability.ghosts && member?.role !== 'ghost';
  startMatchButton.disabled = !member?.host || !room?.players.some(player => player.role === 'pacman') || isPlaying;
  startMatchButton.hidden = !member?.host;
  if (member?.role) lobbyMessage.textContent = `You control ${member.role === 'pacman' ? 'Pac-Man' : `Ghost ${member.ghostIndex + 1}`}.`;
}
function renderPublicRooms() {
  publicRoomList.innerHTML = publicRooms.length
    ? publicRooms.map(item => '<button class="public-room" data-room-code="' + item.code + '" type="button"><strong>' + item.code + '</strong><span>' + (item.phase === 'playing' ? 'IN MATCH' : 'LOBBY') + ' · ' + item.playerCount + '/5</span><b>JOIN</b></button>').join('')
    : '<span class="empty-rooms">No public rooms yet. Create one to get started.</span>';
}
function handleServerEvent(event) {
  if (event.type === 'connected') playerId = event.id;
  if (event.type === 'room:joined') roomCodeInput.value = event.roomCode;
  if (event.type === 'room:state') { room = event.room; renderLobby(); }
  if (event.type === 'rooms:public') { publicRooms = event.rooms; renderPublicRooms(); }
  if (event.type === 'role:assigned') { myRole = event.role; lobbyMessage.textContent = `Role claimed: ${event.role === 'pacman' ? 'Pac-Man' : `Ghost ${event.ghostIndex + 1}`}.`; }
  if (event.type === 'match:state') {
    remoteGame = event.game; refreshHud();
    if (event.game.state === 'playing') { hideMessage(); setStatus('RUN!'); playAudio(); }
  }
  if (event.type === 'match:ended') {
    stopAudio(); setStatus(event.won ? 'CLEARED' : 'CAUGHT');
    if (!event.won) { caughtAudio.currentTime = 0; caughtAudio.play().catch(() => {}); }
    showMessage(event.won ? 'MAZE CLEARED' : 'SIGNAL LOST', event.won ? 'PAC-MAN ESCAPED!' : 'THE GHOSTS WON', event.reason, myMember()?.host ? 'PLAY AGAIN' : 'WAIT FOR HOST', () => { if (myMember()?.host) send('match:start'); });
  }
  if (event.type === 'error') lobbyMessage.textContent = event.message;
}

function localTick(elapsed) {
  if (mode !== 'single' || localGame.state !== 'playing') return;
  localPlayerClock += elapsed; localGhostClock += elapsed;
  if (localPlayerClock >= 128) {
    localPlayerClock %= 128; localGame.pendingPlayerDirection = localPending; movePlayer(localGame);
    if (localGame.dots.size === 0) endLocal(true);
  }
  if (localGame.state === 'playing' && localGhostClock >= 220) {
    localGhostClock %= 220; localGame.ghosts.forEach((ghost, index) => moveGhost(localGame, index, chooseGhostDirection(localGame, ghost)));
    if (hasCollision(localGame)) endLocal(false);
  }
}
function endLocal(won) {
  localGame.state = won ? 'won' : 'over'; stopAudio(); setStatus(won ? 'CLEARED' : 'CAUGHT');
  if (!won) { caughtAudio.currentTime = 0; caughtAudio.play().catch(() => {}); }
  showMessage(won ? 'MAZE CLEARED' : 'SIGNAL LOST', won ? 'YOU ESCAPED!' : 'THE GHOSTS GOT YOU', won ? 'Every yellow dot has been collected.' : 'Try a different corridor and keep your distance.', 'PLAY AGAIN', startSinglePlayer);
}

function roundedRect(x, y, width, height, radius) { ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.stroke(); }
function drawWalls(game) {
  ctx.lineWidth = 3; ctx.strokeStyle = '#2d42ff'; ctx.shadowColor = '#263dff'; ctx.shadowBlur = 7;
  game.map.forEach((row, y) => row.forEach((cell, x) => { if (cell !== '#') return; const px = x * TILE; const py = y * TILE; ctx.fillStyle = '#0a0b2b'; ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4); roundedRect(px + 5, py + 5, TILE - 10, TILE - 10, 7); }));
  ctx.shadowBlur = 0;
}
function drawDots(game, pulse) {
  ctx.fillStyle = '#ffe4a7'; const dots = game.dots instanceof Set ? game.dots : new Set(game.dots);
  dots.forEach(key => { const [x, y] = key.split(',').map(Number); ctx.beginPath(); ctx.arc(x * TILE + TILE / 2, y * TILE + TILE / 2, 3 + Math.sin(pulse / 210 + x + y) * 0.45, 0, Math.PI * 2); ctx.fill(); });
}
function drawPlayer(player, time) {
  const centerX = player.x * TILE + TILE / 2; const centerY = player.y * TILE + TILE / 2; const open = 0.17 + (Math.sin(time / 75) + 1) * 0.12;
  ctx.save(); ctx.translate(centerX, centerY); ctx.rotate(DIRECTIONS[player.direction].angle); ctx.fillStyle = '#ffdf38'; ctx.shadowColor = '#ffdf38'; ctx.shadowBlur = 12; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 14, open * Math.PI, (2 - open) * Math.PI); ctx.closePath(); ctx.fill(); ctx.restore(); ctx.shadowBlur = 0;
}
function drawGhost(ghost) {
  const x = ghost.x * TILE + TILE / 2; const y = ghost.y * TILE + TILE / 2; ctx.save(); ctx.translate(x, y); ctx.fillStyle = ghost.color; ctx.shadowColor = ghost.color; ctx.shadowBlur = 9; ctx.beginPath(); ctx.arc(0, -3, 14, Math.PI, 0); ctx.lineTo(14, 13); ctx.lineTo(7, 9); ctx.lineTo(0, 13); ctx.lineTo(-7, 9); ctx.lineTo(-14, 13); ctx.lineTo(-14, -3); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
  [-5, 5].forEach(eyeX => { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(eyeX, -3, 4, 5, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#2730a5'; const direction = DIRECTIONS[ghost.direction]; ctx.beginPath(); ctx.arc(eyeX + direction.x * 1.4, -3 + direction.y * 1.4, 2, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
}
function draw(time) {
  ctx.fillStyle = '#020207'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = 'rgba(255,255,255,.025)'; for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
  const game = currentGame(); if (!game) return; drawWalls(game); drawDots(game, time); game.ghosts.forEach(drawGhost); drawPlayer(game.player, time);
}
function loop(time) { const elapsed = Math.min(time - lastTime, 80); lastTime = time; localTick(elapsed); refreshHud(); draw(time); requestAnimationFrame(loop); }
function controlDirection(direction) { if (!direction) return; if (mode === 'single') { localPending = direction; if (localGame.state === 'ready') startSinglePlayer(); } else if (room?.phase === 'playing') send('input:direction', { direction }); }
function resetJoystick() { joystickKnob.style.transform = ''; }
function moveJoystick(event) { const rect = joystick.getBoundingClientRect(); const center = rect.width / 2; const dx = event.clientX - rect.left - center; const dy = event.clientY - rect.top - center; const distance = Math.hypot(dx, dy); const limit = center * .55; const scale = distance > limit ? limit / distance : 1; joystickKnob.style.transform = 'translate(' + (dx * scale) + 'px, ' + (dy * scale) + 'px)'; if (distance >= center * .22) controlDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')); }

window.addEventListener('keydown', event => {
  const direction = KEY_TO_DIRECTION[event.key]; if (!direction) return; event.preventDefault();
  controlDirection(direction);
});
modeButtons.forEach(button => button.addEventListener('click', () => button.dataset.mode === 'single' ? enterSinglePlayer() : enterMultiplayer()));
createRoomButton.addEventListener('click', () => send('room:create', { visibility: roomVisibility.value }));
refreshRoomsButton.addEventListener('click', () => send('rooms:list'));
publicRoomList.addEventListener('click', event => { const button = event.target.closest('[data-room-code]'); if (button) send('room:join', { roomCode: button.dataset.roomCode }); });
joinRoomButton.addEventListener('click', () => send('room:join', { roomCode: roomCodeInput.value }));
claimPacmanButton.addEventListener('click', () => send('role:claim', { role: 'pacman' }));
claimGhostButton.addEventListener('click', () => send('role:claim', { role: 'ghost' }));
startMatchButton.addEventListener('click', () => send('match:start'));
joystick.addEventListener('pointerdown', event => { joystickPointerId = event.pointerId; joystick.setPointerCapture(event.pointerId); moveJoystick(event); });
joystick.addEventListener('pointermove', event => { if (event.pointerId === joystickPointerId) moveJoystick(event); });
joystick.addEventListener('pointerup', event => { if (event.pointerId === joystickPointerId) { joystickPointerId = null; resetJoystick(); } });
joystick.addEventListener('pointercancel', () => { joystickPointerId = null; resetJoystick(); });
joystick.addEventListener('keydown', event => { const direction = KEY_TO_DIRECTION[event.key]; if (direction) { event.preventDefault(); controlDirection(direction); } });
enterSinglePlayer(); requestAnimationFrame(loop);
