# Mind Meld

A cooperative real-time word game for 2–8 players. Join with a 4-letter room code, no login, no install.

## How to play
1. Everyone secretly types any word. All words are revealed together.
2. Next round, each player types a word that connects the words just revealed.
3. Repeat until everyone types the same word. Fewer rounds is better.

## Run locally
```
npm install
npm start
```
Open http://localhost:3000 in two browser windows (or a phone on the same Wi-Fi) to test.

## Deploy free on Render (public URL)
1. Create a GitHub repo and push this folder (do not commit `node_modules`; add it to `.gitignore`).
2. On render.com: New > Web Service > connect the repo.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`. Plan: Free.
4. When it finishes, you get a URL like `https://mind-meld-xxxx.onrender.com`. That is your submission link.
5. Free services sleep after inactivity; open the link once before judges/friends try it so it wakes up (about 30 seconds).

Any host that runs Node and supports WebSockets (Railway, Fly.io, Glitch) works the same way. The server reads the `PORT` environment variable.

## Tech
Node.js + `ws` WebSocket server holds all game state; the browser client is a single static HTML file. Reconnect is handled with a per-player token stored in localStorage, so refreshing the page keeps you in the game.

## Reliability and deployment notes
- WebSocket messages are limited to 2 KiB and each connection is rate-limited to 40 messages per 10 seconds.
- The server caps active rooms at 500 and expires rooms with no connected players after 30 minutes of inactivity.
- Optional WebSocket origin allowlisting is available with `ALLOWED_ORIGINS`, a comma-separated list of full origins (for example `https://your-game.example.com`). Leave it unset when hosting environments or preview URLs make a fixed list impractical.
- Room state is still in memory. A process restart clears rooms and scores; use a shared persistent store only if persistence or multiple server instances are needed.

## Tests

```sh
npm test       # Offline protocol + HTTP regression tests (no installed dependencies needed)
npm run test:live  # Real WebSocket end-to-end test; run after npm install
```

The offline suite exercises room creation/joining, round transitions, matching-word wins, invalid sessions, reconnection identity, host handover, and HTTP routes through a deterministic WebSocket transport double. The live suite starts the actual server and uses the `ws` package to verify real WebSocket gameplay and reconnection.

## Quick checks
```sh
npm install
npm test
npm run test:live
npm start
# In another terminal:
curl -i http://localhost:3000/health
curl -i http://localhost:3000/
```
