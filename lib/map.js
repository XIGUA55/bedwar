"use strict";

function buildMap(teamDefs) {
  const locations = {};
  const gridPos = {};
  locations['main'] = { id: 'main', name: '主岛', team: null, isBed: false, conns: [] };
  gridPos['main'] = { x: 50, y: 50 };

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

module.exports = { buildMap };
