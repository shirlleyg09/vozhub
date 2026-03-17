/**
 * VozHub — Music Bot v3.1
 * Fontes: Rádio | MP3 Upload | Link Direto | SoundCloud | YouTube
 * Usa @distube/ytdl-core (fork mantida) e soundcloud-downloader
 */

const path = require('path');
const fs   = require('fs');
const { AudioStream, FFMPEG, YTDLP } = require('./audioStream');

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
let ytSearch;
try { ytSearch = require('yt-search'); } catch { ytSearch = null; }
const ytdl = null;
const SC   = null;
function getSC() { return null; } // SoundCloud bloqueou servidores (401)

// Rádios fixas — verificadas e funcionais
const RADIOS_FIXAS = [
  // ── BRASIL — Zeno.FM ─────────────────────────────────
  { id:'br_sertanejo',   name:'Sertaneja FM',            emoji:'🤠', url:'https://stream.zeno.fm/f3e4rqrmb5zuv',      genre:'Sertanejo'    },
  { id:'br_sertanejo2',  name:'Sertanejo Universitário', emoji:'🎸', url:'https://stream.zeno.fm/0r0xa792kwzuv',      genre:'Sertanejo'    },
  { id:'br_pagode',      name:'Pagode 90',               emoji:'🥁', url:'https://stream.zeno.fm/yn65m0tmdrhvv',      genre:'Pagode'       },
  { id:'br_pagode2',     name:'Só Pagode BR',            emoji:'🎶', url:'https://stream.zeno.fm/4d5n1qrmb5zuv',      genre:'Pagode'       },
  { id:'br_gospel',      name:'Gospel BR',               emoji:'✝️', url:'https://stream.zeno.fm/tsua3rs0y6zuv',      genre:'Gospel'       },
  { id:'br_gospel2',     name:'Gospel Música',           emoji:'🙏', url:'https://stream.zeno.fm/2e0hmqrmb5zuv',      genre:'Gospel'       },
  { id:'br_funk',        name:'Funk Brasil',             emoji:'🔥', url:'https://stream.zeno.fm/7f0hmqrmb5zuv',      genre:'Funk'         },
  { id:'br_funk2',       name:'Funk Ostentação',         emoji:'💎', url:'https://stream.zeno.fm/q0zy0tmdrhvv',       genre:'Funk'         },
  { id:'br_forro',       name:'Forró Universitário',     emoji:'🪗', url:'https://stream.zeno.fm/g5e4rqrmb5zuv',      genre:'Forró'        },
  { id:'br_axe',         name:'Axé & Baile',             emoji:'🎉', url:'https://stream.zeno.fm/h3e4rqrmb5zuv',      genre:'Axé'          },
  { id:'br_mpb',         name:'MPB Clássicos',           emoji:'🇧🇷', url:'https://stream.zeno.fm/i2e4rqrmb5zuv',    genre:'MPB'          },
  { id:'br_flashback',   name:'Flashback Romântico',     emoji:'📼', url:'https://stream.zeno.fm/j1e4rqrmb5zuv',      genre:'Flashback'    },
  { id:'br_rap',         name:'Rap Nacional',            emoji:'🎤', url:'https://stream.zeno.fm/k0e4rqrmb5zuv',      genre:'Rap BR'       },
  { id:'br_pop',         name:'Pop Brasil',              emoji:'🌟', url:'https://stream.zeno.fm/l9d4rqrmb5zuv',      genre:'Pop BR'       },
  // ── INTERNACIONAL — iLoveMusic + SomaFM ──────────────
  { id:'int_lofi',       name:'Lofi Hip Hop',            emoji:'🎧', url:'https://streams.ilovemusic.de/iloveradio17.mp3', genre:'Lo-fi'    },
  { id:'int_chill',      name:'Chill Out',               emoji:'🌊', url:'https://streams.ilovemusic.de/iloveradio2.mp3',  genre:'Chill'    },
  { id:'int_hiphop',     name:'Hip-Hop',                 emoji:'🎤', url:'https://streams.ilovemusic.de/iloveradio6.mp3',  genre:'Hip-Hop'  },
  { id:'int_trap',       name:'Trap & Rap',              emoji:'🔊', url:'https://streams.ilovemusic.de/iloveradio25.mp3', genre:'Trap'     },
  { id:'int_rnb',        name:'R&B Soul',                emoji:'💜', url:'https://streams.ilovemusic.de/iloveradio11.mp3', genre:'R&B'      },
  { id:'int_indie',      name:'Indie Rock',              emoji:'🪨', url:'https://streams.ilovemusic.de/iloveradio12.mp3', genre:'Indie'    },
  { id:'int_rock',       name:'Rock Classic',            emoji:'🎸', url:'https://streams.ilovemusic.de/iloveradio5.mp3',  genre:'Rock'     },
  { id:'int_metal',      name:'Heavy Metal',             emoji:'🤘', url:'https://streams.ilovemusic.de/iloveradio9.mp3',  genre:'Metal'    },
  { id:'int_pop',        name:'Pop Internacional',       emoji:'🌟', url:'https://streams.ilovemusic.de/iloveradio1.mp3',  genre:'Pop'      },
  { id:'int_edm',        name:'EDM / Festival',          emoji:'🎡', url:'https://streams.ilovemusic.de/iloveradio4.mp3',  genre:'EDM'      },
  { id:'int_electronic', name:'Electronic / Dance',      emoji:'⚡', url:'https://streams.ilovemusic.de/iloveradio3.mp3',  genre:'Eletrônico'},
  { id:'int_80s',        name:'80s Hits',                emoji:'📻', url:'https://streams.ilovemusic.de/iloveradio7.mp3',  genre:'80s'      },
  { id:'int_90s',        name:'90s Hits',                emoji:'💿', url:'https://streams.ilovemusic.de/iloveradio8.mp3',  genre:'90s'      },
  { id:'int_reggae',     name:'Reggae Vibes',            emoji:'🌴', url:'https://streams.ilovemusic.de/iloveradio21.mp3', genre:'Reggae'   },
  { id:'int_kpop',       name:'K-Pop Radio',             emoji:'🇰🇷', url:'https://streams.ilovemusic.de/iloveradio23.mp3', genre:'K-Pop' },
  { id:'int_jazz',       name:'Jazz',                    emoji:'🎷', url:'https://streams.ilovemusic.de/iloveradio10.mp3', genre:'Jazz'     },
  { id:'int_classical',  name:'Clássico',                emoji:'🎻', url:'https://streams.ilovemusic.de/iloveradio14.mp3', genre:'Clássico' },
  { id:'int_ambient',    name:'Ambient / Sleep',         emoji:'🌙', url:'https://somafm.com/groovesalad256.mp3',          genre:'Ambient'  },
  { id:'soma_indie',     name:'Indie Pop Rocks (SomaFM)',emoji:'🌈', url:'https://somafm.com/indiepop130.pls',             genre:'Indie Pop'},
];

// Cache de rádios do Radio Browser API (atualizado a cada hora)
let _radioBrowserCache = [];
let _radioBrowserLastFetch = 0;

async function fetchRadioBrowser(tag, limit = 5) {
  try {
    const fetch = require('node-fetch');
    const url   = `https://de1.api.radio-browser.info/json/stations/bytag/${encodeURIComponent(tag)}?limit=${limit}&order=clickcount&reverse=true&hidebroken=true&has_extended_info=true`;
    const data  = await fetch(url, { timeout: 5000, headers: { 'User-Agent': 'VozHub/3.0' } }).then(r => r.json());
    return (data || []).filter(s => s.url_resolved && s.lastcheckok === '1');
  } catch { return []; }
}

async function getRadios() {
  const now = Date.now();
  // Recarrega do Radio Browser a cada 1h
  if (now - _radioBrowserLastFetch > 3600000 || !_radioBrowserCache.length) {
    _radioBrowserLastFetch = now;
    try {
      const [gospel, rap, sertanejo, hiphop] = await Promise.all([
        fetchRadioBrowser('gospel', 4),
        fetchRadioBrowser('rap', 3),
        fetchRadioBrowser('sertanejo', 3),
        fetchRadioBrowser('hip hop', 3),
      ]);
      const dynamic = [...gospel, ...rap, ...sertanejo, ...hiphop].map(s => ({
        id:    's-' + s.stationuuid,
        name:  s.name.slice(0, 30),
        emoji: s.tags?.includes('gospel') ? '✝️' : s.tags?.includes('rap') ? '🎤' : s.tags?.includes('sertanejo') ? '🤠' : '📻',
        url:   s.url_resolved,
        genre: s.tags?.split(',')[0] || 'Rádio',
        dynamic: true,
      }));
      _radioBrowserCache = dynamic;
      console.log(`[Rádios] Radio Browser: ${dynamic.length} estações carregadas`);
    } catch(e) {
      console.warn('[Rádios] Radio Browser indisponível:', e.message);
    }
  }
  // Combina fixas + dinâmicas, removendo duplicatas
  const combined = [...RADIOS_FIXAS];
  _radioBrowserCache.forEach(r => {
    if (!combined.find(f => f.url === r.url)) combined.push(r);
  });
  return combined;
}

// NÃO carrega Radio Browser no startup — evita lentidão
// As rádios fixas ficam disponíveis imediatamente
let RADIOS = RADIOS_FIXAS;
// Carrega Radio Browser em background após 10s (não bloqueia o startup)
setTimeout(() => {
  getRadios().then(r => {
    RADIOS = r;
    console.log(`[Rádios] Radio Browser carregado: ${r.length} estações`);
  }).catch(() => {});
}, 10000);

class MusicBot {
  constructor(io, channelKey) {
    this.io = io; this.channelKey = channelKey; this.room = `room::${channelKey}`;
    this.queue = []; this.currentIdx = -1; this.playing = false; this.paused = false;
    this.volume = 80; this.shuffled = false; this.elapsed = 0;
    this.startedAt = null; this._skipTimer = null; this.history = [];
    // AudioStream: streaming server-side igual bot Discord
    this.audioStream = new AudioStream(io, channelKey);
    // Restaura fila salva do disco
    this._loadQueue();
  }

  // Registra socket no audioStream (chamado ao entrar no canal)
  addAudioListener(socket) {
    this.audioStream.addListener(socket);
  }
  removeAudioListener(socketId) {
    this.audioStream.removeListener(socketId);
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
      sources: { soundcloud: !!getSC(), youtube: true, ffmpeg: !!FFMPEG, ytdlp: !!YTDLP },
    };
  }

  broadcast() { this.io.to(this.room).emit('music:state', this.getState()); }

  // ── Rádio — entra na FILA (não interrompe o que está tocando) ──
  addRadio(radioId, requestedBy) {
    const r = RADIOS.find(x => x.id === radioId); if (!r) return false;
    this._enqueue({
      id:          radioId,
      type:        'radio',
      title:       r.name,
      artist:      r.genre + ' · Ao vivo 🔴',
      emoji:       r.emoji,
      url:         r.url,
      streamUrl:   r.url,
      duration:    0,
      durationFmt: '🔴 Ao vivo',
      requestedBy,
      thumbnail:   null,
      isLive:      true,
    }, requestedBy);
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
    socket.emit('music:searching', { source: 'soundcloud', query });
    const fetch = require('node-fetch');

    // Abordagem 1: extrai client_id dinâmico da página do SoundCloud
    async function getDynamicClientId() {
      try {
        const html  = await fetch('https://soundcloud.com', { timeout: 6000 }).then(r => r.text());
        const urls  = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
        for (const jsUrl of urls.slice(-3)) {
          const js = await fetch(jsUrl, { timeout: 5000 }).then(r => r.text());
          const m  = js.match(/client_id:"([a-zA-Z0-9]{32})"/);
          if (m) return m[1];
        }
      } catch {}
      return null;
    }

    // Tenta obter client_id dinâmico
    let clientId = await getDynamicClientId();
    console.log('[SC] client_id dinâmico:', clientId ? clientId.slice(0,8)+'...' : 'não encontrado');

    // Fallback para IDs conhecidos
    const fallbackIds = [
      'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
      'a3e059563d7fd3372b49b37f00a00bcf',
    ];
    const idsToTry = clientId ? [clientId, ...fallbackIds] : fallbackIds;

    for (const id of idsToTry) {
      try {
        const url  = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=8&client_id=${id}`;
        const resp = await fetch(url, { timeout: 8000 });
        if (!resp.ok) { console.warn('[SC] HTTP', resp.status, 'para', id.slice(0,8)); continue; }
        const data = await resp.json();
        const results = (data.collection || []).slice(0, 8).map(t => ({
          title:       t.title,
          artist:      t.user?.username || 'SoundCloud',
          url:         t.permalink_url,
          streamUrl:   t.media?.transcodings?.find(x => x.format?.mime_type === 'audio/mpeg')?.url || null,
          thumbnail:   t.artwork_url?.replace('-large','-t300x300') || null,
          duration:    Math.floor((t.duration||0)/1000),
          durationFmt: this._fmt(Math.floor((t.duration||0)/1000)),
          type: 'soundcloud', emoji: '☁️',
          clientId: id,
        }));
        if (results.length) {
          console.log(`[SC] ✅ ${results.length} resultados com ${id.slice(0,8)}...`);
          socket.emit('music:sc:results', { results }); return;
        }
      } catch(e) { console.warn('[SC] erro:', e.message?.slice(0,60)); }
    }

    // Último recurso: soundcloud-scraper
    const scClient = getSC();
    if (scClient) {
      try {
        const res = await scClient.search(query, 'track');
        const results = (res.collection || []).slice(0, 8).map(t => ({
          title: t.title, artist: t.user?.username || 'SoundCloud',
          url: t.permalink_url || t.url,
          thumbnail: t.artwork_url?.replace('-large','-t300x300') || null,
          duration: Math.floor((t.duration||0)/1000),
          durationFmt: this._fmt(Math.floor((t.duration||0)/1000)),
          type: 'soundcloud', emoji: '☁️',
        }));
        if (results.length) { socket.emit('music:sc:results', { results }); return; }
      } catch(e) { console.warn('[SC] scraper:', e.message?.slice(0,60)); }
    }

    socket.emit('music:sc:results', {
      results: [],
      error: 'SoundCloud bloqueando requisições de servidor. Use Jamendo ou Link Direto.'
    });
  }

  async addSoundCloud({ url, title, artist, duration, thumbnail, streamUrl: directStreamUrl, clientId, requestedBy }, socket) {
    const fetch = require('node-fetch');
    let resolvedStream = null;

    // Se já tem streamUrl da busca, resolve o URL final
    if (directStreamUrl && clientId) {
      try {
        const data = await fetch(`${directStreamUrl}?client_id=${clientId}`, { timeout: 8000 }).then(r => r.json());
        resolvedStream = data.url || null;
      } catch {}
    }

    // Fallback: usa proxy do servidor
    if (!resolvedStream) {
      resolvedStream = `/api/scstream?url=${encodeURIComponent(url)}`;
    }

    this._enqueue({
      id: `sc-${Date.now()}`, type: 'soundcloud',
      title: title || 'SoundCloud Track',
      artist: (artist || 'SoundCloud') + ' · por ' + requestedBy,
      emoji: '☁️', url,
      streamUrl: resolvedStream,
      duration: duration || 0,
      durationFmt: this._fmt(duration || 0),
      requestedBy, thumbnail: thumbnail || null, isLive: false,
    }, requestedBy);
  }

  // ── YouTube ─────────────────────────────────────────────
  async searchYouTube(query, socket) {
    socket.emit('music:searching', { source: 'youtube', query });

    // Tenta yt-search (biblioteca Node)
    if (ytSearch) {
      try {
        const res = await ytSearch(query);
        const results = (res.videos||[]).slice(0,6).map(v => ({
          title: v.title, artist: v.author?.name||'YouTube',
          url: v.url, thumbnail: v.thumbnail||null,
          duration: v.duration?.seconds||0, durationFmt: v.duration?.timestamp||'?',
          type:'youtube', emoji:'▶️',
        }));
        if (results.length) { socket.emit('music:yt:results', { results }); return; }
      } catch(e) { console.warn('[YT search] yt-search falhou:', e.message); }
    }

    // Fallback: busca via Invidious API
    try {
      const fetch = require('node-fetch');
      const q     = encodeURIComponent(query);
      const data  = await fetch(`https://inv.nadeko.net/api/v1/search?q=${q}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails`, { timeout: 8000 }).then(r => r.json());
      const results = (Array.isArray(data) ? data : []).slice(0,6).map(v => ({
        title: v.title, artist: v.author||'YouTube',
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        thumbnail: v.videoThumbnails?.[0]?.url || null,
        duration: v.lengthSeconds||0,
        durationFmt: v.lengthSeconds ? `${Math.floor(v.lengthSeconds/60)}:${String(v.lengthSeconds%60).padStart(2,'0')}` : '?',
        type:'youtube', emoji:'▶️',
      }));
      socket.emit('music:yt:results', { results });
    } catch(e) {
      socket.emit('music:yt:results', { results: [], error: 'Busca YouTube indisponível. Cole um link direto.' });
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

  // ── JAMENDO ─────────────────────────────────────────────
  // API gratuita, 500k músicas Creative Commons, stream direto
  async searchJamendo(query, socket) {
    socket.emit('music:searching', { source: 'jamendo', query });
    try {
      const fetch     = require('node-fetch');
      const clientId  = process.env.JAMENDO_CLIENT_ID || '330e6981';
      console.log(`[Jamendo] Buscando: "${query}" com clientId ${clientId}`);
      const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&format=json&limit=10&search=${encodeURIComponent(query)}&audioformat=mp31&include=musicinfo`;
      const resp = await fetch(url, { timeout: 10000 });
      console.log(`[Jamendo] HTTP ${resp.status}`);
      const data = await resp.json();
      console.log(`[Jamendo] Resultados: ${data.results?.length || 0}`);
      const results = (data.results || []).map(t => ({
        title:       t.name,
        artist:      t.artist_name,
        url:         t.shareurl,
        streamUrl:   t.audio,
        thumbnail:   t.image || null,
        duration:    parseInt(t.duration) || 0,
        durationFmt: this._fmt(parseInt(t.duration) || 0),
        type:        'jamendo',
        emoji:       '🎼',
        license:     t.license_ccurl,
      }));
      socket.emit('music:jamendo:results', { results });
    } catch(e) {
      socket.emit('music:jamendo:results', { results: [], error: 'Jamendo indisponível: ' + e.message });
    }
  }

  addJamendo({ streamUrl, url, title, artist, duration, thumbnail, requestedBy }, socket) {
    if (!streamUrl) { socket?.emit('music:error', { msg: 'URL de stream Jamendo inválida.' }); return; }
    this._enqueue({
      id:          `jm-${Date.now()}`,
      type:        'jamendo',
      title:       title || 'Jamendo Track',
      artist:      (artist || 'Jamendo') + ' · por ' + requestedBy,
      emoji:       '🎼',
      url,
      streamUrl,
      duration:    duration || 0,
      durationFmt: this._fmt(duration || 0),
      requestedBy,
      thumbnail:   thumbnail || null,
      isLive:      false,
    }, requestedBy);
  }

  // ── AUDIUS ──────────────────────────────────────────────
  // Plataforma descentralizada, API pública, sem autenticação
  // Conteúdo: hip-hop, eletrônico, indie, remixes
  async searchAudius(query, socket) {
    socket.emit('music:searching', { source: 'audius', query });
    const fetch = require('node-fetch');

    // Audius usa múltiplos nodes — tenta cada um
    const AUDIUS_NODES = [
      'https://discoveryprovider.audius.co',
      'https://discoveryprovider2.audius.co',
      'https://discoveryprovider3.audius.co',
    ];

    for (const node of AUDIUS_NODES) {
      try {
        const url  = `${node}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=8&app_name=VozHub`;
        const data = await fetch(url, { timeout: 8000 }).then(r => r.json());
        const results = (data.data || []).map(t => ({
          title:       t.title,
          artist:      t.user?.name || 'Audius',
          url:         `https://audius.co${t.permalink}`,
          streamUrl:   null, // resolvido ao adicionar
          audiusId:    t.id,
          thumbnail:   t.artwork?.['480x480'] || t.artwork?.['150x150'] || null,
          duration:    t.duration || 0,
          durationFmt: this._fmt(t.duration || 0),
          type:        'audius',
          emoji:       '🎵',
          genre:       t.genre || '',
        }));
        if (results.length) {
          console.log(`[Audius] ✅ ${results.length} resultados via ${node}`);
          socket.emit('music:audius:results', { results, node });
          return;
        }
      } catch(e) { console.warn(`[Audius] ${node} falhou:`, e.message?.slice(0,60)); }
    }
    socket.emit('music:audius:results', { results: [], error: 'Audius indisponível.' });
  }

  async addAudius({ audiusId, title, artist, duration, thumbnail, requestedBy }, socket) {
    const fetch = require('node-fetch');
    const AUDIUS_NODES = [
      'https://discoveryprovider.audius.co',
      'https://discoveryprovider2.audius.co',
    ];

    let streamUrl = null;
    for (const node of AUDIUS_NODES) {
      try {
        // Resolve stream URL do Audius
        const url  = `${node}/v1/tracks/${audiusId}/stream?app_name=VozHub`;
        const resp = await fetch(url, { method: 'HEAD', timeout: 6000, redirect: 'follow' });
        if (resp.ok || resp.status === 302) {
          streamUrl = resp.url || url;
          break;
        }
      } catch {}
    }

    if (!streamUrl) {
      // Fallback direto
      streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${audiusId}/stream?app_name=VozHub`;
    }

    this._enqueue({
      id:          `au-${audiusId}`,
      type:        'audius',
      title:       title || 'Audius Track',
      artist:      (artist || 'Audius') + ' · por ' + requestedBy,
      emoji:       '🎵',
      url:         `https://audius.co/tracks/${audiusId}`,
      streamUrl,
      audiusId,
      duration:    duration || 0,
      durationFmt: this._fmt(duration || 0),
      requestedBy,
      thumbnail:   thumbnail || null,
      isLive:      false,
    }, requestedBy);
  }

  // ── Controles ────────────────────────────────────────────
  _enqueue(track, requestedBy) {
    this.queue.push(track);
    const position = this.queue.length;

    if (!this.playing) {
      // Nada tocando — começa imediatamente
      this.currentIdx = this.queue.length - 1;
      this._startTrack();
      this.io.to(this.room).emit('music:added', { track, requestedBy, queueLength: this.queue.length, playingNow: true });
    } else {
      // Já tem algo tocando — entra no final da fila
      this.io.to(this.room).emit('music:added', {
        track, requestedBy,
        queueLength: this.queue.length,
        playingNow:  false,
        position,
        message: `"${track.title}" adicionado à fila (#${position})`,
      });
    }

    this._saveQueue();
    this.broadcast();
    console.log(`[Bot:${this.channelKey}] ➕ "${track.title}" por ${requestedBy} (pos ${position})`);
  }
  pause() {
    if (!this.playing || this.paused) return;
    this.paused = true;
    if (this.startedAt) this.elapsed += (Date.now() - this.startedAt) / 1000;
    this._clearTimer();
    this.broadcast(); // broadcast PRIMEIRO — sem delay para o cliente
    this.audioStream.pause(); // ffmpeg async — não bloqueia
  }
  resume() {
    if (!this.playing || !this.paused) return;
    this.paused = false; this.startedAt = Date.now();
    const t = this.queue[this.currentIdx];
    if (t?.duration > 0) {
      const r = t.duration - this.elapsed;
      if (r > 0) this._skipTimer = setTimeout(() => this.skip(), r * 1000);
    }
    this.broadcast(); // broadcast PRIMEIRO
    this.audioStream.resume();
  }
  skip() {
    this._clearTimer();
    if (!this.queue.length) return;
    const next = this.shuffled
      ? Math.floor(Math.random() * this.queue.length)
      : this.currentIdx + 1;
    if (!this.shuffled && next >= this.queue.length) { this.stop(); return; }
    this.currentIdx = next;
    this._startTrack();
    this._saveQueue();
    this.broadcast(); // broadcast PRIMEIRO
  }
  stop() {
    this._clearTimer();
    this.playing = false; this.paused = false;
    this.currentIdx = -1; this.elapsed = 0; this.startedAt = null;
    this.broadcast(); // broadcast PRIMEIRO
    this.audioStream.stop();
    this._saveQueue();
  }
  playAt(socket,{index}){ if(index<0||index>=this.queue.length) return; this._clearTimer(); this.currentIdx=index; this._startTrack(); this.broadcast(); }
  removeFromQueue(socket,{index}){ if(index<0||index>=this.queue.length) return; const r=this.queue.splice(index,1)[0]; if(index<this.currentIdx) this.currentIdx--; else if(index===this.currentIdx){if(!this.queue.length){this.stop();return;} this.currentIdx=Math.min(this.currentIdx,this.queue.length-1); this._startTrack();} this._saveQueue(); this.broadcast(); }
  shuffle()             { this.shuffled=!this.shuffled; this.broadcast(); }
  setVolume(s,{volume}) { this.volume=Math.max(0,Math.min(100,parseInt(volume)||80)); this.broadcast(); }
  clearQueue()          { this.stop(); this.queue=[]; this._saveQueue(); this.broadcast(); }

  _startTrack() {
    this.playing = true; this.paused = false; this.elapsed = 0; this.startedAt = Date.now();
    const t = this.queue[this.currentIdx]; if (!t) return;
    if (t.duration > 0) this._skipTimer = setTimeout(() => this.skip(), t.duration * 1000);
    // Broadcast IMEDIATO — cliente recebe novo estado sem esperar ffmpeg
    this.broadcast();
    // Inicia streaming async (não bloqueia o broadcast)
    setImmediate(() => {
      this.audioStream.startTrack(t).catch(e => console.error('[Bot] audioStream:', e.message));
    });
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

    // Verifica se yt-dlp está disponível (async IIFE para permitir await)
    let ytdlpPath = null;
    (async () => {
      try {
        const { stdout } = await promisify(exec)('which yt-dlp || where yt-dlp');
        ytdlpPath = stdout.trim().split('\n')[0];
        console.log('[yt-dlp] encontrado em:', ytdlpPath);
      } catch {
        console.warn('[yt-dlp] não encontrado — YouTube pode não funcionar');
      }
    })();

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
      radio:      true,
      mp3:        true,
      url:        true,
      soundcloud: !!getSC(),
      youtube:    true, // busca sempre disponível via yt-search, stream via yt-dlp
    }));
  }
}

module.exports = { MusicBot, RADIOS, RADIOS_FIXAS, getRadios }; // Audius integrado