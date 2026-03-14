/**
 * VozHub — AudioStream
 * Streaming de áudio server-side via ffmpeg + yt-dlp
 * Igual ao bot do Discord: o servidor processa e todos ouvem sincronizado
 *
 * Fluxo:
 *   fonte (YT/SC/rádio/mp3) → yt-dlp/ffmpeg → PCM chunks → Socket.IO → Web Audio API
 */

const { spawn, execSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const fetch = require('node-fetch');

// ── Detecta ferramentas disponíveis ──────────────────────
function detectTool(names) {
  for (const name of names) {
    try { execSync(`which ${name}`, { stdio: 'ignore' }); return name; } catch {}
    try { execSync(`${name} --version`, { stdio: 'ignore' }); return name; } catch {}
  }
  return null;
}

const FFMPEG  = detectTool(['ffmpeg']);
const YTDLP   = detectTool(['yt-dlp', 'yt_dlp']);
console.log(`[AudioStream] ffmpeg: ${FFMPEG||'NÃO ENCONTRADO'} | yt-dlp: ${YTDLP||'NÃO ENCONTRADO'}`);

// ── Instâncias Invidious ──────────────────────────────────
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.privacydev.net',
  'https://iv.datura.network',
  'https://invidious.nerdvpn.de',
];

class AudioStream {
  constructor(io, channelKey) {
    this.io          = io;
    this.channelKey  = channelKey;
    this.room        = `room::${channelKey}`;

    this._ffmpeg     = null;   // processo ffmpeg atual
    this._ytdlp      = null;   // processo yt-dlp atual
    this._playing    = false;
    this._paused     = false;
    this._volume     = 1.0;    // 0.0 – 2.0
    this._chunkSize  = 4096;   // bytes por chunk de PCM
    this._sampleRate = 48000;  // Hz (padrão Web Audio)
    this._channels   = 2;      // estéreo
    this._pauseBuffer= [];     // chunks durante pause
    this._listeners  = new Map(); // socketId -> { socket }
  }

  // ── Adicionar/remover ouvintes ────────────────────────
  addListener(socket) {
    this._listeners.set(socket.id, socket);
    // Envia configuração de áudio para o cliente
    socket.emit('audio:config', {
      sampleRate: this._sampleRate,
      channels:   this._channels,
      playing:    this._playing,
      paused:     this._paused,
    });
  }

  removeListener(socketId) {
    this._listeners.delete(socketId);
  }

  // ── Broadcast de chunk de áudio ───────────────────────
  _broadcastChunk(chunk) {
    if (this._paused) return;
    if (!this._listeners.size) return;
    // Converte Buffer para ArrayBuffer e envia para todos
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    this._listeners.forEach(socket => {
      try { socket.volatile.emit('audio:chunk', ab); } catch {}
    });
  }

  // ── Resolve URL de stream para qualquer fonte ─────────
  async resolveStreamUrl(track) {
    const { type, url, id } = track;

    // Rádio ou link direto — usa direto
    if (type === 'radio' || type === 'url' || type === 'mp3') {
      return { url: track.streamUrl || url, direct: true };
    }

    // YouTube — tenta yt-dlp primeiro, depois Invidious
    if (type === 'youtube') {
      const videoId = id || (url?.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)||[])[1];
      if (!videoId) return null;

      // yt-dlp
      if (YTDLP) {
        try {
          const { stdout } = await new Promise((res, rej) => {
            const p = spawn(YTDLP, [
              `https://www.youtube.com/watch?v=${videoId}`,
              '--get-url', '-f', 'bestaudio[ext=webm]/bestaudio/best',
              '--no-playlist', '--quiet', '--no-warnings',
            ]);
            let out = '', err = '';
            p.stdout.on('data', d => out += d);
            p.stderr.on('data', d => err += d);
            p.on('close', code => code === 0 ? res({ stdout: out }) : rej(new Error(err)));
            setTimeout(() => { p.kill(); rej(new Error('timeout')); }, 12000);
          });
          const streamUrl = stdout.trim().split('\n')[0];
          if (streamUrl?.startsWith('http')) return { url: streamUrl, direct: false };
        } catch(e) { console.warn('[AudioStream] yt-dlp:', e.message?.slice(0,80)); }
      }

      // Invidious fallback
      for (const inst of INVIDIOUS) {
        try {
          const data = await fetch(`${inst}/api/v1/videos/${videoId}?fields=adaptiveFormats`, { timeout: 6000 }).then(r => r.json());
          const fmts = (data.adaptiveFormats || [])
            .filter(f => f.type?.startsWith('audio/'))
            .sort((a,b) => (parseInt(b.bitrate)||0) - (parseInt(a.bitrate)||0));
          if (fmts[0]?.url) return { url: fmts[0].url, direct: false };
        } catch {}
      }
      return null;
    }

    // SoundCloud — usa streamUrl já resolvido
    if (type === 'soundcloud') {
      return { url: track.streamUrl || url, direct: false };
    }

    return null;
  }

  // ── Iniciar streaming de uma faixa ────────────────────
  async startTrack(track) {
    this.stop(); // Para o que estiver tocando
    if (!FFMPEG) {
      console.warn('[AudioStream] ffmpeg não disponível — usando stream direto');
      this._playing = true; this._paused = false;
      // Sem ffmpeg: envia a URL para o cliente tocar diretamente
      this.io.to(this.room).emit('audio:direct', {
        url:        track.streamUrl || track.url,
        type:       track.type,
        isLive:     track.isLive,
        sampleRate: this._sampleRate,
        channels:   this._channels,
      });
      return;
    }

    console.log(`[AudioStream:${this.channelKey}] Iniciando: ${track.title}`);
    const resolved = await this.resolveStreamUrl(track);
    if (!resolved) {
      this.io.to(this.room).emit('music:error', { msg: `Não foi possível carregar: ${track.title}` });
      return;
    }

    this._playing = true; this._paused = false;

    // Notifica clientes para preparar o Web Audio
    this.io.to(this.room).emit('audio:config', {
      sampleRate: this._sampleRate,
      channels:   this._channels,
      playing:    true,
      paused:     false,
      trackTitle: track.title,
    });

    // Monta argumentos do ffmpeg
    const ffArgs = [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', resolved.url,
      '-vn',                          // sem vídeo
      '-af', `volume=${this._volume}`,
      '-ar', String(this._sampleRate),
      '-ac', String(this._channels),
      '-f', 's16le',                  // PCM 16-bit little-endian
      '-',                            // stdout
    ];

    this._ffmpeg = spawn(FFMPEG, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._ffmpeg.stdout.on('data', chunk => {
      this._broadcastChunk(chunk);
    });

    this._ffmpeg.stderr.on('data', d => {
      const msg = d.toString();
      if (!msg.includes('size=') && !msg.includes('time=')) {
        console.log(`[ffmpeg] ${msg.slice(0,120)}`);
      }
    });

    this._ffmpeg.on('close', code => {
      console.log(`[AudioStream] ffmpeg encerrou (code ${code}) — ${track.title}`);
      this._playing = false;
      this.io.to(this.room).emit('audio:ended', { channelKey: this.channelKey });
    });

    this._ffmpeg.on('error', err => {
      console.error('[AudioStream] ffmpeg erro:', err.message);
      this._playing = false;
    });
  }

  // ── Controles ─────────────────────────────────────────
  pause() {
    if (!this._playing || this._paused) return;
    this._paused = true;
    if (this._ffmpeg) this._ffmpeg.kill('SIGSTOP'); // pausa o processo
    this.io.to(this.room).emit('audio:paused');
  }

  resume() {
    if (!this._playing || !this._paused) return;
    this._paused = false;
    if (this._ffmpeg) this._ffmpeg.kill('SIGCONT'); // retoma o processo
    this.io.to(this.room).emit('audio:resumed');
  }

  stop() {
    this._playing = false; this._paused = false;
    if (this._ffmpeg) { try { this._ffmpeg.kill('SIGKILL'); } catch {} this._ffmpeg = null; }
    if (this._ytdlp)  { try { this._ytdlp.kill('SIGKILL');  } catch {} this._ytdlp  = null; }
    this.io.to(this.room).emit('audio:stopped');
  }

  setVolume(vol) {
    this._volume = Math.max(0, Math.min(2, vol));
    // Volume em tempo real via ffmpeg requer reiniciar — notifica clientes para ajustar localmente
    this.io.to(this.room).emit('audio:volume', { volume: this._volume });
  }

  get playing() { return this._playing; }
  get paused()  { return this._paused; }
}

module.exports = { AudioStream, FFMPEG, YTDLP };