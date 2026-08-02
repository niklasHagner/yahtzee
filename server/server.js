const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3008;

// Create HTTP server to serve index.html
const httpServer = http.createServer((req, res) => {
  // Handle room code API
  if (req.method === 'GET' && req.url === '/api/new-room') {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code }));
    return;
  }

  // Serve index.html for all other requests
  const filePath = path.join(__dirname, '..', 'index.html');
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404: index.html not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

console.log(`Server listening on http://localhost:${PORT}`);

// Room codes: code -> { roomId, players: [ws, ws], started: bool }
const roomCodes = new Map();

// active rooms: roomId -> { players: [{ws, name, id}], scores, turn }
const rooms = new Map();

let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, excludeId = null) {
  room.players.forEach(p => {
    if (p.id !== excludeId) send(p.ws, msg);
  });
}

function rollDice(count) {
  return Array.from({ length: count }, () => Math.ceil(Math.random() * 6));
}

const MAX_LOBBY_PLAYERS = 6;

wss.on('connection', ws => {
  const id = nextId++;
  ws.playerId = id;
  console.log(`[connect] player ${id}`);

  send(ws, { type: 'connected', id });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const name = (msg.name || 'ANON').toUpperCase().replace(/[^A-Z ]/g,'').slice(0, 20).trim() || 'ANON';
        const code = msg.code ? msg.code.toUpperCase() : null;
        ws.playerName = name;
        console.log(`[join] player ${id} name=${name} code=${code || '(create)'}`);

        if (code) {
          const roomData = roomCodes.get(code);
          console.log(`[join] lookup ${code}:`, roomData ? `started=${roomData.started} players=${roomData.players.length}` : 'NOT FOUND');

          if (!roomData) { send(ws, { type: 'error', message: 'Room not found.' }); return; }
          if (roomData.started) { send(ws, { type: 'error', message: 'Game already in progress.' }); return; }
          if (roomData.players.length >= MAX_LOBBY_PLAYERS) { send(ws, { type: 'error', message: 'Room is full.' }); return; }

          // Already in this lobby — re-send current state
          const existing = roomData.players.findIndex(p => p.ws === ws);
          if (existing !== -1) {
            const list = roomData.players.map((p, i) => ({ name: p.name, index: i }));
            send(ws, { type: 'player_joined', players: list, yourIndex: existing });
            return;
          }

          // Host slot disconnected — take it over
          if (roomData.hostDisconnected) {
            roomData.players[0] = { ws, name, id };
            roomData.hostDisconnected = false;
          } else {
            roomData.players.push({ ws, name, id });
          }
          ws.code = code;
        } else {
          // Create new room
          const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
          roomCodes.set(newCode, { players: [{ ws, name, id }], started: false, hostDisconnected: false });
          ws.code = newCode;
          console.log(`[join] player ${id} created room ${newCode}`);
          send(ws, { type: 'room_created', code: newCode });
        }

        // Broadcast updated lobby state to all members
        const code2 = ws.code;
        const roomData2 = roomCodes.get(code2);
        const list = roomData2.players.map((p, i) => ({ name: p.name, index: i }));
        roomData2.players.forEach((p, i) => send(p.ws, { type: 'player_joined', players: list, yourIndex: i }));
        break;
      }

      case 'start': {
        const code = ws.code;
        const roomData = roomCodes.get(code);
        if (!roomData || roomData.started) return;
        const hostIdx = roomData.players.findIndex(p => p.ws === ws);
        if (hostIdx !== 0) { send(ws, { type: 'error', message: 'Only the host can start.' }); return; }
        if (roomData.players.length < 2) { send(ws, { type: 'error', message: 'Need at least 2 players to start.' }); return; }

        const roomId = `room_${code}`;
        const room = {
          id: roomId,
          players: roomData.players.map(p => ({ ws: p.ws, name: p.name, id: p.id, scores: {}, yahtzeeBonus: 0 })),
          turn: 0,
          rollsLeft: 3,
          dice: rollDice(5),
          keptMask: [false, false, false, false, false],
        };
        rooms.set(roomId, room);
        roomData.started = true;
        room.players.forEach(p => { p.ws.roomId = roomId; });
        console.log(`[start] room ${roomId} with ${room.players.length} players`);

        room.players.forEach((p, i) => send(p.ws, {
          type: 'game_start',
          roomId,
          yourIndex: i,
          players: room.players.map(p2 => p2.name),
          dice: room.dice,
          rollsLeft: room.rollsLeft,
          turn: room.turn,
        }));
        break;
      }

      case 'keep_toggle': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const pi = room.players.findIndex(p => p.id === id);
        if (pi !== room.turn) return;
        const idx = msg.index;
        if (idx < 0 || idx > 4) return;
        room.keptMask[idx] = !room.keptMask[idx];
        broadcast(room, { type: 'keep_update', index: idx, kept: room.keptMask[idx] });
        break;
      }

      case 'roll': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const pi = room.players.findIndex(p => p.id === id);
        if (pi !== room.turn || room.rollsLeft <= 0) return;

        room.dice = room.dice.map((d, i) => room.keptMask[i] ? d : Math.ceil(Math.random() * 6));
        room.rollsLeft--;

        broadcast(room, {
          type: 'dice_rolled',
          dice: room.dice,
          keptMask: room.keptMask,
          rollsLeft: room.rollsLeft,
          rolledBy: pi,
        });
        break;
      }

      case 'score': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const pi = room.players.findIndex(p => p.id === id);
        if (pi !== room.turn) return;

        const player = room.players[pi];
        const { category, score } = msg;
        if (player.scores[category] !== undefined) return;
        player.scores[category] = score;

        room.turn = (room.turn + 1) % room.players.length;
        room.rollsLeft = 3;
        room.keptMask = [false, false, false, false, false];
        room.dice = rollDice(5);

        broadcast(room, {
          type: 'score_committed',
          byIndex: pi,
          category,
          score,
          nextTurn: room.turn,
          dice: room.dice,
          rollsLeft: room.rollsLeft,
        });

        const CATS = ['ones','twos','threes','fours','fives','sixes','3oak','4oak','fh','ss','ls','yahtzee','chance'];
        const allDone = room.players.every(p => CATS.every(c => p.scores[c] !== undefined));
        if (allDone) {
          const totals = room.players.map(p => Object.values(p.scores).reduce((a,b) => a+b, 0));
          broadcast(room, { type: 'game_over', totals, names: room.players.map(p => p.name) });
          rooms.delete(room.id);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[disconnect] player ${id}`);
    if (ws.code) {
      const roomData = roomCodes.get(ws.code);
      if (roomData && !roomData.started) {
        const idx = roomData.players.findIndex(p => p.ws === ws);
        if (idx !== -1) roomData.players.splice(idx, 1);
        if (roomData.players.length === 0) {
          // Schedule cleanup; code stays alive briefly so URL sharing still works
          roomData.hostDisconnected = true;
          setTimeout(() => { if (!roomData.started) roomCodes.delete(ws.code); }, 5 * 60_000);
        } else {
          // Promote next player as host if host left
          if (idx === 0) roomData.players[0].ws.code = ws.code;
          const list = roomData.players.map((p, i) => ({ name: p.name, index: i }));
          roomData.players.forEach((p, i) => send(p.ws, { type: 'player_joined', players: list, yourIndex: i }));
        }
      }
    }
    const room = rooms.get(ws.roomId);
    if (room) {
      broadcast(room, { type: 'opponent_disconnected' }, id);
      rooms.delete(ws.roomId);
    }
  });
});

httpServer.listen(PORT);
console.log(`Yahtzee server running on http://localhost:${PORT}`);

// keep-alive ping so free hosts don't drop idle connections
setInterval(() => {
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.ping(); });
}, 25_000);
