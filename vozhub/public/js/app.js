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

// Som de mensagem de chat (beep suave)
function playMsgSound() {
  try {
    const ctx = getACtx(); if (ctx.state === 'suspended') return;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
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
let _appReady   = false;
let _loginType  = 'new';   // new | returning | temp
let _micMeterInterval = null;
let _screen     = null;
let _screenSharing = false;

socket.on('connect', () => {
  console.log('[Socket] conectado:', socket.id);

  // Reconexão — já estava logado
  if (_appReady && S.me) {
    socket.emit('auth:login', {
      name: S.me.name,
      code: S.me.code || '',
      type: S.me.temporary ? 'temp' : (S.me.code ? 'returning' : 'new')
    });
    if (S.connected) {
      const srv = S.servers[S.aSrv], ch = srv?.channels?.[S.aCh];
      if (srv && ch) socket.emit('voice:join', { srvId: srv.id, chId: ch.id });
    }
    toast('🔄 Reconectado!');
    return;
  }

  // Primeira conexão — habilita botão
  const st  = document.getElementById('conn-status');
  const btn = document.getElementById('login-btn');
  const ni  = document.getElementById('ni');
  if (st)  { st.textContent = '✅ Conectado!'; st.className = 'conn-status ok'; }
  if (btn) btn.disabled = false;

  // Auto-fill e auto-login se tiver sessão salva
  const saved     = getSaved();
  const savedCode = localStorage.getItem('vozhub_code') || '';
  if (saved && ni) {
    ni.value = saved;
    if (savedCode) {
      const ci = document.getElementById('ci');
      if (ci) ci.value = savedCode;
      selectLoginType('returning');
    }
    if (st) st.textContent = `✅ Bem-vindo de volta, ${saved}!`;
    setTimeout(() => doLogin(), 400);
  }
});

socket.on('connect_error', (err) => {
  console.warn('[Socket] connect_error:', err?.message);
  const st  = document.getElementById('conn-status');
  const btn = document.getElementById('login-btn');
  if (st)  { st.textContent = '⚠️ Servidor iniciando... aguarde'; st.className = 'conn-status'; }
  if (btn) btn.disabled = false; // Deixa tentar mesmo assim
});

socket.on('disconnect', reason => {
  console.log('[Socket] desconectado:', reason);
  if (_appReady) toast('⚠️ Conexão perdida. Reconectando...');
});

/* ── Login ─────────────────────────────────────────────── */
// Safe addEventListener — elemento pode não existir ainda
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ni')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('ci')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  // Aplica tema salvo
  const t = localStorage.getItem('vox_theme') || 'dark';
  setTheme(t);
});


function selectLoginType(type) {
  _loginType = type;
  document.querySelectorAll('.lg-opt-btn').forEach(b => b.classList.remove('active'));
  const map = { new:'opt-new', returning:'opt-ret', temp:'opt-tmp' };
  document.getElementById(map[type])?.classList.add('active');
  const codeField = document.getElementById('lg-code-field');
  const nameLabel = document.getElementById('lg-name-label');
  const note      = document.getElementById('lg-note');
  if (type === 'returning') {
    if (codeField) codeField.style.display = 'block';
    if (nameLabel) nameLabel.textContent   = 'Seu nome';
    if (note)      note.textContent        = 'Use o mesmo nome e código da última vez';
  } else if (type === 'temp') {
    if (codeField) codeField.style.display = 'none';
    if (nameLabel) nameLabel.textContent   = 'Seu nome (temporário)';
    if (note)      note.textContent        = '⏳ Conta temporária — apagada ao sair';
  } else {
    if (codeField) codeField.style.display = 'none';
    if (nameLabel) nameLabel.textContent   = 'Seu nome';
    if (note)      note.textContent        = 'Guarde seu código de acesso para voltar depois';
  }
}

async function _initApp(name, code) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('up-name').textContent = name;
  document.getElementById('up-tag').textContent  = code && code !== 'TEMP'
    ? '#' + code.slice(-4)
    : '#' + String(Math.floor(Math.random()*9000)+1000);
  const av = document.getElementById('up-av');
  av.className = 'up-av ' + avc(name);
  av.innerHTML = ini(name) + '<div class="up-dot"></div>';
  _appReady = true;
  // Mostra código nas configurações
  const cd = document.getElementById('user-code-display');
  if (cd) cd.textContent = (!code || code === 'TEMP') ? '(temporário)' : code;
  // Inicia WebRTC
  rtc = new WebRTCManager(socket);
  rtc.onSpeaking = sp => {
    socket.emit('audio:speaking', { speaking: sp });
    mascotReact(sp ? 'speaking' : null);
  };
  await rtc.initMic();
  window._botAudio = new BotAudioPlayer(socket);
  if (!_screen) _screen = new ScreenShare(socket);
  fetch('/api/sources').then(r => r.json()).then(src => { S.sources = src; updateSourceBadges(); }).catch(() => {});
}

async function doLogin() {
  const name = document.getElementById('ni')?.value.trim(); if (!name) return;
  const code = document.getElementById('ci')?.value.trim().toUpperCase() || '';
  document.getElementById('login-btn').disabled = true;

  if (_loginType === 'returning' && !code) {
    toast('⚠️ Digite seu código de acesso'); 
    document.getElementById('login-btn').disabled = false; 
    return;
  }

  // Salva nome para autopreenchimento
  saveSession(name);

  // Tenta autenticar via servidor
  socket.emit('auth:login', { name, code, type: _loginType });
}

// Resposta do servidor ao auth
socket.on('auth:ok', async ({ user }) => {
  S.me = { name: user.name, code: user.code, temporary: user.temporary };
  if (!user.temporary) {
    localStorage.setItem('vozhub_code', user.code);
    localStorage.setItem('vozhub_name', user.name);
  }
  await _initApp(user.name, user.code);
});

socket.on('auth:error', ({ msg }) => {
  toast('❌ ' + msg);
  document.getElementById('login-btn').disabled = false;
});

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
  // Se users vazio, é confirmação que saímos — atualiza sempre
  if (key !== curKey() && users.length > 0) return;
  S.users = users;
  if (music) S.music = music;
  // Se canal ficou vazio para nós = saímos
  if (users.length === 0) {
    S.connected = false;
    const audio = document.getElementById('music-audio');
    if (audio) { audio.pause(); audio.src = ''; audio.load(); audio.dataset.url = ''; }
    window._botAudio?.mute(true);
  }
  rChannelPanel(); rStage(); rUsers(); updateMusicUI();
  const cnt = S.music?.queue?.length || 0;
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
socket.on('music:searching', ({ source, query }) => {
  const map = { soundcloud:'sc-results', youtube:'yt-results', jamendo:'jm-results', audius:'au-results' };
  const el  = document.getElementById(map[source]);
  if (el) el.innerHTML = `<div class="search-loading">🔍 Buscando "${query||''}"...</div>`;
});
socket.on('music:sc:results',      ({ results, error }) => renderSearchResults('sc-results', results, error, 'sc'));
socket.on('music:jamendo:results', ({ results, error }) => renderSearchResults('jm-results', results, error, 'jamendo'));
socket.on('music:audius:results',  ({ results, error }) => renderSearchResults('au-results', results, error, 'audius'));
socket.on('music:yt:results', ({ results, error }) => renderSearchResults('yt-results', results, error, 'yt'));
socket.on('error',  ({ msg }) => toast('❌ ' + msg));
socket.on('kicked', ({ reason }) => { toast('🚫 '+reason); S.connected=false; rtc?.disconnect(); S.users=[]; rAll(); });
socket.on('voice:peers', async ({ peers }) => { if (rtc) await rtc.connectToPeers(peers); });

// Servidor manda parar áudio local (ao sair do canal)
socket.on('audio:stop_local', () => {
  const audio = document.getElementById('music-audio');
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.dataset.url = ''; }
  window._botAudio?.mute(true);
});



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
  document.getElementById('tb-desc').textContent = ch.desc || '';
  const stage = document.getElementById('stage'); stage.innerHTML = '';

  // Mascote de fundo (sempre presente)
  const mascot = document.createElement('div');
  mascot.className = 'stage-mascot'; mascot.id = 'stage-mascot';
  mascot.innerHTML = `
    <picture><source srcset="/img/mascote.webp" type="image/webp">
      <img src="/img/mascote.png" class="mascot-img" id="mascot-img" alt="VOX">
    </picture>
    <video class="mascot-video" id="mascot-video-reaction" loop muted playsinline preload="none"></video>
    <video class="mascot-video" id="mascot-video-join"     muted playsinline preload="none"></video>
    <video class="mascot-video" id="mascot-video-leave"    muted playsinline preload="none"></video>`;
  stage.appendChild(mascot);

  // Log de eventos (entrada/saída)
  const evtLog = document.createElement('div');
  evtLog.className = 'evt-log'; evtLog.id = 'evt-log';
  stage.appendChild(evtLog);

  const members = S.connected ? S.users : (ch.users||[]);
  const ban = document.createElement('div'); ban.className = 'stg-banner';
  ban.innerHTML = `<div class="stg-vis">${srv.icon}</div><div class="stg-info">
    <div class="stg-title">🔊 ${ch.name}</div>
    <div class="stg-sub">${srv.name} · ${ch.desc||'Canal de voz'} · ${members.length} participante${members.length!==1?'s':''}</div>
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
  // Inicializa ScreenShare e habilita botão
  if (!_screen) _screen = new ScreenShare(socket);
  const sb = document.getElementById('screen-btn');
  if (sb) { sb.disabled = false; sb.style.opacity = '1'; sb.style.cursor = 'pointer'; sb.title = 'Compartilhar tela'; }
  // Desmuta áudio ao entrar no canal
  window._botAudio?.mute(false);
  S.localMuted = false;
  const volEl = document.getElementById('vol-sl');
  if (volEl) setLocalVol(volEl.value);
  closeMobilePanel();
  rAll(); toast('🎤 Conectado a '+ch.name);
}

function leaveVoice() {
  S.connected = false;
  socket.emit('voice:leave');
  playSound('leave');
  if (_screenSharing) stopScreenShare();
  // Para áudio IMEDIATAMENTE
  const audio = document.getElementById('music-audio');
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.dataset.url = ''; }
  window._botAudio?.mute(true);
  // Desabilita botão de tela
  const sb = document.getElementById('screen-btn');
  if (sb) { sb.disabled = true; sb.style.opacity = '.4'; sb.style.cursor = 'not-allowed'; sb.textContent = '🖥️ Tela'; sb.classList.remove('active'); sb.style.color = ''; }
  rtc?.disconnect();
  S.users = [];
  S.music = null;
  rAll();
  updateMusicUI();
  // Quando voltar ao canal, desmutar novamente
  S.localMuted = false;
  toast('🚪 Saiu do canal');
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
  // Silencia música
  const audio = document.getElementById('music-audio');
  if (audio) audio.muted = S.deafOn;
  window._botAudio?.mute(S.deafOn);
  // Se surdou → desativa mic automaticamente
  if (S.deafOn && S.micOn) {
    S.micOn = false;
    rtc?.setMic(false);
    const mb = document.getElementById('mic-btn');
    mb.textContent = '🔇'; mb.classList.add('red');
    socket.emit('audio:toggle', { micOn: false });
  }
  const b = document.getElementById('deaf-btn');
  b.textContent = S.deafOn ? '🔇' : '🔊';
  b.classList.toggle('red', S.deafOn);
  socket.emit('audio:toggle', { deafOn: S.deafOn });
  toast(S.deafOn ? '🔇 Som + microfone desativados' : '🔊 Som ativado');
  rStage();
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
  const mbar  = document.querySelector('.mbar');
  const audio = document.getElementById('music-audio');
  const th    = document.getElementById('mb-th');

  // Esconde a barra de música se o usuário não está em canal
  if (mbar) mbar.style.display = S.connected ? '' : 'none';

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
  // Tocar áudio — rádios, links, jamendo, audius tocam direto no cliente
  const streamUrl = t.streamUrl || t.url || '';
  const isDirectPlay = ['radio','url','mp3','jamendo','audius'].includes(t.type);

  if (m.playing && !m.paused && streamUrl && isDirectPlay) {
    // Rádios passam pelo proxy (resolve CORS e firewall corporativo)
    const finalUrl = t.type === 'radio'
      ? '/api/radioproxy?url=' + encodeURIComponent(streamUrl)
      : streamUrl;
    if (audio.dataset.url !== finalUrl) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.dataset.url = finalUrl;
      audio.preload     = t.isLive ? 'none' : 'auto';
      audio.src         = finalUrl;
      audio.volume      = Math.min(1, parseInt(document.getElementById('vol-sl')?.value || 80) / 100);
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

/* ── Audius ────────────────────────────────────────────── */
function doAudiusSearch() {
  const q = document.getElementById('au-in').value.trim(); if (!q) return;
  if (!S.connected) { toast('⚠️ Entre em um canal primeiro'); return; }
  socket.emit('music:search:audius', { query: q });
  document.getElementById('au-results').innerHTML = '<div class="search-loading">🔍 Buscando no Audius...</div>';
}
document.addEventListener('keydown', e => {
  if (e.target.id === 'au-in' && e.key === 'Enter') doAudiusSearch();
});

/* ── Jamendo ────────────────────────────────────────────── */
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
    const srcEmoji = source==='audius'?'🎵':source==='sc'?'☁️':source==='jamendo'?'🎼':'▶️';
    const srcColor = source==='audius'?'au':source==='sc'?'sc':source==='jamendo'?'jm':'';
    item.innerHTML = `
      <div class="si-thumb">${r.thumbnail?`<img src="${r.thumbnail}" alt="">`:(r.emoji||srcEmoji)}</div>
      <div class="si-info">
        <div class="si-title">${r.title}</div>
        <div class="si-meta">${r.artist||''} · ${r.durationFmt||'?'} · ${source==='audius'?'🎵 Audius':source==='jamendo'?'🎼 Jamendo (CC)':source==='sc'?'☁️ SoundCloud':'▶️'}</div>
      </div>
      <button class="si-add ${srcColor}">+ Fila</button>`;
    item.querySelector('.si-add').onclick = () => {
      if (source === 'audius') {
        socket.emit('music:add:audius', {
          audiusId:  r.audiusId,
          title:     r.title,
          artist:    r.artist,
          duration:  r.duration,
          thumbnail: r.thumbnail,
        });
        toast(`🎵 Adicionando: ${r.title}`);
      } else if (source === 'sc') {
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
// ── Medidor de mic em tempo real ─────────────────────
function startMicMeter() {
  stopMicMeter();
  if (!rtc?.analyser) return;
  const data = new Uint8Array(rtc.analyser.frequencyBinCount);
  _micMeterInterval = setInterval(() => {
    if (!rtc?.analyser) { stopMicMeter(); return; }
    rtc.analyser.getByteFrequencyData(data);
    const avg = data.reduce((a,b) => a+b, 0) / data.length;
    const pct = Math.min(100, Math.round(avg / 128 * 100));
    const bar = document.getElementById('mic-meter');
    const lbl = document.getElementById('mic-meter-label');
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = pct + '% ' + (pct > 30 ? '🟢' : pct > 5 ? '🟡' : '⚪');
    if (bar) bar.style.background = pct > 60 ? 'var(--red)' : pct > 20 ? 'linear-gradient(90deg,var(--green),var(--blue))' : 'var(--bg-active)';
  }, 50);
}
function stopMicMeter() {
  try { if (_micMeterInterval) { clearInterval(_micMeterInterval); _micMeterInterval = null; } } catch {}
}

// ── Teste de alto-falante ─────────────────────────────
function testSpeaker() {
  try {
    const ctx = getACtx();
    if (ctx.state === 'suspended') { ctx.resume().then(testSpeaker); return; }
    // Toca beeps de teste
    [440, 550, 660].forEach((freq, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0, ctx.currentTime + i * 0.2);
      g.gain.linearRampToValueAtTime(0.3, ctx.currentTime + i * 0.2 + 0.05);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.2 + 0.2);
      o.start(ctx.currentTime + i * 0.2);
      o.stop(ctx.currentTime + i * 0.2 + 0.25);
    });
    toast('🔔 Se ouviu os beeps, o alto-falante está funcionando!');
  } catch(e) {
    toast('❌ Erro ao testar: ' + e.message);
  }
}

// ── Diagnóstico completo ──────────────────────────────
async function runDiagnostic() {
  const set = (id, html, ok) => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = (ok === true ? '✅' : ok === false ? '❌' : '⚠️') + ' ' + html;
    el.style.color = ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : 'var(--amber)';
  };

  // Testa microfone
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    set('diag-mic', 'Microfone: acesso permitido ✓', true);
  } catch(e) {
    set('diag-mic', `Microfone: BLOQUEADO — ${e.message}`, false);
  }

  // Testa AudioContext
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') {
      set('diag-ctx', 'AudioContext: suspenso — clique em "Desbloquear áudio"', null);
    } else {
      set('diag-ctx', 'AudioContext: ativo ✓', true);
    }
    ctx.close();
  } catch(e) {
    set('diag-ctx', 'AudioContext: não suportado', false);
  }

  // Testa elemento de áudio
  const audio = document.getElementById('music-audio');
  if (audio) {
    const blocked = audio.paused && audio.src && !audio.ended;
    set('diag-audio', blocked
      ? 'Áudio: bloqueado (autoplay) — clique em "Desbloquear áudio"'
      : 'Áudio: elemento ok ✓', blocked ? null : true);
  }

  // Testa conexão
  set('diag-conn', S.connected
    ? `Conexão: no canal ✓`
    : 'Conexão: fora do canal', S.connected ? true : null);
}

async function openSettings() {
  const {inputs,outputs} = await WebRTCManager.getDevices();
  const ms = document.getElementById('mic-select'); ms.innerHTML = '';
  const ss = document.getElementById('spk-select'); ss.innerHTML = '';
  inputs.forEach((d,i)  => { const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Microfone '+(i+1); ms.appendChild(o); });
  outputs.forEach((d,i) => { const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Alto-falante '+(i+1); ss.appendChild(o); });
  if (!inputs.length)  ms.innerHTML='<option>Nenhum microfone</option>';
  if (!outputs.length) ss.innerHTML='<option>Padrão do sistema</option>';
  openMo('mo-settings');
  runDiagnostic();
  startMicMeter();
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

/* ── Mascote VOX — controle de animações ─────────────── */
let _mascotTimer = null;

// Carrega src do vídeo sob demanda (lazy) — evita baixar 19MB na abertura
function _loadVideo(id, src) {
  const vid = document.getElementById(id);
  if (!vid) return null;
  if (!vid.src || !vid.src.includes(src)) {
    vid.src = src;
    vid.load();
  }
  return vid;
}

function mascotReact(state) {
  const mascot = document.getElementById('stage-mascot');
  if (!mascot) return;
  mascot.classList.remove('speaking', 'joining', 'leaving');
  if (state === 'speaking') {
    mascot.classList.add('speaking');
    const vid = _loadVideo('mascot-video-reaction', '/img/reacao.mp4');
    if (vid && vid.paused) vid.play().catch(() => {});
  } else {
    const vid = document.getElementById('mascot-video-reaction');
    if (vid) vid.pause();
  }
}

function mascotJoin() {
  const mascot = document.getElementById('stage-mascot');
  if (!mascot) return;
  mascot.classList.remove('speaking', 'leaving');
  mascot.classList.add('joining');
  const vid = _loadVideo('mascot-video-join', '/img/oi.mp4');
  if (vid) {
    vid.currentTime = 0;
    vid.play().catch(() => {});
    vid.onended = () => { mascot.classList.remove('joining'); vid.onended = null; };
  } else {
    setTimeout(() => mascot.classList.remove('joining'), 2500);
  }
}

function mascotLeave() {
  const mascot = document.getElementById('stage-mascot');
  if (!mascot) return;
  mascot.classList.remove('speaking', 'joining');
  mascot.classList.add('leaving');
  const vid = _loadVideo('mascot-video-leave', '/img/tchau.mp4');
  if (vid) {
    vid.currentTime = 0;
    vid.play().catch(() => {});
    vid.onended = () => { mascot.classList.remove('leaving'); vid.onended = null; };
  } else {
    setTimeout(() => mascot.classList.remove('leaving'), 2500);
  }
}

function openCreateChannel() {
  if (!S.me) return toast('Faça login primeiro');
  openMo('mo-create-channel');
}

function doCreateChannel() {
  const name = document.getElementById('ch-name-input')?.value.trim();
  const type = document.getElementById('ch-type-input')?.value || 'public';
  const pass = document.getElementById('ch-pass-input')?.value || '';
  if (!name) return toast('⚠️ Digite um nome para o canal');
  const srv = S.servers[S.aSrv]; if (!srv) return;
  socket.emit('channel:create', { srvId: srv.id, name, type, password: pass });
  closeMo('mo-create-channel');
  document.getElementById('ch-name-input').value = '';
  document.getElementById('ch-pass-input').value = '';
}

socket.on('channel:created', ({ channel }) => {
  toast('✅ Canal "' + channel.name + '" criado!');
});

function copyInvite() {
  const url = window.location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('🔗 Link copiado: ' + url))
      .catch(() => { prompt('Copie o link:', url); });
  } else {
    prompt('Copie o link de convite:', url);
  }
}

/* ── Ativar Som (contorna bloqueio de autoplay / TI) ── */
function unlockSound() {
  // Desbloqueia AudioContext
  const ctx = getACtx();
  ctx?.resume().then(() => console.log('[Audio] AudioContext resumido'));

  // Desbloqueia BotAudio
  window._botAudio?.unlock();

  // Força reprodução do áudio atual
  const audio = document.getElementById('music-audio');
  if (audio) {
    if (audio.paused && audio.src && audio.src !== window.location.href) {
      audio.play().then(() => {
        console.log('[Audio] Desbloqueado com sucesso');
        toast('🔊 Som ativado!');
      }).catch(e => {
        console.warn('[Audio] ainda bloqueado:', e.message);
        toast('⚠️ Clique em qualquer lugar da página para ativar o som');
      });
    } else {
      toast('🔊 Áudio desbloqueado!');
    }
  }

  document.getElementById('sound-unlock-btn').style.display = 'none';
}

// Detecta se o autoplay está bloqueado e mostra o botão
function checkAutoplayBlocked() {
  const audio = document.getElementById('music-audio');
  if (!audio) return;
  const handler = () => {
    document.getElementById('sound-unlock-btn').style.display = 'block';
    audio.removeEventListener('play', okHandler);
  };
  const okHandler = () => {
    document.getElementById('sound-unlock-btn').style.display = 'none';
    audio.removeEventListener('pause', handler);
  };
  audio.addEventListener('pause', handler, { once: true });
  audio.addEventListener('play', okHandler, { once: true });
}

/* ── Mobile — painel lateral ─────────────────────────── */
function toggleMobilePanel() {
  const pc      = document.querySelector('.pc');
  const overlay = document.getElementById('pc-overlay');
  const isOpen  = pc?.classList.contains('open');
  if (isOpen) { closeMobilePanel(); }
  else { pc?.classList.add('open'); overlay?.classList.add('show'); }
}

function closeMobilePanel() {
  document.querySelector('.pc')?.classList.remove('open');
  document.getElementById('pc-overlay')?.classList.remove('show');
}

// Fecha painel mobile ao entrar em canal
const _origJoinVoice = typeof joinVoice !== 'undefined' ? joinVoice : null;

/* ── Compartilhamento de Tela ──────────────────────────── */

async function toggleScreenShare() {
  if (!_screen) _screen = new ScreenShare(socket);
  _screenSharing = _screen.sharing;
  await _screen.start();
  _screenSharing = _screen.sharing;
}

function stopScreenShare() {
  _screen?.stop();
  _screenSharing = false;
}

function onScreenTrack() {} // mantido por compatibilidade — ScreenShare.js trata direto