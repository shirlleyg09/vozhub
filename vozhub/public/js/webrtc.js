/**
 * VozHub — WebRTC Manager
 * Gerencia peer connections, microfone, e VAD (Voice Activity Detection)
 */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peers  = new Map();  // peerId -> RTCPeerConnection
    this.localStream   = null;
    this.audioContext  = null;
    this.analyser      = null;
    this.micOn    = true;
    this.deafOn   = false;
    this.vadTimer = null;
    this.onSpeaking = null; // callback(bool)

    // STUN/TURN servers (adicione TURN para produção)
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Para produção adicione TURN:
        // { urls: 'turn:seu-servidor:3478', username: 'user', credential: 'pass' }
      ]
    };

    this._bindSocketEvents();
  }

  // ── Ganho do microfone ─────────────────────────────────
  setMicVolume(value) {
    // value: 0.0 a 2.0 (1.0 = normal, 2.0 = dobro do volume)
    if (this._micGain) {
      this._micGain.gain.setTargetAtTime(value, this._micGain.context.currentTime, 0.01);
    }
  }

  // ── Capturar microfone ──────────────────────────────────
  async initMic(deviceId = null) {
    try {
      const constraints = {
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this._initVAD();
      console.log('[WebRTC] Microfone capturado');
      return true;
    } catch (err) {
      console.error('[WebRTC] Erro ao capturar microfone:', err.message);
      return false;
    }
  }

  // ── VAD — Voice Activity Detection ─────────────────────
  _initVAD() {
    if (!this.localStream) return;
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source      = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyser     = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;

      // Nó de ganho para controlar volume do microfone
      this._micGain = this.audioContext.createGain();
      this._micGain.gain.value = 1.0;
      source.connect(this._micGain);
      this._micGain.connect(this.analyser);

      const data = new Uint8Array(this.analyser.frequencyBinCount);
      let speaking = false;
      let silenceFrames = 0;

      const check = () => {
        this.analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const isSpeaking = avg > 18 && this.micOn;

        if (isSpeaking !== speaking) {
          if (isSpeaking) {
            speaking = true;
            silenceFrames = 0;
            this.onSpeaking?.(true);
            this.socket.emit('audio:speaking', { speaking: true });
          } else {
            silenceFrames++;
            if (silenceFrames > 8) { // ~240ms de silêncio
              speaking = false;
              this.onSpeaking?.(false);
              this.socket.emit('audio:speaking', { speaking: false });
            }
          }
        } else if (!isSpeaking) {
          silenceFrames = Math.min(silenceFrames + 1, 999);
        }
        this.vadTimer = requestAnimationFrame(check);
      };
      check();
    } catch (err) {
      console.warn('[WebRTC] VAD init error:', err.message);
    }
  }

  // ── Conectar com peers ──────────────────────────────────
  async connectToPeers(peers) {
    for (const peerId of peers) {
      await this._createOffer(peerId);
    }
  }

  async _createOffer(peerId) {
    const pc = this._createPC(peerId);
    try {
      const offer  = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('rtc:offer', { to: peerId, offer });
      console.log(`[WebRTC] Offer enviado para ${peerId}`);
    } catch (err) {
      console.error('[WebRTC] createOffer error:', err.message);
    }
  }

  _createPC(peerId) {
    if (this.peers.has(peerId)) this.peers.get(peerId).close();

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers.set(peerId, pc);

    // Adiciona faixas locais
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    // ICE candidates
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('rtc:ice', { to: peerId, candidate });
      }
    };

    // Receber áudio remoto
    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      let audio = document.getElementById(`audio-${peerId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id    = `audio-${peerId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = stream;
      audio.muted = this.deafOn;
      console.log(`[WebRTC] Áudio recebido de ${peerId}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        pc.restartIce();
      }
    };

    return pc;
  }

  // ── Eventos Socket ──────────────────────────────────────
  _bindSocketEvents() {
    this.socket.on('rtc:offer', async ({ from, offer }) => {
      const pc = this._createPC(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('rtc:answer', { to: from, answer });
        console.log(`[WebRTC] Answer enviado para ${from}`);
      } catch (err) {
        console.error('[WebRTC] answer error:', err.message);
      }
    });

    this.socket.on('rtc:answer', async ({ from, answer }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('[WebRTC] setRemoteDescription error:', err.message);
      }
    });

    this.socket.on('rtc:ice', async ({ from, candidate }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[WebRTC] addIceCandidate:', err.message);
      }
    });

    this.socket.on('voice:peer:left', ({ socketId }) => {
      this._removePeer(socketId);
    });
  }

  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) { pc.close(); this.peers.delete(peerId); }
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) audio.remove();
    console.log(`[WebRTC] Peer removido: ${peerId}`);
  }

  // ── Toggle mic ──────────────────────────────────────────
  setMic(enabled) {
    this.micOn = enabled;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
    }
  }

  // ── Toggle deafen ───────────────────────────────────────
  setDeaf(deafed) {
    this.deafOn = deafed;
    document.querySelectorAll('[id^="audio-"]').forEach(a => (a.muted = deafed));
  }

  // ── Trocar microfone ────────────────────────────────────
  async changeMic(deviceId) {
    await this._stopLocal();
    await this.initMic(deviceId);
    // Re-adiciona tracks em todos peers
    this.peers.forEach(async (pc) => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender && this.localStream) {
        const newTrack = this.localStream.getAudioTracks()[0];
        if (newTrack) await sender.replaceTrack(newTrack);
      }
    });
  }

  // ── Cleanup ─────────────────────────────────────────────
  async disconnect() {
    if (this.vadTimer) cancelAnimationFrame(this.vadTimer);
    if (this.audioContext) await this.audioContext.close().catch(() => {});
    await this._stopLocal();
    this.peers.forEach((pc, id) => this._removePeer(id));
    this.peers.clear();
    console.log('[WebRTC] Desconectado');
  }

  async _stopLocal() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  }

  // ── Listar dispositivos ─────────────────────────────────
  static async getDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }); // pede permissão
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs:  devices.filter(d => d.kind === 'audioinput'),
        outputs: devices.filter(d => d.kind === 'audiooutput'),
      };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }
}

window.WebRTCManager = WebRTCManager;