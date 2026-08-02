# Yahtzee Multiplayer Server

WebSocket server for the online multiplayer mode of Yahtzee.

## Prerequisites

- Node.js 14+ and npm

## Installation

```bash
cd server
npm install
```

## Running

```bash
npm start
```

The server will start on port 3008 (or the `PORT` environment variable if set).

```bash
# Custom port example
PORT=8080 npm start
```

## Configuration

The client connects to the server using the `WS_URL` constant in `index.html`. You need to update this with your deployed server URL:

```javascript
const WS_URL = 'wss://your-server-host.example.com';
```

**Important**: Use `wss://` (secure WebSocket) in production.

## How It Works

- **Lobby matching**: Players join with a 3-letter name and are auto-matched with the first waiting opponent
- **Game rooms**: Each matched pair gets a private room for the entire game
- **Turn management**: Server enforces turn order and validates all moves
- **Auto keep-alive**: Sends ping every 25 seconds to prevent idle disconnects on free hosting (e.g., Render, Heroku)
- **Reconnection logic**: Client automatically retries with exponential backoff (1s → 2s → 4s… capped at 10s) if the server goes to sleep

## Deployment

Recommended free/cheap hosts with WebSocket support:
- **Render** (render.com) — free tier, auto-spins down after 15 mins of inactivity
- **Railway** (railway.app) — $5/month for hobby tier
- **Replit** (replit.com) — free with limitations
- **Fly.io** (fly.io) — generous free tier

For Render, set the health check endpoint to any path (it will return a 404, but that's fine).

## Protocol

**Client → Server messages:**

- `{ type: 'join', name: 'ABC' }` — Enter lobby with a name
- `{ type: 'keep_toggle', index: 0 }` — Toggle keeping die at index 0–4
- `{ type: 'roll' }` — Roll the free dice
- `{ type: 'score', category: 'ones', score: 5 }` — Commit a score and end turn

**Server → Client messages:**

- `{ type: 'connected', id }` — Connection established
- `{ type: 'waiting', message: '...' }` — Waiting for an opponent
- `{ type: 'game_start', roomId, yourIndex, opponent, dice, rollsLeft, turn }` — Game started
- `{ type: 'keep_update', index, kept }` — A keep toggle was processed
- `{ type: 'dice_rolled', dice, keptMask, rollsLeft, rolledBy }` — Dice rolled
- `{ type: 'score_committed', byIndex, category, score, nextTurn, dice, rollsLeft }` — Turn advanced
- `{ type: 'game_over', totals, names }` — Game ended
- `{ type: 'opponent_disconnected' }` — Opponent left

## Notes

- The server does **not** enforce Yahtzee scoring rules; it trusts the client. For a production game, move score validation to the server.
- Game state is ephemeral; restarting the server drops all active games.
- No persistent database; scores are not saved on the server (only localStorage in the browser).
