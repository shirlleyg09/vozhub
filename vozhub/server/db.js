/**
 * VozHub — DB (JSON persistente)
 * Usuários, servidores, canais — armazenados em /data/db.json
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

// ── Estrutura padrão ──────────────────────────────────────
const DEFAULT_DB = {
  users:   {},   // { [code]: { code, name, createdAt, lastSeen, temporary, servers:[] } }
  servers: {},   // { [serverId]: { id, name, icon, ownerId, privacy, password, channels, createdAt, lastActive } }
};

// ── Lê/salva ──────────────────────────────────────────────
function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE))  return JSON.parse(JSON.stringify(DEFAULT_DB));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return JSON.parse(JSON.stringify(DEFAULT_DB)); }
}

function save(db) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch(e) { console.error('[DB] Erro ao salvar:', e.message); }
}

// ── Usuários ──────────────────────────────────────────────
function generateCode() {
  // Código de 8 chars alfanumérico fácil de lembrar
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createUser(name, temporary = false) {
  const db   = load();
  let code;
  do { code = generateCode(); } while (db.users[code]);
  const user = {
    code, name: name.trim().slice(0, 24),
    createdAt: Date.now(), lastSeen: Date.now(),
    temporary, servers: [],
  };
  if (!temporary) {
    db.users[code] = user;
    save(db);
  }
  return user;
}

function getUser(code) {
  const db = load();
  return db.users[code.toUpperCase()] || null;
}

function updateUserSeen(code) {
  const db = load();
  if (db.users[code]) { db.users[code].lastSeen = Date.now(); save(db); }
}

function deleteUser(code) {
  const db = load();
  delete db.users[code];
  save(db);
}

// ── Servidores ────────────────────────────────────────────
function createServer(ownerId, { name, icon, privacy, password }) {
  const db = load();
  const owner = db.users[ownerId];
  if (!owner) return { error: 'Usuário não encontrado' };
  if ((owner.servers || []).length >= 4) return { error: 'Limite de 4 servidores por usuário' };

  const id  = uuid().slice(0, 8);
  const maxPublicChannels  = 2;
  const maxPrivateChannels = 3;
  const roomsPerPublic     = 4;
  const roomsPerPrivate    = 2;

  const server = {
    id, name: name.trim().slice(0, 30),
    icon:      icon || '🌐',
    ownerId,
    privacy:   privacy || 'public',  // public | private
    password:  privacy === 'private' ? (password || '') : null,
    channels:  [],
    createdAt: Date.now(),
    lastActive: Date.now(),
    limits: {
      maxPublicChannels, maxPrivateChannels,
      roomsPerPublic, roomsPerPrivate,
    },
  };

  // Cria canal padrão
  server.channels.push({
    id:      'geral',
    name:    'Geral',
    desc:    'Canal principal',
    type:    'public',
    rooms:   [{ id: 'conversa', name: 'Conversa' }],
  });

  db.servers[id] = server;
  if (!db.users[ownerId].servers) db.users[ownerId].servers = [];
  db.users[ownerId].servers.push(id);
  save(db);
  return server;
}

function getServer(serverId) {
  return load().servers[serverId] || null;
}

function getAllServers() {
  return Object.values(load().servers);
}

function updateServerActivity(serverId) {
  const db = load();
  if (db.servers[serverId]) { db.servers[serverId].lastActive = Date.now(); save(db); }
}

function addChannelToServer(serverId, ownerId, { name, type, password }) {
  const db = load();
  const srv = db.servers[serverId];
  if (!srv) return { error: 'Servidor não encontrado' };
  if (srv.ownerId !== ownerId) return { error: 'Sem permissão' };

  const publicChs  = srv.channels.filter(c => c.type === 'public').length;
  const privateChs = srv.channels.filter(c => c.type === 'private').length;

  if (type === 'public'  && publicChs  >= srv.limits.maxPublicChannels)  return { error: `Limite de ${srv.limits.maxPublicChannels} canais públicos` };
  if (type === 'private' && privateChs >= srv.limits.maxPrivateChannels) return { error: `Limite de ${srv.limits.maxPrivateChannels} canais privados` };

  const ch = {
    id:       uuid().slice(0, 8),
    name:     name.trim().slice(0, 24),
    desc:     '',
    type:     type || 'public',
    password: type === 'private' ? (password || '') : null,
    rooms:    [{ id: uuid().slice(0,8), name: 'Sala 1' }],
  };
  srv.channels.push(ch);
  save(db);
  return ch;
}

// ── Auto-delete: 7 dias de inatividade ───────────────────
function runCleanup() {
  const db  = load();
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  let changed = false;

  // Remove usuários inativos (não temporários)
  for (const [code, user] of Object.entries(db.users)) {
    if (!user.temporary && now - user.lastSeen > SEVEN_DAYS) {
      console.log(`[DB] Auto-delete usuário: ${user.name} (${code})`);
      delete db.users[code];
      changed = true;
    }
  }

  // Remove servidores inativos
  for (const [id, srv] of Object.entries(db.servers)) {
    if (now - srv.lastActive > SEVEN_DAYS) {
      console.log(`[DB] Auto-delete servidor: ${srv.name} (${id})`);
      delete db.servers[id];
      // Remove referência nos usuários
      for (const user of Object.values(db.users)) {
        if (user.servers) user.servers = user.servers.filter(s => s !== id);
      }
      changed = true;
    }
  }

  if (changed) save(db);
}

// Roda limpeza a cada 6h
setInterval(runCleanup, 6 * 60 * 60 * 1000);
runCleanup(); // roda na inicialização

module.exports = {
  createUser, getUser, updateUserSeen, deleteUser,
  createServer, getServer, getAllServers, updateServerActivity, addChannelToServer,
  load, save,
};