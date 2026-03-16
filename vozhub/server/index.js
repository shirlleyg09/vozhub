/**
 * VozHub — Servidor v2
 * Node.js + Express + Socket.IO + WebRTC Signaling + MusicBot v2
 */

// ── Proteção global contra crashes ───────────────────────
// Impede que erros não capturados (ex: ytdl 429) derrubem o servidor
process.on('uncaughtException', err => {
  console.error('[ERRO NÃO CAPTURADO]', err.message);
  // Não deixa o processo morrer
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROMISE NÃO TRATADA]', reason?.message || reason);
  // Não deixa o processo morrer
});

const express      = require('express');
const http         = require('http');
const fs           = require('fs');
const { Server }   = require('socket.io');
const cors         = require('cors');
const path         = require('path');
const { v4: uuid } = require('uuid');
const { MusicBot } = require('./musicBot');

const app    = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout:  60000,   // 60s — evita desconexão por latência do Render
  pingInterval: 25000,   // ping a cada 25s
  transports: ['websocket', 'polling'],
  upgradeTimeout: 30000,
  allowEIO3: true,
});
const UPLOAD_DIR = path.join(__dirname, '../public/uploads');

// Garante que a pasta de uploads existe (necessário no Render)
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log('[Init] Pasta uploads criada:', UPLOAD_DIR);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Registra rotas do bot (upload, stream, radios)
MusicBot.registerRoutes(app, UPLOAD_DIR);

// ── Configuração dos servidores ───────────────────────────
const SERVERS_CONFIG = [
  { id:'geral',      name:'Geral',      icon:'⚡', channels:[
    { id:'conversa',    name:'Conversa',    desc:'Canal de voz principal' },
    { id:'debate',      name:'Debate',      desc:'Discussões abertas'     },
    { id:'jogos',       name:'Jogos',       desc:'Sessão de jogos'        },
  ]},
  { id:'comunidade', name:'Comunidade', icon:'🌐', channels:[
    { id:'boasvindas',  name:'Boas-vindas', desc:'Apresente-se aqui!'    },
    { id:'geral-com',   name:'Geral',       desc:'Canal da comunidade'   },
    { id:'eventos',     name:'Eventos',     desc:'Próximos eventos'      },
  ]},
  { id:'musica',     name:'Música',     icon:'🎵', channels:[
    { id:'lofi',        name:'Lo-fi',       desc:'Beats para relaxar'    },
    { id:'pop',         name:'Pop',         desc:'Músicas pop'           },
    { id:'classico',    name:'Clássico',    desc:'Música clássica'       },
  ]},
];

// ── Estado em memória ─────────────────────────────────────
const state = { channels: {}, sockets: new Map() };

SERVERS_CONFIG.forEach(srv => {
  srv.channels.forEach(ch => {
    const key = `${srv.id}::${ch.id}`;
    state.channels[key] = {
      srvId: srv.id, chId: ch.id, name: ch.name,
      users: new Map(),
      musicBot: new MusicBot(io, key),
    };
  });
});

// ── Helpers ───────────────────────────────────────────────
const chKey   = (s, c) => `${s}::${c}`;
const roomName = (s, c) => `room::${chKey(s, c)}`;

function serializeChannel(key) {
  const ch = state.channels[key]; if (!ch) return null;
  return { key, srvId: ch.srvId, chId: ch.chId, name: ch.name,
           users: [...ch.users.values()], music: ch.musicBot.getState() };
}

function fullServer(srvId) {
  const srv = SERVERS_CONFIG.find(s => s.id === srvId); if (!srv) return null;
  return { ...srv, channels: srv.channels.map(ch => ({ ...ch, ...serializeChannel(chKey(srvId, ch.id)) })) };
}

// Rate limit simples
const RATE = new Map();
function limited(sid) {
  const now = Date.now(), e = RATE.get(sid) || { n: 0, t: now };
  if (now - e.t > 5000) { e.n = 0; e.t = now; }
  e.n++; RATE.set(sid, e);
  return e.n > 25;
}

function leaveChannel(socket, srvId, chId) {
  const key = chKey(srvId, chId), ch = state.channels[key]; if (!ch) return;
  const user = ch.users.get(socket.id);
  ch.users.delete(socket.id);
  socket.leave(roomName(srvId, chId));
  // Remove do audioStream
  ch.musicBot.removeAudioListener(socket.id);

  // Se canal ficou vazio, pausa a música automaticamente
  if (ch.users.size === 0 && ch.musicBot.playing) {
    ch.musicBot.pause();
    console.log(`[Bot] Canal ${key} vazio — música pausada`);
  }

  io.to(roomName(srvId, chId)).emit('channel:users', {
    key, users: [...ch.users.values()], music: ch.musicBot.getState()
  });
  io.to(roomName(srvId, chId)).emit('voice:peer:left', { socketId: socket.id });
  if (user) console.log(`[voice] ${user.name} saiu de ${key}`);
}

// ── Socket.IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── Login ─────────────────────────────────────────────
  socket.on('join:app', ({ name }) => {
    name = (name || '').trim().slice(0, 24); if (!name) return;
    state.sockets.set(socket.id, { socketId: socket.id, name, srvId: null, chId: null });
    socket.emit('app:ready', { socketId: socket.id,
      servers: SERVERS_CONFIG.map(s => fullServer(s.id)) });
    console.log(`[app] ${name} entrou`);
  });

  // ── Voice Join ────────────────────────────────────────
  socket.on('voice:join', ({ srvId, chId }) => {
    if (limited(socket.id)) return;
    const user = state.sockets.get(socket.id); if (!user) return;
    const key  = chKey(srvId, chId), ch = state.channels[key]; if (!ch) return;
    if (ch.users.size >= 20) { socket.emit('error', { msg: 'Canal cheio (máx 20)' }); return; }
    if (user.srvId) leaveChannel(socket, user.srvId, user.chId);
    user.srvId = srvId; user.chId = chId;
    socket.join(roomName(srvId, chId));
    ch.users.set(socket.id, { socketId: socket.id, name: user.name, micOn: true, deafOn: false, speaking: false });
    const room = roomName(srvId, chId);
    io.to(room).emit('channel:users', { key, users: [...ch.users.values()], music: ch.musicBot.getState() });
    const peers = [...ch.users.keys()].filter(id => id !== socket.id);
    socket.emit('voice:peers', { peers, key });
    // Registra no audioStream para receber chunks de áudio
    ch.musicBot.addAudioListener(socket);
    // Envia estado completo da música ao entrar (inclui fila preservada)
    const musicState = ch.musicBot.getState();
    socket.emit('music:state', musicState);
    if (musicState.playing && musicState.track) {
      socket.emit('music:restore', { state: musicState });
    }
    console.log(`[voice] ${user.name} → ${key}`);
  });

  socket.on('voice:leave', () => {
    const user = state.sockets.get(socket.id); if (!user?.srvId) return;
    leaveChannel(socket, user.srvId, user.chId);
    user.srvId = null; user.chId = null;
  });

  // ── WebRTC ────────────────────────────────────────────
  socket.on('rtc:offer',  ({ to, offer })     => socket.to(to).emit('rtc:offer',  { from: socket.id, offer }));
  socket.on('rtc:answer', ({ to, answer })    => socket.to(to).emit('rtc:answer', { from: socket.id, answer }));
  socket.on('rtc:ice',    ({ to, candidate }) => socket.to(to).emit('rtc:ice',    { from: socket.id, candidate }));

  // ── Áudio ─────────────────────────────────────────────
  socket.on('audio:toggle', ({ micOn, deafOn }) => {
    if (limited(socket.id)) return;
    const user = state.sockets.get(socket.id); if (!user?.srvId) return;
    const ch   = state.channels[chKey(user.srvId, user.chId)]; if (!ch) return;
    const info = ch.users.get(socket.id); if (!info) return;
    if (micOn  !== undefined) info.micOn  = micOn;
    if (deafOn !== undefined) info.deafOn = deafOn;
    io.to(roomName(user.srvId, user.chId)).emit('channel:users',
      { key: chKey(user.srvId, user.chId), users: [...ch.users.values()], music: ch.musicBot.getState() });
  });

  socket.on('audio:speaking', ({ speaking }) => {
    const user = state.sockets.get(socket.id); if (!user?.srvId) return;
    const ch   = state.channels[chKey(user.srvId, user.chId)]; if (!ch) return;
    const info = ch.users.get(socket.id); if (info) info.speaking = speaking;
    io.to(roomName(user.srvId, user.chId)).emit('user:speaking', { socketId: socket.id, speaking });
  });

  // ── Music Bot — fila colaborativa ─────────────────────
  function getBot() {
    const user = state.sockets.get(socket.id); if (!user?.srvId) return null;
    return state.channels[chKey(user.srvId, user.chId)]?.musicBot || null;
  }
  function userName() { return state.sockets.get(socket.id)?.name || 'Anônimo'; }

  // Qualquer usuário pode adicionar — sem restrição de role
  socket.on('music:add:radio', ({ radioId }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    const ok  = bot.addRadio(radioId, userName());
    if (!ok) socket.emit('music:error', { msg: 'Rádio não encontrada.' });
  });

  socket.on('music:add:url', ({ url, title }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    bot.addDirectUrl(url, title, userName());
  });

  socket.on('music:add:mp3', ({ filename, originalName, size }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    bot.addMp3({ id: uuid(), filename, originalName, size }, userName());
  });

  socket.on('music:add:yt', async ({ query, url }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    await bot.addYouTube({ query, url, requestedBy: userName() }, socket);
  });

  socket.on('music:search:yt', async ({ query }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    await bot.searchYouTube(query, socket);
  });

  // ── SoundCloud ────────────────────────────────────────
  socket.on('music:search:sc', async ({ query }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    await bot.searchSoundCloud(query, socket);
  });

  socket.on('music:add:sc', async ({ url, title, artist, duration, thumbnail }) => {
    if (limited(socket.id)) return;
    const bot = getBot(); if (!bot) return;
    await bot.addSoundCloud({ url, title, artist, duration, thumbnail, requestedBy: userName() }, socket);
  });

  // Controles — qualquer usuário do canal
  socket.on('music:pause',    () => { if(!limited(socket.id)) getBot()?.pause(socket) });
  socket.on('music:resume',   () => { if(!limited(socket.id)) getBot()?.resume(socket) });
  socket.on('music:skip',     () => { if(!limited(socket.id)) getBot()?.skip(socket) });
  socket.on('music:stop',     () => { if(!limited(socket.id)) getBot()?.stop(socket) });
  socket.on('music:shuffle',  () => { if(!limited(socket.id)) getBot()?.shuffle(socket) });
  socket.on('music:clear',    () => { if(!limited(socket.id)) getBot()?.clearQueue(socket) });
  socket.on('music:remove',   (d) => { if(!limited(socket.id)) getBot()?.removeFromQueue(socket, d) });
  socket.on('music:play:at',  (d) => { if(!limited(socket.id)) getBot()?.playAt(socket, d) });
  socket.on('music:volume',   (d) => { if(!limited(socket.id)) getBot()?.volume(socket, d) });

  // ── Moderação ─────────────────────────────────────────
  socket.on('mod:kick', ({ targetSocketId, reason }) => {
    const user = state.sockets.get(socket.id); if (!user) return;
    const target = io.sockets.sockets.get(targetSocketId); if (!target) return;
    const tUser  = state.sockets.get(targetSocketId);
    target.emit('kicked', { reason: reason || 'Removido por ' + user.name });
    if (tUser?.srvId) leaveChannel(target, tUser.srvId, tUser.chId);
  });

  // ── Disconnect ────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = state.sockets.get(socket.id);
    if (user?.srvId) leaveChannel(socket, user.srvId, user.chId);
    state.sockets.delete(socket.id);
    RATE.delete(socket.id);
    console.log(`[-] ${user?.name || socket.id}`);
  });
});

// ── REST ──────────────────────────────────────────────────
app.get('/api/servers', (_, res) => res.json(SERVERS_CONFIG.map(s => fullServer(s.id))));

// Rota para upload de cookies do YouTube (protegida por senha)
app.post('/api/admin/cookies', express.text({ limit: '2mb' }), (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'vozhub-admin';
  const auth   = req.headers['x-admin-secret'];
  if (auth !== secret) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const cookiesContent = req.body;
    if (!cookiesContent?.includes('youtube')) {
      return res.status(400).json({ error: 'Arquivo de cookies inválido — deve conter cookies do YouTube' });
    }
    const cookiesPath = '/tmp/yt_cookies.txt';
    fs.writeFileSync(cookiesPath, cookiesContent, 'utf8');
    const lines = cookiesContent.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    // Atualiza o COOKIES_PATH no audioStream via env simulado
    process.env.YT_COOKIES_FILE = cookiesContent;
    // Re-inicializa cookies em todos os bots
    Object.values(state.channels).forEach(ch => {
      if (ch.musicBot?.audioStream) {
        ch.musicBot.audioStream._cookiesPath = cookiesPath;
      }
    });
    console.log(`[Admin] Cookies atualizados via API: ${lines} cookies`);
    res.json({ ok: true, cookies: lines });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Status das ferramentas
app.get('/api/admin/status', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'vozhub-admin';
  if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Não autorizado' });
  const { FFMPEG, YTDLP } = require('./audioStream');
  const cookiesFile = '/tmp/yt_cookies.txt';
  let cookiesInfo = { exists: false, size: 0, firstLine: '', lines: 0 };
  try {
    if (fs.existsSync(cookiesFile)) {
      const raw = fs.readFileSync(cookiesFile, 'utf8');
      const lines = raw.split('\n');
      cookiesInfo = {
        exists: true,
        size: raw.length,
        lines: lines.filter(l => l.trim() && !l.startsWith('#')).length,
        firstLine: lines[0]?.slice(0, 80),
        secondLine: lines[1]?.slice(0, 80),
        hasNetscape: raw.includes('Netscape'),
        hasYoutube: raw.includes('youtube'),
        hasTabs: raw.includes('\t'),
      };
    }
  } catch(e) { cookiesInfo.error = e.message; }
  res.json({
    ffmpeg:   FFMPEG || null,
    ytdlp:    YTDLP  || null,
    cookies:  cookiesInfo,
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;

// Descobre o IP local para mostrar no console
function getLocalIP() {
  const { networkInterfaces } = require('os');
  for (const iface of Object.values(networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  🎙️  VozHub rodando!');
  console.log('');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Rede:    http://${ip}:${PORT}`);
  console.log('');
});