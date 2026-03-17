/**
 * VozHub — Screen Share Manager
 * Abordagem: peer connections dedicadas criadas no momento do share
 * Quem compartilha → cria offer para cada pessoa no canal
 * Quem entra depois → recebe offer automaticamente via 'screen:join'
 */

class ScreenShare {
  constructor(socket) {
    this.socket    = socket;
    this.stream    = null;
    this.sharing   = false;
    this.pcs       = new Map(); // peerId -> RTCPeerConnection
    this.iceConfig = { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]};
    this._bindEvents();
  }

  // ── Iniciar compartilhamento ─────────────────────────
  async start() {
    if (this.sharing) { this.stop(); return; }
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 }, cursor: 'always' },
        audio: true,
      });
      this.sharing = true;
      this._updateBtn(true);
      this.socket.emit('screen:start');
      toast('🖥️ Compartilhando tela para todos no canal');
      this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());
      console.log('[Screen] Stream capturado, aguardando peers...');
    } catch(e) {
      if (e.name !== 'NotAllowedError') toast('❌ Erro: ' + e.message);
    }
  }

  // ── Parar ────────────────────────────────────────────
  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.pcs.forEach(pc => pc.close());
    this.pcs.clear();
    this.sharing = false;
    this._updateBtn(false);
    this.socket.emit('screen:stop');
    document.getElementById('screen-overlay').style.display = 'none';
    toast('🖥️ Compartilhamento encerrado');
  }

  // ── Cria offer para um peer (quem está recebendo) ────
  async _offerTo(peerId) {
    if (!this.stream) return;
    const pc = new RTCPeerConnection(this.iceConfig);
    this.pcs.set(peerId, pc);
    this.stream.getTracks().forEach(t => pc.addTrack(t, this.stream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('screen:ice', { to: peerId, candidate });
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('screen:offer', { to: peerId, offer });
      console.log('[Screen] Offer enviado para', peerId);
    } catch(e) { console.error('[Screen] offer error:', e); }
  }

  // ── Eventos Socket ────────────────────────────────────
  _bindEvents() {
    // Servidor avisa quem está no canal quando compartilhamento começa
    this.socket.on('screen:peers', ({ peers }) => {
      console.log('[Screen] Peers para enviar stream:', peers);
      peers.forEach(p => this._offerTo(p));
    });

    // Novo usuário entrou no canal enquanto compartilha
    this.socket.on('screen:new_peer', ({ peerId }) => {
      if (this.sharing) this._offerTo(peerId);
    });

    // Recebe offer (sou o espectador)
    this.socket.on('screen:offer', async ({ from, offer }) => {
      console.log('[Screen] Offer recebido de', from);
      const pc = new RTCPeerConnection(this.iceConfig);
      this.pcs.set(from, pc);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.socket.emit('screen:ice', { to: from, candidate });
      };

      pc.ontrack = ({ streams, track }) => {
        if (track.kind !== 'video') return;
        console.log('[Screen] Stream de vídeo recebido!');
        this._showVideo(from, streams[0]);
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('screen:answer', { to: from, answer });
      } catch(e) { console.error('[Screen] answer error:', e); }
    });

    // Recebe answer (sou quem compartilha)
    this.socket.on('screen:answer', async ({ from, answer }) => {
      const pc = this.pcs.get(from); if (!pc) return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
      catch(e) { console.error('[Screen] setRemote error:', e); }
    });

    // ICE candidates
    this.socket.on('screen:ice', async ({ from, candidate }) => {
      const pc = this.pcs.get(from); if (!pc) return;
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch {}
    });

    // Alguém começou a compartilhar (sou espectador)
    this.socket.on('screen:start', ({ socketId, name }) => {
      toast(`🖥️ ${name} compartilhou a tela`);
      const overlay = document.getElementById('screen-overlay');
      const title   = document.getElementById('screen-title');
      const body    = document.getElementById('screen-body');
      if (title) title.textContent = `🖥️ Tela de ${name}`;
      if (body)  body.innerHTML = `<div class="screen-empty">⏳ Conectando ao stream de ${name}...</div>`;
      if (overlay) overlay.style.display = 'flex';
    });

    // Compartilhamento encerrou
    this.socket.on('screen:stop', ({ socketId, name }) => {
      const pc = this.pcs.get(socketId);
      if (pc) { pc.close(); this.pcs.delete(socketId); }
      document.getElementById(`screen-vid-${socketId}`)?.remove();
      const body = document.getElementById('screen-body');
      if (body && !body.querySelector('video')) {
        document.getElementById('screen-overlay').style.display = 'none';
        toast(`🖥️ ${name || 'Usuário'} encerrou o compartilhamento`);
      }
    });
  }

  // ── Exibe vídeo recebido ──────────────────────────────
  _showVideo(peerId, stream) {
    const body = document.getElementById('screen-body'); if (!body) return;
    body.innerHTML = ''; // limpa loading
    let vid = document.getElementById(`screen-vid-${peerId}`);
    if (!vid) {
      vid = document.createElement('video');
      vid.id        = `screen-vid-${peerId}`;
      vid.className = 'screen-video';
      vid.autoplay  = true;
      vid.controls  = true;
      vid.playsInline = true;
      vid.muted     = false;
      body.appendChild(vid);
    }
    vid.srcObject = stream;
    vid.play().catch(() => {
      // Autoplay bloqueado — mostra botão
      body.insertAdjacentHTML('beforeend',
        `<button class="stg-btn p" style="margin-top:12px" onclick="document.getElementById('screen-vid-${peerId}').play()">▶ Clique para ver</button>`
      );
    });
    document.getElementById('screen-overlay').style.display = 'flex';
  }

  // ── Atualiza botão ────────────────────────────────────
  _updateBtn(sharing) {
    const btn = document.getElementById('screen-btn');
    if (!btn) return;
    if (sharing) {
      btn.textContent = '🔴 Parar tela';
      btn.classList.add('active');
    } else {
      btn.textContent = '🖥️ Compartilhar tela';
      btn.classList.remove('active');
    }
  }
}

window.ScreenShare = ScreenShare;