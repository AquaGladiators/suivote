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

const DATA_FILE = path.join(process.cwd(), 'tokens.json');
const VOTES_FILE = path.join(process.cwd(), 'votes.json');

// Utility: read a JSON file, or return fallback if missing/invalid
async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
// Utility: write JSON file with 2‑space indent
async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ————— Admin Login Endpoint —————
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Unauthorized' });
});

// ————— Socket.io Connection —————
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
});

// ————— Get all approved tokens + 24h vote counts —————
app.get('/api/approved', async (_req, res) => {
  const tokens = await readJson(DATA_FILE, []);
  const voteEvents = await readJson(VOTES_FILE, []);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  // Count how many votes each symbol got in the last 24h
  const counts24h = voteEvents
    .filter(e => e.ts >= cutoff)
    .reduce((acc, e) => {
      acc[e.symbol] = (acc[e.symbol] || 0) + 1;
      return acc;
    }, {});

  // Attach votes24h to each token
  const out = tokens.map(t => ({
    ...t,
    votes: t.votes || 0,
    votes24h: counts24h[t.symbol] || 0,
  }));

  res.json(out);
});

// ————— Submit a new token (pending admin approval) —————
app.post('/api/approved', async (req, res) => {
  const newToken = req.body;
  if (!newToken || !newToken.name) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  newToken.createdAt = Date.now();
  newToken.votes = 0;

  const tokens = await readJson(DATA_FILE, []);
  tokens.push(newToken);
  await writeJson(DATA_FILE, tokens);

  res.status(201).json(newToken);
});

// ————— Delete an approved token —————
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

// ————— Vote for a token (rate‑limited & record history) —————
app.put('/api/approved/:symbol/vote', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const symbol = req.params.symbol;
  const now = Date.now();
  const TTL = 12 * 60 * 60 * 1000; // 12 hours

  const tokens = await readJson(DATA_FILE, []);
  let voteEvents = await readJson(VOTES_FILE, []);

  // Rate limit: last vote timestamp by this IP for this symbol
  const lastByIp = voteEvents
    .filter(e => e.symbol === symbol && e.ip === ip)
    .sort((a, b) => b.ts - a.ts)[0]?.ts || 0;

  if (now - lastByIp < TTL) {
    const hoursLeft = Math.ceil((TTL - (now - lastByIp)) / (60 * 60 * 1000));
    return res.status(429).json({ error: `Rate limit: wait ${hoursLeft}h before voting` });
  }

  // Append new vote event
  voteEvents.push({ symbol, ip, ts: now });
  await writeJson(VOTES_FILE, voteEvents);

  // Increment total vote count on the token
  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }
  tokens[idx].votes = (tokens[idx].votes || 0) + 1;
  await writeJson(DATA_FILE, tokens);

  // Broadcast update
  io.emit('voteUpdate', { symbol, votes: tokens[idx].votes });

  res.json({ symbol, votes: tokens[idx].votes });
});

// Ensure votes.json exists as an array
(async () => {
  await readJson(VOTES_FILE, []);
})();

// Catch-all to serve index.html for SPA/deep routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
