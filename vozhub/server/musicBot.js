/**
 * VozHub — Music Bot v3.1
 * Fontes: Rádio | MP3 Upload | Link Direto | SoundCloud | YouTube
 * Usa @distube/ytdl-core (fork mantida) e soundcloud-downloader
 */

const path = require('path');
const fs   = require('fs');

// ── Persistência da fila em arquivo ──────────────────────
const QUEUE_DIR  = path.join(__dirname, '../data');
const QUEUE_FILE = path.join(QUEUE_DIR, 'queues.json');

function loadQueues() {
  try {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
    if (!fs.existsSync(QUEUE_FILE)) return {};
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch { return {}; }
}

function saveQueues(data) {
  try {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
  } catch(e) { console.error('[Queue] Erro ao salvar:', e.message); }
}

// Dependências opcionais
let ytSearch, SC;
try { ytSearch = require('yt-search');         } catch { ytSearch = null; }
try { SC      = require('soundcloud-scraper'); } catch { SC       = null; }
const ytdl = null; // ytdl removido — YouTube bloqueia IPs de data center (429)

function getSC() {
  if (!SC) return null;
  try { return new SC.Client(); } catch { return null; }
}

const RADIOS = [
  // Gospel — múltiplas opções confiáveis
  { id:'gospel1',   name:'Rádio Gospel Mais',     emoji:'✝️',  url:'https://stream.zeno.fm/yn65m0tmdrhvv',                         genre:'Gospel'    },
  { id:'gospel2',   name:'Gospel Prime',           emoji:'🙏', url:'https://stream.zeno.fm/f3e4rqrmb5zuv',                         genre:'Gospel'    },
  { id:'gospel3',   name:'Rádio Melodia',          emoji:'🎶', url:'https://stream.zeno.fm/tsua3rs0y6zuv',                         genre:'Gospel'    },
  // Lo-fi / Chill
  { id:'lofi1',     name:'Lofi Hip Hop',           emoji:'🎧', url:'https://stream.zeno.fm/f3e4jkrmb5zuv',                         genre:'Lo-fi'     },
  { id:'chill1',    name:'Chill Out Zone',         emoji:'🌊', url:'https://streams.ilovemusic.de/iloveradio2.mp3',                genre:'Chill'     },
  { id:'ambient1',  name:'Ambient Radio',          emoji:'🌙', url:'https://stream.zeno.fm/yn65m0tndrhvv',                         genre:'Ambient'   },
  // Pop / Rock
  { id:'pop1',      name:'Pop Hits Brasil',        emoji:'🎵', url:'https://stream.zeno.fm/4d5n1qrmb5zuv',                         genre:'Pop'       },
  { id:'rock1',     name:'Radio Rock',             emoji:'🎸', url:'https://streams.ilovemusic.de/iloveradio5.mp3',                genre:'Rock'      },
  // Sertanejo / Brasil
  { id:'sertanejo', name:'Sertanejo Total',        emoji:'🤠', url:'https://stream.zeno.fm/2e0hmqrmb5zuv',                         genre:'Sertanejo' },
  { id:'brasil1',   name:'MPB Radio',              emoji:'🇧🇷', url:'https://streams.ilovemusic.de/iloveradio24.mp3',              genre:'MPB'       },
  { id:'samba1',    name:'Pagode e Samba',         emoji:'🥁', url:'https://stream.zeno.fm/7f0hmqrmb5zuv',                         genre:'Samba'     },
  // Outros
  { id:'jazz1',     name:'Jazz Radio',             emoji:'🎷', url:'https://streams.ilovemusic.de/iloveradio10.mp3',               genre:'Jazz'      },
  { id:'classical', name:'Classical Music',        emoji:'🎻', url:'https://streams.ilovemusic.de/iloveradio14.mp3',               genre:'Clássico'  },
  { id:'hiphop1',   name:'Hip Hop Radio',          emoji:'🎤', url:'https://streams.ilovemusic.de/iloveradio6.mp3',                genre:'Hip-Hop'   },
  { id:'eletronic', name:'Electronic / Dance',     emoji:'⚡', url:'https://streams.ilovemusic.de/iloveradio3.mp3',                genre:'Eletrônico'},
];

class MusicBot {
  constructor(io, channelKey) {
    this.io = io; this.channelKey = channelKey; this.room = `room::${channelKey}`;
    this.queue = []; this.currentIdx = -1; this.playing = false; this.paused = false;
    this.volume = 80; this.shuffled = false; this.elapsed = 0;
    this.startedAt = null; this._skipTimer = null; this.history = [];
    // Restaura fila salva do disco
    this._loadQueue();
  }

  _loadQueue() {
    try {
      const all = loadQueues();
      const saved = all[this.channelKey];
      if (saved && saved.queue?.length) {
        this.queue      = saved.queue;
        this.currentIdx = saved.currentIdx ?? -1;
        this.shuffled   = saved.shuffled ?? false;
        // Começa pausado ao restaurar (não auto-toca)
        this.playing = false; this.paused = true;
        console.log(`[Bot:${this.channelKey}] Fila restaurada: ${this.queue.length} faixas`);
      }
    } catch(e) { console.error('[Bot] _loadQueue:', e.message); }
  }

  _saveQueue() {
    try {
      const all = loadQueues();
      all[this.channelKey] = {
        queue:      this.queue,
        currentIdx: this.currentIdx,
        shuffled:   this.shuffled,
        savedAt:    Date.now(),
      };
      saveQueues(all);
    } catch(e) { console.error('[Bot] _saveQueue:', e.message); }
  }

  getState() {
    const track = this.currentIdx >= 0 ? this.queue[this.currentIdx] : null;
    let progress = this.elapsed;
    if (this.playing && !this.paused && this.startedAt)
      progress = this.elapsed + (Date.now() - this.startedAt) / 1000;
    return {
      playing: this.playing, paused: this.paused, volume: this.volume,
      shuffled: this.shuffled, currentIdx: this.currentIdx,
      progress: Math.floor(Math.max(0, progress)),
      queue: this.queue.map((t, i) => ({ ...t, isCurrent: i === this.currentIdx })),
      track, radios: RADIOS,
      sources: { soundcloud: !!getSC(), youtube: !!(ytdl || ytSearch) },
    };
  }

  broadcast() { this.io.to(this.room).emit('music:state', this.getState()); }

  // ── Rádio ───────────────────────────────────────────────
  addRadio(radioId, requestedBy) {
    const r = RADIOS.find(x => x.id === radioId); if (!r) return false;
    this._enqueue({ id: radioId, type:'radio', title: r.name, artist: r.genre+' · Ao vivo',
      emoji: r.emoji, url: r.url, streamUrl: r.url, duration: 0,
      durationFmt:'🔴 Ao vivo', requestedBy, thumbnail: null, isLive: true }, requestedBy);
    return true;
  }

  // ── MP3 Upload ──────────────────────────────────────────
  addMp3(fileInfo, requestedBy) {
    this._enqueue({ id: fileInfo.id, type:'mp3',
      title: fileInfo.originalName.replace(/\.[^.]+$/, ''),
      artist:'Enviado por '+requestedBy, emoji:'🎵',
      url:`/uploads/${fileInfo.filename}`, streamUrl:`/uploads/${fileInfo.filename}`,
      duration: fileInfo.duration||0, durationFmt: this._fmt(fileInfo.duration||0),
      requestedBy, thumbnail: null, isLive: false }, requestedBy);
  }

  // ── Link direto ─────────────────────────────────────────
  addDirectUrl(url, title, requestedBy) {
    const ext = (url.split('?')[0].split('.').pop()||'').toLowerCase();
    const isAudio = ['mp3','ogg','aac','opus','flac','wav','m3u8','m3u'].includes(ext);
    this._enqueue({ id: Date.now().toString(), type:'url',
      title: title || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Link de áudio',
      artist:'Link direto · '+requestedBy, emoji:'🔗',
      url, streamUrl: url, duration: 0,
      durationFmt: isAudio ? '?' : '🔴 Stream',
      requestedBy, thumbnail: null, isLive: !isAudio }, requestedBy);
  }

  // ── SoundCloud ──────────────────────────────────────────
  async searchSoundCloud(query, socket) {
    const client = getSC();
    if (!client) {
      socket.emit('music:sc:results', { results: [], error: 'SoundCloud indisponível no servidor.' });
      return;
    }
    socket.emit('music:searching', { source: 'soundcloud', query });
    try {
      const res     = await client.search(query, 'track');
      const results = (res.collection || []).slice(0, 8).map(t => ({
        title: t.title, artist: t.user?.username || 'SoundCloud',
        url: t.permalink_url || t.url,
        thumbnail: t.artwork_url || null,
        duration: Math.floor((t.duration||0)/1000),
        durationFmt: this._fmt(Math.floor((t.duration||0)/1000)),
        type:'soundcloud', emoji:'☁️',
      }));
      socket.emit('music:sc:results', { results });
    } catch (err) {
      socket.emit('music:sc:results', { results: [], error: 'Erro SoundCloud: '+err.message });
    }
  }

  async addSoundCloud({ url, title, artist, duration, thumbnail, requestedBy }, socket) {
    const client = getSC();
    if (!client) { socket?.emit('music:error', { msg: 'SoundCloud indisponível.' }); return; }
    try {
      if (!title) {
        try {
          const song = await client.getSong(url);
          title     = song.title;
          artist    = song.author?.name || 'SoundCloud';
          duration  = Math.floor((song.duration||0)/1000);
          thumbnail = song.thumbnail;
        } catch {}
      }
      const streamUrl = `/api/scstream?url=${encodeURIComponent(url)}`;
      this._enqueue({ id:`sc-${Date.now()}`, type:'soundcloud',
        title: title||'SoundCloud Track',
        artist:(artist||'SoundCloud')+' · por '+requestedBy,
        emoji:'☁️', url, streamUrl,
        duration: duration||0, durationFmt: this._fmt(duration||0),
        requestedBy, thumbnail: thumbnail||null, isLive: false }, requestedBy);
    } catch (err) {
      socket?.emit('music:error', { msg: 'Erro ao carregar SoundCloud: '+err.message });
    }
  }

  // ── YouTube ─────────────────────────────────────────────
  async searchYouTube(query, socket) {
    if (!ytSearch) {
      socket.emit('music:yt:results', { results: [], error: 'YouTube indisponível no servidor.' });
      return;
    }
    socket.emit('music:searching', { source: 'youtube', query });
    try {
      const res = await ytSearch(query);
      const results = (res.videos||[]).slice(0,6).map(v => ({
        title: v.title, artist: v.author?.name||'YouTube',
        url: v.url, thumbnail: v.thumbnail||null,
        duration: v.duration?.seconds||0, durationFmt: v.duration?.timestamp||'?',
        type:'youtube', emoji:'▶️',
      }));
      socket.emit('music:yt:results', { results });
    } catch (err) {
      socket.emit('music:yt:results', { results: [], error: 'Erro YouTube: '+err.message });
    }
  }

  async addYouTube({ url, query, requestedBy }, socket) {
    if (!ytSearch) {
      socket?.emit('music:error', { msg: 'YouTube indisponível. Use rádio, MP3 ou link direto.' });
      return;
    }
    try {
      let videoId, title, artist, duration, durationFmt, thumbnail, videoUrl;

      // Se recebeu URL, extrai o videoId
      if (url) {
        const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        videoId = m ? m[1] : null;
      }

      // Busca metadados via yt-search
      if (videoId && !title) {
        try {
          const res = await ytSearch({ videoId });
          const v   = res.videos?.[0] || res;
          title       = v.title;
          artist      = v.author?.name || 'YouTube';
          duration    = v.duration?.seconds || 0;
          durationFmt = v.duration?.timestamp || '?';
          thumbnail   = v.thumbnail || null;
          videoUrl    = url;
        } catch {}
      } else if (query) {
        const res = await ytSearch(query);
        const v   = (res.videos||[])[0];
        if (!v) { socket?.emit('music:error', { msg: 'Nenhum resultado no YouTube.' }); return; }
        videoId     = v.videoId;
        title       = v.title;
        artist      = v.author?.name || 'YouTube';
        duration    = v.duration?.seconds || 0;
        durationFmt = v.duration?.timestamp || '?';
        thumbnail   = v.thumbnail || null;
        videoUrl    = v.url;
      }

      if (!videoId) { socket?.emit('music:error', { msg: 'Não foi possível identificar o vídeo.' }); return; }

      // streamUrl será resolvido pelo proxy /api/ytstream no cliente
      // O servidor tenta ytdl se disponível, senão usa Invidious como fallback
      const streamUrl = `/api/ytstream?id=${videoId}`;

      this._enqueue({
        id: videoId, type: 'youtube', emoji: '▶️',
        title: title || 'YouTube Video',
        artist: (artist || 'YouTube') + ' · por ' + requestedBy,
        url: videoUrl || `https://youtube.com/watch?v=${videoId}`,
        streamUrl,
        duration, durationFmt, requestedBy,
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        isLive: false,
      }, requestedBy);
    } catch (err) {
      socket?.emit('music:error', { msg: 'Erro YouTube: ' + err.message });
    }
  }

  // ── Controles ────────────────────────────────────────────
  _enqueue(track, requestedBy) {
    this.queue.push(track);
    if (!this.playing) { this.currentIdx = this.queue.length-1; this._startTrack(); }
    this._saveQueue();
    this.broadcast();
    this.io.to(this.room).emit('music:added', { track, requestedBy, queueLength: this.queue.length });
    console.log(`[Bot:${this.channelKey}] ➕ "${track.title}" por ${requestedBy}`);
  }
  pause()  { if(!this.playing||this.paused) return; this.paused=true; if(this.startedAt) this.elapsed+=(Date.now()-this.startedAt)/1000; this._clearTimer(); this.broadcast(); }
  resume() { if(!this.playing||!this.paused) return; this.paused=false; this.startedAt=Date.now(); const t=this.queue[this.currentIdx]; if(t?.duration>0){const r=t.duration-this.elapsed; if(r>0) this._skipTimer=setTimeout(()=>this.skip(),r*1000);} this.broadcast(); }
  skip()   { this._clearTimer(); if(!this.queue.length) return; const next=this.shuffled?Math.floor(Math.random()*this.queue.length):this.currentIdx+1; if(!this.shuffled&&next>=this.queue.length){this.stop();return;} this.currentIdx=next; this._startTrack(); this._saveQueue(); this.broadcast(); }
  stop()   { this._clearTimer(); this.playing=false; this.paused=false; this.currentIdx=-1; this.elapsed=0; this.startedAt=null; this._saveQueue(); this.broadcast(); }
  playAt(socket,{index}){ if(index<0||index>=this.queue.length) return; this._clearTimer(); this.currentIdx=index; this._startTrack(); this.broadcast(); }
  removeFromQueue(socket,{index}){ if(index<0||index>=this.queue.length) return; const r=this.queue.splice(index,1)[0]; if(index<this.currentIdx) this.currentIdx--; else if(index===this.currentIdx){if(!this.queue.length){this.stop();return;} this.currentIdx=Math.min(this.currentIdx,this.queue.length-1); this._startTrack();} this._saveQueue(); this.broadcast(); }
  shuffle()             { this.shuffled=!this.shuffled; this.broadcast(); }
  setVolume(s,{volume}) { this.volume=Math.max(0,Math.min(100,parseInt(volume)||80)); this.broadcast(); }
  clearQueue()          { this.stop(); this.queue=[]; this._saveQueue(); this.broadcast(); }

  _startTrack() {
    this.playing=true; this.paused=false; this.elapsed=0; this.startedAt=Date.now();
    const t=this.queue[this.currentIdx]; if(!t) return;
    if(t.duration>0) this._skipTimer=setTimeout(()=>this.skip(),t.duration*1000);
    console.log(`[Bot:${this.channelKey}] ▶ "${t.title}"`);
  }
  _clearTimer() { clearTimeout(this._skipTimer); }
  _fmt(s) { s=Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }

  // ── Rotas Express ────────────────────────────────────────
  static async registerRoutes(app, uploadDir) {
    const multer = require('multer');
    const { v4: uuid } = require('uuid');

    const storage = multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, uuid()+path.extname(file.originalname)),
    });
    const upload = multer({ storage, limits:{ fileSize:30*1024*1024 },
      fileFilter:(_,file,cb)=>cb(null,/audio\/(mpeg|ogg|aac|wav|flac|opus|mp4|x-m4a)/.test(file.mimetype)) });

    app.post('/api/upload', upload.single('audio'), (req,res) => {
      if(!req.file) return res.status(400).json({error:'Arquivo inválido'});
      res.json({ filename:req.file.filename, originalName:req.file.originalname, size:req.file.size });
    });
    app.use('/uploads', require('express').static(uploadDir));
    app.get('/api/radios', (_,res) => res.json(RADIOS));

    // SoundCloud stream proxy
    app.get('/api/scstream', async (req,res) => {
      const { url } = req.query;
      const client  = getSC();
      if(!client||!url) return res.status(400).json({error:'SoundCloud indisponível ou URL inválida'});
      try {
        const song      = await client.getSong(url);
        const streamUrl = await song.downloadProgressive();
        res.redirect(streamUrl);
      } catch(err) { res.status(500).json({error:err.message}); }
    });

    // YouTube stream via yt-dlp (mais confiável que ytdl-core em servidores)
    const { execFile, exec } = require('child_process');
    const { promisify }      = require('util');
    const execFileAsync      = promisify(execFile);

    // Verifica se yt-dlp está disponível
    let ytdlpPath = null;
    try {
      const { stdout } = await promisify(exec)('which yt-dlp || where yt-dlp');
      ytdlpPath = stdout.trim().split('\n')[0];
      console.log('[yt-dlp] encontrado em:', ytdlpPath);
    } catch {
      console.warn('[yt-dlp] não encontrado — YouTube pode não funcionar');
    }

    app.get('/api/ytstream', async (req, res) => {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'videoId inválido' });

      // Tenta yt-dlp primeiro
      const dlp = ytdlpPath || 'yt-dlp';
      try {
        const { stdout } = await execFileAsync(dlp, [
          `https://www.youtube.com/watch?v=${id}`,
          '--get-url',
          '-f', 'bestaudio[ext=webm]/bestaudio/best',
          '--no-playlist',
          '--quiet',
        ], { timeout: 15000 });
        const streamUrl = stdout.trim().split('\n')[0];
        if (streamUrl && streamUrl.startsWith('http')) {
          console.log(`[yt-dlp] ✅ stream obtido para ${id}`);
          return res.redirect(streamUrl);
        }
      } catch(e) {
        console.warn('[yt-dlp] falhou:', e.message?.slice(0, 100));
      }

      // Fallback: Invidious
      const fetch = require('node-fetch');
      const INVIDIOUS = [
        'https://inv.nadeko.net',
        'https://invidious.privacydev.net',
        'https://iv.datura.network',
      ];
      for (const inst of INVIDIOUS) {
        try {
          const data = await fetch(`${inst}/api/v1/videos/${id}?fields=adaptiveFormats`, { timeout: 6000 }).then(r => r.json());
          const fmts = (data.adaptiveFormats || []).filter(f => f.type?.startsWith('audio/')).sort((a,b) => (b.bitrate||0)-(a.bitrate||0));
          if (fmts[0]?.url) { console.log(`[YT] fallback via ${inst}`); return res.redirect(fmts[0].url); }
        } catch {}
      }

      res.status(503).json({ error: 'YouTube indisponível no momento. Use rádio, SoundCloud ou link MP3.' });
    });

    app.get('/api/sources', (_,res) => res.json({
      radio:true, mp3:true, url:true,
      soundcloud:!!getSC(), youtube:!!(ytdl||ytSearch),
    }));
  }
}

module.exports = { MusicBot, RADIOS };