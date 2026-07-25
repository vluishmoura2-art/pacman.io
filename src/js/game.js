const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const dotsEl = document.querySelector('#dots');
const statusEl = document.querySelector('#status');
const messageEl = document.querySelector('#game-message');
const startButton = document.querySelector('#start-button');
const restartButton = document.querySelector('#restart-button');
const gameAudio = new Audio('/assets/pacman-soundtrack.mp3');
const caughtAudio = new Audio('/assets/pacman-die.mp3');

const TILE = 40;
const DIRECTIONS = {
  up: { x: 0, y: -1, angle: -Math.PI / 2 },
  down: { x: 0, y: 1, angle: Math.PI / 2 },
  left: { x: -1, y: 0, angle: Math.PI },
  right: { x: 1, y: 0, angle: 0 },
};
const KEY_TO_DIRECTION = { w: 'up', a: 'left', s: 'down', d: 'right', ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right' };
const GHOST_COLORS = ['#ff4f69', '#39dcff', '#ff94d7', '#ffad38'];
const INTRO_END = 5;
const GAMEPLAY_START = 6;
const GAMEPLAY_END = 151;

// Wide, connected corridors ensure Pac-Man has multiple exits while ghosts roam.
const LEVEL = [
  '#####################',
  '#.........#.........#',
  '#.###.###.#.###.###.#',
  '#.#.....#.#.#.....#.#',
  '#.#.###.#.#.#.###.#.#',
  '#.....#.....#.....#.#',
  '###.#.#.#####.#.#.###',
  '#...#.#...#...#.#...#',
  '#.###.###.#.###.###.#',
  '#.....#...G...#.....#',
  '#.###.#.###.###.#.###',
  '#...#.#.....###.#...#',
  '#.###.###.#.###.###.#',
  '#.#.....#.#.#.....#.#',
  '#.#.###.#.#.#.###.#.#',
  '#.....#.....#.....#.#',
  '#.###.###.###.###.#.#',
  '#.......P...........#',
  '#####################',
];

let map;
let dots;
let totalDots;
let player;
let ghosts;
let pendingDirection = 'left';
let state = 'ready';
let playerClock = 0;
let ghostClock = 0;
let lastTime = 0;
let introTimer;
let audioFrame;

function pointKey({ x, y }) { return `${x},${y}`; }
function isWall(x, y) { return !map[y] || map[y][x] === '#'; }
function nextPoint(point, direction) {
  const vector = DIRECTIONS[direction];
  return { x: point.x + vector.x, y: point.y + vector.y };
}
function canMove(point, direction) {
  const next = nextPoint(point, direction);
  return !isWall(next.x, next.y);
}

function setMessage(kicker, title, body, buttonText) {
  messageEl.innerHTML = `<p class="message-kicker">${kicker}</p><h2>${title}</h2><p>${body}</p><button id="start-button" type="button">${buttonText}</button>`;
  messageEl.classList.remove('is-hidden');
  messageEl.querySelector('button').addEventListener('click', startGame);
}

function stopGameAudio() {
  clearTimeout(introTimer);
  cancelAnimationFrame(audioFrame);
  gameAudio.pause();
}

function playCaughtAudio() {
  caughtAudio.pause();
  caughtAudio.currentTime = 0;
  caughtAudio.play().catch(() => {});
}

function keepGameplayAudioInRange() {
  if (!gameAudio.paused && gameAudio.currentTime >= GAMEPLAY_END) gameAudio.currentTime = GAMEPLAY_START;
  audioFrame = requestAnimationFrame(keepGameplayAudioInRange);
}

function playGameplayAudio() {
  clearTimeout(introTimer);
  cancelAnimationFrame(audioFrame);
  gameAudio.pause();
  gameAudio.currentTime = GAMEPLAY_START;
  gameAudio.play().catch(() => {});
  audioFrame = requestAnimationFrame(keepGameplayAudioInRange);
}

function playIntroThenStart() {
  stopGameAudio();
  gameAudio.currentTime = 0;
  gameAudio.play().catch(() => {});
  introTimer = setTimeout(() => {
    gameAudio.pause();
    state = 'playing';
    statusEl.textContent = 'RUN!';
    messageEl.classList.add('is-hidden');
    playGameplayAudio();
  }, INTRO_END * 1000);
}

function resetGame() {
  stopGameAudio();
  map = LEVEL.map(row => row.split(''));
  dots = new Set();
  let ghostHome;
  map.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === '.') dots.add(`${x},${y}`);
    if (cell === 'P') { player = { x, y, direction: 'left' }; map[y][x] = ' '; }
    if (cell === 'G') { ghostHome = { x, y }; map[y][x] = ' '; }
  }));
  totalDots = dots.size;
  ghosts = [
    { x: ghostHome.x, y: ghostHome.y, direction: 'left', color: GHOST_COLORS[0] },
    { x: ghostHome.x - 1, y: ghostHome.y, direction: 'right', color: GHOST_COLORS[1] },
    { x: ghostHome.x + 1, y: ghostHome.y, direction: 'left', color: GHOST_COLORS[2] },
    { x: ghostHome.x, y: ghostHome.y + 2, direction: 'up', color: GHOST_COLORS[3] },
  ];
  pendingDirection = 'left';
  playerClock = 0;
  ghostClock = 0;
  state = 'ready';
  updateHud();
  draw(0);
}

function startGame() {
  if (state === 'over' || state === 'won') resetGame();
  if (state !== 'ready') return;
  state = 'starting';
  playIntroThenStart();
}

function updateHud() {
  dotsEl.textContent = `${totalDots - dots.size} / ${totalDots}`;
}

function movePlayer() {
  if (canMove(player, pendingDirection)) player.direction = pendingDirection;
  if (canMove(player, player.direction)) player = { ...nextPoint(player, player.direction), direction: player.direction };
  dots.delete(pointKey(player));
  updateHud();
  if (dots.size === 0) endGame(true);
}

function opposite(direction) {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[direction];
}

function chooseGhostDirection(ghost) {
  const choices = Object.keys(DIRECTIONS).filter(direction => canMove(ghost, direction));
  const nonReverse = choices.filter(direction => direction !== opposite(ghost.direction));
  const usable = nonReverse.length ? nonReverse : choices;
  if (Math.random() < .3) return usable[Math.floor(Math.random() * usable.length)];
  return usable.sort((a, b) => {
    const aPoint = nextPoint(ghost, a);
    const bPoint = nextPoint(ghost, b);
    return Math.abs(aPoint.x - player.x) + Math.abs(aPoint.y - player.y) - (Math.abs(bPoint.x - player.x) + Math.abs(bPoint.y - player.y));
  })[0];
}

function moveGhosts() {
  ghosts.forEach(ghost => {
    ghost.direction = chooseGhostDirection(ghost);
    const next = nextPoint(ghost, ghost.direction);
    ghost.x = next.x;
    ghost.y = next.y;
  });
}

function checkCollisions() {
  if (ghosts.some(ghost => ghost.x === player.x && ghost.y === player.y)) endGame(false);
}

function endGame(won) {
  if (state !== 'playing') return;
  state = won ? 'won' : 'over';
  stopGameAudio();
  if (!won) playCaughtAudio();
  statusEl.textContent = won ? 'CLEARED' : 'CAUGHT';
  setMessage(won ? 'MAZE CLEARED' : 'SIGNAL LOST', won ? 'YOU ESCAPED!' : 'THE GHOSTS GOT YOU', won ? 'Every yellow dot has been collected. Your route was perfect.' : 'Try a different corridor and keep your distance from the chase pack.', 'PLAY AGAIN');
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.stroke();
}

function drawWalls() {
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2d42ff';
  ctx.shadowColor = '#263dff';
  ctx.shadowBlur = 7;
  map.forEach((row, y) => row.forEach((cell, x) => {
    if (cell !== '#') return;
    const px = x * TILE;
    const py = y * TILE;
    ctx.fillStyle = '#0a0b2b';
    ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
    roundedRect(px + 5, py + 5, TILE - 10, TILE - 10, 7);
  }));
  ctx.shadowBlur = 0;
}

function drawDots(pulse) {
  ctx.fillStyle = '#ffe4a7';
  dots.forEach(key => {
    const [x, y] = key.split(',').map(Number);
    const size = 3 + Math.sin(pulse / 210 + x + y) * .45;
    ctx.beginPath();
    ctx.arc(x * TILE + TILE / 2, y * TILE + TILE / 2, size, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawPlayer(time) {
  const centerX = player.x * TILE + TILE / 2;
  const centerY = player.y * TILE + TILE / 2;
  const open = .17 + (Math.sin(time / 75) + 1) * .12;
  const angle = DIRECTIONS[player.direction].angle;
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(angle);
  ctx.fillStyle = '#ffdf38';
  ctx.shadowColor = '#ffdf38';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 14, open * Math.PI, (2 - open) * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.shadowBlur = 0;
}

function drawGhost(ghost) {
  const x = ghost.x * TILE + TILE / 2;
  const y = ghost.y * TILE + TILE / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ghost.color;
  ctx.shadowColor = ghost.color;
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.arc(0, -3, 14, Math.PI, 0);
  ctx.lineTo(14, 13);
  ctx.lineTo(7, 9);
  ctx.lineTo(0, 13);
  ctx.lineTo(-7, 9);
  ctx.lineTo(-14, 13);
  ctx.lineTo(-14, -3);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  [-5, 5].forEach(eyeX => {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(eyeX, -3, 4, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2730a5';
    const direction = DIRECTIONS[ghost.direction];
    ctx.beginPath(); ctx.arc(eyeX + direction.x * 1.4, -3 + direction.y * 1.4, 2, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}

function draw(time) {
  ctx.fillStyle = '#020207';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,.025)';
  for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
  drawWalls();
  drawDots(time);
  ghosts.forEach(drawGhost);
  drawPlayer(time);
}

function loop(time) {
  const elapsed = Math.min(time - lastTime, 80);
  lastTime = time;
  if (state === 'playing') {
    playerClock += elapsed;
    ghostClock += elapsed;
    if (playerClock >= 128) {
      playerClock %= 128;
      movePlayer();
      checkCollisions();
    }
    if (state === 'playing' && ghostClock >= 310) {
      ghostClock %= 310;
      moveGhosts();
      checkCollisions();
    }
  }
  draw(time);
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', event => {
  const direction = KEY_TO_DIRECTION[event.key];
  if (!direction) return;
  event.preventDefault();
  pendingDirection = direction;
  if (state === 'ready') startGame();
});
restartButton.addEventListener('click', () => { resetGame(); setMessage('READY PLAYER ONE', 'COLLECT EVERY DOT', 'Outrun four roaming ghosts through the neon corridors.', 'START GAME'); });
startButton.addEventListener('click', startGame);

resetGame();
requestAnimationFrame(loop);
