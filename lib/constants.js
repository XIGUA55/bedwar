"use strict";

const TEAM_DEFS = [
  { id: 'red',    name: '红队', color: '#e74c3c', emoji: '🔴' },
  { id: 'blue',   name: '蓝队', color: '#3498db', emoji: '🔵' },
  { id: 'green',  name: '绿队', color: '#2ecc71', emoji: '🟢' },
  { id: 'yellow', name: '黄队', color: '#f1c40f', emoji: '🟡' },
];

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

module.exports = { TEAM_DEFS, BEATS };
