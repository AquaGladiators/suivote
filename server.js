// server.js
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();                     // Load environment variables from .env

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

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
}
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

// ————— Voting & Token APIs —————
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
});

// Get all approved tokens
app.get('/api/approved', async (_req, res) => {
  const tokens = await readJson(DATA_FILE, []);
  res.json(tokens);
});

// Submit a new token (pending admin approval)
app.post('/api/approved', async (req, res) => {
  const newToken = req.body;
  if (!newToken || !newToken.name) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  newToken.createdAt = Date.now();
  const tokens = await readJson(DATA_FILE, []);
  tokens.push(newToken);
  await writeJson(DATA_FILE, tokens);
  res.status(201).json(newToken);
});

// Delete an approved token
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

// Vote for a token (rate‑limited by real client IP every 12h)
app.put('/api/approved/:symbol/vote', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const symbol = req.params.symbol;

  const tokens   = await readJson(DATA_FILE, []);
  const votesMap = await readJson(VOTES_FILE, {});

  if (!votesMap[ip]) votesMap[ip] = {};
  const last = votesMap[ip][symbol] || 0;
  const now  = Date.now();
  const TTL  = 12 * 60 * 60 * 1000; // 12 hours

  if (now - last < TTL) {
    const hoursLeft = Math.ceil((TTL - (now - last)) / (60 * 60 * 1000));
    return res.status(429).json({ error: `Rate limit: wait ${hoursLeft}h before voting` });
  }

  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }

  tokens[idx].votes = (tokens[idx].votes || 0) + 1;
  votesMap[ip][symbol] = now;

  await writeJson(DATA_FILE, tokens);
  await writeJson(VOTES_FILE, votesMap);

  io.emit('voteUpdate', { symbol, votes: tokens[idx].votes });
  res.json({ symbol, votes: tokens[idx].votes });
});

// Ensure votes.json exists
(async () => { await readJson(VOTES_FILE, {}); })();

// Catch-all to serve index.html for SPA/deep routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
