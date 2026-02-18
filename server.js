const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Connection', 'keep-alive');
  next();
});

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

app.get('/index.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') res.sendStatus(200); else next();
});

const GAME_CONFIG = {
  MAP_WIDTH: 1000, MAP_HEIGHT: 800,
  MIN_PLAYERS_TO_START: 2,
  UPDATE_RATE: 30,
  GAME_DURATION_MS: 600000,
  SPAWN_MIN_DIST: 100, SPAWN_MAX_DIST: 150,
  COLLECTOR_COLLECT_RATE: 15,
  COLLECTOR_CARRY_MAX: 150,
  NODE_REGEN_RATE: 0.4
};

const UNIT_TYPES = {
  soldier:    { health: 30,  maxHealth: 30,  damage: 10, speed: 2,   range: 80,  attackCooldown: 600,  cost: { gold: 30,  energy: 20  } },
  tank:       { health: 120, maxHealth: 120, damage: 22, speed: 0.8, range: 50,  attackCooldown: 900,  cost: { gold: 100, energy: 50  } },
  fighter:    { health: 50,  maxHealth: 50,  damage: 35, speed: 3.2, range: 100, attackCooldown: 400,  cost: { gold: 150, energy: 80  } },
  cannon:     { health: 40,  maxHealth: 40,  damage: 50, speed: 0.4, range: 160, attackCooldown: 1200, cost: { gold: 200, energy: 100 } },
  helicopter: { health: 60,  maxHealth: 60,  damage: 40, speed: 3.8, range: 120, attackCooldown: 500,  cost: { gold: 250, energy: 120 } },
  bomber:     { health: 70,  maxHealth: 70,  damage: 65, speed: 2.2, range: 180, attackCooldown: 1500, cost: { gold: 300, energy: 150 } },
  collector:  { health: 25,  maxHealth: 25,  damage: 0,  speed: 2,   range: 0,   attackCooldown: 9999, cost: { gold: 20,  energy: 10  } }
};

function spawnPosition(baseX, baseY) {
  const angle = Math.random() * Math.PI * 2;
  const dist = GAME_CONFIG.SPAWN_MIN_DIST + Math.random() * (GAME_CONFIG.SPAWN_MAX_DIST - GAME_CONFIG.SPAWN_MIN_DIST);
  return {
    x: Math.max(30, Math.min(GAME_CONFIG.MAP_WIDTH - 30, baseX + Math.cos(angle) * dist)),
    y: Math.max(30, Math.min(GAME_CONFIG.MAP_HEIGHT - 30, baseY + Math.sin(angle) * dist))
  };
}

const RESOURCE_NODES = [
  { id:'node_0',  x:500, y:400, amount:500, maxAmount:500 },
  { id:'node_1',  x:350, y:350, amount:400, maxAmount:400 },
  { id:'node_2',  x:650, y:450, amount:400, maxAmount:400 },
  { id:'node_3',  x:200, y:400, amount:450, maxAmount:450 },
  { id:'node_4',  x:800, y:400, amount:450, maxAmount:450 },
  { id:'node_5',  x:450, y:200, amount:400, maxAmount:400 },
  { id:'node_6',  x:550, y:600, amount:400, maxAmount:400 },
  { id:'node_7',  x:300, y:600, amount:350, maxAmount:350 }
];

class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    console.log('[RESET] Creating fresh game state');
    this.players = new Map();
    this.units = new Map();
    this.bases = new Map();
    this.gameTime = 0;
    this.gameStartTime = null;
    this.gameStatus = 'waiting';
    this.gameStarted = false;
    this.winner = null;
    this.version = '3.1';
    this.messages = [];
  }

  canStartGame() {
    const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
    
    if (alivePlayers.length >= GAME_CONFIG.MIN_PLAYERS_TO_START && !this.gameStarted) {
      console.log('[START_GAME] Game starting with ' + alivePlayers.length + ' players');
      this.gameStatus = 'playing';
      this.gameStarted = true;
      this.gameStartTime = Date.now();
      return true;
    }
    
    if (alivePlayers.length < GAME_CONFIG.MIN_PLAYERS_TO_START) {
      this.gameStatus = 'waiting';
    }
    
    return false;
  }

  isGameFinished() {
    if (this.gameStatus !== 'playing' || !this.gameStarted) {
      return false;
    }

    const alive = Array.from(this.players.values()).filter(p => p.isAlive);
    
    if (alive.length === 0) {
      return false;
    }

    const teams = new Set(alive.map(p => p.team));
    
    if (teams.size === 1) {
      const winner = alive[0].team;
      console.log('[WIN] ' + winner.toUpperCase() + ' TEAM WINS');
      this.gameStatus = 'finished';
      this.winner = winner;
      this.gameStarted = false;
      return true;
    }

    if (this.gameStartTime && Date.now() - this.gameStartTime >= GAME_CONFIG.GAME_DURATION_MS) {
      const teams_array = Array.from(teams);
      let maxKills = 0;
      let winnerTeam = teams_array[0];
      
      for (const team of teams_array) {
        const kills = alive.filter(p => p.team === team).reduce((sum, p) => sum + p.kills, 0);
        if (kills > maxKills) {
          maxKills = kills;
          winnerTeam = team;
        }
      }
      
      console.log('[WIN] TIME - ' + winnerTeam.toUpperCase());
      this.gameStatus = 'finished';
      this.winner = winnerTeam;
      this.gameStarted = false;
      return true;
    }

    return false;
  }
}

let gameState = new GameState();
let unitIdCounter = 0;
let playerIdCounter = 0;
const TEAMS = ['blue', 'red', 'green', 'yellow', 'purple', 'orange'];
const BASE_POSITIONS = [
  { x: 100, y: 100 },
  { x: 900, y: 700 },
  { x: 100, y: 700 },
  { x: 900, y: 100 },
  { x: 500, y: 100 },
  { x: 500, y: 700 }
];

console.log(`\n${'='.repeat(70)}`);
console.log(`🎮 WAR ZONE SERVER V3.1 - SYNC FIX`);
console.log(`${'='.repeat(70)}`);
console.log(`📡 WebSocket broadcasting to ALL clients`);
console.log(`👥 Multi-player: 2-6 players`);
console.log(`${'='.repeat(70)}\n`);

class Player {
  constructor(id, name, team, ws) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.ws = ws;
    const pos = BASE_POSITIONS[TEAMS.indexOf(team)];
    this.baseX = pos.x;
    this.baseY = pos.y;
    this.health = 100;
    this.kills = 0;
    this.gold = 500;
    this.energy = 100;
    this.joinedAt = Date.now();
    this.isAlive = true;

    console.log(`[PLAYER_JOIN] ${name} (${team}) - Total players: ${Array.from(gameState.players.values()).length + 1}`);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (e) {
        console.error(`[SEND_ERROR] ${e.message}`);
      }
    }
  }
}

class Unit {
  constructor(id, playerId, type, x, y, team) {
    this.id = id;
    this.playerId = playerId;
    this.type = type;
    this.x = x;
    this.y = y;
    this.targetX = null;
    this.targetY = null;
    this.vx = 0;
    this.vy = 0;
    this.team = team;

    const stats = UNIT_TYPES[type];
    Object.assign(this, stats);
    
    this.targetId = null;
    this.targetNode = null;
    this.carrying = 0;
    this.lastAttack = 0;
  }

  findTarget(allUnits) {
    let nearest = null;
    let minDist = this.range;

    for (const unit of allUnits) {
      if (unit.team !== this.team && unit.health > 0) {
        const dist = Math.hypot(unit.x - this.x, unit.y - this.y);
        if (dist < minDist) {
          minDist = dist;
          nearest = unit;
        }
      }
    }

    return nearest;
  }

  updateAI(allUnits) {
    const target = this.findTarget(allUnits);

    if (target && this.range > 0) {
      this.targetX = target.x;
      this.targetY = target.y;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0) {
        this.vx = (dx / dist) * this.speed;
        this.vy = (dy / dist) * this.speed;
      }
    } else if (this.targetX !== null && this.targetY !== null) {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 2) {
        this.vx = (dx / dist) * this.speed;
        this.vy = (dy / dist) * this.speed;
      } else {
        this.vx = 0;
        this.vy = 0;
        this.targetX = null;
        this.targetY = null;
      }
    } else {
      this.vx = 0;
      this.vy = 0;
    }
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;

    if (this.x <= 0 || this.x >= GAME_CONFIG.MAP_WIDTH) this.vx *= -1;
    if (this.y <= 0 || this.y >= GAME_CONFIG.MAP_HEIGHT) this.vy *= -1;

    this.x = Math.max(0, Math.min(GAME_CONFIG.MAP_WIDTH, this.x));
    this.y = Math.max(0, Math.min(GAME_CONFIG.MAP_HEIGHT, this.y));
  }
}

class Base {
  constructor(id, playerId, x, y, team) {
    this.id = id;
    this.playerId = playerId;
    this.x = x;
    this.y = y;
    this.health = 500;
    this.maxHealth = 500;
    this.team = team;
  }
}

wss.on('connection', (ws) => {
  console.log(`[CONNECT] Total clients: ${wss.clients.size}`);

  let playerId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'JOIN_GAME':
          playerId = handleJoinGame(ws, data);
          break;

        case 'SPAWN_UNIT':
          if (playerId) handleSpawnUnit(playerId, data);
          break;

        case 'MOVE_UNIT':
          if (playerId) handleMoveUnit(playerId, data);
          break;

        case 'GET_STATE':
          if (playerId) sendGameState(ws, playerId);
          break;

        case 'CHAT_MESSAGE':
          if (playerId) handleChatMessage(playerId, data);
          break;

        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;
      }
    } catch (e) {
      console.error(`[ERROR] ${e.message}`);
    }
  });

  ws.on('close', () => {
    if (playerId) {
      handleDisconnect(playerId);
    }
  });
});

function handleJoinGame(ws, data) {
  if (gameState.gameStatus === 'finished') {
    gameState = new GameState();
    unitIdCounter = 0;
    playerIdCounter = 0;
  }

  const playerId = `player_${++playerIdCounter}`;
  
  const teamCounts = {};
  TEAMS.forEach(t => teamCounts[t] = 0);
  Array.from(gameState.players.values()).forEach(p => {
    if (teamCounts[p.team] !== undefined) teamCounts[p.team]++;
  });
  
  let team = TEAMS[0];
  let minCount = teamCounts[TEAMS[0]];
  for (const t of TEAMS) {
    if (teamCounts[t] < minCount) {
      team = t;
      minCount = teamCounts[t];
    }
  }

  const player = new Player(playerId, data.playerName, team, ws);
  gameState.players.set(playerId, player);

  const baseId = `base_${playerId}`;
  const base = new Base(baseId, playerId, player.baseX, player.baseY, team);
  gameState.bases.set(baseId, base);

  gameState.canStartGame();

  ws.send(JSON.stringify({
    type: 'JOIN_CONFIRMED',
    playerId,
    team,
    baseX: player.baseX,
    baseY: player.baseY,
    version: '3.1',
    gameStatus: gameState.gameStatus
  }));

  // ===== FIX #1: BROADCAST TO ALL CLIENTS =====
  broadcastGameState();
  return playerId;
}

function handleSpawnUnit(playerId, data) {
  const player = gameState.players.get(playerId);
  if (!player || !player.isAlive || gameState.gameStatus !== 'playing') return;

  const unitType = data.unitType;
  const stats = UNIT_TYPES[unitType];
  if (!stats) return;

  if (player.gold < stats.cost.gold || player.energy < stats.cost.energy) return;

  const unitId = `unit_${++unitIdCounter}`;
  const pos = spawnPosition(player.baseX, player.baseY);
  const unit = new Unit(unitId, playerId, unitType, pos.x, pos.y, player.team);

  gameState.units.set(unitId, unit);
  player.gold -= stats.cost.gold;
  player.energy -= stats.cost.energy;

  console.log(`[SPAWN] ${player.name} spawned ${unitType} - Total units: ${gameState.units.size}`);

  // ===== FIX #1: BROADCAST TO ALL CLIENTS =====
  broadcastGameState();
}

function handleMoveUnit(playerId, data) {
  const unit = gameState.units.get(data.unitId);
  if (!unit || unit.playerId !== playerId) return;

  unit.targetX = data.x;
  unit.targetY = data.y;

  // ===== FIX #1: BROADCAST TO ALL CLIENTS =====
  broadcastGameState();
}

function handleChatMessage(playerId, data) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  const msg = data.message.trim();
  if (msg.length === 0) return;

  if (msg.startsWith('/')) {
    handleCommand(playerId, msg);
    return;
  }

  gameState.messages.push({
    playerId,
    playerName: player.name,
    team: player.team,
    message: msg,
    timestamp: Date.now()
  });

  if (gameState.messages.length > 50) {
    gameState.messages.shift();
  }

  broadcastMessage(playerId, msg, player.name, player.team);
}

function handleCommand(playerId, cmd) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  const parts = cmd.split(' ');
  const command = parts[0].toLowerCase();

  let response = '';

  if (command === '/stats') {
    response = `Stats: HP=${player.health} Kills=${player.kills} Gold=${Math.round(player.gold)} Energy=${Math.round(player.energy)}`;
  } else if (command === '/units') {
    const count = Array.from(gameState.units.values()).filter(u => u.playerId === playerId).length;
    response = `You have ${count} units`;
  } else if (command === '/help') {
    response = 'Commands: /stats /units /help';
  } else {
    response = 'Unknown command. Type /help';
  }

  broadcastMessage(playerId, response, 'SYSTEM', player.team);
}

function broadcastMessage(playerId, message, playerName, team) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({
          type: 'CHAT_MESSAGE',
          playerId,
          playerName,
          team,
          message
        }));
      } catch (e) {
        console.error(`[MSG_ERROR] ${e.message}`);
      }
    }
  });
}

function handleDisconnect(playerId) {
  const player = gameState.players.get(playerId);
  if (player) {
    player.isAlive = false;
    player.ws = null;
    console.log(`[DISCONNECT] ${player.name} disconnected`);
  }

  for (const [unitId, unit] of gameState.units) {
    if (unit.playerId === playerId) {
      gameState.units.delete(unitId);
    }
  }

  for (const [baseId, base] of gameState.bases) {
    if (base.playerId === playerId) {
      gameState.bases.delete(baseId);
    }
  }

  gameState.players.delete(playerId);

  const alive = Array.from(gameState.players.values()).filter(p => p.isAlive).length;
  if (alive < GAME_CONFIG.MIN_PLAYERS_TO_START) {
    gameState.gameStatus = 'waiting';
    gameState.gameStarted = false;
  }

  // ===== FIX #1: BROADCAST TO ALL CLIENTS =====
  broadcastGameState();
}

function sendGameState(ws, forPlayerId) {
  const state = buildGameState();
  state.myPlayerId = forPlayerId;

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(state));
    } catch (e) {
      console.error(`[ERROR] ${e.message}`);
    }
  }
}

function buildGameState() {
  const playersList = Array.from(gameState.players.values())
    .filter(p => p.isAlive)
    .map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      baseX: p.baseX,
      baseY: p.baseY,
      health: p.health,
      kills: p.kills,
      gold: p.gold,
      energy: p.energy,
      isAlive: p.isAlive
    }));

  const unitsList = Array.from(gameState.units.values())
    .filter(u => u.health > 0)
    .map(u => ({
      id: u.id,
      playerId: u.playerId,
      type: u.type,
      x: Math.round(u.x),
      y: Math.round(u.y),
      health: Math.round(u.health),
      maxHealth: u.maxHealth,
      team: u.team,
      range: u.range,
      damage: u.damage
    }));

  const basesList = Array.from(gameState.bases.values())
    .map(b => ({
      id: b.id,
      playerId: b.playerId,
      x: b.x,
      y: b.y,
      health: Math.round(b.health),
      maxHealth: b.maxHealth,
      team: b.team
    }));

  gameState.isGameFinished();

  const leaderboard = playersList
    .filter(p => p.isAlive)
    .sort((a, b) => b.kills - a.kills);

  return {
    type: 'GAME_STATE',
    version: '3.1',
    gameTime: gameState.gameTime,
    players: playersList,
    units: unitsList,
    bases: basesList,
    resourceNodes: RESOURCE_NODES,
    leaderboard,
    gameStatus: gameState.gameStatus,
    winner: gameState.winner,
    activeSessions: wss.clients.size,
    messages: gameState.messages.slice(-10)
  };
}

function broadcastGameState() {
  const state = buildGameState();

  console.log(`[BROADCAST] Sending state to ${wss.clients.size} clients - Players: ${state.players.length}, Units: ${state.units.length}`);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(state));
      } catch (e) {
        console.error(`[BROADCAST_ERROR] ${e.message}`);
      }
    }
  });
}

let gameLoopStarted = false;

function startGameLoop() {
  if (gameLoopStarted) return;
  gameLoopStarted = true;

  console.log('[GAMELOOP] Started');

  setInterval(() => {
    if (gameState.gameStatus !== 'playing' || !gameState.gameStarted) {
      return;
    }

    gameState.gameTime++;

    const unitsArray = Array.from(gameState.units.values());

    unitsArray.forEach(unit => {
      unit.updateAI(unitsArray);
      unit.update();

      if (unit.type === 'collector') {
        for (const node of RESOURCE_NODES) {
          const dist = Math.hypot(unit.x - node.x, unit.y - node.y);
          if (dist < 30 && node.amount > 0) {
            unit.carrying = Math.min(GAME_CONFIG.COLLECTOR_CARRY_MAX, unit.carrying + GAME_CONFIG.COLLECTOR_COLLECT_RATE);
            node.amount = Math.max(0, node.amount - GAME_CONFIG.COLLECTOR_COLLECT_RATE);
            break;
          }
        }

        if (unit.carrying >= GAME_CONFIG.COLLECTOR_CARRY_MAX) {
          const player = gameState.players.get(unit.playerId);
          if (player) {
            const distToBase = Math.hypot(unit.x - player.baseX, unit.y - player.baseY);
            if (distToBase < 50) {
              player.gold += unit.carrying;
              unit.carrying = 0;
            } else {
              unit.targetX = player.baseX;
              unit.targetY = player.baseY;
            }
          }
        }
      }
    });

    // Combat
    for (let i = 0; i < unitsArray.length; i++) {
      for (let j = i + 1; j < unitsArray.length; j++) {
        const u1 = unitsArray[i];
        const u2 = unitsArray[j];

        if (u1.team !== u2.team && u1.health > 0 && u2.health > 0 && u1.range > 0) {
          const dist = Math.hypot(u1.x - u2.x, u1.y - u2.y);

          if (dist < 30) {
            const now = Date.now();

            if (now - u1.lastAttack > u1.attackCooldown) {
              const damage = (Math.random() * u1.damage) / 2;
              u2.health = Math.max(0, u2.health - damage);
              u1.lastAttack = now;
            }

            if (now - u2.lastAttack > u2.attackCooldown) {
              const damage = (Math.random() * u2.damage) / 2;
              u1.health = Math.max(0, u1.health - damage);
              u2.lastAttack = now;
            }

            if (u1.health <= 0) {
              gameState.units.delete(u1.id);
              const killer = gameState.players.get(u2.playerId);
              if (killer && killer.isAlive) killer.kills++;
            }

            if (u2.health <= 0) {
              gameState.units.delete(u2.id);
              const killer = gameState.players.get(u1.playerId);
              if (killer && killer.isAlive) killer.kills++;
            }
          }
        }
      }
    }

    // Base damage
    for (const [baseId, base] of gameState.bases) {
      for (const unit of unitsArray) {
        if (unit.health > 0 && unit.team !== base.team) {
          const dist = Math.hypot(unit.x - base.x, unit.y - base.y);
          if (dist < 50) {
            base.health -= unit.damage * 0.05;
          }
        }
      }
    }

    // Check if base destroyed
    for (const [baseId, base] of gameState.bases) {
      if (base.health <= 0) {
        const player = gameState.players.get(base.playerId);
        if (player) {
          player.isAlive = false;
        }
      }
    }

    // Resources generation
    for (const [playerId, player] of gameState.players) {
      if (player.isAlive) {
        player.gold = Math.min(player.gold + 1, 1000);
        player.energy = Math.min(player.energy + 0.5, 500);
      }
    }

    // Node regeneration
    for (const node of RESOURCE_NODES) {
      node.amount = Math.min(node.maxAmount, node.amount + GAME_CONFIG.NODE_REGEN_RATE);
    }

    broadcastGameState();

  }, GAME_CONFIG.UPDATE_RATE);
}

startGameLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎮 WAR ZONE SERVER V3.1 RUNNING ON PORT ${PORT}`);
  console.log(`${'='.repeat(70)}\n`);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Server shutting down...');
  wss.clients.forEach(client => client.close());
  process.exit(0);
});
