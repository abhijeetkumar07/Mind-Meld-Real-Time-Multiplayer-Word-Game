const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 30 * 60 * 1000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }

  // Only serve files explicitly inside public; room invite URLs use the SPA fallback.
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, requested);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const serve = (target, fallback = false) => fs.readFile(target, (err, data) => {
    if (err) {
      const rawCode = pathname.replace(/^\/+|\/+$/g, '');
      if (!fallback && /^[A-Za-z]{4}$/.test(rawCode)) {
        serve(path.join(PUBLIC, 'index.html'), true);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
      }
      return;
    }
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
  serve(file);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 2048,
  verifyClient: ({ origin }, done) => {
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      done(false, 403, 'Origin not allowed');
      return;
    }
    done(true);
  },
});

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 100; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no codes');
}

function normalize(w) {
  return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function cleanName(n) {
  return String(n || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connected(room) { return [...room.players.values()].filter(p => p.ws); }

function viewFor(room, me) {
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, connected: !!p.ws,
    submitted: p.word !== null,
    word: room.phase === 'reveal' || room.phase === 'won' ? p.lastWord : undefined,
    ready: p.ready,
  }));
  return {
    type: 'state',
    code: room.code, phase: room.phase, round: room.round, hostId: room.hostId,
    me: me.id, myWord: me.word, players, history: room.history, best: room.best,
  };
}

function broadcast(room) {
  for (const p of room.players.values()) if (p.ws) send(p.ws, viewFor(room, p));
}

function allSubmitted(room) {
  const live = connected(room);
  return live.length >= 2 && live.every(p => p.word !== null);
}

function reveal(room) {
  const live = connected(room).filter(p => p.word !== null);
  const entry = { round: room.round, words: live.map(p => ({ name: p.name, color: p.color, word: p.word })) };
  for (const p of room.players.values()) { p.lastWord = p.word; }
  room.history.push(entry);
  const set = new Set(live.map(p => p.word));
  if (set.size === 1) {
    room.phase = 'won';
    if (room.best === null || room.round < room.best) room.best = room.round;
  } else {
    room.phase = 'reveal';
  }
  for (const p of room.players.values()) { p.ready = false; }
  broadcast(room);
}

function startRound(room) {
  room.round += 1;
  room.phase = 'input';
  for (const p of room.players.values()) { p.word = null; p.ready = false; }
  broadcast(room);
}

function resetGame(room) {
  room.round = 0; room.history = []; room.phase = 'lobby';
  for (const p of room.players.values()) { p.word = null; p.lastWord = null; p.ready = false; }
  broadcast(room);
}

function pickHost(room) {
  const cur = room.players.get(room.hostId);
  if (cur && cur.ws) return;
  const next = connected(room)[0];
  if (next) room.hostId = next.id;
}

wss.on('connection', (ws) => {
  let room = null, player = null;
  let windowStarted = Date.now(), messageCount = 0;
  ws.on('error', () => {});
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStarted >= 10000) { windowStarted = now; messageCount = 0; }
    if (++messageCount > 40) { send(ws, { type: 'error', message: 'Too many requests. Please slow down.' }); ws.close(1008, 'Rate limit'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'The server is busy. Try again shortly.' });
      if (room && player) return send(ws, { type: 'error', message: 'Leave your current room before creating another.' });
      let code;
      try { code = makeCode(); }
      catch { return send(ws, { type: 'error', message: 'Unable to create room. Please try again.' }); }
      room = { code, players: new Map(), phase: 'lobby', round: 0, history: [], hostId: null, best: null, created: Date.now(), lastActivity: Date.now() };
      rooms.set(code, room);
      msg = { type: 'join', code, name: msg.name };
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'error', message: `No room "${code}". Check the code and try again.` });
      // reconnect by token
      let p = msg.token && [...r.players.values()].find(x => x.token === msg.token);
      if (msg.token && !p) return send(ws, { type: 'error', message: 'That saved session has expired. Please join the room again.' });
      if (p) {
        if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} }
        p.ws = ws;
      } else {
        if (r.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'This room is full (max 8).' });
        if (r.phase !== 'lobby') return send(ws, { type: 'error', message: 'That game already started. Ask the host to restart to the lobby.' });
        const used = new Set([...r.players.values()].map(x => x.color));
        p = {
          id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(12).toString('hex'),
          name: cleanName(msg.name), color: COLORS.find(c => !used.has(c)) || COLORS[0],
          ws, word: null, lastWord: null, ready: false,
        };
        r.players.set(p.id, p);
      }
      room = r; player = p; room.lastActivity = Date.now();
      if (!room.hostId) room.hostId = p.id;
      pickHost(room);
      send(ws, { type: 'joined', code: room.code, token: p.token, id: p.id });
      broadcast(room);
      return;
    }

    if (!room || !player) return;
    room.lastActivity = Date.now();

    if (msg.type === 'start') {
      if (player.id !== room.hostId || room.phase !== 'lobby') return;
      if (connected(room).length < 2) return send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
      startRound(room);
    } else if (msg.type === 'submit') {
      if (room.phase !== 'input' || player.word !== null) return;
      const w = normalize(msg.word);
      if (!w) return send(ws, { type: 'error', message: 'Type a word first.' });
      player.word = w;
      if (allSubmitted(room)) reveal(room); else broadcast(room);
    } else if (msg.type === 'next') {
      if (room.phase !== 'reveal') return;
      player.ready = true;
      const live = connected(room);
      if (live.length >= 2 && live.every(p => p.ready)) startRound(room); else broadcast(room);
    } else if (msg.type === 'again') {
      if (player.id !== room.hostId || room.phase !== 'won') return;
      resetGame(room);
    } else if (msg.type === 'leave') {
      removePlayer(room, player);
      try { ws.close(); } catch {}
      room = null; player = null;
    }
  });

  ws.on('close', () => {
    if (!room || !player) return;
    room.lastActivity = Date.now();
    if (player.ws === ws) player.ws = null;
    pickHost(room);
    const live = connected(room);
    if (room.phase === 'input' && allSubmitted(room)) reveal(room);
    else if (room.phase === 'reveal' && live.length >= 2 && live.every(p => p.ready)) startRound(room);
    else broadcast(room);
    if (connected(room).length < 2 && room.phase !== 'lobby' && room.phase !== 'won') {
      // not enough players left: wait; they can rejoin with their token
    }
  });
});

function removePlayer(room, player) {
  room.lastActivity = Date.now();
  room.players.delete(player.id);
  pickHost(room);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  const live = connected(room);
  if (room.phase === 'input' && allSubmitted(room)) reveal(room);
  else if (room.phase === 'reveal' && live.length >= 2 && live.every(p => p.ready)) startRound(room);
  else broadcast(room);
}

// heartbeat + cleanup of abandoned rooms
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (connected(room).length === 0 && now - (room.lastActivity || room.created) > ROOM_TTL_MS) rooms.delete(code);
  }
}, 20000);
heartbeatTimer.unref?.();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mind Meld running on port ${PORT}`));
}

module.exports = { server, wss, rooms, normalize, cleanName, constants: { MAX_ROOMS, MAX_PLAYERS, ROOM_TTL_MS } };
