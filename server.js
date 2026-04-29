"use strict";

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameRoom } = require('./lib/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ==================== ROOM MANAGER ====================
const rooms = {};           // code -> GameRoom
const socketRooms = {};     // socketId -> { code, playerId }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? genCode() : code;
}

function broadcast(room) {
  room.broadcastAll();
}

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('createRoom', (data, callback) => {
    const numTeams = Math.max(2, Math.min(4, parseInt(data.numTeams) || 4));
    const code = genCode();
    const room = new GameRoom(code, numTeams, io);
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

  socket.on('claim', (data) => {
    const rec = socketRooms[socket.id];
    if (!rec) return;
    const room = rooms[rec.code];
    if (!room || room.phase !== 'prepare') return;
    const player = room.players.find(p => p.id === rec.playerId);
    if (!player || !player.alive || player.respawning) return;
    const c = data.choice;
    if (['rock','paper','scissors'].includes(c)) { room.claims[rec.playerId] = c; broadcast(room); }
  });

  socket.on('rpsChoice', (data, callback) => {
    const rec = socketRooms[socket.id];
    if (!rec) { callback({ ok: false }); return; }
    const room = rooms[rec.code];
    if (!room || room.phase !== 'rps') { callback({ ok: false }); return; }
    const ok = room.submitRPS(rec.playerId, data.choice);
    if (!ok) { callback({ ok: false }); return; }
    callback({ ok: true });
    if (room.allRPSReady()) room.resolveRPS();
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
    msg = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    room.addChat(player.name, player.team, msg);
    io.to(rec.code).emit('chatMsg', {
      sender: player.name, team: player.team, msg: msg, time: Date.now(),
    });
  });

  // ==================== DEBUG ====================
  socket.on('debugAutoRPS', (data) => {
    const rec = socketRooms[socket.id];
    if (!rec) return;
    const room = rooms[rec.code];
    if (!room || room.phase !== 'rps') return;
    const choices = ['rock','paper','scissors'];
    for (const p of room.alivePlayers()) {
      if (room.rpsChoices[p.id] === undefined) {
        room.rpsChoices[p.id] = choices[Math.floor(Math.random()*3)];
      }
    }
    if (room.allRPSReady()) room.resolveRPS();
    broadcast(room);
  });

  socket.on('debugSkipTimer', (data) => {
    const rec = socketRooms[socket.id];
    if (!rec) return;
    const room = rooms[rec.code];
    if (!room) return;
    if (room._timer) { clearTimeout(room._timer); room._timer = null; }
    if (room.phase === 'prepare') { room._startRPSTimer(); }
    else if (room.phase === 'rps') { for (const p of room.alivePlayers()) { if (room.rpsChoices[p.id] === undefined) room.rpsChoices[p.id] = 'rock'; } if (room.alivePlayers().length > 0) room.resolveRPS(); }
    else if (room.phase === 'action') { const a = room.currentActor(); if (a) room.passAction(a.id); }
    broadcast(room);
  });

  socket.on('debugAddBot', (data) => {
    const rec = socketRooms[socket.id];
    if (!rec) return;
    const room = rooms[rec.code];
    if (!room) return;
    if (room.allClaimed()) return;
    const botName = '🤖 Bot' + (room.players.length + 1);
    const botSid = 'bot_' + Math.random().toString(36).slice(2, 8);
    const player = room.addPlayer(botSid, botName);
    if (player) {
      player.connected = true;
      room.addLog(`🤖 ${botName} 加入（调试模式）`, 'info');
      broadcast(room);
    }
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

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[REJECTION]', reason);
});

server.listen(PORT, () => {
  console.log(`🛏️  起床战争服务器已启动 http://localhost:${PORT}`);
});
