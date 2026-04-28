// ==================== RENDER ====================
function render() {
  if (!state) return;

  // Detect phase transitions
  if (prevState) {
    if (prevState.phase === 'rps' && state.phase === 'reveal') Sfx.play('reveal');
    if (prevState.phase !== 'rps' && state.phase === 'rps' && prevState.phase !== 'lobby') Sfx.play('round');
  }

  // Process server-sent events (kills, bed destroys, gameover)
  if (state.lastEvents) {
    processEvents(state.lastEvents);
    state.lastEvents = null;
  }
  prevState = JSON.parse(JSON.stringify(state));

  // Hide/show sections
  const isLobby = state.phase === 'lobby';
  document.getElementById('lobby').style.display = isLobby ? 'flex' : 'none';
  document.getElementById('room-lobby').style.display = isLobby ? '' : 'none';
  document.getElementById('game').style.display = (!isLobby) ? 'flex' : 'none';
  // Chat always visible once in a room
  document.getElementById('chat-panel').style.display = (state.code && state.phase !== 'setup') ? 'block' : 'none';
  if (state.code && state.phase !== 'setup') {
    document.body.classList.add('chat-open');
  } else {
    document.body.classList.remove('chat-open');
  }
  document.getElementById('board-overlay').innerHTML = '';

  // Timer for timed phases
  if (state.phaseEndTime) updateTimerBar(state);

  if (state.phase === 'lobby') {
    renderLobby();
  } else {
    renderMap();
    renderTeams();
    renderRPS();
    renderActions();
    renderLog();
    renderGameOver();
  }
}

function renderLobby() {
  document.getElementById('room-code-display').textContent = state.code;

  // Show last winner if returning from a game
  let winBanner = '';
  if (state.lastWinner) {
    winBanner = `<div style="background:#2a2a1a;border:1px solid #ffd700;border-radius:8px;padding:8px;margin-bottom:10px;text-align:center;">
      <span style="color:#ffd700;font-weight:bold;">🏆 上局赢家：${teamEmoji(state.lastWinner)} ${teamName(state.lastWinner)}</span>
    </div>`;
  }

  let html = winBanner;
  for (const t of state.teams) {
    const player = state.players.find(p => p.team === t.id);
    html += `<div class="team-slot">`;
    html += `<span class="dot" style="background:${t.color}"></span>`;
    html += `<span>${t.emoji} ${t.name}</span>`;
    if (player && player.connected) {
      html += `<span class="status taken">👤 ${player.name}</span>`;
    } else {
      html += `<span class="status waiting">等待加入...</span>`;
    }
    html += `</div>`;
  }
  document.getElementById('team-slots').innerHTML = html;

  // Show personal stats if available
  if (state.stats) {
    const s = state.stats;
    document.getElementById('my-stats').innerHTML = `
      <div style="margin-top:10px;padding:8px;border-radius:6px;background:#252540;font-size:11px;text-align:center;color:#aaa;">
        📊 我的战绩：🏆${s.wins||0}胜 · ⚔️${s.kills||0}杀 · 🛏️${s.bedsDestroyed||0}挖床 · 🎮${s.games||0}局
      </div>`;
  } else {
    document.getElementById('my-stats').innerHTML = '';
  }

  const allClaimed = state.allClaimed || (state.players.length >= state.teams.length);
  document.getElementById('btn-start-game').disabled = !allClaimed;
  if (!allClaimed) {
    document.getElementById('btn-start-game').textContent = `等待玩家加入 (${state.players.filter(p=>p.connected).length}/${state.teams.length})...`;
  } else {
    document.getElementById('btn-start-game').textContent = state.lastWinner ? '🔄 再来一局' : '⚔️ 开始游戏';
  }
}

function renderMap() {
  const mapEl = document.getElementById('map');
  const svgEl = document.getElementById('conn-svg');
  mapEl.innerHTML = '';

  // Draw connections
  const rect = document.getElementById('board-container').getBoundingClientRect();
  const w = rect.width || 800, h = rect.height || 600;
  let svg = '';
  const drawn = new Set();
  for (const [lid, loc] of Object.entries(state.locations)) {
    const pos = state.gridPos[lid];
    if (!pos) continue;
    for (const cid of loc.conns) {
      const key = [lid, cid].sort().join('-');
      if (drawn.has(key)) continue;
      drawn.add(key);
      const cp = state.gridPos[cid];
      if (!cp) continue;
      svg += `<line x1="${pos.x/100*w}" y1="${pos.y/100*h}" x2="${cp.x/100*w}" y2="${cp.y/100*h}" />`;
    }
  }
  svgEl.innerHTML = svg;

  // Draw locations
  for (const [lid, loc] of Object.entries(state.locations)) {
    const pos = state.gridPos[lid];
    if (!pos) continue;
    const div = document.createElement('div');
    div.className = 'map-loc';
    if (lid === 'main') div.classList.add('main-island');
    if (loc.isBed && flashBeds.has(lid)) { div.classList.add('bed-flash'); flashBeds.delete(lid); }
    if (lid === 'shop') div.classList.add('shop-pulse');
    div.style.left = pos.x + '%';
    div.style.top = pos.y + '%';

    if (loc.team) {
      const t = state.teams.find(x => x.id === loc.team);
      const tc = t ? t.color : '#888';
      div.style.background = `rgba(${hexRgb(tc)},0.2)`;
      div.style.border = `2px solid ${tc}`;
    } else {
      div.style.background = '#2a2a4a';
      div.style.border = lid === 'main' ? '3px solid #ffd700' : '2px solid #555';
    }

    if (state.currentActorId) {
      const actor = state.players.find(p => p.id === state.currentActorId);
      if (actor && actor.location === lid && state.phase === 'action') {
        div.classList.add('highlight');
      }
      // Highlight reachable locations when it's my turn
      if (actor && state.currentActorId === myPlayerId && state.phase === 'action') {
        const actorLoc = state.locations[actor.location];
        if (actorLoc && actorLoc.conns.includes(lid)) {
          div.classList.add('reachable');
        }
      }
    }

    let html = '';
    if (loc.isBed) {
      const t = state.teams.find(x => x.id === loc.team);
      html += `<span class="bed-icon${(t && t.bedAlive) ? '' : ' destroyed'}">${(t && t.bedAlive) ? '🛏️' : '💀'}</span>`;
      if (t && t.bedAlive && (t.defense || 0) > 0) {
        html += `<span style="font-size:10px;color:#3498db;">🛡️${t.defense}</span>`;
      }
    }
    html += `<span>${loc.name}</span>`;

    const here = state.players.filter(p => (p.alive || p.respawning) && p.location === lid);
    if (here.length > 0) {
      html += '<div class="loc-players">';
      for (const p of here) {
        const tc = state.teams.find(x => x.id === p.team);
        const extra = p.respawning ? ' style="opacity:0.5"' : '';
        html += `<span class="p-token"${extra} style="background:${tc?tc.color:'#888'}" title="${p.name + (p.respawning?' (复活中)':'')}">${tc?tc.emoji:'?'}</span>`;
      }
      html += '</div>';
    }

    // Speech bubbles for claims during prepare/rps phase
    const RPS_EMOJI_MAP = { rock:'✊', paper:'✋', scissors:'✌️' };
    const playersHere = state.players.filter(p => p.alive && !p.respawning && p.location === lid && state.claims && state.claims[p.id]);
    if (playersHere.length > 0 && (state.phase === 'prepare' || state.phase === 'rps')) {
      for (const p of playersHere) {
        html += `<div class="claim-bubble">${RPS_EMOJI_MAP[state.claims[p.id]]} 我要出${state.claims[p.id] === 'rock' ? '石头' : state.claims[p.id] === 'paper' ? '布' : '剪刀'}</div>`;
      }
    }

    const deadHere = state.players.filter(p => !p.alive && p.location === lid);
    if (deadHere.length > 0 && here.length === 0) {
      html += '<div class="loc-players">';
      for (const p of deadHere) {
        html += `<span class="p-token dead" title="${p.name} (阵亡)">💀</span>`;
      }
      html += '</div>';
    }

    div.innerHTML = html;
    mapEl.appendChild(div);
  }
}

function hexRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

function renderTeams() {
  let html = '<h3>🏴 队伍状态</h3>';
  for (const t of state.teams) {
    const alive = state.players.filter(p => p.team === t.id && p.alive && !p.respawning && p.connected).length;
    const respawning = state.players.filter(p => p.team === t.id && p.respawning && p.connected).length;
    const deadButBed = state.players.filter(p => p.team === t.id && !p.alive && !p.respawning && t.bedAlive && p.connected !== false).length > 0;
    const eliminated = !t.bedAlive && alive === 0 && respawning === 0;
    let cls = eliminated ? ' eliminated' : '';
    html += `<div class="team-row${cls}">`;
    html += `<span class="tcolor" style="background:${t.color}"></span>`;
    html += `<span>${t.emoji} ${t.name}</span>`;
    let s = `🛏️${t.bedAlive ? '床完好' : '床已毁'}`;
    if ((t.defense || 0) > 0) s += ` · 🛡️${t.defense || 0}层`;
    if (alive > 0) s += ` · 👤${alive}人`;
    if (respawning > 0) s += ` · ⏳${respawning}人`;
    html += `<span class="tstatus">${s}</span>`;
    html += `</div>`;
  }
  document.getElementById('teams-status').innerHTML = html;
}

function renderRPS() {
  const el = document.getElementById('rps-section');
  if (state.phase !== 'rps' && state.phase !== 'reveal' && state.phase !== 'prepare') { el.style.display = 'none'; return; }
  el.style.display = '';

  let html = '<h3>✊ 石头剪刀布</h3>';

  if (state.phase === 'prepare') {
    const me = state.players.find(p => p.id === myPlayerId);
    html += '<p style="text-align:center;color:#ffd700;font-size:12px;margin-bottom:6px;">🎭 准备阶段 — 可以公开宣言</p>';
    if (me && me.alive && !me.respawning && me.connected !== false) {
      const myClaim = state.claims && state.claims[me.id];
      if (myClaim) {
        html += `<div style="text-align:center;padding:8px;font-size:14px;color:#2ecc71;">✅ 已宣言：我要出 ${RPS_EMOJI[myClaim]} ${RPS_LABEL[myClaim]}</div>`;
      } else {
        html += '<p style="text-align:center;color:#ffd700;font-size:12px;margin-bottom:4px;">👆 公开宣言（可不选）</p>';
        for (const c of RPS) {
          html += `<button class="rps-big-btn" style="border-color:#9b59b6;min-height:44px;" onclick="socket.emit('claim',{choice:'${c}'});render();">`;
          html += `<span class="emoji-big">${RPS_EMOJI[c]}</span>`;
          html += `<span class="label-big">宣称出${RPS_LABEL[c]}</span></button>`;
        }
      }
    }
    // Player status list in prepare phase
    html += '<div style="margin-top:10px;border-top:1px solid #333;padding-top:6px;">';
    html += '<p style="font-size:11px;color:#666;margin-bottom:4px;">玩家状态</p>';
    for (const p of state.players) {
      if (!p.connected) continue;
      if (p.respawning) {
        html += `<div class="rps-status-row" style="opacity:0.6"><span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name} <span style="margin-left:auto;color:#e67e22;">⏳ 复活中</span></div>`;
      } else if (!p.alive) {
        html += `<div class="rps-status-row" style="opacity:0.4"><span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name} <span style="margin-left:auto;color:#e74c3c;">💀 阵亡</span></div>`;
      } else {
        const claimed = state.claims && state.claims[p.id];
        html += `<div class="rps-status-row"><span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name}`;
        html += `<span class="choice-em" style="color:${claimed ? '#9b59b6' : '#888'}">${claimed ? RPS_EMOJI[claimed] : '—'}</span>`;
        html += `</div>`;
      }
    }
    html += '</div>';
    el.innerHTML = html; return;
  }

  if (state.phase === 'reveal') {
    html += '<p style="text-align:center;color:#ffd700;font-size:12px;margin-bottom:6px;">📢 结果已揭晓</p>';
    for (const p of state.players) {
      if (!p.alive || !p.connected) continue;
      if (p.respawning) continue;  // skip respawning, they didn't play
      const c = state.rpsChoices && state.rpsChoices[p.id];
      if (!c) continue;
      const isWinner = state.winners && state.winners.includes(p.id);
      html += `<div class="rps-reveal-row" style="border-left:3px solid ${teamColor(p.team)}">`;
      html += `<span>${p.name}</span>`;
      html += `<span class="emoji-lg">${RPS_EMOJI[c]} ${RPS_LABEL[c]}</span>`;
      if (isWinner) html += ' 🏆';
      html += `</div>`;
    }
    if (state.winners.length === 0) {
      html += '<p style="text-align:center;color:#ffd700;font-size:12px;">🤝 平局！无人获得行动权</p>';
    } else {
      const perWinner = state.winnerActions[state.winners[0]] || state.loserCount;
      const deadCount = state.players.filter(p => p.respawning).length;
      const extra = deadCount > 0 ? ` (含${deadCount}人阵亡)` : '';
      html += `<p style="text-align:center;color:#2ecc71;font-size:13px;margin-top:4px;">🏆 赢家各获得 ${perWinner} 次行动${extra}</p>`;
    }
  } else {
    // RPS selection phase
    const me = state.players.find(p => p.id === myPlayerId);
    const myChoice = me ? state.rpsMyChoice : null;
    const iChose = myChoice !== null;

    if (me && me.alive && me.connected !== false) {
      if (iChose) {
        html += `<div style="text-align:center;padding:16px;font-size:28px;color:#2ecc71;">✅ 已选择 ${RPS_EMOJI[myChoice]}</div>`;
      } else {
        html += '<p style="text-align:center;color:#ffd700;font-size:13px;margin-bottom:8px;">👆 你的选择（点击出拳）</p>';
        for (const c of RPS) {
          html += `<button class="rps-big-btn" onclick="doRPS('${c}');render();">`;
          html += `<span class="emoji-big">${RPS_EMOJI[c]}</span>`;
          html += `<span class="label-big">${RPS_LABEL[c]}</span>`;
          html += `</button>`;
        }
      }
    } else if (me && me.respawning) {
      html += '<p style="text-align:center;color:#e67e22;font-size:13px;">⏳ 等待复活中...</p>';
    } else if (me) {
      html += '<p style="text-align:center;color:#888;font-size:13px;">你已阵亡，等待下一轮...</p>';
    }

    // Status for all players
    html += '<div style="margin-top:10px;border-top:1px solid #333;padding-top:6px;">';
    html += '<p style="font-size:11px;color:#666;margin-bottom:4px;">玩家状态</p>';
    for (const p of state.players) {
      if (!p.connected) continue;
      if (p.respawning) {
        html += `<div class="rps-status-row" style="opacity:0.6"><span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name} <span style="margin-left:auto;color:#e67e22;">⏳ 复活中</span></div>`;
      } else if (!p.alive) {
        html += `<div class="rps-status-row" style="opacity:0.4"><span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name} <span style="margin-left:auto;color:#e74c3c;">💀 阵亡</span></div>`;
      } else {
        const readyPlayers = state.rpsReadyPlayers || [];
        const chosen = readyPlayers.includes(p.id);
        html += `<div class="rps-status-row" style="flex-wrap:wrap;">`;
        html += `<span style="color:${teamColor(p.team)}">${teamEmoji(p.team)}</span> ${p.name}`;
        if (chosen) {
          html += `<span class="choice-em" style="color:#2ecc71;">✅</span>`;
        } else {
          html += `<span class="choice-em" style="color:#ffd700;">⏳</span>`;
        }

        // RPS history stats
        const hist = state.rpsHistory && state.rpsHistory[p.id];
        if (hist && hist.length > 0) {
          const rock = hist.filter(c => c === 'rock').length;
          const paper = hist.filter(c => c === 'paper').length;
          const scis = hist.filter(c => c === 'scissors').length;
          const total = hist.length;
          const rp = Math.round(rock / total * 100);
          const pp = Math.round(paper / total * 100);
          const sp = Math.round(scis / total * 100);
          html += `<span style="width:100%;font-size:10px;color:#888;margin-top:2px;">`;
          html += `📊 ✊${rp}% ✋${pp}% ✌️${sp}%`;
          if (total > 1) {
            const recent = hist.slice(-5);
            html += ` · <span style="color:#aaa;">${recent.map(c => RPS_EMOJI[c]).join(' ')}</span>`;
          }
          html += `</span>`;
        }
        html += `</div>`;
      }
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderActions() {
  const el = document.getElementById('action-section');
  if (state.phase !== 'action') { el.style.display = 'none'; return; }
  el.style.display = '';

  const isMe = state.currentActorId === myPlayerId;
  const actor = state.players.find(p => p.id === state.currentActorId);
  if (!actor) { el.innerHTML = '<h3>⚡ 行动阶段</h3><p style="font-size:12px;text-align:center;color:#ffd700;">行动结束，进入下一轮...</p>'; return; }

  let html = '<h3>⚡ 行动阶段</h3>';
  const rem = state.winnerActions[actor.id] || 0;
  const pn = ['🪓','⛏️木','⛏️铁','⛏️钻'][actor.pickaxe];
  let inv = [pn];
  if (actor.enderPearl > 0) inv.push(`🟣${actor.enderPearl > 1 ? '×'+actor.enderPearl : ''}`);
  if (actor.tnt) inv.push('💣');
  const sp = actor.shopPoints || 0;
  html += `<div class="action-info">${actor.name} 行动中 · ${inv.join(' ')}${sp > 0 ? ` · 💰储蓄${sp}` : ''}<br>剩余: <b>${rem}</b> 次 ${isMe ? '(轮到你!)' : '(等待中...)'}</div>`;

  if (!isMe) { el.innerHTML = html; return; }

  html += '<div class="action-buttons">';

  const loc = state.locations[actor.location];
  // Movement
  if (loc) {
    for (const cid of loc.conns) {
      const cloc = state.locations[cid];
      if (!cloc) continue;
      html += `<button class="action-btn" onclick="doAction('move','${cid}');render();">🚶 移动到 ${cloc.name}</button>`;
    }
  }

  // Shop
  if (actor.location === 'shop') {
    const sp = actor.shopPoints || 0;
    // Save button
    html += `<button class="action-btn" style="border-color:#ffd700;" onclick="doAction('save');render();">💰 储蓄1行动点 (已有${sp}点)</button>`;
    const myTeam = state.teams.find(t => t.id === actor.team);
    if (myTeam) {
      if (myTeam.defense < 20) {
        const cost = myTeam.defense < 10 ? 1 : 2;
        const need = Math.max(0, cost - sp);
        html += `<button class="action-btn" style="border-color:#3498db;" onclick="doAction('buy','defense');render();">🛡️ 加固床防御 (需${cost}点${need>0 ? ' 还差'+need : ''}) [${myTeam.defense}/20层]</button>`;
      }
      if (actor.pickaxe < 3) {
        const costs = {0:1,1:2,2:3};
        const names = ['木镐','铁镐','钻石镐'];
        const cost = costs[actor.pickaxe];
        const need = Math.max(0, cost - sp);
        html += `<button class="action-btn" style="border-color:#3498db;" onclick="doAction('buy','pickaxe');render();">⛏️ 升级${names[actor.pickaxe]} (需${cost}点${need>0 ? ' 还差'+need : ''})</button>`;
      }
    }
    if (actor.enderPearl < 3) {
      const need = Math.max(0, 3 - sp);
      html += `<button class="action-btn" style="border-color:#9b59b6;" onclick="doAction('buy','enderPearl');render();">🟣 购买末影珍珠 (需3点${need>0 ? ' 还差'+need : ''}) [${actor.enderPearl}/3]</button>`;
    }
    if (!actor.tnt) {
      const need = Math.max(0, 4 - sp);
      html += `<button class="action-btn" style="border-color:#e74c3c;" onclick="doAction('buy','tnt');render();">💣 购买TNT (需4点${need>0 ? ' 还差'+need : ''})</button>`;
    }
  }

  // Kill enemies
  const enemies = state.players.filter(p => p.alive && p.location === actor.location && p.team !== actor.team);
  for (const e of enemies) {
    html += `<button class="action-btn" style="border-color:#e74c3c;" onclick="doAction('kill',${e.id});render();">⚔️ 击杀 ${teamEmoji(e.team)} ${e.name}</button>`;
  }

  // At enemy bed: defense or destroy
  if (loc && loc.isBed && loc.team !== actor.team) {
    const t = state.teams.find(x => x.id === loc.team);
    if (t && t.bedAlive) {
      if (t.defense > 0) {
        html += `<button class="action-btn" style="border-color:#f39c12;" onclick="doAction('breakDefense');render();">⛏️ 拆除防御 [${t.defense}层]</button>`;
        if (actor.tnt) {
          html += `<button class="action-btn" style="border-color:#e74c3c;" onclick="doAction('useTNT');render();">💥 使用TNT炸毁所有防御</button>`;
        }
      } else {
        html += `<button class="action-btn" style="border-color:#f39c12;" onclick="doAction('destroyBed');render();">🛏️ 摧毁 ${t.name} 的床</button>`;
      }
    }
  }

  // Ender pearl
  if (actor.enderPearl > 0) {
    html += '<div style="margin:4px 0;padding:4px;background:#2a2035;border-radius:6px;">';
    html += '<span style="font-size:11px;color:#9b59b6;">🟣 末影珍珠 — 传送到：</span>';
    for (const [lid, l] of Object.entries(state.locations)) {
      if (lid === actor.location) continue;
      html += `<button class="action-btn" style="border-color:#9b59b6;font-size:11px;padding:6px;margin:2px 0;" onclick="doAction('useEnderPearl','${lid}');render();">↗ ${l.name}</button>`;
    }
    html += '</div>';
  }

  // Suicide
  html += `<button class="action-btn" style="border-color:#666;color:#e74c3c;" onclick="if(confirm('确定要自杀？')){doAction('suicide');render();}">💀 自杀 (1行动)</button>`;

  html += `<button class="action-btn pass" onclick="doAction('pass');render();">⏭️ 跳过 (剩余${rem}次)</button>`;
  html += '</div>';
  el.innerHTML = html;
}

function renderLog() {
  let html = '';
  for (const e of state.logEntries) {
    html += `<div class="le ${e.type || ''}">${e.msg}</div>`;
  }
  document.getElementById('log-entries').innerHTML = html;
}

function renderGameOver() {
  const overlay = document.getElementById('gameover-overlay');
  if (state.phase === 'gameover') {
    overlay.classList.add('show');
    let recap = '';
    const gs = state.gameSummary;
    if (gs) {
      recap += '<div style="text-align:left;margin:10px 0;font-size:13px;line-height:1.9;">';
      if (gs.mvp) {
        recap += `<div>⭐ MVP：${teamEmoji(gs.mvp.team)} ${gs.mvp.name} (${gs.mvp.kills}杀 ${gs.mvp.beds}拆床)</div>`;
      }
      if (gs.keyStats && gs.keyStats.length > 0) {
        for (const s of gs.keyStats) {
          recap += `<div style="font-size:12px;opacity:0.85;">${s.text}</div>`;
        }
      }
      recap += '</div>';
    }
    document.getElementById('go-content').innerHTML = `
      <h2>${state.winnerTeam ? (teamEmoji(state.winnerTeam) + ' ' + teamName(state.winnerTeam) + ' 获胜！🎉') : '全军覆没...'}</h2>
      ${recap}
      <p style="color:#888;font-size:11px;">8秒后自动回到房间</p>
      <button onclick="returnToLobby()">🔙 回到房间</button>
    `;
  } else {
    overlay.classList.remove('show');
  }
}

function returnToLobby() {
  document.getElementById('gameover-overlay').classList.remove('show');
  // Server will set phase to lobby on its own, but dismiss overlay immediately
}

function openHelp() {
  document.getElementById('help-overlay').classList.add('show');
}
function closeHelp() {
  document.getElementById('help-overlay').classList.remove('show');
}

function teamColor(tid) {
  const t = state.teams.find(x => x.id === tid);
  return t ? t.color : '#888';
}
function teamEmoji(tid) {
  const t = state.teams.find(x => x.id === tid);
  return t ? t.emoji : '⚪';
}
function teamName(tid) {
  const t = state.teams.find(x => x.id === tid);
  return t ? t.name : tid;
}

window.addEventListener('resize', () => { if (state && state.phase !== 'lobby') renderMap(); });

function updateTimerBar(s) {
  const ov = document.getElementById('board-overlay');
  if (!s.phaseEndTime || s.phase === 'reveal' || s.phase === 'gameover') {
    ov.innerHTML = ''; return;
  }
  const now = Date.now();
  const total = s.phase === 'action' && s.currentActorId === s.myPlayerId
    ? (s.actionEndTime - (s.phaseEndTime - (s.phase === 'rps' ? 20000 : s.phase === 'prepare' ? 5000 : 15000)))
    : (s.phaseEndTime - now + (s.phaseEndTime < now ? 5000 : 0));
  
  // Simpler: just show remaining seconds
  const endTime = (s.phase === 'action' && s.currentActorId === s.myPlayerId) ? s.actionEndTime : s.phaseEndTime;
  const remaining = Math.max(0, Math.round((endTime - now) / 1000));
  const pct = Math.min(100, Math.max(0, remaining / (s.phase === 'prepare' ? 5 : s.phase === 'rps' ? 20 : 15) * 100));
  const urgent = remaining <= 3;
  const label = s.phase === 'prepare' ? `🎭 公开宣言 ${remaining}s`
    : s.phase === 'rps' ? `✊ 选择手势 ${remaining}s`
    : `⚡ 行动 ${remaining}s`;
  ov.innerHTML = `<div style="text-align:center;font-size:13px;color:#ffd700;margin-bottom:2px;">${label}</div><div class="timer-bar"><div class="timer-bar-fill${urgent?' urgent':''}" style="width:${pct}%"></div></div>`;
}
