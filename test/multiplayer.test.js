'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const EventEmitter = require('node:events');
const Module = require('node:module');

// A deterministic WebSocket transport double lets the full server protocol and
// HTTP layer run in offline CI. Production still uses the real `ws` package.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(String(raw))); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() { this.emit('pong'); }
  receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
  take(type) { return this.sent.filter(m => m.type === type).at(-1); }
  all(type) { return this.sent.filter(m => m.type === type); }
}
class FakeWebSocketServer extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  connect() { const socket = new FakeSocket(); this.clients.add(socket); this.emit('connection', socket); return socket; }
  close() { for (const socket of this.clients) socket.close(); this.clients.clear(); }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return { WebSocketServer: FakeWebSocketServer };
  return originalLoad.call(this, request, parent, isMain);
};
const { server, wss, rooms } = require('../server');
Module._load = originalLoad;

let base;
test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  wss.close();
  await new Promise(resolve => server.close(resolve));
});
test.beforeEach(() => rooms.clear());

function connect() { return wss.connect(); }
function send(socket, message) { socket.receive(message); }
function state(socket) { return socket.take('state'); }
function joined(socket) { const m = socket.take('joined'); assert.ok(m, 'expected joined response'); return m; }
function createRoom(host, name = 'Host') {
  send(host, { type: 'create', name });
  const j = joined(host);
  assert.match(j.code, /^[A-Z]{4}$/);
  return j;
}
function joinRoom(socket, code, name, token) { send(socket, { type: 'join', code, name, ...(token ? { token } : {}) }); return joined(socket); }

 test('health endpoint and static frontend return expected responses', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Mind Meld/);
  const missing = await fetch(`${base}/not-a-real-file.js`);
  assert.equal(missing.status, 404);
});

test('host can create a room and a second player can join', () => {
  const host = connect();
  const guest = connect();
  const h = createRoom(host);
  const g = joinRoom(guest, h.code, 'Guest');
  assert.equal(g.code, h.code);
  assert.equal(state(host).players.length, 2);
  assert.equal(state(guest).players.length, 2);
  assert.equal(state(host).hostId, h.id);
});

test('a complete round reveals words and matching words win', () => {
  const host = connect(); const guest = connect();
  const h = createRoom(host); joinRoom(guest, h.code, 'Guest');
  send(host, { type: 'start' });
  assert.equal(state(host).phase, 'input');
  send(host, { type: 'submit', word: '  APPLE!! ' });
  assert.equal(state(host).players.find(p => p.id === h.id).submitted, true);
  send(guest, { type: 'submit', word: 'apple' });
  assert.equal(state(host).phase, 'won');
  assert.equal(state(host).round, 1);
  assert.equal(state(host).history.length, 1);
  assert.equal(state(host).best, 1);
});

test('different words reveal, and next round starts only after everyone is ready', () => {
  const host = connect(); const guest = connect();
  const h = createRoom(host); joinRoom(guest, h.code, 'Guest');
  send(host, { type: 'start' });
  send(host, { type: 'submit', word: 'river' });
  send(guest, { type: 'submit', word: 'ocean' });
  assert.equal(state(host).phase, 'reveal');
  send(host, { type: 'next' });
  assert.equal(state(host).phase, 'reveal');
  send(guest, { type: 'next' });
  assert.equal(state(host).phase, 'input');
  assert.equal(state(host).round, 2);
});

test('invalid room and expired token return errors without crashing', () => {
  const socket = connect();
  send(socket, { type: 'join', code: 'ZZZZ', token: 'expired' });
  assert.match(socket.take('error').message, /No room/);
  const host = connect(); const h = createRoom(host);
  const guest = connect();
  send(guest, { type: 'join', code: h.code, token: 'not-a-valid-token' });
  assert.match(guest.take('error').message, /saved session has expired/);
});

test('reconnecting with a valid token restores the same player identity', () => {
  const host = connect(); const h = createRoom(host);
  const guest = connect(); const g = joinRoom(guest, h.code, 'Guest');
  guest.close();
  const reconnect = connect();
  const restored = joinRoom(reconnect, h.code, 'Guest', g.token);
  // Use the actual reconnect token explicitly; this test also verifies the
  // server retains the identity across a socket close.
  assert.equal(restored.id, g.id);
  assert.equal(state(reconnect).players.find(p => p.id === g.id).connected, true);
});

test('host disconnect triggers host handover to a connected player', () => {
  const host = connect(); const h = createRoom(host);
  const guest = connect(); joinRoom(guest, h.code, 'Guest');
  host.close();
  assert.equal(state(guest).hostId, state(guest).me);
});

test('messages before joining and duplicate submissions do not corrupt state', () => {
  const stranger = connect();
  send(stranger, { type: 'start' });
  assert.equal(stranger.take('error'), undefined);
  const host = connect(); const h = createRoom(host);
  const guest = connect(); joinRoom(guest, h.code, 'Guest');
  send(host, { type: 'start' });
  send(host, { type: 'submit', word: 'one' });
  send(host, { type: 'submit', word: 'two' });
  assert.equal(state(host).players.find(p => p.id === h.id).submitted, true);
  assert.equal(state(host).phase, 'input');
});

test('player leaving during reveal phase advances round if remaining players are ready', () => {
  const host = connect();
  const guest1 = connect();
  const guest2 = connect();
  const h = createRoom(host);
  joinRoom(guest1, h.code, 'Guest 1');
  joinRoom(guest2, h.code, 'Guest 2');
  send(host, { type: 'start' });
  send(host, { type: 'submit', word: 'cat' });
  send(guest1, { type: 'submit', word: 'dog' });
  send(guest2, { type: 'submit', word: 'bird' });
  assert.equal(state(host).phase, 'reveal');
  send(host, { type: 'next' });
  send(guest1, { type: 'next' });
  assert.equal(state(host).phase, 'reveal');
  send(guest2, { type: 'leave' });
  assert.equal(state(host).phase, 'input');
  assert.equal(state(host).round, 2);
});

test('lowercase room code url and trailing slash successfully serve html', async () => {
  const lowercase = await fetch(`${base}/abcd`);
  assert.equal(lowercase.status, 200);
  assert.match(await lowercase.text(), /Mind Meld/);
  const trailingSlash = await fetch(`${base}/ABCD/`);
  assert.equal(trailingSlash.status, 200);
  assert.match(await trailingSlash.text(), /Mind Meld/);
});

test('lone connected player cannot advance round alone in reveal phase', () => {
  const host = connect();
  const guest = connect();
  const h = createRoom(host);
  joinRoom(guest, h.code, 'Guest');
  send(host, { type: 'start' });
  send(host, { type: 'submit', word: 'sun' });
  send(guest, { type: 'submit', word: 'moon' });
  assert.equal(state(host).phase, 'reveal');
  guest.close();
  send(host, { type: 'next' });
  assert.equal(state(host).phase, 'reveal');
});

