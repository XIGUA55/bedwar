# 🛏️ BedWar 起床战争

A multiplayer turn-based strategy game inspired by Minecraft BedWars. Actions are resolved through rock-paper-scissors (RPS) instead of real-time combat.

一款受 Minecraft 起床战争启发的多人回合制策略游戏。用石头剪刀布而非实时战斗来决定行动。

---

## 🎮 Gameplay / 玩法

| | |
|---|---|
| **Players / 人数** | 2–4 teams, 1 player per team / 每队1人 |
| **Map / 地图** | Cross-shaped: Main island + bridges + upper/lower bases per team / 十字形：主岛 + 桥 + 每队的上下层 |
| **Win condition / 胜利** | Eliminate all other teams / 消灭所有其他队伍 |

### Round Structure / 每轮流程

1. **RPS Phase / 猜拳阶段** — all alive players secretly choose ✊ ✋ ✌️. Results revealed simultaneously.
2. **Action Phase / 行动阶段** — winners act. Each gets `loserCount` actions.
3. **Actions / 可用行动：**
   - 🚶 **Move** — walk to an adjacent location (1 action)
   - ⚔️ **Kill** — eliminate an enemy on the same tile (1 action)
   - 🛏️ **Destroy Bed** — break an enemy team's bed (1 action)

### Respawn / 复活

- If your team's bed is **intact** → you respawn next round at your lower base.
- If your bed is **destroyed** → permanent death.

---

## 🚀 How to Run / 运行方式

### Offline (local hot-seat) / 离线本地

Open `bedwar.html` in a browser. 3–4 players take turns on the same device.

```bash
open bedwar.html
```

### Online (multiplayer) / 在线联机

```bash
# 1. Install dependencies
npm install

# 2. Start server
npm run dev
```

Then open `http://localhost:3000` in your browser.

#### Expose with Cloudflare Tunnel / 用 Cloudflare Tunnel 暴露

```bash
# Download once
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared

# Start tunnel
./cloudflared tunnel --url http://localhost:3000
```

Share the `https://xxx.trycloudflare.com` URL with friends. No registration or public IP needed.

---

## 📁 Project Structure / 项目结构

```
bedwar/
├── bedwar.html          # Offline version / 离线版 (single-file HTML)
├── package.json         # Node dependencies
├── server.js            # Game server / 游戏服务端 (state machine + Socket.io)
├── public/
│   └── index.html       # Online client / 联机客户端
└── stats.json           # Player stats / 玩家数据 (auto-generated)
```

---

## ✨ Features / 特性

- 🔐 **RPS-based action resolution** — everyone reveals simultaneously
- 📊 **RPS history tracking** — see opponents' choice patterns (frequency + recent picks)
- 💬 **In-game chat** — persists before, during, and after matches
- 🎵 **Sound effects** — Web Audio API, no external files
- 📢 **Event toasts** — kills, bed destroys, game-over notifications
- 💾 **Player stats** — wins, kills, beds destroyed saved to JSON
- 📱 **Mobile responsive** — works on phones and tablets
- 🔌 **Reconnection** — auto-reconnect on disconnect
- 🏆 **Room persistence** — stay in room after game ends, chat continues, start another match

---

## 🛠️ Tech Stack / 技术栈

| Layer | Tech |
|-------|------|
| Frontend | HTML5, CSS3, Vanilla JS |
| Backend | Node.js, Express, Socket.io |
| Audio | Web Audio API (oscillator synthesis) |
| Storage | Local JSON file |

---

## 📄 License

MIT
