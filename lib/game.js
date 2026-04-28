"use strict";

const { TEAM_DEFS, BEATS } = require('./constants');
const { buildMap } = require('./map');
const { globalStats, saveStats } = require('./stats');

// ==================== GAME ROOM CLASS ====================
class GameRoom {
  constructor(code, numTeams, io) {
    this.io = io;
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
    this.roundStats = {};     // playerId -> expanded stats
    this.lastEvents = [];     // recent events for toast/sfx on clients
    this.rpsHistory = {};     // playerId -> ['rock', 'paper', ...]
    this.roundNumber = 0;     // current round count
    this.highlights = [];     // key moments for post-game recap
    this.bedDestroyLog = [];  // { byTeam, byPlayer, toTeam, round }
    this.finalKillLog = [];   // { byTeam, byPlayer, toTeam, round }
    this.gameStartTime = 0;

    const map = buildMap(this.teams);
    this.locations = map.locations;
    this.gridPos = map.gridPos;
  }

  addLog(msg, type) {
    this.logEntries.unshift({ msg, type, time: Date.now() });
    if (this.logEntries.length > 80) this.logEntries.length = 80;
  }

  broadcastAll() {
    for (const p of this.players) {
      if (p.connected !== false) {
        this.io.to(p.sid).emit('update', this.getState(p.id));
      }
    }
  }

  broadcastToPid(pid) {
    const p = this.players.find(x => x.id === pid);
    if (p && p.connected !== false) {
      this.io.to(p.sid).emit('update', this.getState(pid));
    }
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
    this.highlights = [];
    this.bedDestroyLog = [];
    this.finalKillLog = [];
    this.gameStartTime = Date.now();
    this.roundNumber = 1;
    for (const p of this.players) { this.roundStats[p.id] = { kills: 0, bedsDestroyed: 0, finalKills: 0, rpsWins: 0, rpsAttempts: 0, shopSpent: 0, deaths: 0, firstDeathRound: 0 }; this.rpsHistory[p.id] = []; }
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

    // Track RPS attempts and record history
    for (const p of alive) {
      this.roundStats[p.id].rpsAttempts++;
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

    // Players waiting to respawn (bed still alive) count as automatic losers
    const deadLosers = this.players.filter(p => p.respawning && p.connected !== false).length;

    if (maxScore === 0 || winners.length === alive.length) {
      // All alive tied: dead players are the only losers
      const loserCount = deadLosers;
      if (loserCount === 0) {
        this.addLog('🤝 本轮平局！无人获得行动权', 'warn');
        this.winners = [];
        this.loserCount = alive.length;
        this.winnerActions = {};
        this.winnerOrder = [];
        this.winnerIdx = 0;
        setTimeout(() => { this.startNextRound(); this.broadcastAll(); }, 1500);
        return;
      }
      this.winners = alive.map(p => p.id);
      this.loserCount = loserCount;
      this.winnerActions = {};
      this.winnerOrder = [...this.winners].sort(() => Math.random() - 0.5);
      for (const pid of this.winnerOrder) {
        this.winnerActions[pid] = loserCount;
        this.roundStats[pid].rpsWins++;
      }
      this.winnerIdx = 0;
      this.advanceToNextAlive();
      const names = alive.map(p => p.name).join(', ');
      this.addLog(`🤝 ${names} 平局，因${deadLosers}人阵亡，各获得 ${loserCount} 次行动`, 'good');
      setTimeout(() => {
        this.phase = 'action';
        this.advanceToNextAlive();
        this.broadcastAll();
      }, 1500);
      return;
    }

    const loserCount = deadLosers + (alive.length - winners.length);
    this.winners = winners.map(p => p.id);
    this.loserCount = loserCount;
    this.winnerActions = {};
    this.winnerOrder = [...this.winners].sort(() => Math.random() - 0.5);

    for (const pid of this.winnerOrder) {
      this.winnerActions[pid] = Math.max(1, loserCount);
      this.roundStats[pid].rpsWins++;
    }
    this.winnerIdx = 0;
    this.advanceToNextAlive();

    const names = winners.map(p => p.name).join(', ');
    const extra = deadLosers > 0 ? ` (含${deadLosers}人阵亡)` : '';
    this.addLog(`🏆 ${names} 获胜！各获得 ${Math.max(1, loserCount)} 次行动${extra}`, 'good');

    setTimeout(() => {
      this.phase = 'action';
      this.advanceToNextAlive();
      this.broadcastAll();
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
    this.roundStats[target.id].deaths++;
    if (!this.roundStats[target.id].firstDeathRound) this.roundStats[target.id].firstDeathRound = this.roundNumber;
    this.winnerActions[actor.id]--;
    this.roundStats[actor.id].kills++;
    this.lastEvents.push({ type: 'kill', killerTeam: actor.team, killerName: actor.name, targetTeam: target.team, targetName: target.name });
    this.addLog(`⚔️ ${this.teamEmoji(actor.team)} ${actor.name} 击杀了 ${this.teamEmoji(target.team)} ${target.name}！`, 'warn');

    if (this.teamEliminated(target.team)) {
      this.teams.find(t => t.id === target.team).bedAlive = false;
      this.roundStats[actor.id].finalKills++;
      this.finalKillLog.push({ byTeam: actor.team, byPlayer: actor.name, toTeam: target.team, round: this.roundNumber });
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
    this.highlights.push({ type: 'bedDestroy', msg: `🛏️ ${this.teamEmoji(actor.team)} ${actor.name} 摧毁了 ${this.teamName(t.id)} 的床` });
    this.bedDestroyLog.push({ byTeam: actor.team, byPlayer: actor.name, toTeam: t.id, round: this.roundNumber });
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
    this.roundStats[actor.id].shopSpent++;
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
      this.roundStats[actor.id].shopSpent += cost;
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
      this.roundStats[actor.id].shopSpent += cost;
      actor.pickaxe++;
      const names = ['无镐','木镐','铁镐','钻石镐'];
      this.addLog(`⛏️ ${this.teamEmoji(actor.team)} ${actor.name} 升级到 ${names[actor.pickaxe]}`, '');
    } else if (item === 'enderPearl') {
      const cost = 3;
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      this.roundStats[actor.id].shopSpent += cost;
      actor.enderPearl++;
      this.addLog(`🟣 ${this.teamEmoji(actor.team)} ${actor.name} 购买了末影珍珠 (共${actor.enderPearl}颗)`, '');
    } else if (item === 'tnt') {
      const cost = 4;
      if (actor.tnt) return false;
      if (total < cost) return false;
      const fromSave = Math.min(savings, cost);
      actor.shopPoints -= fromSave;
      this.winnerActions[actor.id] -= (cost - fromSave);
      this.roundStats[actor.id].shopSpent += cost;
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
    this.highlights.push({ type: 'tnt', msg: `💥 ${this.teamEmoji(actor.team)} 用TNT炸毁 ${this.teamName(targetTeam.id)} ${blown}层防御` });
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
    this.roundStats[actor.id].deaths++;
    if (!this.roundStats[actor.id].firstDeathRound) this.roundStats[actor.id].firstDeathRound = this.roundNumber;
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
      this.compileGameSummary();
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

  compileGameSummary() {
    const duration = Math.round((Date.now() - this.gameStartTime) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;

    // MVP score: kill=1, bedDestroy=5, finalKill=3
    let mvp = null, mvpScore = -1;
    const playerStats = {};
    for (const p of this.players) {
      const rs = this.roundStats[p.id] || { kills:0, bedsDestroyed:0, finalKills:0, rpsWins:0, rpsAttempts:0, shopSpent:0, deaths:0, firstDeathRound:0 };
      const score = rs.kills + rs.bedsDestroyed * 5 + rs.finalKills * 3;
      playerStats[p.id] = { ...rs, score };
      if (score > mvpScore) { mvp = p; mvpScore = score; }
    }

    // Collect candidate key stats
    const candidates = [];
    const ps = (id) => playerStats[id] || {};

    // RPS win rates (exclude players who never attempted)
    let bestRPS = null, worstRPS = null;
    for (const p of this.players) {
      const st = ps(p.id);
      if (st.rpsAttempts === 0) continue;
      const rate = Math.round(st.rpsWins / st.rpsAttempts * 100);
      if (!bestRPS || rate > bestRPS.rate) bestRPS = { name: p.name, team: p.team, rate, wins: st.rpsWins, att: st.rpsAttempts };
      if (!worstRPS || (rate < worstRPS.rate && st.rpsAttempts > 0)) worstRPS = { name: p.name, team: p.team, rate, wins: st.rpsWins, att: st.rpsAttempts };
    }
    if (bestRPS && bestRPS.rate > 0 && bestRPS.att >= 2)
      candidates.push({ type:'bestRPS', text: `${this.teamEmoji(bestRPS.team)} ${bestRPS.name} 的SRP胜率高达 ${bestRPS.rate}%！(${bestRPS.wins}/${bestRPS.att})` });
    if (worstRPS && worstRPS.rate < 100 && worstRPS.att >= 2)
      candidates.push({ type:'worstRPS', text: `${this.teamEmoji(worstRPS.team)} ${worstRPS.name} 的SRP胜率仅 ${worstRPS.rate}%... (${worstRPS.wins}/${worstRPS.att})` });

    // Most kills
    let mostKills = null;
    for (const p of this.players) { const k = ps(p.id).kills; if (k > (mostKills?.kills || 0)) mostKills = { name: p.name, team: p.team, kills: k }; }
    if (mostKills && mostKills.kills > 0)
      candidates.push({ type:'mostKills', text: `${this.teamEmoji(mostKills.team)} ${mostKills.name} 击杀最多 (${mostKills.kills}次)` });

    // Most shop spending
    let mostShop = null;
    for (const p of this.players) { const s = ps(p.id).shopSpent; if (s > (mostShop?.spent || 0)) mostShop = { name: p.name, team: p.team, spent: s }; }
    if (mostShop && mostShop.spent > 0)
      candidates.push({ type:'mostShop', text: `${this.teamEmoji(mostShop.team)} ${mostShop.name} 商店消费最多 (${mostShop.spent}点)` });

    // Most bed destroys (>=2)
    let mostBeds = null;
    for (const p of this.players) { const b = ps(p.id).bedsDestroyed; if (b > (mostBeds?.beds || 0)) mostBeds = { name: p.name, team: p.team, beds: b }; }
    if (mostBeds && mostBeds.beds >= 2)
      candidates.push({ type:'mostBeds', text: `🛏️ ${this.teamEmoji(mostBeds.team)} ${mostBeds.name} 拆床最多 (${mostBeds.beds}次)` });

    // Most final kills (>=2)
    let mostFinal = null;
    for (const p of this.players) { const f = ps(p.id).finalKills; if (f > (mostFinal?.finals || 0)) mostFinal = { name: p.name, team: p.team, finals: f }; }
    if (mostFinal && mostFinal.finals >= 2)
      candidates.push({ type:'mostFinal', text: `💀 ${this.teamEmoji(mostFinal.team)} ${mostFinal.name} 终结最多 (${mostFinal.finals}次)` });

    // Most deaths
    let mostDeaths = null;
    for (const p of this.players) { const d = ps(p.id).deaths; if (d > (mostDeaths?.deaths || 0)) mostDeaths = { name: p.name, team: p.team, deaths: d }; }
    if (mostDeaths && mostDeaths.deaths > 0)
      candidates.push({ type:'mostDeaths', text: `😵 ${this.teamEmoji(mostDeaths.team)} ${mostDeaths.name} 阵亡最多 (${mostDeaths.deaths}次)` });

    // Match duration
    candidates.push({ type:'duration', text: `⏱️ 本局仅耗时 ${min}:${sec.toString().padStart(2,'0')}！` });

    // Fastest death
    let fastest = null;
    for (const p of this.players) { const fd = ps(p.id).firstDeathRound; if (fd > 0 && (!fastest || fd < fastest.round)) fastest = { name: p.name, team: p.team, round: fd }; }
    if (fastest)
      candidates.push({ type:'fastestDeath', text: `💨 ${this.teamEmoji(fastest.team)} ${fastest.name} 在第${fastest.round}轮就阵亡了` });

    // Revenge: X destroyed Y's bed, then Y destroyed X's bed
    for (const a of this.bedDestroyLog) {
      for (const b of this.bedDestroyLog) {
        if (a.byTeam === b.toTeam && a.toTeam === b.byTeam && a.round < b.round) {
          candidates.push({ type:'revenge', text: `🔁 ${this.teamEmoji(b.byTeam)} ${b.byPlayer} 完成了对 ${this.teamEmoji(a.byTeam)} 的复仇！` });
          break;
        }
      }
    }

    // Counter-kill (反杀): X destroyed Y's bed, then Y destroyed X's bed AND got the final kill
    for (const a of this.bedDestroyLog) {
      for (const fk of this.finalKillLog) {
        if (fk.toTeam === a.byTeam && a.toTeam === fk.byTeam && a.round < fk.round) {
          for (const b of this.bedDestroyLog) {
            if (b.toTeam === a.byTeam && b.byTeam === a.toTeam && b.round > a.round && b.round < fk.round + 2) {
              candidates.push({ type:'counterKill', text: `⚡ ${this.teamEmoji(fk.byTeam)} ${fk.byPlayer} 完成了对 ${this.teamEmoji(a.byTeam)} 的反杀！` });
              break;
            }
          }
        }
      }
    }

    // Randomly pick 2 candidates (excluding duration which is always shown)
    const nonDuration = candidates.filter(c => c.type !== 'duration');
    const picked = [];
    while (nonDuration.length > 0 && picked.length < 2) {
      const idx = Math.floor(Math.random() * nonDuration.length);
      picked.push(nonDuration.splice(idx, 1)[0]);
    }
    const keyStats = [...candidates.filter(c => c.type === 'duration'), ...picked];

    const mvpRS = playerStats[mvp?.id] || { kills:0, bedsDestroyed:0, finalKills:0 };
    this.gameSummary = {
      mvp: mvp ? { name: mvp.name, team: mvp.team, kills: mvpRS.kills, beds: mvpRS.bedsDestroyed, score: mvpScore } : null,
      keyStats: keyStats.slice(0, 5),
    };
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
    this.broadcastAll();
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
      gameSummary: this.gameSummary || null,
    };
  }
}

module.exports = { GameRoom };
