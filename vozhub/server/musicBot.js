/**
 * VozHub — Music Bot v3
 * ─────────────────────────────────────────────────────────
 * FONTES SUPORTADAS:
 *   1. 📻 Rádios online      — sempre disponível, sem install
 *   2. 📁 Upload MP3/OGG/AAC — usuário envia arquivo (≤30MB)
 *   3. 🔗 Link direto        — qualquer URL de áudio/stream
 *   4. ☁️  SoundCloud         — busca + stream via soundcloud-scraper
 *   5. ▶️  YouTube            — opcional, via ytdl-core + yt-search
 *
 * FILA COLABORATIVA:
 *   Qualquer usuário do canal pode adicionar, remover, pular,
 *   pausar e reordenar — igual ao bot do Discord.
 */

const path = require('path');

// ── Dependências opcionais (não quebra se faltar) ─────────
let SC, ytdl, ytSearch;
try { SC       = require('soundcloud-scraper'); } catch { SC       = null; }
try { ytdl     = require('ytdl-core');          } catch { ytdl     = null; }
try { ytSearch = require('yt-search');          } catch { ytSearch = null; }

// ── Rádios pré-configuradas ───────────────────────────────
const RADIOS = [
  { id:'lofi1',     name:'Lofi Hip Hop Radio',   emoji:'🎧', url:'https://streams.ilovemusic.de/iloveradio17.mp3',                    genre:'Lo-fi'    },
  { id:'jazz1',     name:'Jazz 24',               emoji:'🎷', url:'https://live.wostreaming.net/manifest/ppm-jazz24aac-ibc1.m3u8',    genre:'Jazz'     },
  { id:'chill1',    name:'Chill Out Zone',        emoji:'🌊', url:'https://streams.ilovemusic.de/iloveradio2.mp3',                    genre:'Chill'    },
  { id:'pop1',      name:'OpenFM Pop',            emoji:'🎵', url:'https://stream.open.fm/4',                                        genre:'Pop'      },
  { id:'rock1',     name:'Radio Rock BR',         emoji:'🎸', url:'https://24803.live.streamtheworld.com/RADIOROCK_ADP.aac',          genre:'Rock'     },
  { id:'classical', name:'Classic FM',            emoji:'🎻', url:'https://media-ice.musicradio.com/ClassicFMMP3',                   genre:'Clássico' },
  { id:'gospel1',   name:'Rádio Gospel Ativa',   emoji:'✝️',  url:'https://cast1.hoost.com.br:7136/stream',                          genre:'Gospel'   },
  { id:'ambient1',  name:'Ambient Sleeping Pill', emoji:'🌙', url:'https://he.cdn.ambslp.com:3440/ambientslp',                       genre:'Ambient'  },
  { id:'brasil1',   name:'Rádio Brasil Atual',   emoji:'🇧🇷', url:'https://rbatual.webradiobrasil.com.br/rbatual128',                genre:'Brasil'   },
  { id:'samba1',    name:'Samba Radio BR',        emoji:'🥁', url:'https://sambaradiobr.webradiobrasil.com.br/sambaradiobr128',      genre:'Samba'    },
  { id:'eletronic', name:'DI.FM Electronic',      emoji:'⚡', url:'https://prem4.di.fm/electronicpioneers?1234567',                  genre:'Eletrônico'},
  { id:'hiphop1',   name:'HipHop Radio Global',  emoji:'🎤', url:'https://streams.ilovemusic.de/iloveradio6.mp3',                   genre:'Hip-Hop'  },
];

// ── SoundCloud client (singleton) ────────────────────────
let scClient = null;
function getSCClient() {
  if (!SC) return null;
  if (!scClient) scClient = new SC.Client();
  return scClient;
}

class MusicBot {
  constructor(io, channelKey) {
    this.io         = io;
    this.channelKey = channelKey;
    this.room       = `room::${channelKey}`;

    this.queue      = [];
    this.currentIdx = -1;
    this.playing    = false;
    this.paused     = false;
    this.volume     = 80;
    this.shuffled   = false;
    this.elapsed    = 0;
    this.startedAt  = null;
    this._skipTimer = null;
    this.history    = [];
  }

  // ── Estado serializado ────────────────────────────────
  getState() {
    const track = this.currentIdx >= 0 ? this.queue[this.currentIdx] : null;
    let progress = this.elapsed;
    if (this.playing && !this.paused && this.startedAt) {
      progress = this.elapsed + (Date.now() - this.startedAt) / 1000;
    }
    return {
      playing:    this.playing,
      paused:     this.paused,
      volume:     this.volume,
      shuffled:   this.shuffled,
      currentIdx: this.currentIdx,
      progress:   Math.floor(Math.max(0, progress)),
      queue:      this.queue.map((t, i) => ({ ...t, isCurrent: i === this.currentIdx })),
      track,
      radios:     RADIOS,
      sources: {
        soundcloud: !!getSCClient(),
        youtube:    !!(ytdl || ytSearch),
      },
    };
  }

  broadcast() { this.io.to(this.room).emit('music:state', this.getState()); }

  // ════════════════════════════════════════════════════════
  // FONTE 1 — RÁDIO ONLINE
  // ════════════════════════════════════════════════════════
  addRadio(radioId, requestedBy) {
    const radio = RADIOS.find(r => r.id === radioId);
    if (!radio) return false;
    this._enqueue({
      id:          radioId,
      type:        'radio',
      title:       radio.name,
      artist:      radio.genre + ' · Ao vivo',
      emoji:       radio.emoji,
      url:         radio.url,
      streamUrl:   radio.url,
      duration:    0,
      durationFmt: '🔴 Ao vivo',
      requestedBy,
      thumbnail:   null,
      isLive:      true,
    }, requestedBy);
    return true;
  }

  // ════════════════════════════════════════════════════════
  // FONTE 2 — UPLOAD MP3
  // ════════════════════════════════════════════════════════
  addMp3(fileInfo, requestedBy) {
    this._enqueue({
      id:          fileInfo.id,
      type:        'mp3',
      title:       fileInfo.originalName.replace(/\.[^.]+$/, ''),
      artist:      'Enviado por ' + requestedBy,
      emoji:       '🎵',
      url:         `/uploads/${fileInfo.filename}`,
      streamUrl:   `/uploads/${fileInfo.filename}`,
      duration:    fileInfo.duration || 0,
      durationFmt: this._fmt(fileInfo.duration || 0),
      requestedBy,
      thumbnail:   null,
      isLive:      false,
    }, requestedBy);
  }

  // ════════════════════════════════════════════════════════
  // FONTE 3 — LINK DIRETO
  // ════════════════════════════════════════════════════════
  addDirectUrl(url, title, requestedBy) {
    const ext   = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    const isAudio = ['mp3','ogg','aac','opus','flac','wav','m3u8','m3u'].includes(ext);
    this._enqueue({
      id:          Date.now().toString(),
      type:        'url',
      title:       title || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Link de áudio',
      artist:      'Link direto · adicionado por ' + requestedBy,
      emoji:       '🔗',
      url,
      streamUrl:   url,
      duration:    0,
      durationFmt: isAudio ? '?' : '🔴 Stream',
      requestedBy,
      thumbnail:   null,
      isLive:      !isAudio,
    }, requestedBy);
  }

  // ════════════════════════════════════════════════════════
  // FONTE 4 — SOUNDCLOUD
  // ════════════════════════════════════════════════════════
  async searchSoundCloud(query, socket) {
    const client = getSCClient();
    if (!client) {
      socket.emit('music:sc:results', { results: [], error: 'SoundCloud não disponível. Execute: npm install soundcloud-scraper' });
      return;
    }
    socket.emit('music:searching', { source: 'soundcloud', query });
    try {
      const results = await client.search(query, 'track');
      const tracks  = (results.collection || []).slice(0, 8).map(t => ({
        title:       t.title,
        artist:      t.user?.username || 'SoundCloud',
        url:         t.permalink_url || t.url,
        thumbnail:   t.artwork_url   || null,
        duration:    Math.floor((t.duration || 0) / 1000),
        durationFmt: this._fmt(Math.floor((t.duration || 0) / 1000)),
        type:        'soundcloud',
        emoji:       '☁️',
      }));
      socket.emit('music:sc:results', { results: tracks });
    } catch (err) {
      console.error('[MusicBot] SoundCloud search:', err.message);
      socket.emit('music:sc:results', { results: [], error: 'Erro na busca do SoundCloud: ' + err.message });
    }
  }

  async addSoundCloud({ url, title, artist, duration, thumbnail, requestedBy }, socket) {
    const client = getSCClient();
    if (!client) {
      socket?.emit('music:error', { msg: 'SoundCloud não disponível. Execute: npm install soundcloud-scraper' });
      return;
    }
    try {
      // Resolve stream URL
      let streamUrl = null;
      try {
        const song = await client.getSong(url);
        streamUrl  = await song.downloadProgressive();
        // Atualiza metadata se vier da resolução
        title    = title    || song.title;
        artist   = artist   || song.author?.name;
        duration = duration || Math.floor(song.duration / 1000);
        thumbnail= thumbnail|| song.thumbnail;
      } catch { /* usa URL direta se falhar */ }

      this._enqueue({
        id:          `sc-${Date.now()}`,
        type:        'soundcloud',
        title:       title    || 'SoundCloud Track',
        artist:      (artist  || 'SoundCloud') + ' · por ' + requestedBy,
        emoji:       '☁️',
        url,
        streamUrl:   streamUrl || url,
        duration:    duration  || 0,
        durationFmt: this._fmt(duration || 0),
        requestedBy,
        thumbnail:   thumbnail || null,
        isLive:      false,
      }, requestedBy);
    } catch (err) {
      console.error('[MusicBot] SoundCloud add:', err.message);
      socket?.emit('music:error', { msg: 'Erro ao carregar SoundCloud: ' + err.message });
    }
  }

  // ════════════════════════════════════════════════════════
  // FONTE 5 — YOUTUBE (opcional)
  // ════════════════════════════════════════════════════════
  async searchYouTube(query, socket) {
    if (!ytSearch) {
      socket.emit('music:yt:results', { results: [], error: 'YouTube não disponível. Execute: npm install yt-search ytdl-core' });
      return;
    }
    socket.emit('music:searching', { source: 'youtube', query });
    try {
      const res     = await ytSearch(query);
      const results = (res.videos || []).slice(0, 6).map(v => ({
        title:       v.title,
        artist:      v.author?.name || 'YouTube',
        url:         v.url,
        thumbnail:   v.thumbnail || null,
        duration:    v.duration?.seconds || 0,
        durationFmt: v.duration?.timestamp || '?',
        type:        'youtube',
        emoji:       '▶️',
      }));
      socket.emit('music:yt:results', { results });
    } catch (err) {
      socket.emit('music:yt:results', { results: [], error: 'Falha na busca do YouTube.' });
    }
  }

  async addYouTube({ url, query, title, requestedBy }, socket) {
    if (!ytdl && !ytSearch) {
      socket?.emit('music:error', { msg: 'YouTube não disponível. Use SoundCloud, rádio, MP3 ou link direto.' });
      return;
    }
    try {
      let track;
      if (url && ytdl?.validateURL(url)) {
        const info = await ytdl.getBasicInfo(url);
        const v    = info.videoDetails;
        track = {
          id: v.videoId, type: 'youtube', emoji: '▶️',
          title: v.title, artist: v.author?.name || 'YouTube',
          url, streamUrl: `/api/ytstream?url=${encodeURIComponent(url)}`,
          duration: parseInt(v.lengthSeconds) || 0,
          durationFmt: this._fmt(parseInt(v.lengthSeconds) || 0),
          requestedBy, thumbnail: v.thumbnails?.[0]?.url || null,
        };
      } else if (query && ytSearch) {
        const res = await ytSearch(query);
        const v   = (res.videos || [])[0];
        if (!v) { socket?.emit('music:error', { msg: 'Nenhum resultado YouTube.' }); return; }
        track = {
          id: v.videoId, type: 'youtube', emoji: '▶️',
          title: v.title || title, artist: v.author?.name || 'YouTube',
          url: v.url, streamUrl: `/api/ytstream?url=${encodeURIComponent(v.url)}`,
          duration: v.duration?.seconds || 0,
          durationFmt: v.duration?.timestamp || '?',
          requestedBy, thumbnail: v.thumbnail || null,
        };
      }
      if (track) this._enqueue(track, requestedBy);
    } catch (err) {
      console.error('[MusicBot] YouTube add:', err.message);
      socket?.emit('music:error', { msg: 'Erro YouTube: ' + err.message });
    }
  }

  // ════════════════════════════════════════════════════════
  // FILA COLABORATIVA — controles
  // ════════════════════════════════════════════════════════
  _enqueue(track, requestedBy) {
    this.queue.push(track);
    this.history.push({ title: track.title, by: requestedBy, at: Date.now() });
    if (!this.playing) { this.currentIdx = this.queue.length - 1; this._startTrack(); }
    this.broadcast();
    this.io.to(this.room).emit('music:added', { track, requestedBy, queueLength: this.queue.length });
    console.log(`[Bot:${this.channelKey}] ➕ "${track.title}" por ${requestedBy}`);
  }

  pause()  {
    if (!this.playing || this.paused) return;
    this.paused = true;
    if (this.startedAt) this.elapsed += (Date.now() - this.startedAt) / 1000;
    this._clearTimer(); this.broadcast();
  }

  resume() {
    if (!this.playing || !this.paused) return;
    this.paused = false; this.startedAt = Date.now();
    const t = this.queue[this.currentIdx];
    if (t?.duration > 0) {
      const rem = t.duration - this.elapsed;
      if (rem > 0) this._skipTimer = setTimeout(() => this.skip(), rem * 1000);
    }
    this.broadcast();
  }

  skip() {
    this._clearTimer();
    if (!this.queue.length) return;
    const next = this.shuffled
      ? Math.floor(Math.random() * this.queue.length)
      : this.currentIdx + 1;
    if (!this.shuffled && next >= this.queue.length) { this.stop(); return; }
    this.currentIdx = next; this._startTrack(); this.broadcast();
  }

  stop() {
    this._clearTimer();
    this.playing = false; this.paused = false;
    this.currentIdx = -1; this.elapsed = 0; this.startedAt = null;
    this.broadcast();
  }

  playAt(socket, { index }) {
    if (index < 0 || index >= this.queue.length) return;
    this._clearTimer(); this.currentIdx = index; this._startTrack(); this.broadcast();
  }

  removeFromQueue(socket, { index }) {
    if (index < 0 || index >= this.queue.length) return;
    const removed = this.queue.splice(index, 1)[0];
    if (index < this.currentIdx) this.currentIdx--;
    else if (index === this.currentIdx) {
      if (!this.queue.length) { this.stop(); return; }
      this.currentIdx = Math.min(this.currentIdx, this.queue.length - 1);
      this._startTrack();
    }
    this.broadcast();
    console.log(`[Bot] 🗑 "${removed.title}"`);
  }

  shuffle()               { this.shuffled = !this.shuffled; this.broadcast(); }
  setVolume(socket, { volume }) { this.volume = Math.max(0, Math.min(100, parseInt(volume)||80)); this.broadcast(); }
  clearQueue()            { this.stop(); this.queue = []; this.broadcast(); }

  // ── Internos ──────────────────────────────────────────
  _startTrack() {
    this.playing = true; this.paused = false;
    this.elapsed = 0; this.startedAt = Date.now();
    const t = this.queue[this.currentIdx]; if (!t) return;
    if (t.duration > 0) this._skipTimer = setTimeout(() => this.skip(), t.duration * 1000);
    console.log(`[Bot:${this.channelKey}] ▶ "${t.title}"`);
  }
  _clearTimer() { clearTimeout(this._skipTimer); }
  _fmt(s) { s = Math.floor(s||0); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }

  // ════════════════════════════════════════════════════════
  // ROTAS EXPRESS (upload, stream, radios, soundcloud proxy)
  // ════════════════════════════════════════════════════════
  static registerRoutes(app, uploadDir) {
    const multer    = require('multer');
    const { v4: uuid } = require('uuid');

    // ── Multer: upload de áudio ──────────────────────────
    const storage = multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname)),
    });
    const upload = multer({
      storage,
      limits: { fileSize: 30 * 1024 * 1024 },
      fileFilter: (_, file, cb) => {
        cb(null, /audio\/(mpeg|ogg|aac|wav|flac|opus|mp4|x-m4a)/.test(file.mimetype));
      },
    });

    app.post('/api/upload', upload.single('audio'), (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Arquivo inválido' });
      res.json({ filename: req.file.filename, originalName: req.file.originalname, size: req.file.size });
    });

    app.use('/uploads', require('express').static(uploadDir));

    // ── Rádios ───────────────────────────────────────────
    app.get('/api/radios', (_, res) => res.json(RADIOS));

    // ── SoundCloud proxy (resolve stream URL no servidor) ─
    app.get('/api/scstream', async (req, res) => {
      const { url } = req.query;
      const client  = getSCClient();
      if (!client || !url) return res.status(400).json({ error: 'SoundCloud indisponível ou URL inválida' });
      try {
        const song      = await client.getSong(url);
        const streamUrl = await song.downloadProgressive();
        // Redireciona para o stream real
        res.redirect(streamUrl);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── YouTube stream proxy ──────────────────────────────
    app.get('/api/ytstream', async (req, res) => {
      const { url } = req.query;
      if (!ytdl || !url || !ytdl.validateURL(url)) {
        return res.status(400).json({ error: 'ytdl indisponível ou URL inválida' });
      }
      try {
        res.setHeader('Content-Type', 'audio/mpeg');
        ytdl(url, { filter: 'audioonly', quality: 'lowestaudio' })
          .pipe(res).on('error', () => res.end());
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Status das fontes ─────────────────────────────────
    app.get('/api/sources', (_, res) => res.json({
      radio:       true,
      mp3:         true,
      url:         true,
      soundcloud:  !!getSCClient(),
      youtube:     !!(ytdl || ytSearch),
    }));
  }
}

module.exports = { MusicBot, RADIOS };
