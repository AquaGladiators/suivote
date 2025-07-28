// server.js
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

// ✅ Let Express trust proxy headers (important for real IP detection)
app.set('trust proxy', true);

const DATA_FILE  = path.join(process.cwd(), 'tokens.json');
const VOTES_FILE = path.join(process.cwd(), 'votes.json');

// Allow large JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd())); // Serve HTML, JSON

// Helpers
async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
}
async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// WebSocket connection
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
});

// GET approved tokens
app.get('/api/approved', async (_req, res) => {
  const tokens = await readJson(DATA_FILE, []);
  res.json(tokens);
});

// POST new token
app.post('/api/approved', async (req, res) => {
  const newToken = req.body;
  if (!newToken || !newToken.name) return res.status(400).json({ error: 'Invalid payload' });
  newToken.createdAt = Date.now();
  const tokens = await readJson(DATA_FILE, []);
  tokens.push(newToken);
  await writeJson(DATA_FILE, tokens);
  res.status(201).json(newToken);
});

// DELETE token by symbol
app.delete('/api/approved/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  let tokens = await readJson(DATA_FILE, []);
  const before = tokens.length;
  tokens = tokens.filter(t => t.symbol !== symbol);
  if (tokens.length === before) return res.status(404).json({ error: 'Token not found' });
  await writeJson(DATA_FILE, tokens);
  res.status(204).end();
});

// ✅ PUT to vote, limited by IP every 12h (real IP fix)
app.put('/api/approved/:symbol/vote', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const symbol = req.params.symbol;

  const tokens   = await readJson(DATA_FILE, []);
  const votesMap = await readJson(VOTES_FILE, {});

  if (!votesMap[ip]) votesMap[ip] = {};
  const last = votesMap[ip][symbol] || 0;
  const now = Date.now();
  const TTL = 12 * 60 * 60 * 1000;

  if (now - last < TTL) {
    const hoursLeft = Math.ceil((TTL - (now - last)) / (60 * 60 * 1000));
    return res.status(429).json({ error: `Rate limit: wait ${hoursLeft}h before voting for ${symbol}` });
  }

  const idx = tokens.findIndex(t => t.symbol === symbol);
  if (idx === -1) return res.status(404).json({ error: 'Token not found' });

  tokens[idx].votes = (tokens[idx].votes || 0) + 1;
  votesMap[ip][symbol] = now;

  await writeJson(DATA_FILE, tokens);
  await writeJson(VOTES_FILE, votesMap);

  // Broadcast vote update
  io.emit('voteUpdate', { symbol, votes: tokens[idx].votes });
  res.json({ symbol, votes: tokens[idx].votes });
});

// Ensure votes.json exists
(async () => { await readJson(VOTES_FILE, {}); })();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
