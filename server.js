"use strict";

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONSTANTS ====================
const TEAM_DEFS = [
  { id: 'red',    name: '红队', color: '#e74c3c', emoji: '🔴' },
  { id: 'blue',   name: '蓝队', color: '#3498db', emoji: '🔵' },
  { id: 'green',  name: '绿队', color: '#2ecc71', emoji: '🟢' },
  { id: 'yellow', name: '黄队', color: '#f1c40f', emoji: '🟡' },
];

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

// ==================== PERSISTENT STATS ====================
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
  catch (e) { console.error('[stats] save error:', e.message); }
}
let globalStats = loadStats();

// ==================== MAP DEFINITION ====================
function buildMap(teamDefs) {
  const locations = {};
  const gridPos = {};
  locations['main'] = { id: 'main', name: '主岛', team: null, isBed: false, conns: [] };
  gridPos['main'] = { x: 50, y: 50 };

  // Shared shop, connected only to main island
  locations['shop'] = { id: 'shop', name: '🏪商店', team: null, isBed: false, conns: ['main'] };
  gridPos['shop'] = { x: 64, y: 64 };
  locations['main'].conns.push('shop');
  const n = teamDefs.length;

  function addTeam(teamDef, bx, by, lx, ly, ux, uy) {
    const b = teamDef.id + '_bridge', l = teamDef.id + '_lower', u = teamDef.id + '_upper';
    locations[b] = { id: b, name: teamDef.name + '桥', team: teamDef.id, isBed: false, conns: ['main', l] };
    locations[l] = { id: l, name: '下层', team: teamDef.id, isBed: false, conns: [b, u] };
    locations[u] = { id: u, name: '床', team: teamDef.id, isBed: true, conns: [l] };
    gridPos[b] = { x: bx, y: by };
    gridPos[l] = { x: lx, y: ly };
    gridPos[u] = { x: ux, y: uy };
    locations['main'].conns.push(b);
  }

  if (n === 2) {
    addTeam(teamDefs[0], 38, 50, 26, 50, 14, 50);
    addTeam(teamDefs[1], 62, 50, 74, 50, 86, 50);
  } else if (n === 3) {
    addTeam(teamDefs[0], 50, 38, 50, 26, 50, 14);
    addTeam(teamDefs[1], 62, 50, 74, 50, 86, 50);
    addTeam(teamDefs[2], 50, 62, 50, 74, 50, 86);
  } else {
    addTeam({ id: 'blue',   name: '蓝队', color: '#3498db', emoji: '🔵' }, 50, 38, 50, 26, 50, 14);
    addTeam({ id: 'red',    name: '红队', color: '#e74c3c', emoji: '🔴' }, 62, 50, 74, 50, 86, 50);
    addTeam({ id: 'green',  name: '绿队', color: '#2ecc71', emoji: '🟢' }, 50, 62, 50, 74, 50, 86);
    addTeam({ id: 'yellow', name: '黄队', color: '#f1c40f', emoji: '🟡' }, 38, 50, 26, 50, 14, 50);
  }
  return { locations, gridPos };
}

// ==================== GAME ROOM CLASS ====================
class GameRoom {
  constructor(code, numTeams) {
    this.code = code;
    this.teams = TEAM_DEFS.slice(0, numTeams).map(t => ({
      id: t.id, name: t.name, color: t.color, emoji: t.emoji, bedAlive: true, defense: 0
    }));
    this.players = [];        // { id, name, team, location, alive, sid }
    this.phase = 'lobby';    // lobby | rps | reveal | action | gameover
    this.rpsChoices = {};    // playerId -> choice
    this.rpsRevealed = false;
    this.winners = [];       // playerIds
    this.loserCount = 0;
    this.winnerActions = {}; // playerId -> remaining
    this.winnerOrder = [];   // shuffled order of playerIds
    this.winnerIdx = 0;
    this.logEntries = [];
    this.chatMessages = [];
    this.winnerTeam = null;
    this.lastWinner = null;  // persisted across games, displayed in lobby
    this.roundStats = {};     // playerId -> { kills, bedsDestroyed }
    this.lastEvents = [];     // recent events for toast/sfx on clients
    this.rpsHistory = {};     // playerId -> ['rock', 'paper', ...]
    this.roundNumber = 0;     // current round count

    const map = buildMap(this.teams);
    this.locations = map.locations;
    this.gridPos = map.gridPos;
  }

  addLog(msg, type) {
    this.logEntries.unshift({ msg, type, time: Date.now() });
    if (this.logEntries.length > 80) this.logEntries.length = 80;
  }

  addChat(sender, team, msg) {
    this.chatMessages.push({ sender, team, msg, time: Date.now() });
    if (this.chatMessages.length > 100) this.chatMessages.shift();
  }

  addPlayer(sid, name) {
    for (const t of this.teams) {
      if (!this.players.some(p => p.team === t.id)) {
        const p = {
          id: this.players.length + 1,
          name: name || (t.emoji + ' ' + t.name + '战士'),
          team: t.id,
          location: t.id + '_lower',
          alive: false,
          sid: sid,
          connected: true,
          pickaxe: 0,  enderPearl: 0,  tnt: false,
          respawning: false,  respawnRound: 0,
          shopPoints: 0,
        };
        this.players.push(p);
        this.addLog(`${t.emoji} ${p.name} 加入房间`, 'info');
        return p;
      }
    }
    return null;
  }

  alivePlayers() {
    return this.players.filter(p => p.alive && !p.respawning && p.connected !== false);
  }

  teamHasBed(tid) {
    const t = this.teams.find(t => t.id === tid);
    return t ? t.bedAlive : false;
  }

  teamEliminated(tid) {
    if (this.teamHasBed(tid)) return false;
    return this.players.filter(p => p.alive && p.team === tid && p.connected !== false).length === 0;
  }

  activeTeams() {
    return this.teams.filter(t => !this.teamEliminated(t.id));
  }

  allClaimed() {
    return this.players.length >= this.teams.length;
  }

  // ======== GAME START ========
  startGame() {
    const map = buildMap(this.teams);
    this.locations = map.locations;
    this.gridPos = map.gridPos;
    for (const p of this.players) {
      p.location = p.team + '_lower';
      p.alive = true;
      p.connected = true;
      p.pickaxe = 0;  p.enderPearl = 0;  p.tnt = false;
      p.respawning = false;  p.respawnRound = 0;
      p.shopPoints = 0;
    }
    for (const t of this.teams) t.defense = 0;
    this.phase = 'rps';
    this.roundNumber = 1;
    this.rpsChoices = {};
    this.rpsRevealed = false;
    this.winners = [];
    this.loserCount = 0;
    this.winnerActions = {};
    this.winnerOrder = [];
    this.winnerIdx = 0;
    this.logEntries = [];
    this.winnerTeam = null;
    this.lastWinner = null;
    this.roundStats = {};
    for (const p of this.players) this.roundStats[p.id] = { kills: 0, bedsDestroyed: 0 };
    this.lastEvents = [];
    this.rpsHistory = {};
    this.roundNumber = 1;
    for (const p of this.players) { this.roundStats[p.id] = { kills: 0, bedsDestroyed: 0 }; this.rpsHistory[p.id] = []; }
    this.addLog(`🎮 游戏开始！${this.teams.length} 支队伍展开对决！`, 'info');
  }

  // ======== RPS LOGIC ========
  submitRPS(playerId, choice) {
    if (this.phase !== 'rps') return false;
    if (this.rpsChoices[playerId] !== undefined) return false;
    const p = this.players.find(pl => pl.id === playerId);
    if (!p || !p.alive) return false;
    this.rpsChoices[playerId] = choice;
    return true;
  }

  allRPSReady() {
    const alive = this.alivePlayers();
    return alive.length > 0 && alive.every(p => this.rpsChoices[p.id] !== undefined);
  }

  resolveRPS() {
    this.rpsRevealed = true;
    this.phase = 'reveal';

    const alive = this.alivePlayers();
    const choices = this.rpsChoices;

    // Record history for each alive player
    for (const p of alive) {
      if (!this.rpsHistory[p.id]) this.rpsHistory[p.id] = [];
      this.rpsHistory[p.id].push(choices[p.id]);
    }
    const scores = {};
    for (const p of alive) scores[p.id] = 0;

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const ca = choices[alive[i].id], cb = choices[alive[j].id];
        if (ca === cb) continue;
        if (BEATS[ca] === cb) scores[alive[i].id]++;
        else scores[alive[j].id]++;
      }
    }

    const maxScore = Math.max(...Object.values(scores));
    const winners = alive.filter(p => scores[p.id] === maxScore);

    if (maxScore === 0 || winners.length === alive.length) {
      this.addLog('🤝 本轮平局！无人获得行动权', 'warn');
      this.winners = [];
      this.loserCount = alive.length;
      this.winnerActions = {};
      this.winnerOrder = [];
      this.winnerIdx = 0;
      setTimeout(() => { this.startNextRound(); broadcast(this); }, 1500);
      return;
    }

    const loserCount = alive.length - winners.length;
    this.winners = winners.map(p => p.id);
    this.loserCount = loserCount;
    this.winnerActions = {};
    this.winnerOrder = [...this.winners].sort(() => Math.random() - 0.5);

    for (const pid of this.winnerOrder) {
      this.winnerActions[pid] = Math.max(1, loserCount);
    }
    this.winnerIdx = 0;
    this.advanceToNextAlive();

    const names = winners.map(p => p.name).join(', ');
    this.addLog(`🏆 ${names} 获胜！各获得 ${Math.max(1, loserCount)} 次行动`, 'good');

    setTimeout(() => {
      this.phase = 'action';
      this.advanceToNextAlive();
      broadcast(this);
    }, 1500);
  }

  // ======== ACTION LOGIC ========
  advanceToNextAlive() {
    const orig = this.winnerIdx;
    for (let i = 0; i < this.winnerOrder.length; i++) {
      const idx = (orig + i) % this.winnerOrder.length;
      const pid = this.winnerOrder[idx];
      const p = this.players.find(pl => pl.id === pid);
      if (p && p.alive && p.connected !== false) {
        this.winnerIdx = idx;
        return;
      }
    }
    this.winnerOrder = [];
    this.winnerActions = {};
  }

  currentActor() {
    if (this.phase !== 'action' || this.winnerOrder.length === 0) return null;
    const pid = this.winnerOrder[this.winnerIdx];
    return this.players.find(pl => pl.id === pid) || null;
  }

  performMove(playerId, targetId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;

    const loc = this.locations[actor.location];
    if (!loc || !loc.conns.includes(targetId)) return false;

    actor.location = targetId;
    if (actor.shopPoints > 0 && targetId !== 'shop') {
      this.addLog(`💸 ${this.teamEmoji(actor.team)} ${actor.name} 离开商店，储蓄清零`, '');
      actor.shopPoints = 0;
    }
    this.winnerActions[actor.id]--;
    this.addLog(`🚶 ${this.teamEmoji(actor.team)} ${actor.name} 移动到 ${this.locations[targetId].name}`, '');
    this.advanceAction();
    return true;
  }

  performKill(playerId, targetPid) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;

    const target = this.players.find(p => p.id === targetPid);
    if (!target || !target.alive || target.location !== actor.location || target.team === actor.team) return false;

    target.alive = false;
    target.respawning = true;
    target.respawnRound = this.roundNumber + 2;
    target.pickaxe = Math.max(1, target.pickaxe - 1);
    target.enderPearl = 0;
    target.tnt = false;
    target.shopPoints = 0;
    target.location = target.team + '_lower';
    this.winnerActions[actor.id]--;
    this.roundStats[actor.id].kills++;
    this.lastEvents.push({ type: 'kill', killerTeam: actor.team, killerName: actor.name, targetTeam: target.team, targetName: target.name });
    this.addLog(`⚔️ ${this.teamEmoji(actor.team)} ${actor.name} 击杀了 ${this.teamEmoji(target.team)} ${target.name}！`, 'warn');

    if (this.teamEliminated(target.team)) {
      this.teams.find(t => t.id === target.team).bedAlive = false;
      this.addLog(`💀 ${this.teamName(target.team)} 被淘汰！全员阵亡`, 'warn');
    }

    if (this.checkWin()) return true;
    this.advanceAction();
    return true;
  }

  performDestroyBed(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;

    const loc = this.locations[actor.location];
    if (!loc || !loc.isBed || loc.team === actor.team) return false;

    const t = this.teams.find(t => t.id === loc.team);
    if (!t || !t.bedAlive) return false;
    if (t.defense > 0) return false;  // must break defense first

    t.bedAlive = false;
    this.winnerActions[actor.id]--;
    this.roundStats[actor.id].bedsDestroyed++;
    this.lastEvents.push({ type: 'bedDestroy', killerTeam: actor.team, killerName: actor.name, targetTeam: t.id });
    this.addLog(`🛏️ ${this.teamEmoji(actor.team)} ${actor.name} 摧毁了 ${this.teamName(t.id)} 的床！`, 'warn');

    if (this.teamEliminated(t.id)) {
      this.addLog(`💀 ${this.teamName(t.id)} 被淘汰！床已摧毁，全员阵亡`, 'warn');
    }

    if (this.checkWin()) return true;
    this.advanceAction();
    return true;
  }

  passAction(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    const remaining = this.winnerActions[actor.id] || 0;
    this.winnerActions[actor.id] = 0;
    this.addLog(`⏭️ ${this.teamEmoji(actor.team)} ${actor.name} 放弃了剩余的 ${remaining} 次行动`, '');
    this.advanceAction(true);
    return true;
  }

  // ======== SHOP & ITEMS ========
  save(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;
    if (actor.location !== 'shop') return false;
    actor.shopPoints++;
    this.winnerActions[actor.id]--;
    this.addLog(`💰 ${this.teamEmoji(actor.team)} ${actor.name} 储蓄行动点 (共${actor.shopPoints}点)`, '');
    this.advanceAction();
    return true;
  }

  buy(playerId, item) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if (actor.location !== 'shop') return false;
    const myTeam = this.teams.find(t => t.id === actor.team);
    if (!myTeam) return false;

    const actions = this.winnerActions[actor.id] || 0;
    const savings = actor.shopPoints || 0;
    const total = actions + savings;

    if (item === 'defense') {
      const cost = myTeam.defense < 10 ? 1 : 2;
      if (myTeam.defense >= 20) return false;
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      myTeam.defense++;
      this.addLog(`🛡️ ${this.teamEmoji(actor.team)} ${actor.name} 加固了床防御 (${myTeam.defense}层)`, '');
    } else if (item === 'pickaxe') {
      const costs = { 0:1, 1:2, 2:3 };
      const level = actor.pickaxe;
      if (level >= 3) return false;
      const cost = costs[level];
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      actor.pickaxe++;
      const names = ['无镐','木镐','铁镐','钻石镐'];
      this.addLog(`⛏️ ${this.teamEmoji(actor.team)} ${actor.name} 升级到 ${names[actor.pickaxe]}`, '');
    } else if (item === 'enderPearl') {
      const cost = 3;
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      actor.enderPearl++;
      this.addLog(`🟣 ${this.teamEmoji(actor.team)} ${actor.name} 购买了末影珍珠 (共${actor.enderPearl}颗)`, '');
    } else if (item === 'tnt') {
      const cost = 4;
      if (actor.tnt) return false;
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      actor.tnt = true;
      this.addLog(`💣 ${this.teamEmoji(actor.team)} ${actor.name} 购买了TNT`, '');
    } else {
      return false;
    }
    this.advanceAction();
    return true;
  }

  breakDefense(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;
    const loc = this.locations[actor.location];
    if (!loc || !loc.isBed || loc.team === actor.team) return false;
    const targetTeam = this.teams.find(t => t.id === loc.team);
    if (!targetTeam || targetTeam.defense <= 0) return false;

    const multi = [1, 2, 3, 5][actor.pickaxe];
    const removed = Math.min(multi, targetTeam.defense);
    targetTeam.defense -= removed;
    this.winnerActions[actor.id]--;
    this.addLog(`⛏️ ${this.teamEmoji(actor.team)} ${actor.name} 拆除了 ${this.teamName(targetTeam.id)} ${removed}层防御 (剩余${targetTeam.defense})`, 'warn');
    this.lastEvents.push({ type: 'breakDef', team: actor.team, targetTeam: targetTeam.id, removed, remaining: targetTeam.defense });
    this.advanceAction();
    return true;
  }

  useTNT(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if (!actor.tnt) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;
    const loc = this.locations[actor.location];
    if (!loc || !loc.isBed || loc.team === actor.team) return false;
    const targetTeam = this.teams.find(t => t.id === loc.team);
    if (!targetTeam || targetTeam.defense <= 0) return false;

    const blown = targetTeam.defense;
    targetTeam.defense = 0;
    actor.tnt = false;
    this.winnerActions[actor.id]--;
    this.addLog(`💥 ${this.teamEmoji(actor.team)} ${actor.name} 用TNT炸毁了 ${this.teamName(targetTeam.id)} 全部${blown}层防御！`, 'warn');
    this.lastEvents.push({ type: 'tnt', team: actor.team, killerName: actor.name, targetTeam: targetTeam.id, blown });
    this.advanceAction();
    return true;
  }

  useEnderPearl(playerId, targetId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if (actor.enderPearl <= 0) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;
    if (!this.locations[targetId]) return false;

    actor.enderPearl--;
    actor.location = targetId;
    this.winnerActions[actor.id]--;
    this.addLog(`🟣 ${this.teamEmoji(actor.team)} ${actor.name} 用末影珍珠传送到 ${this.locations[targetId].name}`, '');
    this.lastEvents.push({ type: 'pearl', team: actor.team, killerName: actor.name, loc: targetId });
    this.advanceAction();
    return true;
  }

  suicide(playerId) {
    const actor = this.currentActor();
    if (!actor || actor.id !== playerId) return false;
    if ((this.winnerActions[actor.id] || 0) <= 0) return false;

    actor.alive = false;
    actor.respawning = true;
    actor.respawnRound = this.roundNumber + 2;
    actor.pickaxe = Math.max(1, actor.pickaxe - 1);
    actor.enderPearl = 0;
    actor.tnt = false;
    actor.shopPoints = 0;
    actor.location = actor.team + '_lower';
    this.winnerActions[actor.id]--;
    this.addLog(`💀 ${this.teamEmoji(actor.team)} ${actor.name} 自杀了`, 'warn');
    this.lastEvents.push({ type: 'suicide', team: actor.team, killerName: actor.name });
    if (this.checkWin()) return true;
    this.advanceAction();
    return true;
  }

  advanceAction(force = false) {
    if (this.winnerTeam !== null) return;

    const pid = this.winnerOrder.length > 0 ? this.winnerOrder[this.winnerIdx] : null;
    const rem = pid ? (this.winnerActions[pid] || 0) : 0;

    if (rem <= 0 || force) {
      this.winnerIdx++;
      if (this.winnerIdx >= this.winnerOrder.length) {
        this.startNextRound();
        return;
      }
      this.advanceToNextAlive();
      const next = this.currentActor();
      if (!next || (this.winnerActions[next.id] || 0) <= 0) {
        this.startNextRound();
        return;
      }
    }
  }

  checkWin() {
    const active = this.activeTeams();
    if (active.length <= 1) {
      if (active.length === 1) {
        this.winnerTeam = active[0].id;
        this.lastWinner = active[0].id;
        this.phase = 'gameover';
        this.addLog(`🎉 ${active[0].name} 获得最终胜利！🏆`, 'good');
      } else {
        this.winnerTeam = null;
        this.lastWinner = null;
        this.phase = 'gameover';
        this.addLog('💀 所有队伍全军覆没！', 'warn');
      }
      this.saveGameStats();
      this.lastEvents.push({ type: 'gameover', winnerTeam: this.winnerTeam });
      setTimeout(() => this.returnToLobby(), 8000);
      return true;
    }
    return false;
  }

  saveGameStats() {
    const winner = this.winnerTeam;
    for (const p of this.players) {
      const key = p.name;
      if (!globalStats[key]) globalStats[key] = { wins: 0, kills: 0, bedsDestroyed: 0, games: 0 };
      globalStats[key].games++;
      if (p.team === winner) globalStats[key].wins++;
      const rs = this.roundStats[p.id] || { kills: 0, bedsDestroyed: 0 };
      globalStats[key].kills += rs.kills;
      globalStats[key].bedsDestroyed += rs.bedsDestroyed;
    }
    saveStats(globalStats);
  }

  returnToLobby() {
    for (const t of this.teams) { t.bedAlive = true; t.defense = 0; }
    for (const p of this.players) {
      p.alive = false;
      p.location = p.team + '_lower';
      p.connected = p.connected !== false;
      p.pickaxe = 0; p.enderPearl = 0; p.tnt = false;
      p.respawning = false; p.respawnRound = 0;
      p.shopPoints = 0;
    }
    this.phase = 'lobby';
    this.rpsChoices = {};
    this.rpsRevealed = false;
    this.winners = [];
    this.loserCount = 0;
    this.winnerActions = {};
    this.winnerOrder = [];
    this.winnerIdx = 0;
    this.winnerTeam = null;
    this.logEntries = [];
    this.addLog('🔄 回到房间，聊天继续。可以开始下一局！', 'info');
    broadcast(this);
  }

  startNextRound() {
    this.roundNumber++;
    for (const p of this.players) {
      if (p.respawning && this.roundNumber >= p.respawnRound && this.teamHasBed(p.team) && p.connected !== false) {
        p.alive = true;
        p.respawning = false;
        p.location = p.team + '_lower';
        this.addLog(`🔄 ${this.teamEmoji(p.team)} ${p.name} 复活！`, 'good');
      }
    }

    if (this.checkWin()) return;

    this.rpsChoices = {};
    this.rpsRevealed = false;
    this.winners = [];
    this.loserCount = 0;
    this.winnerActions = {};
    this.winnerOrder = [];
    this.winnerIdx = 0;
    this.phase = 'rps';
  }

  teamEmoji(tid) { const t = this.teams.find(x => x.id === tid); return t ? t.emoji : '⚪'; }
  teamName(tid) { const t = this.teams.find(x => x.id === tid); return t ? t.name : tid; }
  teamColor(tid) { const t = this.teams.find(x => x.id === tid); return t ? t.color : '#888'; }

  // ======== PUBLIC STATE ========
  getState(forPid) {
    return {
      code: this.code,
      phase: this.phase,
      teams: this.teams,
      players: this.players.map(p => ({ id: p.id, name: p.name, team: p.team, location: p.location, alive: p.alive, connected: p.connected !== false, respawning: p.respawning, pickaxe: p.pickaxe, enderPearl: p.enderPearl, tnt: p.tnt, shopPoints: p.shopPoints })),
      locations: this.locations,
      gridPos: this.gridPos,
      rpsRevealed: this.rpsRevealed,
      rpsChoices: this.rpsRevealed ? this.rpsChoices : null,
      rpsMyChoice: forPid ? (this.rpsChoices[forPid] || null) : null,
      rpsReady: forPid ? (this.rpsChoices[forPid] !== undefined) : false,
      rpsReadyPlayers: (!this.rpsRevealed) ? Object.keys(this.rpsChoices).map(Number) : null,
      rpsAllReady: this.phase === 'rps' && this.allRPSReady(),
      winners: this.winners,
      loserCount: this.loserCount,
      winnerOrder: this.winnerOrder,
      winnerIdx: this.winnerIdx,
      winnerActions: this.winnerActions,
      logEntries: this.logEntries.slice(0, 20),
      winnerTeam: this.winnerTeam,
      lastWinner: this.lastWinner,
      myPlayerId: forPid,
      currentActorId: this.currentActor() ? this.currentActor().id : null,
      allClaimed: this.allClaimed(),
      lastEvents: this.lastEvents.splice(0, this.lastEvents.length), // consume and send
      stats: forPid ? (globalStats[this.players.find(p => p.id === forPid)?.name] || null) : null,
      rpsHistory: this.rpsHistory,
    };
  }
}

// ==================== ROOM MANAGER ====================
const rooms = {};           // code -> GameRoom
const socketRooms = {};     // socketId -> { code, playerId }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // avoid collision
  return rooms[code] ? genCode() : code;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected !== false) {
      io.to(p.sid).emit('update', room.getState(p.id));
    }
  }
}

function broadcastTo(room, pid) {
  const p = room.players.find(x => x.id === pid);
  if (p && p.connected !== false) {
    io.to(p.sid).emit('update', room.getState(pid));
  }
}

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('createRoom', (data, callback) => {
    const numTeams = Math.max(2, Math.min(4, parseInt(data.numTeams) || 4));
    const code = genCode();
    const room = new GameRoom(code, numTeams);
    rooms[code] = room;
    const name = String(data.name || '').trim().substring(0, 16) || null;
    const player = room.addPlayer(socket.id, name);
    if (!player) { callback({ ok: false, error: '房间创建失败' }); return; }
    socketRooms[socket.id] = { code, playerId: player.id };
    socket.join(code);
    console.log(`[room] created ${code} (${numTeams} teams)`);
    broadcast(room);
    callback({ ok: true, code, playerId: player.id });
  });

  socket.on('joinRoom', (data, callback) => {
    const code = data.code.toUpperCase();
    const room = rooms[code];
    if (!room) { callback({ ok: false, error: '房间不存在' }); return; }
    if (room.phase !== 'lobby') { callback({ ok: false, error: '游戏已开始' }); return; }
    const name = String(data.name || '').trim().substring(0, 16) || null;
    const player = room.addPlayer(socket.id, name);
    if (!player) { callback({ ok: false, error: '房间已满' }); return; }
    socketRooms[socket.id] = { code, playerId: player.id };
    socket.join(code);
    console.log(`[join] ${socket.id} -> ${code}`);
    broadcast(room);
    callback({ ok: true, code, playerId: player.id });
  });

  socket.on('rejoin', (data) => {
    const room = rooms[data.code];
    if (!room) return;
    const player = room.players.find(p => p.id === data.playerId);
    if (!player) return;
    // Remove old socket mapping if exists
    const oldSid = player.sid;
    if (oldSid && socketRooms[oldSid]) delete socketRooms[oldSid];
    player.sid = socket.id;
    player.connected = true;
    socketRooms[socket.id] = { code: data.code, playerId: data.playerId };
    socket.join(data.code);
    room.addLog(`🔗 ${room.teamEmoji(player.team)} ${player.name} 重新连接`, 'info');
    broadcast(room);
    console.log(`[rejoin] ${socket.id} -> room ${data.code} as player ${data.playerId}`);
  });

  socket.on('startGame', (data, callback) => {
    const rec = socketRooms[socket.id];
    if (!rec) { callback({ ok: false, error: '未加入房间' }); return; }
    const room = rooms[rec.code];
    if (!room) { callback({ ok: false, error: '房间不存在' }); return; }
    if (!room.allClaimed()) { callback({ ok: false, error: '玩家未到齐' }); return; }
    room.startGame();
    broadcast(room);
    callback({ ok: true });
  });

  socket.on('rpsChoice', (data, callback) => {
    const rec = socketRooms[socket.id];
    if (!rec) { callback({ ok: false }); return; }
    const room = rooms[rec.code];
    if (!room || room.phase !== 'rps') { callback({ ok: false }); return; }

    const ok = room.submitRPS(rec.playerId, data.choice);
    if (!ok) { callback({ ok: false }); return; }
    callback({ ok: true });

    // All alive players chose? Resolve.
    if (room.allRPSReady()) {
      room.resolveRPS();
    }
    // Broadcast updated state to all
    broadcast(room);
  });

  socket.on('performAction', (data, callback) => {
    const rec = socketRooms[socket.id];
    if (!rec) { callback({ ok: false }); return; }
    const room = rooms[rec.code];
    if (!room || room.phase !== 'action') { callback({ ok: false }); return; }

    let ok = false;
    switch (data.action) {
      case 'move': ok = room.performMove(rec.playerId, data.target); break;
      case 'kill': ok = room.performKill(rec.playerId, data.target); break;
      case 'destroyBed': ok = room.performDestroyBed(rec.playerId); break;
      case 'pass': ok = room.passAction(rec.playerId); break;
      case 'buy': ok = room.buy(rec.playerId, data.item); break;
      case 'save': ok = room.save(rec.playerId); break;
      case 'breakDefense': ok = room.breakDefense(rec.playerId); break;
      case 'useTNT': ok = room.useTNT(rec.playerId); break;
      case 'useEnderPearl': ok = room.useEnderPearl(rec.playerId, data.target); break;
      case 'suicide': ok = room.suicide(rec.playerId); break;
    }
    if (ok) broadcast(room);
    else callback({ ok: false, error: '操作无效' });
  });

  socket.on('sendChat', (data) => {
    const rec = socketRooms[socket.id];
    if (!rec) return;
    const room = rooms[rec.code];
    if (!room) return;
    const player = room.players.find(p => p.id === rec.playerId);
    if (!player) return;
    let msg = String(data.msg || '').trim().substring(0, 200);
    if (!msg) return;
    // Basic XSS sanitize
    msg = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    room.addChat(player.name, player.team, msg);
    io.to(rec.code).emit('chatMsg', {
      sender: player.name,
      team: player.team,
      msg: msg,
      time: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const rec = socketRooms[socket.id];
    if (rec) {
      const room = rooms[rec.code];
      if (room) {
        const p = room.players.find(x => x.id === rec.playerId);
        if (p) {
          p.connected = false;
          if (room.phase !== 'lobby' && room.phase !== 'gameover') {
            room.addLog(`🔌 ${room.teamEmoji(p.team)} ${p.name} 断开连接`, 'warn');
          }
          broadcast(room);
        }
      }
      delete socketRooms[socket.id];
    }
    console.log(`[disconnect] ${socket.id}`);
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;

// Prevent server crash from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[REJECTION]', reason);
});

server.listen(PORT, () => {
  console.log(`🛏️  起床战争服务器已启动 http://localhost:${PORT}`);
  console.log(`   房间上限 200，按 Ctrl+C 停止`);
});
