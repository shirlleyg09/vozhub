/**
 * VozHub — WebRTC Manager v2
 * - Noise reduction via Web Audio API (filtros reais)
 * - Volume por usuário (igual Discord)
 * - Controle de ganho do microfone funcional
 * - VAD melhorado
 */

class WebRTCManager {
  constructor(socket) {
    this.socket      = socket;
    this.peers       = new Map();   // peerId -> { pc, gainNode, audioEl }
    this.localStream = null;
    this.audioCtx    = null;
    this.analyser    = null;
    this.micOn       = true;
    this.deafOn      = false;
    this.vadTimer    = null;
    this.onSpeaking  = null;
    this._micGain    = null;
    this._peerVolumes = new Map(); // peerId -> volume 0~2

    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    };
    this._bindSocketEvents();
  }

  _getCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  async initMic(deviceId = null) {
    try {
      const constraints = {
        audio: {
          deviceId:         deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  false,
          sampleRate:       48000,
          channelCount:     1,
        },
        video: false,
      };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this._buildAudioChain();
      console.log('[WebRTC] Microfone capturado + pipeline de ruído ativo');
      return true;
    } catch (err) {
      console.error('[WebRTC] Erro mic:', err.message);
      return false;
    }
  }

  // Pipeline: source → highpass → lowpass → compressor → gain → analyser + destino processado
  _buildAudioChain() {
    if (!this.localStream) return;
    const ctx = this._getCtx();
    const source = ctx.createMediaStreamSource(this.localStream);

    // Highpass: remove hum/ruído baixo
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;

    // Lowpass: remove chiado alto
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 8000; lp.Q.value = 0.7;

    // Compressor: iguala volume, reduz picos
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 10;
    comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;

    // Gain: controle manual
    this._micGain = ctx.createGain();
    this._micGain.gain.value = 1.0;

    // Analyser: VAD
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;

    // Destino processado (stream que vai para os peers)
    const dest = ctx.createMediaStreamDestination();

    source.connect(hp).connect(lp).connect(comp).connect(this._micGain);
    this._micGain.connect(this.analyser);
    this._micGain.connect(dest);

    // Substitui track original pelo stream processado
    const processed = dest.stream.getAudioTracks()[0];
    if (processed) {
      const old = this.localStream.getAudioTracks()[0];
      if (old) { this.localStream.removeTrack(old); old.stop(); }
      this.localStream.addTrack(processed);
    }

    this._startVAD();
  }

  _startVAD() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    let speaking = false, silence = 0;
    const check = () => {
      this.analyser.getByteFrequencyData(data);
      const s = Math.floor(300  / 24000 * data.length);
      const e = Math.floor(3400 / 24000 * data.length);
      let sum = 0;
      for (let i = s; i < e; i++) sum += data[i];
      const avg = sum / (e - s);
      const isSp = avg > 20 && this.micOn;
      if (isSp && !speaking) {
        speaking = true; silence = 0;
        this.onSpeaking?.(true); this.socket.emit('audio:speaking', { speaking: true });
      } else if (!isSp && speaking) {
        if (++silence > 10) {
          speaking = false;
          this.onSpeaking?.(false); this.socket.emit('audio:speaking', { speaking: false });
        }
      } else if (!isSp) silence = Math.min(silence + 1, 999);
      this.vadTimer = requestAnimationFrame(check);
    };
    check();
  }

  setMicVolume(value) {
    const v = Math.max(0, Math.min(2, value));
    if (this._micGain && this.audioCtx) {
      this._micGain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.02);
      console.log('[WebRTC] Mic volume:', v);
    }
  }

  setPeerVolume(peerId, volume) {
    const v = Math.max(0, Math.min(2, volume));
    this._peerVolumes.set(peerId, v);
    const peer = this.peers.get(peerId);
    if (peer?.gainNode && this.audioCtx) {
      peer.gainNode.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.05);
    }
    if (peer?.audioEl) peer.audioEl.volume = Math.min(1, v);
    console.log(`[WebRTC] Volume de ${peerId}: ${Math.round(v*100)}%`);
  }

  getPeerVolume(peerId) { return this._peerVolumes.get(peerId) ?? 1.0; }

  async connectToPeers(peers) {
    for (const peerId of peers) await this._createOffer(peerId);
  }

  async _createOffer(peerId) {
    const pc = this._createPC(peerId);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('rtc:offer', { to: peerId, offer });
    } catch (err) { console.error('[WebRTC] offer error:', err.message); }
  }

  _createPC(peerId) {
    const ex = this.peers.get(peerId);
    if (ex?.pc) ex.pc.close();

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers.set(peerId, { pc, gainNode: null, audioEl: null });

    // Usa o stream processado se disponível, senão usa o original
    const streamToSend = this._processedStream || this.localStream;
    if (streamToSend) {
      streamToSend.getTracks().forEach(t => pc.addTrack(t, streamToSend));
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('rtc:ice', { to: peerId, candidate });
    };

    pc.ontrack = ({ streams, track }) => {
      const stream = streams[0]; if (!stream) return;

      // Verifica se é vídeo (compartilhamento de tela)
      if (track.kind === 'video') {
        console.log(`[WebRTC] Vídeo/tela recebido de ${peerId}`);
        // Notifica o app para exibir o vídeo
        if (typeof window.onScreenTrack === 'function') {
          window.onScreenTrack(peerId, stream);
        }
        return;
      }

      // Áudio normal de voz
      let audio = document.getElementById(`audio-${peerId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${peerId}`; audio.autoplay = true;
        document.body.appendChild(audio);
      }
      try {
        const ctx  = this._getCtx();
        const src  = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = this.deafOn ? 0 : (this._peerVolumes.get(peerId) ?? 1.0);
        src.connect(gain).connect(ctx.destination);
        const peer = this.peers.get(peerId);
        if (peer) { peer.gainNode = gain; peer.audioEl = audio; }
        audio.muted = true;
        audio.srcObject = stream;
      } catch {
        audio.srcObject = stream;
        audio.volume = Math.min(1, this._peerVolumes.get(peerId) ?? 1.0);
        audio.muted  = this.deafOn;
      }
      console.log(`[WebRTC] Áudio de ${peerId}`);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    return pc;
  }

  _bindSocketEvents() {
    this.socket.on('rtc:offer', async ({ from, offer }) => {
      const pc = this._createPC(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this.socket.emit('rtc:answer', { to: from, answer: ans });
      } catch (err) { console.error('[WebRTC] answer error:', err.message); }
    });

    this.socket.on('rtc:answer', async ({ from, answer }) => {
      const peer = this.peers.get(from); if (!peer?.pc) return;
      try { await peer.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch {}
    });

    this.socket.on('rtc:ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from); if (!peer?.pc) return;
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    });

    this.socket.on('voice:peer:left', ({ socketId }) => this._removePeer(socketId));
  }

  _removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer?.pc) peer.pc.close();
    this.peers.delete(peerId);
    document.getElementById(`audio-${peerId}`)?.remove();
  }

  setMic(enabled) {
    this.micOn = enabled;
    this.localStream?.getAudioTracks().forEach(t => t.enabled = enabled);
  }

  setDeaf(deafed) {
    this.deafOn = deafed;
    this.peers.forEach((peer, peerId) => {
      if (peer.gainNode && this.audioCtx) {
        const vol = deafed ? 0 : (this._peerVolumes.get(peerId) ?? 1.0);
        peer.gainNode.gain.setTargetAtTime(vol, this.audioCtx.currentTime, 0.05);
      }
      if (peer.audioEl) peer.audioEl.muted = deafed;
    });
  }

  async changeMic(deviceId) {
    if (this.vadTimer) cancelAnimationFrame(this.vadTimer);
    this.localStream?.getTracks().forEach(t => t.stop());
    this._processedStream = null;
    await this.initMic(deviceId);
    const streamToSend = this._processedStream || this.localStream;
    this.peers.forEach(async (peer) => {
      const sender = peer.pc?.getSenders().find(s => s.track?.kind === 'audio');
      const newTrack = streamToSend?.getAudioTracks()[0];
      if (sender && newTrack) await sender.replaceTrack(newTrack).catch(() => {});
    });
  }

  async disconnect() {
    if (this.vadTimer) cancelAnimationFrame(this.vadTimer);
    await this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.peers.forEach((_, id) => this._removePeer(id));
    this.peers.clear();
  }

  static async getDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const devs = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs:  devs.filter(d => d.kind === 'audioinput'),
        outputs: devs.filter(d => d.kind === 'audiooutput'),
      };
    } catch { return { inputs: [], outputs: [] }; }
  }
}

window.WebRTCManager = WebRTCManager;