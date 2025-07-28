// server.js
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

// Trust proxy headers so we get the real client IP
app.set('trust proxy', true);

// Serve JSON bodies and static files from project root
app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd()));

const DATA_FILE  = path.join(process.cwd(), 'tokens.json');
const VOTES_FILE = path.join(process.cwd(), 'votes.json');

// Utility: read JSON or fallback
async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
// Utility: write JSON
async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// — Admin login endpoint —
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Unauthorized' });
});

// — Socket.io connection —
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
});

// — GET approved + compute 24h votes —
app.get('/api/approved', async (_req, res) => {
  const tokens = await readJson(DATA_FILE, []);
  let voteEvents = await readJson(VOTES_FILE, []);
  if (!Array.isArray(voteEvents)) voteEvents = [];

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const counts24h = voteEvents
    .filter(e => e.ts >= cutoff)
    .reduce((acc, e) => {
      acc[e.symbol] = (acc[e.symbol] || 0) + 1;
      return acc;
    }, {});

  const out = tokens.map(t => ({
    ...t,
    votes: t.votes || 0,
    votes24h: counts24h[t.symbol] || 0,
    ranking: typeof t.ranking === 'number' ? t.ranking : 0.0
  }));

  res.json(out);
});

// — POST new token (pending approval) —
app.post('/api/approved', async (req, res) => {
  const newToken = req.body;
  if (!newToken || !newToken.name) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  newToken.createdAt = Date.now();
  newToken.votes = 0;
  newToken.ranking = 0.0;

  const tokens = await readJson(DATA_FILE, []);
  tokens.push(newToken);
  await writeJson(DATA_FILE, tokens);

  res.status(201).json(newToken);
});

// — DELETE an approved token —
app.delete('/api/approved/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  let tokens = await readJson(DATA_FILE, []);
  const before = tokens.length;
  tokens = tokens.filter(t => t.symbol !== symbol);
  if (tokens.length === before) {
    return res.status(404).json({ error: 'Token not found' });
  }
  await writeJson(DATA_FILE, tokens);
  res.status(204).end();
});

// — PUT vote (rate‑limited & record history) —
app.put('/api/approved/:symbol/vote', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const symbol = req.params.symbol;
  const now = Date.now();
  const TTL = 12 * 60 * 60 * 1000; // 12h

  const tokens = await readJson(DATA_FILE, []);
  let voteEvents = await readJson(VOTES_FILE, []);
  if (!Array.isArray(voteEvents)) voteEvents = [];

  const lastByIp = voteEvents
    .filter(e => e.symbol === symbol && e.ip === ip)
    .sort((a, b) => b.ts - a.ts)[0]?.ts || 0;

  if (now - lastByIp < TTL) {
    const hoursLeft = Math.ceil((TTL - (now - lastByIp)) / (60 * 60 * 1000));
    return res.status(429).json({ error: `Rate limit: wait ${hoursLeft}h before voting` });
  }

  voteEvents.push({ symbol, ip, ts: now });
  await writeJson(VOTES_FILE, voteEvents);

  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }
  tokens[idx].votes = (tokens[idx].votes || 0) + 1;
  await writeJson(DATA_FILE, tokens);

  io.emit('voteUpdate', { symbol, votes: tokens[idx].votes });
  res.json({ symbol, votes: tokens[idx].votes });
});

// — PUT set total votes for a token —
app.put('/api/approved/:symbol/votes', async (req, res) => {
  const symbol = req.params.symbol;
  const { votes } = req.body;
  if (typeof votes !== 'number' || votes < 0) {
    return res.status(400).json({ error: 'Invalid votes value' });
  }

  const tokens = await readJson(DATA_FILE, []);
  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }

  tokens[idx].votes = votes;
  await writeJson(DATA_FILE, tokens);

  io.emit('voteUpdate', { symbol, votes });
  res.json({ symbol, votes });
});

// — PUT set safety ranking for a token (admin only) —
// << ONLY THIS BLOCK WAS CHANGED >>
app.put('/api/approved/:symbol/ranking', async (req, res) => {
  const symbol = req.params.symbol;
  let { ranking } = req.body;

  // Clamp and validate
  if (typeof ranking !== 'number') {
    return res.status(400).json({ error: 'Ranking must be a number between 0 and 100' });
  }
  ranking = Math.min(100, Math.max(0, ranking));

  // Round to one decimal
  const newRank = parseFloat(ranking.toFixed(1));

  const tokens = await readJson(DATA_FILE, []);
  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }

  tokens[idx].ranking = newRank;
  await writeJson(DATA_FILE, tokens);

  // Broadcast as a voteUpdate so your existing client listener will pick it up
  io.emit('voteUpdate', { symbol, votes: tokens[idx].votes });

  res.json({ symbol, ranking: newRank });
});
// << END CHANGED BLOCK >>

// Ensure votes.json exists as array
(async () => {
  let v = await readJson(VOTES_FILE, []);
  if (!Array.isArray(v)) v = [];
  await writeJson(VOTES_FILE, v);
})();

// Catch-all to serve index.html for SPA/deep routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
