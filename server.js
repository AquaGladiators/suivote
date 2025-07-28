// server.js
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();                     // Load .env

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.set('trust proxy', true);        // Real IPs

// Serve JSON bodies and static files from project root
app.use(express.json({ limit: '50mb' }));
app.use(express.static(process.cwd()));

const DATA_FILE  = path.join(process.cwd(), 'tokens.json');
const VOTES_FILE = path.join(process.cwd(), 'votes.json');

async function readJson(fp, fallback) {
  try { return JSON.parse(await fs.readFile(fp, 'utf8')); }
  catch { return fallback; }
}
async function writeJson(fp, data) {
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
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
io.on('connection', sock => console.log('Client connected:', sock.id));

app.get('/api/approved', async (_req, res) => {
  res.json(await readJson(DATA_FILE, []));
});

app.post('/api/approved', async (req, res) => {
  const t = req.body;
  if (!t?.name) return res.status(400).json({ error: 'Invalid payload' });
  t.createdAt = Date.now();
  const list = await readJson(DATA_FILE, []);
  list.push(t);
  await writeJson(DATA_FILE, list);
  res.status(201).json(t);
});

app.delete('/api/approved/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  let list = await readJson(DATA_FILE, []);
  const before = list.length;
  list = list.filter(t => t.symbol !== sym);
  if (list.length === before) return res.status(404).json({ error: 'Not found' });
  await writeJson(DATA_FILE, list);
  res.status(204).end();
});

app.put('/api/approved/:symbol/vote', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const sym = req.params.symbol;

  const list = await readJson(DATA_FILE, []);
  const votes = await readJson(VOTES_FILE, {});

  votes[ip] = votes[ip] || {};
  const last = votes[ip][sym] || 0;
  const now  = Date.now();
  const TTL  = 12 * 60 * 60 * 1000;

  if (now - last < TTL) {
    const hrs = Math.ceil((TTL - (now - last)) / (60*60*1000));
    return res.status(429).json({ error: `Wait ${hrs}h` });
  }

  const idx = list.findIndex(t => t.symbol === sym);
  if (idx === -1) return res.status(404).json({ error: 'Token not found' });

  list[idx].votes = (list[idx].votes || 0) + 1;
  votes[ip][sym] = now;

  await writeJson(DATA_FILE, list);
  await writeJson(VOTES_FILE, votes);

  io.emit('voteUpdate', { symbol: sym, votes: list[idx].votes });
  res.json({ symbol: sym, votes: list[idx].votes });
});

// Ensure votes.json exists
(async()=>{ await readJson(VOTES_FILE, {}); })();

// ————— Catch‑all to serve index.html —————
app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
