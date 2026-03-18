/**
 * VozHub — BotAudioPlayer
 * Recebe chunks PCM do servidor via Socket.IO e toca via Web Audio API
 * Todos os usuários ouvem exatamente o mesmo áudio, sincronizado pelo servidor
 */

class BotAudioPlayer {
  constructor(socket) {
    this.socket      = socket;
    this._actx       = null;
    this._gainNode   = null;
    this._sampleRate = 48000;
    this._channels   = 2;
    this._playing    = false;
    this._queue      = [];          // chunks aguardando ser tocados
    this._nextTime   = 0;           // próximo tempo de reprodução no AudioContext
    this._bufSize    = 0.1;         // segundos de buffer (latência vs smoothness)
    this._volume     = 1.0;
    this._muted      = false;

    this._bindEvents();
  }

  // ── Inicializa o AudioContext (precisa de gesto do usuário) ──
  init() {
    if (this._actx) return;
    this._actx     = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this._sampleRate });
    this._gainNode = this._actx.createGain();
    this._gainNode.gain.value = this._volume;
    this._gainNode.connect(this._actx.destination);
    this._nextTime = this._actx.currentTime;
    console.log('[BotAudio] AudioContext iniciado, sampleRate:', this._actx.sampleRate);
  }

  // ── Eventos do socket ─────────────────────────────────
  _bindEvents() {
    // Configuração de áudio (nova faixa começando)
    this.socket.on('audio:config', ({ sampleRate, channels, playing, trackTitle }) => {
      this._sampleRate = sampleRate || 48000;
      this._channels   = channels   || 2;
      this._queue      = [];
      if (this._actx) {
        this._nextTime = this._actx.currentTime + 0.1; // pequeno buffer inicial
      }
      if (playing && trackTitle) {
        console.log('[BotAudio] Nova faixa:', trackTitle);
        this.init();
        if (this._actx?.state === 'suspended') this._actx.resume();
      }
    });

    // Chunk de áudio PCM chegando do servidor
    this.socket.on('audio:chunk', (arrayBuffer) => {
      if (!this._actx || this._muted) return;
      if (this._actx.state === 'suspended') this._actx.resume();
      try {
        this._scheduleChunk(arrayBuffer);
      } catch(e) { console.warn('[BotAudio] chunk error:', e.message); }
    });

    // Rádios, MP3, Jamendo, Audius tocam direto no cliente
    this.socket.on('audio:direct', ({ url, type, isLive }) => {
      console.log('[BotAudio] audio:direct recebido:', type, url?.slice(0,80));
      if (!url) { console.warn('[BotAudio] URL vazia!'); return; }
      const audio = document.getElementById('music-audio');
      if (!audio) return;

      // Para o que estava tocando
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.volume = Math.min(1, this._volume);
      audio.muted  = this._muted;
      audio.preload = isLive ? 'none' : 'auto';

      // Para rádios: sempre usa proxy do servidor
      // Isso garante funcionamento mesmo em redes corporativas que bloqueiam streams externos
      const isRadioType = type === 'radio';
      const finalUrl = isRadioType
        ? '/api/radioproxy?url=' + encodeURIComponent(url)
        : url;

      console.log('[BotAudio] URL final:', isRadioType ? '(proxy) ' : '', finalUrl.slice(0,80));

      audio.src         = finalUrl;
      audio.dataset.url = finalUrl;

      const tryPlay = () => {
        audio.play().then(() => {
          console.log('[BotAudio] ✅ Tocando:', type);
        }).catch(e => {
          console.warn('[BotAudio] play falhou:', e.name, e.message);
          if (e.name === 'NotAllowedError') {
            // Aguarda interação do usuário
            const unlock = () => { audio.play().catch(()=>{}); };
            document.addEventListener('click',    unlock, { once: true });
            document.addEventListener('keydown',  unlock, { once: true });
            document.addEventListener('touchend', unlock, { once: true });
          } else if (e.name === 'NotSupportedError' && !isRadioType) {
            // Fallback: tenta via proxy mesmo para não-rádios
            const proxyUrl = '/api/radioproxy?url=' + encodeURIComponent(url);
            audio.src = proxyUrl;
            audio.play().catch(() => {});
          }
        });
      };

      // Desbloqueia AudioContext se suspenso
      if (this._actx?.state === 'suspended') {
        this._actx.resume().then(tryPlay).catch(tryPlay);
      } else {
        tryPlay();
      }
    });

    // Controles
    this.socket.on('audio:paused',  () => { this._queue = []; this._schedPaused = true; });
    this.socket.on('audio:resumed', () => {
      this._schedPaused = false;
      if (this._actx) this._nextTime = this._actx.currentTime + 0.05;
    });
    this.socket.on('audio:stopped', () => {
      this._queue = []; this._schedPaused = false;
      const audio = document.getElementById('music-audio');
      if (audio) audio.pause();
    });
    this.socket.on('audio:ended',   () => {
      this._queue = [];
      console.log('[BotAudio] Faixa terminou');
    });
    this.socket.on('audio:volume',  ({ volume }) => {
      this._volume = volume;
      if (this._gainNode) this._gainNode.gain.setTargetAtTime(volume, this._actx.currentTime, 0.01);
      const audio = document.getElementById('music-audio');
      if (audio) audio.volume = Math.min(1, volume);
    });
  }

  // ── Agenda chunk PCM no Web Audio ────────────────────
  _scheduleChunk(arrayBuffer) {
    if (this._schedPaused) return;

    // Converte PCM s16le para Float32
    const pcm16   = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    const samplesPerChannel = Math.floor(float32.length / this._channels);
    if (samplesPerChannel === 0) return;

    // Cria AudioBuffer
    const buffer = this._actx.createBuffer(this._channels, samplesPerChannel, this._sampleRate);
    for (let ch = 0; ch < this._channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < samplesPerChannel; i++) {
        channelData[i] = float32[i * this._channels + ch];
      }
    }

    // Garante que não atrasamos
    const now = this._actx.currentTime;
    if (this._nextTime < now) this._nextTime = now + 0.02;

    // Agenda reprodução
    const source = this._actx.createBufferSource();
    source.buffer = buffer;
    source.connect(this._gainNode);
    source.start(this._nextTime);
    this._nextTime += buffer.duration;
  }

  // ── Volume local ──────────────────────────────────────
  setVolume(vol) {
    this._volume = Math.max(0, Math.min(2, vol));
    this._muted  = false;
    if (this._gainNode) {
      this._gainNode.gain.setTargetAtTime(this._volume, this._actx?.currentTime || 0, 0.01);
    }
    const audio = document.getElementById('music-audio');
    if (audio) audio.volume = Math.min(1, this._volume);
  }

  mute(muted) {
    this._muted = muted;
    if (this._gainNode) {
      this._gainNode.gain.setTargetAtTime(muted ? 0 : this._volume, this._actx?.currentTime || 0, 0.01);
    }
    const audio = document.getElementById('music-audio');
    if (audio) audio.muted = muted;
  }

  // ── Desbloqueia áudio no primeiro gesto ───────────────
  unlock() {
    this.init();
    if (this._actx?.state === 'suspended') this._actx.resume();
  }
}

window.BotAudioPlayer = BotAudioPlayer;