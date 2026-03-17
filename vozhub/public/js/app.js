/**
 * VozHub — App v3.2
 * Correções: logout reposicionado, mic volume vertical, reconexão estável,
 * YouTube/SoundCloud/Rádio funcionando, formatação corrigida
 */

const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});
let rtc = null;

const S = {
  me: null, servers: [], aSrv: 0, aCh: 0,
  connected: false, micOn: true, deafOn: false,
  localMuted: false, music: null, users: [],
  sources: { radio: true, mp3: true, url: true, soundcloud: false, youtube: false },
};

/* ── Sons (Web Audio API) ──────────────────────────────── */
let _actx = null;
function getACtx() {
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
  if (_actx.state === 'suspended') _actx.resume();
  return _actx;
}
['click','touchstart','keydown'].forEach(ev =>
  document.addEventListener(ev, () => {
    getACtx();
    window._botAudio?.unlock();
  }, { once: true })
);

function playSound(type) {
  try {
    const ctx = getACtx();
    if (ctx.state === 'suspended') { ctx.resume().then(() => playSound(type)); return; }
    const g = ctx.createGain(); g.connect(ctx.destination);
    if (type === 'join') {
      [440, 660].forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq; o.connect(g);
        g.gain.setValueAtTime(0, ctx.currentTime + i*.18);
        g.gain.linearRampToValueAtTime(.2, ctx.currentTime + i*.18 + .02);
        g.gain.linearRampToValueAtTime(0,  ctx.currentTime + i*.18 + .22);
        o.start(ctx.currentTime + i*.18); o.stop(ctx.currentTime + i*.18 + .25);
      });
    } else {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(520, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(300, ctx.currentTime + .3);
      o.connect(g);
      g.gain.setValueAtTime(.18, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + .35);
      o.start(); o.stop(ctx.currentTime + .4);
    }
  } catch(e) { console.warn('sound:', e.message); }
}

/* ── Sessão persistente ────────────────────────────────── */
const saveSession  = n => { try { localStorage.setItem('vozhub_name', n); } catch {} };
const clearSession = () => { try { localStorage.removeItem('vozhub_name'); } catch {} };
const getSaved     = () => { try { return localStorage.getItem('vozhub_name') || ''; } catch { return ''; } };

/* ── Utils ─────────────────────────────────────────────── */
const AVC = ['av-b','av-v','av-c','av-e','av-a','av-r','av-t','av-l'];
const avc = n => { let h=0; for(const c of n) h=(h+c.charCodeAt(0))%AVC.length; return AVC[h]; };
const ini = n => (n||'?')[0].toUpperCase();
const fmt = s => { s=Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; };
const chKey  = (s,c) => `${s}::${c}`;
const curKey = () => { const srv=S.servers[S.aSrv],ch=srv?.channels?.[S.aCh]; return srv&&ch?chKey(srv.id,ch.id):null; };

let toastTmr;
function toast(m) {
  const el = document.getElementById('toast');
  el.textContent = m; el.classList.add('show');
  clearTimeout(toastTmr); toastTmr = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Conexão ───────────────────────────────────────────── */
let _appReady = false;

socket.on('connect', () => {
  console.log('[Socket] conectado:', socket.id);
  const saved = getSaved();
  // Se já estava logado, re-envia join:app automaticamente (reconexão)
  if (_appReady && S.me) {
    socket.emit('join:app', { name: S.me.name });
    if (S.connected) {
      const srv = S.servers[S.aSrv], ch = srv?.channels?.[S.aCh];
      if (srv && ch) socket.emit('voice:join', { srvId: srv.id, chId: ch.id });
    }
    toast('🔄 Reconectado!');
    return;
  }
  // Primeira vez
  const st = document.getElementById('conn-status');
  if (saved) {
    document.getElementById('ni').value = saved;
    st.textContent = `✅ Bem-vindo de volta, ${saved}!`; st.className = 'conn-status ok';
    document.getElementById('login-btn').disabled = false;
    setTimeout(() => doLogin(), 350);
  } else {
    st.textContent = '✅ Conectado! Digite seu nome.'; st.className = 'conn-status ok';
    document.getElementById('login-btn').disabled = false;
  }
});

socket.on('connect_error', () => {
  if (!_appReady) {
    const st = document.getElementById('conn-status');
    st.textContent = '❌ Sem conexão com o servidor.'; st.className = 'conn-status err';
    document.getElementById('login-btn').disabled = false;
  }
});

socket.on('disconnect', reason => {
  console.log('[Socket] desconectado:', reason);
  if (_appReady) toast('⚠️ Conexão perdida. Reconectando...');
});

/* ── Login ─────────────────────────────────────────────── */
document.getElementById('ni').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const v = document.getElementById('ni').value.trim(); if (!v) return;
  S.me = { socketId: socket.id, name: v };
  saveSession(v);
  socket.emit('join:app', { name: v });
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('up-name').textContent = v;
  document.getElementById('up-tag').textContent  = '#' + String(Math.floor(Math.random()*9000)+1000);
  const av = document.getElementById('up-av');
  av.className = 'up-av ' + avc(v); av.innerHTML = ini(v) + '<div class="up-dot"></div>';
  _appReady = true;
  rtc = new WebRTCManager(socket);
  rtc.onSpeaking = sp => socket.emit('audio:speaking', { speaking: sp });
  await rtc.initMic();

  // Bot de áudio server-side (igual Discord)
  window._botAudio = new BotAudioPlayer(socket);
  fetch('/api/sources').then(r => r.json()).then(src => { S.sources = src; updateSourceBadges(); }).catch(() => {});
}

function logout() {
  clearSession(); _appReady = false;
  if (S.connected) { socket.emit('voice:leave'); rtc?.disconnect(); }
  setTimeout(() => window.location.reload(), 200);
}

/* ── Eventos servidor ──────────────────────────────────── */
socket.on('app:ready', ({ socketId, servers }) => {
  S.me.socketId = socketId; S.servers = servers; rAll();
});

socket.on('channel:users', ({ key, users, music }) => {
  if (key !== curKey()) return;
  S.users = users; S.music = music;
  rChannelPanel(); rStage(); rUsers(); updateMusicUI();
  const cnt = music?.queue?.length || 0;
  const b = document.getElementById('q-count-badge');
  b.textContent = cnt; b.style.display = cnt ? 'inline' : 'none';
});

socket.on('user:speaking', ({ socketId, speaking }) => {
  const card = document.querySelector(`[data-sid="${socketId}"]`); if (!card) return;
  card.classList.toggle('speaking', speaking);
  const st = card.querySelector('.pc-st'); if (!st) return;
  st.className = 'pc-st'+(speaking?' sp':''); st.textContent = speaking?'🟢 Falando':'⬜ Conectado';
});

socket.on('music:state', state => {
  S.music = state; updateMusicUI();
  const cnt = state?.queue?.length || 0;
  const b = document.getElementById('q-count-badge');
  b.textContent = cnt; b.style.display = cnt ? 'inline' : 'none';
  if (document.getElementById('mo-queue').classList.contains('open')) renderQueue();
});

socket.on('music:added', ({ track, requestedBy, playingNow, position }) => {
  if (playingNow) {
    toast(`▶️ Tocando agora: ${track.title}`);
  } else {
    toast(`📋 #${position} na fila: ${track.title} — por ${requestedBy}`);
  }
  if (document.getElementById('mo-queue').classList.contains('open')) renderQueue();
});
socket.on('music:error',    ({ msg }) => toast('❌ ' + msg));
socket.on('music:searching', ({ source }) => {
  const id = source === 'soundcloud' ? 'sc-results' : 'yt-results';
  document.getElementById(id).innerHTML = '<div class="search-loading">🔍 Buscando...</div>';
});
socket.on('music:sc:results',      ({ results, error }) => renderSearchResults('sc-results', results, error, 'sc'));
socket.on('music:jamendo:results', ({ results, error }) => renderSearchResults('jm-results', results, error, 'jamendo'));
socket.on('music:yt:results', ({ results, error }) => renderSearchResults('yt-results', results, error, 'yt'));
socket.on('error',  ({ msg }) => toast('❌ ' + msg));
socket.on('kicked', ({ reason }) => { toast('🚫 '+reason); S.connected=false; rtc?.disconnect(); S.users=[]; rAll(); });
socket.on('voice:peers', async ({ peers }) => { if (rtc) await rtc.connectToPeers(peers); });

// Restaura estado da música ao reconectar (fila preservada no servidor)
socket.on('music:restore', ({ state }) => {
  S.music = state;
  updateMusicUI();
  toast('🎵 Fila restaurada!');
});

/* ── Render ────────────────────────────────────────────── */
function rAll() { rServers(); rChannelPanel(); rStage(); rUsers(); }

function rServers() {
  const c = document.getElementById('ss-items'); c.innerHTML = '';
  S.servers.forEach((srv, i) => {
    const b = document.createElement('button');
    b.className = 'ss-btn'+(i===S.aSrv?' active':'');
    b.innerHTML = srv.icon+'<span class="ss-tip">'+srv.name+'</span>';
    b.onclick = () => { S.aSrv=i; S.aCh=0; S.connected=false; rAll(); };
    c.appendChild(b);
  });
}

function rChannelPanel() {
  const srv = S.servers[S.aSrv]; if (!srv) return;
  document.getElementById('ph-icon').textContent = srv.icon;
  document.getElementById('ph-name').textContent = srv.name;
  const sc = document.getElementById('ch-scroll'); sc.innerHTML = '';
  const lbl = document.createElement('div'); lbl.className = 'pc-lbl';
  lbl.innerHTML = 'Canais de Voz <button class="pc-ladd" onclick="toast(\'Em breve!\')">+</button>';
  sc.appendChild(lbl);
  if (S.connected) {
    const bar = document.createElement('div'); bar.className = 'vcb';
    bar.innerHTML = '<div class="vcb-dot"></div><span class="vcb-lbl">Voz conectada</span><button class="vcb-leave" onclick="leaveVoice()">✕ Sair</button>';
    sc.appendChild(bar);
  }
  srv.channels.forEach((ch, i) => {
    const count = i===S.aCh ? S.users.length : (ch.users||[]).length;
    const row = document.createElement('div'); row.className = 'ch-row'+(i===S.aCh?' active':'');
    row.innerHTML = '<span class="ch-icon">🔊</span><span class="ch-name">'+ch.name+'</span>'+(count?'<span class="ch-badge">'+count+'</span>':'');
    row.onclick = () => { S.aCh=i; S.connected=false; rAll(); };
    sc.appendChild(row);
    if (i===S.aCh && S.users.length) {
      S.users.forEach(u => {
        const isMe = u.socketId===S.me?.socketId;
        const m = document.createElement('div'); m.className = 'cvm';
        m.innerHTML = '<div class="cvm-av '+avc(u.name)+'">'+ini(u.name)+'</div>'
          +'<span class="cvm-name">'+u.name+(isMe?' (você)':'')+'</span>'
          +'<div class="cvm-ic">'+(u.speaking?'<span class="cvm-sp">🎤</span>':(!u.micOn?'🔇':''))+'</div>';
        sc.appendChild(m);
      });
    }
  });
}

function rStage() {
  const srv = S.servers[S.aSrv]; if (!srv) return;
  const ch  = srv.channels[S.aCh]; if (!ch) return;
  document.getElementById('tb-ch').textContent   = ch.name;
  document.getElementById('tb-desc').textContent = ch.desc;
  const stage = document.getElementById('stage'); stage.innerHTML = '';
  const members = S.connected ? S.users : (ch.users||[]);
  const ban = document.createElement('div'); ban.className = 'stg-banner';
  ban.innerHTML = `<div class="stg-vis">${srv.icon}</div><div class="stg-info">
    <div class="stg-title">🔊 ${ch.name}</div>
    <div class="stg-sub">${srv.name} · ${ch.desc} · ${members.length} participante${members.length!==1?'s':''}</div>
    <div class="stg-acts">
      ${!S.connected
        ?'<button class="stg-btn p" onclick="joinVoice()">🎤 Entrar no canal</button>'
        :'<button class="stg-btn s" onclick="leaveVoice()">🚪 Sair do canal</button>'}
      <button class="stg-btn s" onclick="copyInvite()">🔗 Convidar</button>
    </div></div>`;
  stage.appendChild(ban);
  if (!members.length) {
    const e = document.createElement('div'); e.className = 'stage-empty';
    e.innerHTML = '<div class="se-icon">🎙️</div><div class="se-title">Canal vazio</div><div class="se-sub">Entre e chame os amigos!</div>';
    stage.appendChild(e); return;
  }
  const sec = document.createElement('div');
  sec.innerHTML = '<div class="sec-hdr"><div class="sec-title">Participantes <span class="sec-cnt">'+members.length+'</span></div></div>';
  const grid = document.createElement('div'); grid.className = 'pg';
  members.forEach(u => {
    const isMe = u.socketId===S.me?.socketId||u.name===S.me?.name;
    const sp   = isMe?(S.micOn&&S.connected):(u.speaking||false);
    const mt   = isMe?!S.micOn:!u.micOn;
    const card = document.createElement('div');
    card.className = 'pc-card'+(sp?' speaking':'')+(isMe?' me':'');
    card.setAttribute('data-sid', u.socketId||'');
    card.innerHTML = `<div class="av-wrap"><div class="pc-av ${avc(u.name)}">${ini(u.name)}</div><div class="sp-ring"></div><div class="av-badge">${mt?'🔇':'🎤'}</div></div>
      <div class="pc-nm">${u.name}${isMe?' (você)':''}</div>
      <div class="pc-st ${sp?'sp':mt?'mt':''}">${sp?'🟢 Falando':mt?'🔇 Mudo':'⬜ Conectado'}</div>
      `;
    // Volume por usuário: clique direito no desktop, botão 🔊 visível no hover
    if (!isMe && u.socketId) {
      // Desktop: clique direito
      card.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        openPeerVolume(u.socketId, u.name, ev);
      });
      // Mobile/touch: botão que aparece no card
      const volBtn = document.createElement('button');
      volBtn.className = 'pc-user-vol-btn';
      volBtn.textContent = '🔊';
      volBtn.title = 'Ajustar volume';
      volBtn.onclick = ev => { ev.stopPropagation(); openPeerVolume(u.socketId, u.name, ev); };
      card.appendChild(volBtn);
    }
    grid.appendChild(card);
  });
  sec.appendChild(grid); stage.appendChild(sec);
}

function rUsers() {
  const panel = document.getElementById('pu'); panel.innerHTML = '';
  if (!S.users.length) return;
  const sec = document.createElement('div'); sec.className = 'pu-sec';
  sec.innerHTML = '<div class="pu-lbl">Neste canal — '+S.users.length+'</div>';
  S.users.forEach(u => {
    const isMe = u.socketId===S.me?.socketId||u.name===S.me?.name;
    const r = document.createElement('div'); r.className = 'pu-usr';
    r.innerHTML = `<div class="pu-av ${avc(u.name)} online">${ini(u.name)}</div>
      <div class="pu-info"><div class="pu-nm">${u.name}${isMe?' (você)':''}</div>
      <div class="pu-sub">${u.speaking?'🟢 Falando':'Online'}</div></div>
      <span class="pu-mic">${u.micOn!==false?'🎤':'🔇'}</span>`;
    sec.appendChild(r);
  });
  panel.appendChild(sec);
}

/* ── Voice ─────────────────────────────────────────────── */
async function joinVoice() {
  const srv = S.servers[S.aSrv], ch = srv?.channels?.[S.aCh]; if (!ch) return;
  if (!rtc?.localStream) { const ok = await rtc?.initMic(); if (!ok) { toast('❌ Permita acesso ao microfone'); return; } }
  S.connected = true;
  socket.emit('voice:join', { srvId: srv.id, chId: ch.id });
  playSound('join');
  rAll(); toast('🎤 Conectado a '+ch.name);
}

function leaveVoice() {
  S.connected = false; socket.emit('voice:leave');
  playSound('leave');
  rtc?.disconnect(); S.users = []; rAll(); toast('🚪 Saiu do canal');
}

/* ── Volume por usuário (igual Discord) ─────────────── */
function openPeerVolume(peerId, name, event) {
  event?.stopPropagation?.();
  document.getElementById('peer-vol-popup')?.remove();

  const currentVol = Math.round((rtc?.getPeerVolume(peerId) ?? 1.0) * 100);
  const popup = document.createElement('div');
  popup.id = 'peer-vol-popup';
  popup.className = 'peer-vol-popup';
  popup.innerHTML = `
    <div class="pvp-title">🔊 Volume — ${name}</div>
    <div class="pvp-row">
      <span class="pvp-min">0%</span>
      <input type="range" class="pvp-slider" min="0" max="200" value="${currentVol}" id="pvp-range-${peerId}"
        oninput="setPeerVol('${peerId}', this.value)">
      <span class="pvp-max">200%</span>
    </div>
    <div class="pvp-val" id="pvp-val-${peerId}">${currentVol}%</div>
    <button class="pvp-close" onclick="document.getElementById('peer-vol-popup')?.remove()">Fechar</button>`;

  // Posiciona: tenta perto do clique, garante que não sai da tela
  const x = Math.min((event?.clientX || 200), window.innerWidth  - 220);
  const y = Math.max((event?.clientY || 200) - 180, 10);
  popup.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:600`;
  document.body.appendChild(popup);

  setTimeout(() => {
    document.addEventListener('click', e => {
      if (!e.target.closest('#peer-vol-popup') && !e.target.closest('.pc-user-vol-btn')) {
        document.getElementById('peer-vol-popup')?.remove();
      }
    }, { once: true });
  }, 150);
}

function setPeerVol(peerId, value) {
  const pct = parseInt(value);
  const valEl = document.getElementById('pvp-val-' + peerId);
  if (valEl) valEl.textContent = pct + '%';
  rtc?.setPeerVolume(peerId, pct / 100);
}



function toggleMicVol() {
  const p = document.getElementById('mic-vol-panel');
  if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
}

function toggleMicVolSidebar() {
  const overlay = document.getElementById('mic-vol-overlay');
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
}

function setMicVolume(val) {
  const pct = parseInt(val);
  document.getElementById('mic-vol-val').textContent = pct + '%';
  if (rtc) {
    rtc.setMicVolume(pct / 100);
    console.log('[App] Mic volume set to', pct + '%');
  } else {
    console.warn('[App] rtc não inicializado ainda');
  }
}

function toggleMic() {
  S.micOn = !S.micOn; rtc?.setMic(S.micOn);
  const b = document.getElementById('mic-btn');
  b.textContent = S.micOn?'🎤':'🔇'; b.classList.toggle('red', !S.micOn);
  socket.emit('audio:toggle', { micOn: S.micOn });
  toast(S.micOn?'🎤 Microfone ativado':'🔇 Microfone desativado');
  rStage();
}

function toggleDeaf() {
  S.deafOn = !S.deafOn;
  rtc?.setDeaf(S.deafOn);
  // Também silencia a música quando surdo
  const audio = document.getElementById('music-audio');
  if (audio) audio.muted = S.deafOn;
  window._botAudio?.mute(S.deafOn);
  const b = document.getElementById('deaf-btn');
  b.textContent = S.deafOn ? '🔇' : '🔊';
  b.classList.toggle('red', S.deafOn);
  socket.emit('audio:toggle', { deafOn: S.deafOn });
  toast(S.deafOn ? '🔇 Som desativado (você não ouve ninguém)' : '🔊 Som ativado');
}

document.addEventListener('keydown', e => {
  if (e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if (e.key==='m'||e.key==='M') toggleMic();
  if (e.key==='d'||e.key==='D') toggleDeaf();
});

/* ── Music Bar ─────────────────────────────────────────── */
// Controles de música — sem delay, emite direto
function sendMusicEv(ev, data={}) {
  if (!S.connected) { toast('⚠️ Entre em um canal de voz primeiro'); return; }
  socket.emit(ev, data);
}

function togglePlay() {
  if (!S.connected) { toast('⚠️ Entre em um canal de voz primeiro'); return; }
  const m = S.music;
  if (!m?.queue?.length) { openMusicPanel(); return; }
  sendMusicEv(m.playing&&!m.paused ? 'music:pause' : 'music:resume');
}

let progIv = null, localProg = 0;

function updateMusicUI() {
  const m     = S.music;
  const audio = document.getElementById('music-audio');
  const th    = document.getElementById('mb-th');
  if (!m?.track) {
    document.getElementById('mb-ttl').textContent  = 'Nenhuma faixa tocando';
    document.getElementById('mb-art').textContent  = '🤖 Bot colaborativo · aguardando';
    th.innerHTML = '🎵'; th.className = 'mb-th';
    document.getElementById('mb-fill').style.width = '0%';
    document.getElementById('mb-cur').textContent  = '0:00';
    document.getElementById('mb-dur').textContent  = '0:00';
    document.getElementById('play-btn').textContent = '▶';
    clearInterval(progIv); audio.pause(); return;
  }
  const t = m.track;
  document.getElementById('mb-ttl').textContent   = t.title;
  document.getElementById('mb-art').textContent   = (t.artist||'') + (t.requestedBy ? ' · por '+t.requestedBy : '');
  document.getElementById('mb-dur').textContent   = t.isLive ? '🔴 Ao vivo' : fmt(t.duration||0);
  document.getElementById('play-btn').textContent = (m.playing && !m.paused) ? '⏸' : '▶';
  document.getElementById('shuf-btn').style.color = m.shuffled ? 'var(--green)' : '';
  if (t.thumbnail) {
    th.innerHTML = `<img src="${t.thumbnail}" alt="" onerror="this.parentElement.textContent='${t.emoji||'🎵'}'">`;
  } else { th.textContent = t.emoji||'🎵'; }
  th.className = 'mb-th'+(m.playing&&!m.paused?(t.type==='soundcloud'?' playing-sc':' playing'):'');
  localProg = m.progress||0; updProg();
  clearInterval(progIv);
  if (m.playing&&!m.paused&&t.duration>0) {
    progIv = setInterval(() => { localProg=Math.min(localProg+.25, t.duration); updProg(); }, 250);
  }
  // Tocar áudio — rádios e links tocam direto no cliente
  const streamUrl = t.streamUrl || t.url || '';
  const isDirectPlay = t.type === 'radio' || t.type === 'url' || t.type === 'mp3';

  if (m.playing && !m.paused && streamUrl && isDirectPlay) {
    if (audio.dataset.url !== streamUrl) {
      // Para imediatamente o áudio anterior
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      // Inicia novo stream
      audio.dataset.url = streamUrl;
      audio.preload     = t.isLive ? 'none' : 'auto';
      audio.src         = streamUrl;
      audio.volume      = Math.min(1, parseInt(document.getElementById('vol-sl').value) / 100);
      audio.muted       = S.localMuted;
      audio.play().catch(e => {
        if (e.name === 'NotAllowedError') {
          toast('🔊 Clique aqui para ativar o áudio');
          document.addEventListener('click', () => audio.play().catch(()=>{}), { once: true });
        }
      });
    }
  } else if (!m.playing || m.paused) {
    // Para imediatamente — sem delay
    audio.pause();
    if (!m.playing) {
      audio.removeAttribute('src');
      audio.dataset.url = '';
      audio.load();
    }
  }
}

function updProg() {
  const m = S.music; if (!m?.track?.duration) return;
  const pct = Math.min(100, (localProg/m.track.duration)*100);
  document.getElementById('mb-fill').style.width = pct+'%';
  document.getElementById('mb-cur').textContent  = fmt(localProg);
}

function setLocalVol(v) {
  const vol = parseInt(v) / 100;
  // Controla elemento audio (rádios diretas)
  const audio = document.getElementById('music-audio');
  if (audio) { audio.volume = Math.min(1, vol); audio.muted = (vol === 0); }
  // Controla BotAudioPlayer (YouTube/SC via servidor)
  window._botAudio?.setVolume(vol);
  // Atualiza ícone
  document.getElementById('vol-ic').textContent = vol === 0 ? '🔇' : vol < 0.4 ? '🔉' : '🔈';
  // Se aumentou volume, desmuta
  if (vol > 0) S.localMuted = false;
}

function toggleMuteLocal() {
  S.localMuted = !S.localMuted;
  document.getElementById('vol-sl').value = S.localMuted?0:80;
  setLocalVol(S.localMuted?0:80);
  window._botAudio?.mute(S.localMuted);
  toast(S.localMuted?'🔇 Música silenciada':'🔈 Música ativada');
}

/* ── Painel de música ──────────────────────────────────── */
let RADIOS = [];

function openMusicPanel() {
  if (!S.connected) { toast('⚠️ Entre em um canal de voz primeiro'); return; }
  openMo('mo-music');
  if (!RADIOS.length) loadRadios();
  updateSourceBadges();
}

async function loadRadios() {
  try { const r = await fetch('/api/radios'); RADIOS = await r.json(); }
  catch { RADIOS = []; }
  renderRadios();
}

function updateSourceBadges() {
  const ytSt = document.getElementById('yt-status');
  ytSt.className = 'source-status ok';
  ytSt.textContent = '✅ YouTube — busque pelo nome ou cole um link';
}

function switchTab(btn, tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.mtab').forEach(t => t.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  btn.classList.add('active');
  if (tabId==='tab-radio') renderRadios();
}

/* ── Rádio ─────────────────────────────────────────────── */
function renderRadios(filter='') {
  const grid = document.getElementById('radio-grid'); grid.innerHTML = '';
  const cur  = S.music?.track?.url || '';
  const list = filter
    ? RADIOS.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()) || r.genre.toLowerCase().includes(filter.toLowerCase()))
    : RADIOS;
  if (!list.length) {
    grid.innerHTML = '<div style="color:var(--t3);padding:20px;text-align:center">Nenhuma rádio encontrada</div>';
    return;
  }
  list.forEach(r => {
    const card = document.createElement('div');
    card.className = 'radio-card'+(cur===r.url?' playing':'');
    card.innerHTML = `<span class="rc-emoji">${r.emoji}</span>
      <div class="rc-info">
        <div class="rc-name">${r.name}</div>
        <div class="rc-genre">${r.genre} <span class="rc-live">● AO VIVO</span></div>
      </div>`;
    card.onclick = () => {
      if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
      socket.emit('music:add:radio', { radioId: r.id });
      closeMo('mo-music'); toast('📻 Adicionando: '+r.name);
    };
    grid.appendChild(card);
  });
}

// Busca rádios no Radio Browser ao digitar
let _radioSearchTimer = null;
document.getElementById('radio-filter').addEventListener('input', e => {
  const q = e.target.value.trim();
  clearTimeout(_radioSearchTimer);
  if (!q) { renderRadios(); return; }
  // Filtra locais primeiro (imediato)
  renderRadios(q);
  // Busca no Radio Browser após 600ms
  _radioSearchTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`/api/radios/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.length) {
        // Adiciona resultados que não estão na lista local
        const extra = data.filter(r => !RADIOS.find(l => l.url === r.url));
        if (extra.length) {
          RADIOS = [...RADIOS.filter(r =>
            r.name.toLowerCase().includes(q.toLowerCase()) ||
            r.genre.toLowerCase().includes(q.toLowerCase())
          ), ...extra];
          renderRadios(q);
        }
      }
    } catch {}
  }, 600);
});

/* ── Upload MP3 ────────────────────────────────────────── */
function handleFileSelect(e) { if (e.target.files[0]) uploadFile(e.target.files[0]); }
function handleDrop(e) {
  e.preventDefault(); document.getElementById('upload-zone').classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f && /audio/.test(f.type)) uploadFile(f);
  else toast('❌ Apenas arquivos de áudio');
}

async function uploadFile(file) {
  if (file.size > 30*1024*1024) { toast('❌ Arquivo muito grande (máx 30MB)'); return; }
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  const prog = document.getElementById('upload-progress');
  const bar  = document.getElementById('upload-bar');
  const status = document.getElementById('upload-status');
  prog.style.display = 'block'; bar.style.width = '0%';
  status.textContent = '⬆️ Enviando '+file.name+'...';
  const form = new FormData(); form.append('audio', file);
  const xhr  = new XMLHttpRequest();
  xhr.upload.onprogress = e => { if (e.lengthComputable) bar.style.width=(e.loaded/e.total*100)+'%'; };
  xhr.onload = () => {
    if (xhr.status===200) {
      const res = JSON.parse(xhr.responseText);
      socket.emit('music:add:mp3', { filename:res.filename, originalName:res.originalName, size:res.size });
      status.textContent = '✅ Adicionado à fila!';
      setTimeout(() => { prog.style.display='none'; closeMo('mo-music'); }, 1400);
    } else { status.textContent = '❌ Erro no upload'; }
  };
  xhr.onerror = () => { status.textContent = '❌ Falha na conexão'; };
  xhr.open('POST', '/api/upload'); xhr.send(form);
}

/* ── Link direto ───────────────────────────────────────── */
function addDirectUrl() {
  const url   = document.getElementById('url-in').value.trim();
  const title = document.getElementById('url-title').value.trim();
  if (!url) { toast('❌ Digite uma URL'); return; }
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  socket.emit('music:add:url', { url, title });
  document.getElementById('url-in').value = ''; document.getElementById('url-title').value = '';
  closeMo('mo-music'); toast('🔗 Adicionando link...');
}
document.getElementById('url-in').addEventListener('keydown', e => { if (e.key==='Enter') addDirectUrl(); });

/* ── SoundCloud ────────────────────────────────────────── */
function doSCSearch() {
  const q = document.getElementById('sc-in').value.trim(); if (!q) return;
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  socket.emit('music:search:sc', { query: q });
}
document.getElementById('sc-in').addEventListener('keydown', e => { if (e.key==='Enter') doSCSearch(); });

/* ── Jamendo ───────────────────────────────────────────── */
function doJamendoSearch() {
  const q = document.getElementById('jm-in').value.trim(); if (!q) return;
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  socket.emit('music:search:jamendo', { query: q });
  document.getElementById('jm-results').innerHTML = '<div class="search-loading">🔍 Buscando no Jamendo...</div>';
}
// Listener adicionado via delegação para garantir que o elemento existe
document.addEventListener('keydown', e => {
  if (e.target.id === 'jm-in' && e.key === 'Enter') doJamendoSearch();
});

/* ── YouTube ───────────────────────────────────────────── */
function doYTSearch() {
  const q = document.getElementById('yt-in').value.trim(); if (!q) return;
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  socket.emit('music:search:yt', { query: q });
  document.getElementById('yt-results').innerHTML = '<div class="search-loading">🔍 Buscando no YouTube...</div>';
}
document.getElementById('yt-in').addEventListener('keydown', e => { if (e.key==='Enter') doYTSearch(); });

function renderSearchResults(containerId, results, error, source) {
  const c = document.getElementById(containerId); c.innerHTML = '';
  if (error) {
    const note = document.createElement('div');
    note.className = 'source-status warn'; note.textContent = '⚠️ '+error;
    c.appendChild(note); return;
  }
  if (!results?.length) { c.innerHTML = '<div class="search-loading">Nenhum resultado.</div>'; return; }
  results.forEach(r => {
    const item = document.createElement('div'); item.className = 'search-item';
    const srcEmoji = source==='sc'?'☁️':source==='jamendo'?'🎼':'▶️';
    const srcColor = source==='sc'?'sc':source==='jamendo'?'jm':'';
    item.innerHTML = `
      <div class="si-thumb">${r.thumbnail?`<img src="${r.thumbnail}" alt="">`:(r.emoji||srcEmoji)}</div>
      <div class="si-info">
        <div class="si-title">${r.title}</div>
        <div class="si-meta">${r.artist||''} · ${r.durationFmt||'?'} · ${source==='jamendo'?'🎼 Jamendo (CC)':source==='sc'?'☁️ SoundCloud':'▶️'}</div>
      </div>
      <button class="si-add ${srcColor}">+ Fila</button>`;
    item.querySelector('.si-add').onclick = () => {
      if (source === 'sc') {
        socket.emit('music:add:sc', {
          url: r.url, title: r.title, artist: r.artist,
          duration: r.duration, thumbnail: r.thumbnail,
          streamUrl: r.streamUrl || null,
          clientId:  r.clientId  || null,
        });
        toast(`☁️ Adicionando: ${r.title}`);
      } else if (source === 'jamendo') {
        socket.emit('music:add:jamendo', { streamUrl:r.streamUrl, url:r.url, title:r.title, artist:r.artist, duration:r.duration, thumbnail:r.thumbnail });
        toast(`🎼 Adicionando: ${r.title}`);
      } else {
        socket.emit('music:add:yt', { url:r.url });
        toast(`▶️ Adicionando: ${r.title}`);
      }
      closeMo('mo-music');
    };
    c.appendChild(item);
  });
}

/* ── Fila ──────────────────────────────────────────────── */
function openQueue() { renderQueue(); openMo('mo-queue'); }

function renderQueue() {
  const m    = S.music;
  const list = document.getElementById('q-list');
  const sub  = document.getElementById('q-sub');
  const now  = document.getElementById('q-now-playing');
  list.innerHTML = ''; now.style.display = 'none';
  const queue = m?.queue || [];
  sub.textContent = queue.length+' faixa'+(queue.length!==1?'s':'')+' na fila'+(m?.shuffled?' · 🔀':'');
  document.getElementById('q-shuf-btn').style.color = m?.shuffled?'var(--green)':'';
  if (m?.track) {
    now.style.display = 'flex';
    now.innerHTML = `<span class="qnp-emoji">${m.track.emoji||'🎵'}</span>
      <div class="qnp-info"><div class="qnp-title">${m.track.title}</div>
      <div class="qnp-meta">${m.track.artist||''} · por ${m.track.requestedBy||'?'}</div></div>
      <span class="qnp-badge">${m.paused?'⏸ Pausado':'▶ Tocando'}</span>`;
  }
  if (!queue.length) {
    list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">🎵</div>Fila vazia — adicione músicas!</div>';
    return;
  }
  queue.forEach((t, i) => {
    const isCur = t.isCurrent||i===m.currentIdx;
    const item  = document.createElement('div'); item.className = 'q-item'+(isCur?' current':'');
    item.innerHTML = `<span class="q-pos">${isCur?'▶':i+1}</span>
      <span class="q-emoji">${t.emoji||'🎵'}</span>
      <div class="q-info"><div class="q-title${isCur?' cur':''}">${t.title}</div>
      <div class="q-meta">${t.isLive?'🔴 Ao vivo':fmt(t.duration||0)} · <span class="q-by">por ${t.requestedBy||'?'}</span></div></div>
      <div class="q-actions">
        <button class="q-act" title="Tocar agora">▶</button>
        <button class="q-act del" title="Remover">✕</button>
      </div>`;
    item.querySelectorAll('.q-act')[0].onclick = e => { e.stopPropagation(); sendMusicEv('music:play:at',{index:i}); };
    item.querySelectorAll('.q-act')[1].onclick = e => { e.stopPropagation(); sendMusicEv('music:remove',{index:i}); };
    list.appendChild(item);
  });
}

function confirmClear() {
  if (confirm('Limpar toda a fila?')) { sendMusicEv('music:clear'); renderQueue(); }
}

/* ── Settings ──────────────────────────────────────────── */
async function openSettings() {
  const {inputs,outputs} = await WebRTCManager.getDevices();
  const ms = document.getElementById('mic-select'); ms.innerHTML = '';
  const ss = document.getElementById('spk-select'); ss.innerHTML = '';
  inputs.forEach((d,i)  => { const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Microfone '+(i+1); ms.appendChild(o); });
  outputs.forEach((d,i) => { const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Alto-falante '+(i+1); ss.appendChild(o); });
  if (!inputs.length)  ms.innerHTML='<option>Nenhum microfone</option>';
  if (!outputs.length) ss.innerHTML='<option>Padrão do sistema</option>';
  openMo('mo-settings');
}

async function applySettings() {
  const id = document.getElementById('mic-select').value;
  if (id&&rtc) { await rtc.changeMic(id); toast('✅ Microfone alterado!'); }
  closeMo('mo-settings');
}

/* ── Modals ────────────────────────────────────────────── */
function openMo(id)  { document.getElementById(id).classList.add('open'); }
function closeMo(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.mo').forEach(el => el.addEventListener('click', e => { if(e.target===el) el.classList.remove('open'); }));

function copyInvite() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => toast('🔗 Link copiado!'))
    .catch(() => toast('🔗 Copie o link da barra de endereços!'));
}