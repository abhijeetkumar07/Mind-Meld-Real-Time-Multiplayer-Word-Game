'use strict';

// End-to-end tests using the real `ws` transport. Run after `npm install` with
// `npm run test:live`; the offline protocol suite does not require dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(err => err ? reject(err) : resolve(port));
    });
  });
}

function client(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });
  ws.on('error', () => {});
  const waitFor = (predicate, timeout = 4000) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for message; received: ${messages.map(m => m.type + (m.phase ? ':' + m.phase : '')).join(', ')}`));
      }, timeout);
      waiters.push(waiter);
    });
  };
  const open = () => ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise((resolve, reject) => {
    ws.once('open', resolve); ws.once('error', reject);
  });
  const send = value => ws.send(JSON.stringify(value));
  const close = () => new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve); ws.close();
  });
  return { ws, open, send, waitFor, close, messages };
}

test('real WebSocket clients can play, reconnect, and complete a winning round', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });
  t.after(() => { child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${logs}`);
    try { const r = await fetch(`${base}/health`); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(ready, true, `server did not become ready: ${logs}`);

  const url = `ws://127.0.0.1:${port}`;
  const host = client(url); const guest = client(url);
  t.after(async () => { await Promise.all([host.close(), guest.close()]); });
  await Promise.all([host.open(), guest.open()]);
  host.send({ type: 'create', name: 'Host' });
  const created = await host.waitFor(m => m.type === 'joined');
  guest.send({ type: 'join', code: created.code, name: 'Guest' });
  const joinedGuest = await guest.waitFor(m => m.type === 'joined');
  assert.match(created.code, /^[A-Z]{4}$/);
  assert.ok(joinedGuest.token);

  host.send({ type: 'start' });
  await Promise.all([
    host.waitFor(m => m.type === 'state' && m.phase === 'input'),
    guest.waitFor(m => m.type === 'state' && m.phase === 'input'),
  ]);
  host.send({ type: 'submit', word: 'together' });
  guest.send({ type: 'submit', word: 'together' });
  const [hostWon, guestWon] = await Promise.all([
    host.waitFor(m => m.type === 'state' && m.phase === 'won'),
    guest.waitFor(m => m.type === 'state' && m.phase === 'won'),
  ]);
  assert.equal(hostWon.round, 1);
  assert.equal(guestWon.best, 1);

  await guest.close();
  const reconnect = client(url);
  t.after(() => reconnect.close());
  await reconnect.open();
  reconnect.send({ type: 'join', code: created.code, token: joinedGuest.token, name: 'Guest' });
  const restored = await reconnect.waitFor(m => m.type === 'joined');
  assert.equal(restored.id, joinedGuest.id, 'reconnect should restore the same player');
  const restoredState = await reconnect.waitFor(m => m.type === 'state' && m.phase === 'won');
  assert.ok(restoredState.players.some(p => p.id === restored.id && p.connected));
});
