import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import {
  PLAYER_STEP_MS, GHOST_STEP_MS, DEFAULT_ROOM_SETTINGS, DIRECTIONS, createGame, chooseGhostDirection,
  hasCollision, moveGhost, movePlayer, serialiseGame,
} from './shared/game-core.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const rooms = new Map();
const clients = new Map();
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8' };
function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}
function normaliseSettings(value = {}) {
  return {
    name: String(value.name ?? '').trim().slice(0, 32),
    mapSize: ['small', 'medium', 'large'].includes(value.mapSize) ? value.mapSize : DEFAULT_ROOM_SETTINGS.mapSize,
    pacmanSpeed: clamp(value.pacmanSpeed, 1, 20, DEFAULT_ROOM_SETTINGS.pacmanSpeed),
    ghostSpeed: clamp(value.ghostSpeed, 1, 20, DEFAULT_ROOM_SETTINGS.ghostSpeed),
    mode: value.mode === 'time' ? 'time' : 'coin',
    durationSeconds: clamp(value.durationSeconds, 1, 600, DEFAULT_ROOM_SETTINGS.durationSeconds),
  };
}
function roomName(room) { return room.settings.name || `Room ${room.code}`; }
function speedStep(baseStep, speed) { return Math.max(1, Math.round(baseStep * 10 / speed)); }

function send(socket, payload) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  const size = data.length;
  let header;
  if (size < 126) header = Buffer.from([0x81, size]);
  else if (size < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(size, 2); }
  else { return; }
  socket.write(Buffer.concat([header, data]));
}

function broadcast(room, payload) { room.members.forEach(member => send(member.socket, payload)); }
function roomCode() { return randomBytes(3).toString('hex').toUpperCase(); }
function publicRooms() { return [...rooms.values()].filter(room => room.visibility === 'public').map(room => ({ code: room.code, name: roomName(room), phase: room.game.state === 'playing' ? 'playing' : 'lobby', playerCount: room.members.size, settings: room.settings })); }
function emitPublicRooms() { clients.forEach(client => send(client.socket, { type: 'rooms:public', rooms: publicRooms() })); }
function publicRoom(room) {
  return {
    code: room.code,
    visibility: room.visibility,
    name: roomName(room),
    settings: room.settings,
    phase: room.game.state === 'playing' ? 'playing' : 'lobby',
    players: [...room.members.values()].map(({ id, name, role, ghostIndex, host }) => ({ id, name, role, ghostIndex, host })),
    availability: { pacman: ![...room.members.values()].some(member => member.role === 'pacman'), ghosts: 4 - [...room.members.values()].filter(member => member.role === 'ghost').length },
  };
}
function emitLobby(room) { broadcast(room, { type: 'room:state', room: publicRoom(room) }); emitPublicRooms(); }
function emitGame(room) { broadcast(room, { type: 'match:state', game: serialiseGame(room.game) }); }

function releaseRole(member) { member.role = null; member.ghostIndex = null; }
function joinRoom(client, room) {
  if (client.room) leaveRoom(client, false);
  client.room = room;
  client.host = room.members.size === 0;
  room.members.set(client.id, client);
  send(client.socket, { type: 'room:joined', id: client.id, roomCode: room.code });
  emitLobby(room);
  if (room.game.state === 'playing') emitGame(room);
}
function leaveRoom(client, disconnect = false) {
  const room = client.room;
  if (!room) return;
  const hadPacman = client.role === 'pacman';
  room.members.delete(client.id);
  client.room = null;
  releaseRole(client);
  const nextHost = room.members.values().next().value;
  if (nextHost) nextHost.host = true;
  if (hadPacman && room.game.state === 'playing') {
    room.game.state = 'over';
    broadcast(room, { type: 'match:ended', won: false, reason: 'Pac-Man disconnected.' });
  }
  if (!room.members.size) {
    clearInterval(room.timer);
    rooms.delete(room.code);
    emitPublicRooms();
  } else emitLobby(room);
  if (!disconnect) send(client.socket, { type: 'room:left' });
}

function startMatch(room) {
  room.game = createGame(room.settings);
  room.game.deadline = room.settings.mode === 'time' ? Date.now() + room.settings.durationSeconds * 1000 : null;
  room.game.state = 'playing';
  room.lastTick = Date.now();
  emitLobby(room);
  emitGame(room);
}
function tickRoom(room) {
  if (room.game.state !== 'playing') return;
  const now = Date.now();
  const elapsed = Math.min(now - room.lastTick, 80);
  room.lastTick = now;
  if (room.game.mode === 'time') {
    room.game.remainingMs = Math.max(0, room.game.deadline - now);
    if (room.game.remainingMs === 0) room.game.state = 'won';
  }
  const playerStep = speedStep(PLAYER_STEP_MS, room.settings.pacmanSpeed);
  const ghostStep = speedStep(GHOST_STEP_MS, room.settings.ghostSpeed);
  room.game.playerClock += elapsed;
  room.game.ghostClock += elapsed;
  while (room.game.state === 'playing' && room.game.playerClock >= playerStep) {
    room.game.playerClock -= playerStep;
    movePlayer(room.game);
    if (room.game.mode === 'coin' && room.game.dots.size === 0) room.game.state = 'won';
  }
  while (room.game.state === 'playing' && room.game.ghostClock >= ghostStep) {
    room.game.ghostClock -= ghostStep;
    room.game.ghosts.forEach((ghost, index) => {
      const owner = [...room.members.values()].find(member => member.role === 'ghost' && member.ghostIndex === index);
      moveGhost(room.game, index, owner ? room.game.pendingGhostDirections[index] : chooseGhostDirection(room.game, ghost));
    });
  }
  if (room.game.mode === 'time') {
    room.game.remainingMs = Math.max(0, room.game.deadline - Date.now());
    if (room.game.remainingMs === 0) room.game.state = 'won';
  }
  if (room.game.state === 'playing' && hasCollision(room.game)) room.game.state = 'over';
  emitGame(room);
  if (room.game.state === 'won' || room.game.state === 'over') {
    broadcast(room, { type: 'match:ended', won: room.game.state === 'won', reason: room.game.state === 'won' ? (room.game.mode === 'time' ? 'Pac-Man survived until the timer expired.' : 'Every dot was collected.') : 'The ghosts caught Pac-Man.' });
    emitLobby(room);
  }
}

function handleMessage(client, message) {
  let event;
  try { event = JSON.parse(message); } catch { return send(client.socket, { type: 'error', message: 'Invalid message.' }); }
  if (event.type === 'room:create') {
    let code = roomCode(); while (rooms.has(code)) code = roomCode();
    const visibility = event.visibility === 'private' ? 'private' : 'public';
    const settings = normaliseSettings(event.settings); settings.name ||= `Room ${code}`;
    const room = { code, visibility, settings, members: new Map(), game: createGame(settings), lastTick: Date.now(), timer: null };
    room.timer = setInterval(() => tickRoom(room), 40);
    rooms.set(code, room); joinRoom(client, room); return;
  }
  if (event.type === 'rooms:list') return send(client.socket, { type: 'rooms:public', rooms: publicRooms() });
  if (event.type === 'room:join') {
    const room = rooms.get(String(event.roomCode || '').trim().toUpperCase());
    if (!room) return send(client.socket, { type: 'error', message: 'Room not found. Check the room code and try again.' });
    if (room.members.size >= 5) return send(client.socket, { type: 'error', message: 'This room is full.' });
    joinRoom(client, room); return;
  }
  const room = client.room;
  if (!room) return send(client.socket, { type: 'error', message: 'Join a room first.' });
  if (event.type === 'room:settings') {
    if (!client.host) return send(client.socket, { type: 'error', message: 'Only the room host can change settings.' });
    if (room.game.state === 'playing') return send(client.socket, { type: 'error', message: 'Settings are locked while the match is running.' });
    room.settings = normaliseSettings({ ...room.settings, ...event.settings });
    room.settings.name ||= `Room ${room.code}`;
    room.game = createGame(room.settings);
    emitLobby(room); return;
  }
  if (event.type === 'room:leave') return leaveRoom(client);
  if (event.type === 'role:claim') {
    if (room.game.state === 'playing') return send(client.socket, { type: 'error', message: 'Roles are locked while the match is running.' });
    if (event.role === 'pacman') {
      if ([...room.members.values()].some(member => member !== client && member.role === 'pacman')) return send(client.socket, { type: 'error', message: 'Pac-Man is already claimed.' });
      releaseRole(client); client.role = 'pacman';
    } else if (event.role === 'ghost') {
      const occupied = new Set([...room.members.values()].filter(member => member !== client && member.role === 'ghost').map(member => member.ghostIndex));
      const ghostIndex = [0, 1, 2, 3].find(index => !occupied.has(index));
      if (ghostIndex === undefined) return send(client.socket, { type: 'error', message: 'All four ghosts are already claimed.' });
      releaseRole(client); client.role = 'ghost'; client.ghostIndex = ghostIndex;
    } else return;
    send(client.socket, { type: 'role:assigned', role: client.role, ghostIndex: client.ghostIndex });
    emitLobby(room); return;
  }
  if (event.type === 'match:start') {
    if (!client.host) return send(client.socket, { type: 'error', message: 'Only the room host can start the match.' });
    if (![...room.members.values()].some(member => member.role === 'pacman')) return send(client.socket, { type: 'error', message: 'A player must claim Pac-Man before starting.' });
    startMatch(room); return;
  }
  if (event.type === 'input:direction' && DIRECTIONS[event.direction] && room.game.state === 'playing') {
    if (client.role === 'pacman') room.game.pendingPlayerDirection = event.direction;
    if (client.role === 'ghost') room.game.pendingGhostDirections[client.ghostIndex] = event.direction;
  }
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0]; const second = client.buffer[1];
    const length = second & 0x7f; const masked = Boolean(second & 0x80);
    if (length === 127 || !masked) { client.socket.destroy(); return; }
    const frameLength = 2 + (length === 126 ? 2 : 0) + 4 + (length === 126 ? client.buffer.readUInt16BE(2) : length);
    if (client.buffer.length < frameLength) return;
    const offset = length === 126 ? 4 : 2; const payloadLength = length === 126 ? client.buffer.readUInt16BE(2) : length;
    const mask = client.buffer.subarray(offset, offset + 4); const payload = Buffer.from(client.buffer.subarray(offset + 4, offset + 4 + payloadLength));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    client.buffer = client.buffer.subarray(frameLength);
    if ((first & 0x0f) === 0x8) { client.socket.end(); return; }
    if ((first & 0x0f) === 0x1) handleMessage(client, payload.toString());
  }
}

const server = createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, relativePath));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath) || statSync(filePath).isDirectory()) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});
server.on('upgrade', (request, socket) => {
  if ((request.url || '').split('?')[0] !== '/ws' || !request.headers['sec-websocket-key']) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { id: randomBytes(6).toString('hex'), socket, buffer: Buffer.alloc(0), room: null, role: null, ghostIndex: null, host: false, name: 'Player' };
  clients.set(socket, client);
  socket.on('data', chunk => parseFrames(client, chunk));
  socket.on('close', () => { clients.delete(socket); leaveRoom(client, true); });
  socket.on('error', () => {});
  send(socket, { type: 'connected', id: client.id });
});
server.listen(PORT, () => console.log(`Neon Maze multiplayer server running at http://localhost:${PORT}`));
