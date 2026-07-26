export const TILE = 40;
export const PLAYER_STEP_MS = 128;
export const GHOST_STEP_MS = 160;
export const DEFAULT_ROOM_SETTINGS = {
  name: '',
  mapSize: 'medium',
  pacmanSpeed: 10,
  ghostSpeed: 10,
  mode: 'coin',
  durationSeconds: 60,
};
export const DIRECTIONS = {
  up: { x: 0, y: -1, angle: -Math.PI / 2 },
  down: { x: 0, y: 1, angle: Math.PI / 2 },
  left: { x: -1, y: 0, angle: Math.PI },
  right: { x: 1, y: 0, angle: 0 },
};
export const GHOST_COLORS = ['#ff4f69', '#39dcff', '#ff94d7', '#ffad38'];
const SMALL_LEVEL = [
  '###############',
  '#.....#.......#',
  '#.###.#.###.#.#',
  '#.#...#...#.#.#',
  '#.#.#####.#.#.#',
  '#...#G..#...#.#',
  '###.#.###.#.###',
  '#...#.....#...#',
  '#.#####.#####.#',
  '#.#...#.#...#.#',
  '#.#.#.#.#.#.#.#',
  '#...#...P.#...#',
  '###############',
];

export const LEVEL = [
  '#####################',
  '#.........#.........#',
  '#.###.###.#.###.###.#',
  '#.#.....#.#.#.....#.#',
  '#.#.###.#.#.###.#.#.#',
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

const LARGE_LEVEL = [
  '###########################',
  '#...........#.............#',
  '#.#####.###.#.###.#####.#.#',
  '#.#...#...#.#.#...#...#.#.#',
  '#.#.#.###.#.#.#.###.#.#.#.#',
  '#...#.....#...#.....#...#.#',
  '###.#####.#####.#####.###.#',
  '#.....#.....#.....#.....#.#',
  '#.###.#.###.#.###.#.###.#.#',
  '#.#...#.#...G...#.#...#.#.#',
  '#.#.###.#.#######.#.###.#.#',
  '#.#.....#...#.....#.....#.#',
  '#.#####.###.#.###.#####.#.#',
  '#.....#.....#.....#.....#.#',
  '###.#.#.#########.#.#.###.#',
  '#...#.#.....#.....#.#...#.#',
  '#.###.#####.#.#####.###.#.#',
  '#.#.....#...#...#.....#.#.#',
  '#.#.###.#.#####.#.###.#.#.#',
  '#...#...#...P...#...#...#.#',
  '#.#####.#########.#####.#.#',
  '#.........................#',
  '###########################',
];

export const MAPS = { small: SMALL_LEVEL, medium: LEVEL, large: LARGE_LEVEL };

export function pointKey({ x, y }) { return `${x},${y}`; }
export function nextPoint(point, direction) {
  const vector = DIRECTIONS[direction];
  return { x: point.x + vector.x, y: point.y + vector.y };
}
export function isWall(game, x, y) { return !game.map[y] || game.map[y][x] === '#'; }
export function canMove(game, point, direction) {
  if (!DIRECTIONS[direction]) return false;
  const next = nextPoint(point, direction);
  return !isWall(game, next.x, next.y);
}
export function opposite(direction) {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[direction];
}

export function createGame(settings = DEFAULT_ROOM_SETTINGS) {
  const mapSize = MAPS[settings.mapSize] ? settings.mapSize : DEFAULT_ROOM_SETTINGS.mapSize;
  const mode = settings.mode === 'time' ? 'time' : 'coin';
  const map = MAPS[mapSize].map(row => row.split(''));
  const dots = new Set();
  let player;
  let ghostHome;
  map.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === '.' && mode === 'coin') dots.add(`${x},${y}`);
    if (cell === 'P') { player = { x, y, direction: 'left' }; map[y][x] = ' '; }
    if (cell === 'G') { ghostHome = { x, y }; map[y][x] = ' '; }
  }));
  return {
    map,
    dots,
    totalDots: dots.size,
    player,
    ghosts: [
      { x: ghostHome.x, y: ghostHome.y, direction: 'left', color: GHOST_COLORS[0] },
      { x: ghostHome.x - 1, y: ghostHome.y, direction: 'right', color: GHOST_COLORS[1] },
      { x: ghostHome.x + 1, y: ghostHome.y, direction: 'left', color: GHOST_COLORS[2] },
      { x: ghostHome.x, y: ghostHome.y + 2, direction: 'up', color: GHOST_COLORS[3] },
    ],
    pendingPlayerDirection: 'left',
    pendingGhostDirections: ['left', 'right', 'left', 'up'],
    playerClock: 0,
    ghostClock: 0,
    mapSize,
    mode,
    remainingMs: mode === 'time' ? Math.max(1, Number(settings.durationSeconds) || 60) * 1000 : null,
    state: 'ready',
  };
}

export function movePlayer(game) {
  if (canMove(game, game.player, game.pendingPlayerDirection)) game.player.direction = game.pendingPlayerDirection;
  if (canMove(game, game.player, game.player.direction)) Object.assign(game.player, nextPoint(game.player, game.player.direction));
  game.dots.delete(pointKey(game.player));
}

export function moveGhost(game, index, direction) {
  const ghost = game.ghosts[index];
  if (!ghost) return;
  if (canMove(game, ghost, direction)) ghost.direction = direction;
  if (canMove(game, ghost, ghost.direction)) Object.assign(ghost, nextPoint(ghost, ghost.direction));
}

export function chooseGhostDirection(game, ghost) {
  const choices = Object.keys(DIRECTIONS).filter(direction => canMove(game, ghost, direction));
  const nonReverse = choices.filter(direction => direction !== opposite(ghost.direction));
  const usable = nonReverse.length ? nonReverse : choices;
  if (!usable.length) return ghost.direction;
  if (Math.random() < 0.3) return usable[Math.floor(Math.random() * usable.length)];
  return usable.sort((a, b) => {
    const aPoint = nextPoint(ghost, a);
    const bPoint = nextPoint(ghost, b);
    return Math.abs(aPoint.x - game.player.x) + Math.abs(aPoint.y - game.player.y)
      - Math.abs(bPoint.x - game.player.x) - Math.abs(bPoint.y - game.player.y);
  })[0];
}

export function hasCollision(game) {
  return game.ghosts.some(ghost => ghost.x === game.player.x && ghost.y === game.player.y);
}

export function serialiseGame(game) {
  return {
    map: game.map,
    dots: [...game.dots],
    totalDots: game.totalDots,
    player: game.player,
    ghosts: game.ghosts,
    mapSize: game.mapSize,
    mode: game.mode,
    remainingMs: game.remainingMs,
    state: game.state,
  };
}
