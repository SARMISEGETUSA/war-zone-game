const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache'); res.set('Expires', '0'); res.set('Connection', 'keep-alive');
  next();
});
app.use(express.static('public'));
app.get('/index.html', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/', (req, res) => res.redirect('/index.html'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') res.sendStatus(200); else next();
});

const GAME_CONFIG = {
  MAP_WIDTH: 800, MAP_HEIGHT: 700,
  MIN_PLAYERS_TO_START: 2,
  UPDATE_RATE: 30,
  GAME_DURATION_MS: 600000,
  SPAWN_MIN_DIST: 60, SPAWN_MAX_DIST: 100,
  COLLECTOR_COLLECT_RATE: 15,
  COLLECTOR_CARRY_MAX: 150,
  NODE_REGEN_RATE: 0.4
};

// range = shooting distance; units stop at this range and fire projectiles
const UNIT_TYPES = {
  soldier:    { health: 30,  maxHealth: 30,  damage: 10, speed: 2,   range: 80,  attackCooldown: 600,  cost: { gold: 30,  energy: 20  } },
  tank:       { health: 100, maxHealth: 100, damage: 25, speed: 1,   range: 50,  attackCooldown: 900,  cost: { gold: 100, energy: 50  } },
  fighter:    { health: 50,  maxHealth: 50,  damage: 35, speed: 3,   range: 100, attackCooldown: 400,  cost: { gold: 150, energy: 80  } },
  cannon:     { health: 40,  maxHealth: 40,  damage: 50, speed: 0.5, range: 160, attackCooldown: 1200, cost: { gold: 200, energy: 100 } },
  helicopter: { health: 60,  maxHealth: 60,  damage: 40, speed: 4,   range: 120, attackCooldown: 500,  cost: { gold: 250, energy: 120 } },
  bomber:     { health: 80,  maxHealth: 80,  damage: 70, speed: 2.5, range: 180, attackCooldown: 1500, cost: { gold: 300, energy: 150 } },
  collector:  { health: 25,  maxHealth: 25,  damage: 0,  speed: 2,   range: 0,   attackCooldown: 9999, cost: { gold: 20,  energy: 10  } }
};

function spawnPosition(baseX, baseY) {
  const angle = Math.random() * Math.PI * 2;
  const dist  = GAME_CONFIG.SPAWN_MIN_DIST + Math.random() * (GAME_CONFIG.SPAWN_MAX_DIST - GAME_CONFIG.SPAWN_MIN_DIST);
  return {
    x: Math.max(10, Math.min(GAME_CONFIG.MAP_WIDTH  - 10, baseX + Math.cos(angle) * dist)),
    y: Math.max(10, Math.min(GAME_CONFIG.MAP_HEIGHT - 10, baseY + Math.sin(angle) * dist))
  };
}

// Resource nodes – 15 nodes spread across the map
const RESOURCE_NODES = [
  // Center cluster
  { id:'node_0',  x:400, y:350, amount:500, maxAmount:500 },
  { id:'node_1',  x:350, y:310, amount:400, maxAmount:400 },
  { id:'node_2',  x:450, y:390, amount:400, maxAmount:400 },
  // Mid-left / mid-right
  { id:'node_3',  x:180, y:350, amount:450, maxAmount:450 },
  { id:'node_4',  x:620, y:350, amount:450, maxAmount:450 },
  // Top row
  { id:'node_5',  x:260, y:170, amount:350, maxAmount:350 },
  { id:'node_6',  x:400, y:130, amount:350, maxAmount:350 },
  { id:'node_7',  x:540, y:170, amount:350, maxAmount:350 },
  // Bottom row
  { id:'node_8',  x:260, y:530, amount:350, maxAmount:350 },
  { id:'node_9',  x:400, y:570, amount:350, maxAmount:350 },
  { id:'node_10', x:540, y:530, amount:350, maxAmount:350 },
  // Near-base contested
  { id:'node_11', x:190, y:220, amount:300, maxAmount:300 },
  { id:'node_12', x:610, y:480, amount:300, maxAmount:300 },
  { id:'node_13', x:190, y:480, amount:300, maxAmount:300 },
  { id:'node_14', x:610, y:220, amount:300, maxAmount:300 },
];

// ── Projectiles ───────────────────────────────────────────────────────────────
let projectiles = [];
let projIdCounter = 0;

class Projectile {
  constructor(shooterId, shooterPlayerId, shooterTeam, x, y, tx, ty, damage) {
    this.id = `p${++projIdCounter}`;
    this.shooterId = shooterId;
    this.shooterPlayerId = shooterPlayerId;
    this.shooterTeam = shooterTeam;
    const d = Math.hypot(tx - x, ty - y) || 1;
    const spd = 9;
    this.x = x; this.y = y;
    this.vx = (tx - x) / d * spd;
    this.vy = (ty - y) / d * spd;
    this.damage = damage;
    this.alive = true;
    this.maxDist = Math.hypot(tx - x, ty - y) + 15;
    this.travelDist = 0;
  }
  update() {
    this.x += this.vx; this.y += this.vy;
    this.travelDist += Math.hypot(this.vx, this.vy);
    if (this.travelDist >= this.maxDist ||
        this.x < 0 || this.x > GAME_CONFIG.MAP_WIDTH ||
        this.y < 0 || this.y > GAME_CONFIG.MAP_HEIGHT) {
      this.alive = false;
    }
  }
}

// ── Game State ────────────────────────────────────────────────────────────────
class GameState {
  constructor() { this.reset(); }
  reset() {
    this.players = new Map(); this.units = new Map(); this.bases = new Map();
    this.gameTime = 0; this.gameStartTime = null;
    this.gameStatus = 'waiting'; this.gameStarted = false;
    this.winner = null; this.version = '3.0'; this.messages = [];
    projectiles = []; projIdCounter = 0;
    console.log('[RESET] Fresh game state');
  }
  canStartGame() {
    const alive = Array.from(this.players.values()).filter(p => p.isAlive);
    if (alive.length >= GAME_CONFIG.MIN_PLAYERS_TO_START && !this.gameStarted) {
      console.log('[START] ' + alive.length + ' players');
      this.gameStatus = 'playing'; this.gameStarted = true; this.gameStartTime = Date.now(); return true;
    }
    if (alive.length < GAME_CONFIG.MIN_PLAYERS_TO_START) this.gameStatus = 'waiting';
    return false;
  }
  isGameFinished() {
    if (this.gameStatus !== 'playing' || !this.gameStarted) return false;
    const alive = Array.from(this.players.values()).filter(p => p.isAlive);
    if (!alive.length) return false;
    const teams = new Set(alive.map(p => p.team));
    if (teams.size === 1) {
      this.gameStatus = 'finished'; this.winner = alive[0].team; this.gameStarted = false;
      console.log('[WIN]', this.winner.toUpperCase()); return true;
    }
    if (this.gameStartTime && Date.now() - this.gameStartTime >= GAME_CONFIG.GAME_DURATION_MS) {
      let maxK = 0, winTeam = [...teams][0];
      for (const t of teams) {
        const k = alive.filter(p => p.team === t).reduce((s, p) => s + p.kills, 0);
        if (k > maxK) { maxK = k; winTeam = t; }
      }
      this.gameStatus = 'finished'; this.winner = winTeam; this.gameStarted = false;
      console.log('[WIN] TIME', winTeam.toUpperCase()); return true;
    }
    return false;
  }
}

let gameState = new GameState();
let unitIdCounter = 0;
let playerIdCounter = 0;
const TEAMS = ['blue', 'red', 'green', 'yellow', 'purple', 'orange'];
const BASE_POSITIONS = [
  { x:100, y:100 }, { x:700, y:600 },
  { x:100, y:600 }, { x:700, y:100 },
  { x:400, y:100 }, { x:400, y:600 }
];

console.log(`\n${'='.repeat(60)}\n🎮 WAR ZONE SERVER V3.0\n${'='.repeat(60)}\n`);

// ── Player ────────────────────────────────────────────────────────────────────
class Player {
  constructor(id, name, team, ws) {
    this.id = id; this.name = name; this.team = team; this.ws = ws;
    const pos = BASE_POSITIONS[TEAMS.indexOf(team)];
    this.baseX = pos.x; this.baseY = pos.y;
    this.health = 100; this.kills = 0; this.gold = 500; this.energy = 100;
    this.isAlive = true;
    console.log(`[PLAYER] ${name} (${team})`);
  }
  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN)
      try { this.ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

// ── Unit ──────────────────────────────────────────────────────────────────────
class Unit {
  constructor(id, playerId, type, x, y, team) {
    this.id = id; this.playerId = playerId; this.type = type;
    this.x = x; this.y = y; this.team = team;
    this.targetX = null; this.targetY = null;
    this.vx = 0; this.vy = 0;
    Object.assign(this, UNIT_TYPES[type]);
    this.lastAttack = 0;
    this.isShooting = false;
    // Collector
    this.carrying = 0; this.returning = false; this.targetNodeId = null;
  }

  findEnemy(allUnits) {
    const detect = this.range * 1.6;
    let nearest = null, minDist = detect;
    for (const u of allUnits) {
      if (u.team !== this.team && u.health > 0) {
        const d = Math.hypot(u.x - this.x, u.y - this.y);
        if (d < minDist) { minDist = d; nearest = u; }
      }
    }
    return nearest;
  }

  updateAI(allUnits) {
    const enemy = this.findEnemy(allUnits);
    if (enemy) {
      const dist = Math.hypot(enemy.x - this.x, enemy.y - this.y);
      if (dist <= this.range) {
        // In range: stop and shoot
        this.vx = 0; this.vy = 0; this.isShooting = true;
        const now = Date.now();
        if (now - this.lastAttack >= this.attackCooldown) {
          this.lastAttack = now;
          projectiles.push(new Projectile(
            this.id, this.playerId, this.team,
            this.x, this.y, enemy.x, enemy.y, this.damage
          ));
        }
      } else {
        // Chase
        this.isShooting = false;
        const dx = enemy.x - this.x, dy = enemy.y - this.y;
        const d = Math.hypot(dx, dy);
        this.vx = (dx / d) * this.speed;
        this.vy = (dy / d) * this.speed;
      }
    } else if (this.targetX !== null) {
      this.isShooting = false;
      const dx = this.targetX - this.x, dy = this.targetY - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 2) {
        this.vx = (dx / d) * this.speed;
        this.vy = (dy / d) * this.speed;
      } else {
        this.vx = 0; this.vy = 0;
        this.targetX = null; this.targetY = null;
      }
    } else {
      this.vx = 0; this.vy = 0; this.isShooting = false;
    }
  }

  updateCollector(player) {
    if (!player) return;

    if (this.returning) {
      // Head back to base to deposit
      const db = Math.hypot(this.x - player.baseX, this.y - player.baseY);
      if (db < 40) {
        player.gold   += this.carrying;                              // no cap
        player.energy  = Math.min(player.energy + this.carrying * 0.2, 500);
        this.carrying  = 0; this.returning = false; this.targetNodeId = null;
        this.targetX = null; this.targetY = null;
      } else {
        this.targetX = player.baseX; this.targetY = player.baseY;
      }
    } else {
      // Find nearest non-empty node autonomously
      let bestNode = null, bestDist = Infinity;
      for (const node of RESOURCE_NODES) {
        if (node.amount > 0) {
          const d = Math.hypot(this.x - node.x, this.y - node.y);
          if (d < bestDist) { bestDist = d; bestNode = node; }
        }
      }
      if (bestNode) {
        this.targetNodeId = bestNode.id;
        this.targetX = bestNode.x; this.targetY = bestNode.y;
        if (bestDist < 28) {
          const take = Math.min(GAME_CONFIG.COLLECTOR_COLLECT_RATE, bestNode.amount,
                                GAME_CONFIG.COLLECTOR_CARRY_MAX - this.carrying);
          this.carrying += take;
          bestNode.amount = Math.max(0, bestNode.amount - take);
          if (this.carrying >= GAME_CONFIG.COLLECTOR_CARRY_MAX) this.returning = true;
        }
      } else {
        // No resources → idle near base
        if (this.targetX === null) {
          this.targetX = player.baseX + (Math.random() - 0.5) * 80;
          this.targetY = player.baseY + (Math.random() - 0.5) * 80;
        }
      }
    }

    // Move toward target
    if (this.targetX !== null) {
      const dx = this.targetX - this.x, dy = this.targetY - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 4) { this.vx = (dx/d)*this.speed; this.vy = (dy/d)*this.speed; }
      else        { this.vx = 0; this.vy = 0; }
    }
  }

  update() {
    this.x += this.vx; this.y += this.vy;
    if (this.x <= 0 || this.x >= GAME_CONFIG.MAP_WIDTH)  this.vx *= -1;
    if (this.y <= 0 || this.y >= GAME_CONFIG.MAP_HEIGHT)  this.vy *= -1;
    this.x = Math.max(0, Math.min(GAME_CONFIG.MAP_WIDTH,  this.x));
    this.y = Math.max(0, Math.min(GAME_CONFIG.MAP_HEIGHT, this.y));
  }
}

class Base {
  constructor(id, playerId, x, y, team) {
    this.id = id; this.playerId = playerId; this.x = x; this.y = y;
    this.health = 500; this.maxHealth = 500; this.team = team;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      switch (data.type) {
        case 'JOIN_GAME':     playerId = handleJoinGame(ws, data); break;
        case 'SPAWN_UNIT':   if (playerId) handleSpawnUnit(playerId, data); break;
        case 'MOVE_UNIT':    if (playerId) handleMoveUnit(playerId, data); break;
        case 'GET_STATE':    if (playerId) sendGameState(ws, playerId); break;
        case 'CHAT_MESSAGE': if (playerId) handleChatMessage(playerId, data); break;
        case 'PING': ws.send(JSON.stringify({ type: 'PONG' })); break;
      }
    } catch(e) { console.error('[MSG]', e.message); }
  });
  ws.on('close', () => {
    if (playerId) handleDisconnect(playerId);
    gameState.activeSessions = wss.clients.size;
  });
});

function handleJoinGame(ws, data) {
  if (gameState.gameStatus === 'finished') {
    gameState = new GameState(); unitIdCounter = 0; playerIdCounter = 0;
  }
  const playerId = `player_${++playerIdCounter}`;
  const tc = {}; TEAMS.forEach(t => tc[t] = 0);
  gameState.players.forEach(p => { if (tc[p.team] !== undefined) tc[p.team]++; });
  let team = TEAMS[0], minC = tc[TEAMS[0]];
  TEAMS.forEach(t => { if (tc[t] < minC) { team = t; minC = tc[t]; } });

  const player = new Player(playerId, data.playerName, team, ws);
  gameState.players.set(playerId, player);
  const base = new Base(`base_${playerId}`, playerId, player.baseX, player.baseY, team);
  gameState.bases.set(base.id, base);
  gameState.canStartGame();

  ws.send(JSON.stringify({
    type: 'JOIN_CONFIRMED', playerId, team,
    baseX: player.baseX, baseY: player.baseY,
    version: '3.0', gameStatus: gameState.gameStatus
  }));
  broadcastGameState();
  return playerId;
}

const MAX_COLLECTORS_PER_PLAYER = 5;

function handleSpawnUnit(playerId, data) {
  const player = gameState.players.get(playerId);
  if (!player || !player.isAlive || gameState.gameStatus !== 'playing') return;
  const stats = UNIT_TYPES[data.unitType];
  if (!stats || player.gold < stats.cost.gold || player.energy < stats.cost.energy) return;

  // Limit collectors per player
  if (data.unitType === 'collector') {
    const collectorCount = Array.from(gameState.units.values())
      .filter(u => u.playerId === playerId && u.type === 'collector').length;
    if (collectorCount >= MAX_COLLECTORS_PER_PLAYER) {
      broadcastMessage(playerId,
        `❌ Limita de ${MAX_COLLECTORS_PER_PLAYER} collectors atinsa!`,
        'SYSTEM', player.team);
      return;
    }
  }

  const pos = spawnPosition(player.baseX, player.baseY);
  const unit = new Unit(`unit_${++unitIdCounter}`, playerId, data.unitType, pos.x, pos.y, player.team);
  gameState.units.set(unit.id, unit);
  player.gold -= stats.cost.gold; player.energy -= stats.cost.energy;
  broadcastGameState();
}

function handleMoveUnit(playerId, data) {
  const unit = gameState.units.get(data.unitId);
  if (!unit || unit.playerId !== playerId) return;
  unit.targetX = data.x; unit.targetY = data.y;
  if (unit.type === 'collector') { unit.returning = false; unit.targetNodeId = null; }
}

function handleChatMessage(playerId, data) {
  const player = gameState.players.get(playerId);
  if (!player) return;
  const msg = data.message.trim(); if (!msg) return;
  if (msg.startsWith('/')) { handleCommand(playerId, msg); return; }
  gameState.messages.push({ playerId, playerName: player.name, team: player.team, message: msg, timestamp: Date.now() });
  if (gameState.messages.length > 50) gameState.messages.shift();
  broadcastMessage(playerId, msg, player.name, player.team);
}

function handleCommand(playerId, cmd) {
  const player = gameState.players.get(playerId); if (!player) return;
  const command = cmd.split(' ')[0].toLowerCase();
  let r = '';
  if (command === '/stats') r = `HP=${player.health} K=${player.kills} G=${Math.round(player.gold)} E=${Math.round(player.energy)}`;
  else if (command === '/units') r = `Units: ${Array.from(gameState.units.values()).filter(u=>u.playerId===playerId).length}`;
  else if (command === '/time')  r = `Time: ${gameState.gameStartTime ? Math.floor((Date.now()-gameState.gameStartTime)/1000) : 0}s`;
  else if (command === '/help')  r = '/stats /units /time /heal /boost /list';
  else if (command === '/heal')  { player.health = Math.min(100, player.health+20); r = '+20 HP'; }
  else if (command === '/boost') { player.gold += 100; r = '+100 Gold'; }
  else if (command === '/list')  r = Array.from(gameState.players.values()).filter(p=>p.isAlive).map(p=>`${p.name}(${p.team})[${p.kills}K]`).join(', ');
  else r = 'Unknown. /help';
  broadcastMessage(playerId, r, 'SYSTEM', player.team);
}

function broadcastMessage(playerId, message, playerName, team) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN)
      try { c.send(JSON.stringify({ type: 'CHAT_MESSAGE', playerId, playerName, team, message })); } catch(e) {}
  });
}

function handleDisconnect(playerId) {
  const player = gameState.players.get(playerId);
  if (player) { player.isAlive = false; player.ws = null; }
  gameState.units.forEach((u, id) => { if (u.playerId === playerId) gameState.units.delete(id); });
  gameState.bases.forEach((b, id) => { if (b.playerId === playerId) gameState.bases.delete(id); });
  gameState.players.delete(playerId);
  if (Array.from(gameState.players.values()).filter(p=>p.isAlive).length < GAME_CONFIG.MIN_PLAYERS_TO_START) {
    gameState.gameStatus = 'waiting'; gameState.gameStarted = false;
  }
  broadcastGameState();
}

function sendGameState(ws, forPlayerId) {
  const st = buildGameState(); st.myPlayerId = forPlayerId;
  if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(st)); } catch(e) {}
}

function buildGameState() {
  const playersList = Array.from(gameState.players.values()).filter(p=>p.isAlive).map(p => ({
    id:p.id, name:p.name, team:p.team, baseX:p.baseX, baseY:p.baseY,
    health:p.health, kills:p.kills, gold:p.gold, energy:p.energy, isAlive:p.isAlive
  }));
  const unitsList = Array.from(gameState.units.values()).filter(u=>u.health>0).map(u => ({
    id:u.id, playerId:u.playerId, type:u.type,
    x:Math.round(u.x), y:Math.round(u.y),
    targetX:u.targetX!=null?Math.round(u.targetX):undefined,
    targetY:u.targetY!=null?Math.round(u.targetY):undefined,
    health:Math.round(u.health), maxHealth:u.maxHealth,
    team:u.team, range:u.range, damage:u.damage,
    isShooting:u.isShooting||false,
    carrying:u.carrying||0, returning:u.returning||false
  }));
  const basesList = Array.from(gameState.bases.values()).map(b => ({
    id:b.id, playerId:b.playerId, x:b.x, y:b.y,
    health:Math.round(b.health), maxHealth:b.maxHealth, team:b.team
  }));
  const projList = projectiles.filter(p=>p.alive).map(p => ({
    id:p.id, x:Math.round(p.x), y:Math.round(p.y), team:p.shooterTeam
  }));
  gameState.isGameFinished();
  return {
    type:'GAME_STATE', version:'3.0', gameTime:gameState.gameTime,
    players:playersList, units:unitsList, bases:basesList,
    resourceNodes:RESOURCE_NODES, projectiles:projList,
    leaderboard:[...playersList].sort((a,b)=>b.kills-a.kills),
    gameStatus:gameState.gameStatus, winner:gameState.winner,
    activeSessions:wss.clients.size, messages:gameState.messages.slice(-10)
  };
}

function broadcastGameState() {
  const st = buildGameState();
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) try { c.send(JSON.stringify(st)); } catch(e) {}
  });
}

// ── Game Loop ─────────────────────────────────────────────────────────────────
function startGameLoop() {
  console.log('[GAMELOOP] Started');
  setInterval(() => {
    if (gameState.gameStatus !== 'playing' || !gameState.gameStarted) return;
    gameState.gameTime++;
    const unitsArray = Array.from(gameState.units.values());

    // Unit AI
    unitsArray.forEach(unit => {
      if (unit.type === 'collector') {
        unit.updateCollector(gameState.players.get(unit.playerId));
      } else {
        unit.updateAI(unitsArray);
      }
      unit.update();
    });

    // Projectile tick + hit detection
    projectiles.forEach(proj => {
      if (!proj.alive) return;
      proj.update();
      if (!proj.alive) return;

      // Hit units
      for (const unit of unitsArray) {
        if (unit.team === proj.shooterTeam || unit.health <= 0) continue;
        if (Math.hypot(unit.x - proj.x, unit.y - proj.y) < 10) {
          unit.health = Math.max(0, unit.health - proj.damage);
          proj.alive = false;
          if (unit.health <= 0) {
            gameState.units.delete(unit.id);
            // Credit kill to shooter
            const shooter = unitsArray.find(u => u.id === proj.shooterId);
            if (shooter) {
              const killer = gameState.players.get(shooter.playerId);
              if (killer?.isAlive) killer.kills++;
            }
          }
          break;
        }
      }

      // Hit bases
      if (!proj.alive) return;
      for (const [, base] of gameState.bases) {
        if (base.team === proj.shooterTeam) continue;
        if (Math.hypot(base.x - proj.x, base.y - proj.y) < 28) {
          base.health = Math.max(0, base.health - proj.damage * 0.25);
          proj.alive = false; break;
        }
      }
    });
    projectiles = projectiles.filter(p => p.alive);

    // Light contact pressure on bases from nearby units
    for (const [, base] of gameState.bases) {
      for (const unit of unitsArray) {
        if (unit.health > 0 && unit.team !== base.team &&
            Math.hypot(unit.x - base.x, unit.y - base.y) < 38) {
          base.health -= unit.damage * 0.015;
        }
      }
    }

    // Base destroyed → player eliminated
    for (const [, base] of gameState.bases) {
      if (base.health <= 0) {
        const p = gameState.players.get(base.playerId);
        if (p) p.isAlive = false;
      }
    }

    // Node slow regen
    RESOURCE_NODES.forEach(n => {
      if (n.amount < n.maxAmount) n.amount = Math.min(n.maxAmount, n.amount + GAME_CONFIG.NODE_REGEN_RATE);
    });

    // Passive income – no gold cap
    for (const [, p] of gameState.players) {
      if (p.isAlive) {
        p.gold   += 0.5;                                      // unlimited gold
        p.energy = Math.min(p.energy + 0.3, 500);            // energy still capped at 500
      }
    }

    broadcastGameState();
  }, GAME_CONFIG.UPDATE_RATE);
}

startGameLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮 WAR ZONE V3.0 → port ${PORT}\n`));
process.on('SIGINT', () => { wss.clients.forEach(c => c.close()); process.exit(0); });
