/**
 * VozHub — Music Bot v3.1
 * Fontes: Rádio | MP3 Upload | Link Direto | SoundCloud | YouTube
 * Usa @distube/ytdl-core (fork mantida) e soundcloud-downloader
 */

const path = require('path');

// Dependências opcionais
let ytdl, ytSearch, scdl;
try { ytdl    = require('@distube/ytdl-core'); } catch { ytdl    = null; }
try { ytSearch = require('yt-search');         } catch { ytSearch = null; }
try { scdl    = require('soundcloud-downloader').default; } catch { scdl = null; }

const RADIOS = [
  { id:'lofi1',     name:'Lofi Hip Hop Radio',   emoji:'🎧', url:'https://streams.ilovemusic.de/iloveradio17.mp3',                 genre:'Lo-fi'     },
  { id:'jazz1',     name:'Jazz 24',               emoji:'🎷', url:'https://live.wostreaming.net/manifest/ppm-jazz24aac-ibc1.m3u8', genre:'Jazz'      },
  { id:'chill1',    name:'Chill Out Zone',        emoji:'🌊', url:'https://streams.ilovemusic.de/iloveradio2.mp3',                 genre:'Chill'     },
  { id:'pop1',      name:'OpenFM Pop',            emoji:'🎵', url:'https://stream.open.fm/4',                                     genre:'Pop'       },
  { id:'rock1',     name:'Radio Rock BR',         emoji:'🎸', url:'https://24803.live.streamtheworld.com/RADIOROCK_ADP.aac',       genre:'Rock'      },
  { id:'classical', name:'Classic FM',            emoji:'🎻', url:'https://media-ice.musicradio.com/ClassicFMMP3',                genre:'Clássico'  },
  { id:'gospel1',   name:'Rádio Gospel Ativa',   emoji:'✝️',  url:'https://cast1.hoost.com.br:7136/stream',                       genre:'Gospel'    },
  { id:'ambient1',  name:'Ambient Sleeping Pill', emoji:'🌙', url:'https://he.cdn.ambslp.com:3440/ambientslp',                    genre:'Ambient'   },
  { id:'brasil1',   name:'Rádio Brasil Atual',   emoji:'🇧🇷', url:'https://rbatual.webradiobrasil.com.br/rbatual128',             genre:'Brasil'    },
  { id:'samba1',    name:'Samba Radio BR',        emoji:'🥁', url:'https://sambaradiobr.webradiobrasil.com.br/sambaradiobr128',   genre:'Samba'     },
  { id:'eletronic', name:'DI.FM Electronic',      emoji:'⚡', url:'https://prem4.di.fm/electronicpioneers?1234567',               genre:'Eletrônico' },
  { id:'hiphop1',   name:'HipHop Radio Global',  emoji:'🎤', url:'https://streams.ilovemusic.de/iloveradio6.mp3',                genre:'Hip-Hop'   },
];

class MusicBot {
  constructor(io, channelKey) {
    this.io = io; this.channelKey = channelKey; this.room = `room::${channelKey}`;
    this.queue = []; this.currentIdx = -1; this.playing = false; this.paused = false;
    this.volume = 80; this.shuffled = false; this.elapsed = 0;
    this.startedAt = null; this._skipTimer = null; this.history = [];
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
      sources: { soundcloud: !!scdl, youtube: !!(ytdl || ytSearch) },
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
    if (!scdl) {
      socket.emit('music:sc:results', { results: [], error: 'SoundCloud indisponível no servidor.' });
      return;
    }
    socket.emit('music:searching', { source: 'soundcloud', query });
    try {
      const res = await scdl.search({ query, limit: 8, resourceType: 'tracks' });
      const results = (res.collection || []).map(t => ({
        title: t.title, artist: t.user?.username || 'SoundCloud',
        url: t.permalink_url, thumbnail: t.artwork_url,
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
    if (!scdl) { socket?.emit('music:error', { msg: 'SoundCloud indisponível.' }); return; }
    try {
      // Tenta resolver stream URL diretamente
      const streamUrl = `/api/scstream?url=${encodeURIComponent(url)}`;
      // Busca metadados se não tiver
      if (!title) {
        try {
          const info = await scdl.getInfo(url);
          title     = info.title;
          artist    = info.user?.username || 'SoundCloud';
          duration  = Math.floor((info.duration||0)/1000);
          thumbnail = info.artwork_url;
        } catch {}
      }
      this._enqueue({ id:`sc-${Date.now()}`, type:'soundcloud',
        title: title||'SoundCloud Track', artist:(artist||'SoundCloud')+' · por '+requestedBy,
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
    if (!ytdl && !ytSearch) {
      socket?.emit('music:error', { msg: 'YouTube indisponível. Use rádio, MP3 ou link direto.' });
      return;
    }
    try {
      let track;
      if (url && ytdl?.validateURL(url)) {
        const info = await ytdl.getBasicInfo(url);
        const v    = info.videoDetails;
        track = { id: v.videoId, type:'youtube', emoji:'▶️',
          title: v.title, artist: v.author?.name||'YouTube',
          url, streamUrl:`/api/ytstream?url=${encodeURIComponent(url)}`,
          duration: parseInt(v.lengthSeconds)||0,
          durationFmt: this._fmt(parseInt(v.lengthSeconds)||0),
          requestedBy, thumbnail: v.thumbnails?.[0]?.url||null };
      } else if (query && ytSearch) {
        const res = await ytSearch(query);
        const v   = (res.videos||[])[0];
        if (!v) { socket?.emit('music:error', { msg: 'Nenhum resultado no YouTube.' }); return; }
        track = { id: v.videoId, type:'youtube', emoji:'▶️',
          title: v.title, artist: v.author?.name||'YouTube',
          url: v.url, streamUrl:`/api/ytstream?url=${encodeURIComponent(v.url)}`,
          duration: v.duration?.seconds||0, durationFmt: v.duration?.timestamp||'?',
          requestedBy, thumbnail: v.thumbnail||null };
      }
      if (track) this._enqueue(track, requestedBy);
    } catch (err) {
      socket?.emit('music:error', { msg: 'Erro YouTube: '+err.message });
    }
  }

  // ── Controles ────────────────────────────────────────────
  _enqueue(track, requestedBy) {
    this.queue.push(track);
    if (!this.playing) { this.currentIdx = this.queue.length-1; this._startTrack(); }
    this.broadcast();
    this.io.to(this.room).emit('music:added', { track, requestedBy, queueLength: this.queue.length });
    console.log(`[Bot:${this.channelKey}] ➕ "${track.title}" por ${requestedBy}`);
  }
  pause()  { if(!this.playing||this.paused) return; this.paused=true; if(this.startedAt) this.elapsed+=(Date.now()-this.startedAt)/1000; this._clearTimer(); this.broadcast(); }
  resume() { if(!this.playing||!this.paused) return; this.paused=false; this.startedAt=Date.now(); const t=this.queue[this.currentIdx]; if(t?.duration>0){const r=t.duration-this.elapsed; if(r>0) this._skipTimer=setTimeout(()=>this.skip(),r*1000);} this.broadcast(); }
  skip()   { this._clearTimer(); if(!this.queue.length) return; const next=this.shuffled?Math.floor(Math.random()*this.queue.length):this.currentIdx+1; if(!this.shuffled&&next>=this.queue.length){this.stop();return;} this.currentIdx=next; this._startTrack(); this.broadcast(); }
  stop()   { this._clearTimer(); this.playing=false; this.paused=false; this.currentIdx=-1; this.elapsed=0; this.startedAt=null; this.broadcast(); }
  playAt(socket,{index}){ if(index<0||index>=this.queue.length) return; this._clearTimer(); this.currentIdx=index; this._startTrack(); this.broadcast(); }
  removeFromQueue(socket,{index}){ if(index<0||index>=this.queue.length) return; const r=this.queue.splice(index,1)[0]; if(index<this.currentIdx) this.currentIdx--; else if(index===this.currentIdx){if(!this.queue.length){this.stop();return;} this.currentIdx=Math.min(this.currentIdx,this.queue.length-1); this._startTrack();} this.broadcast(); }
  shuffle()             { this.shuffled=!this.shuffled; this.broadcast(); }
  setVolume(s,{volume}) { this.volume=Math.max(0,Math.min(100,parseInt(volume)||80)); this.broadcast(); }
  clearQueue()          { this.stop(); this.queue=[]; this.broadcast(); }

  _startTrack() {
    this.playing=true; this.paused=false; this.elapsed=0; this.startedAt=Date.now();
    const t=this.queue[this.currentIdx]; if(!t) return;
    if(t.duration>0) this._skipTimer=setTimeout(()=>this.skip(),t.duration*1000);
    console.log(`[Bot:${this.channelKey}] ▶ "${t.title}"`);
  }
  _clearTimer() { clearTimeout(this._skipTimer); }
  _fmt(s) { s=Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }

  // ── Rotas Express ────────────────────────────────────────
  static registerRoutes(app, uploadDir) {
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
      if(!scdl||!url) return res.status(400).json({error:'SoundCloud indisponível ou URL inválida'});
      try {
        const stream = await scdl.download(url);
        res.setHeader('Content-Type','audio/mpeg');
        stream.pipe(res).on('error',()=>res.end());
      } catch(err) { res.status(500).json({error:err.message}); }
    });

    // YouTube stream proxy
    app.get('/api/ytstream', async (req,res) => {
      const { url } = req.query;
      if(!ytdl||!url||!ytdl.validateURL(url)) return res.status(400).json({error:'ytdl indisponível ou URL inválida'});
      try {
        res.setHeader('Content-Type','audio/mpeg');
        ytdl(url,{filter:'audioonly',quality:'lowestaudio'}).pipe(res).on('error',()=>res.end());
      } catch(err) { res.status(500).json({error:err.message}); }
    });

    app.get('/api/sources', (_,res) => res.json({
      radio:true, mp3:true, url:true,
      soundcloud:!!scdl, youtube:!!(ytdl||ytSearch),
    }));
  }
}

module.exports = { MusicBot, RADIOS };