// ==================== SOUND EFFECTS ====================
const Sfx = {
  ctx: null,
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  play(type) {
    try {
      this.init();
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.connect(g); g.connect(this.ctx.destination);

      switch (type) {
        case 'tap':
          o.type = 'sine'; o.frequency.value = 660;
          g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
          o.start(t); o.stop(t + 0.08);
          break;
        case 'kill':
          o.type = 'sawtooth'; o.frequency.setValueAtTime(300, t);
          o.frequency.linearRampToValueAtTime(60, t + 0.2);
          g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
          o.start(t); o.stop(t + 0.25);
          break;
        case 'destroy':
          // Deep rumble + explosion crash
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(120, t);
          o.frequency.exponentialRampToValueAtTime(20, t + 0.55);
          g.gain.setValueAtTime(0.30, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.60);
          o.start(t); o.stop(t + 0.60);
          const o2 = this.ctx.createOscillator();
          const g2 = this.ctx.createGain();
          o2.type = 'square';
          o2.frequency.setValueAtTime(60, t + 0.03);
          o2.frequency.exponentialRampToValueAtTime(15, t + 0.45);
          g2.gain.setValueAtTime(0.20, t + 0.03);
          g2.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
          o2.connect(g2); g2.connect(this.ctx.destination);
          o2.start(t + 0.03); o2.stop(t + 0.50);
          break;
        case 'win':
          const notes = [523, 659, 784, 1047];
          notes.forEach((f, i) => {
            const n = this.ctx.createOscillator();
            const ng = this.ctx.createGain();
            n.connect(ng); ng.connect(this.ctx.destination);
            n.type = 'sine'; n.frequency.value = f;
            ng.gain.setValueAtTime(0.15, t + i * 0.12);
            ng.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.3);
            n.start(t + i * 0.12); n.stop(t + i * 0.12 + 0.3);
          });
          break;
        case 'reveal':
          o.type = 'triangle'; o.frequency.setValueAtTime(440, t);
          o.frequency.linearRampToValueAtTime(880, t + 0.1);
          g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          o.start(t); o.stop(t + 0.15);
          break;
        case 'round':
          o.type = 'sine'; o.frequency.value = 800;
          g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
          o.start(t); o.stop(t + 0.12);
          setTimeout(() => { this.play('round2'); }, 120);
          break;
        case 'round2':
          o.type = 'sine'; o.frequency.value = 1000;
          g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
          o.start(t); o.stop(t + 0.12);
          break;
        case 'move':
          o.type = 'sine'; o.frequency.value = 440;
          g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
          o.start(t); o.stop(t + 0.06);
          break;
      }
    } catch (e) { /* ignore audio errors */ }
  }
};

// ==================== TOAST SYSTEM ====================
function showToast(msg, type) {
  if (document.getElementById('toasts').children.length > 5) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

function processEvents(events) {
  if (!events || !events.length) return;
  for (const e of events) {
    switch (e.type) {
      case 'kill':
        showToast(`⚔️ ${teamEmoji(e.killerTeam)} ${e.killerName} 击杀了 ${teamEmoji(e.targetTeam)} ${e.targetName}`, 'warn');
        Sfx.play('kill');
        break;
      case 'bedDestroy':
        flashBeds.add(e.targetTeam + '_upper');
        showToast(`🛏️ ${teamEmoji(e.killerTeam)} ${e.killerName} 摧毁了 ${teamEmoji(e.targetTeam)} ${teamName(e.targetTeam)} 的床`, 'warn');
        Sfx.play('destroy');
        break;
      case 'gameover':
        if (e.winnerTeam) {
          showToast(`🏆 ${teamName(e.winnerTeam)} 获胜！`, 'good');
        }
        Sfx.play('win');
        break;
      case 'breakDef':
        showToast(`⛏️ ${teamEmoji(e.team)} 拆除了 ${teamName(e.targetTeam)} 的 ${e.removed}层防御 (剩${e.remaining})`, 'info');
        Sfx.play('kill');
        break;
      case 'tnt':
        showToast(`💥 ${teamEmoji(e.team)} 用TNT炸毁 ${teamName(e.targetTeam)} 全部 ${e.blown}层防御！`, 'warn');
        Sfx.play('destroy');
        break;
      case 'pearl':
        showToast(`🟣 ${teamEmoji(e.team)} 使用末影珍珠传送`, 'info');
        Sfx.play('tap');
        break;
      case 'suicide':
        showToast(`💀 ${teamEmoji(e.team)} 自杀了`, 'warn');
        Sfx.play('kill');
        break;
    }
  }
}
