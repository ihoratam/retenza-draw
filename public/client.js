const socket = io();
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const COLORS = ['#000000', '#7f7f7f', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#ec407a'];

// stable id per browser, so a reload is recognised as the same player
let pid = null;
try { pid = localStorage.getItem('pid'); if (!pid) { pid = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('pid', pid); } } catch (e) { pid = Math.random().toString(36).slice(2); }
let lastPhase = null, maxTime = 1, joinedAs = null, me = null, state = null, myWord = null;
let color = '#000000', size = 5, eraser = false, drawing = false, last = null;

// ---------- login ----------
$('name').value = localStorage.getItem('name') || '';
$('code').value = localStorage.getItem('code') || '';
$('admin').value = localStorage.getItem('admin') || '';
$('joinBtn').onclick = join;
[$('name'), $('code'), $('admin')].forEach(i => i.addEventListener('keydown', e => e.key === 'Enter' && join()));
function join() {
  const name = $('name').value.trim(), code = $('code').value.trim(), admin = $('admin').value;
  if (!name || !code) return;
  localStorage.setItem('name', name); localStorage.setItem('code', code); localStorage.setItem('admin', admin);
  joinedAs = { name, code, admin };
  Music.start();
  socket.emit('join', { name, code, admin, pid });
}
// after a connection drop / server restart, re-enter the room automatically
socket.on('connect', () => { if (joinedAs) { $('messages').innerHTML = ''; socket.emit('join', { ...joinedAs, pid }); } });
socket.on('joined', ({ id }) => { me = id; $('login').hidden = true; $('game').hidden = false; });

// ---------- tools ----------
COLORS.forEach(c => {
  const d = document.createElement('div');
  d.className = 'sw' + (c === color ? ' sel' : '');
  d.style.background = c;
  d.onclick = () => { color = c; eraser = false; $('eraser').classList.remove('active'); document.querySelectorAll('.sw').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); };
  $('colors').appendChild(d);
});
$('size').oninput = e => (size = +e.target.value);
$('eraser').onclick = () => { eraser = !eraser; $('eraser').classList.toggle('active', eraser); };
$('clearBtn').onclick = () => socket.emit('clear');

// ---------- drawing ----------
const isDrawer = () => state && state.phase === 'drawing' && state.drawerId === me;
function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function drawSeg(s) {
  ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.x0 * canvas.width, s.y0 * canvas.height);
  ctx.lineTo(s.x1 * canvas.width, s.y1 * canvas.height);
  ctx.stroke();
}
function wipe() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
wipe();

canvas.addEventListener('pointerdown', e => {
  if (!isDrawer()) return;
  drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId);
  emitSeg(last, last);
});
canvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  const p = pos(e); emitSeg(last, p); last = p;
});
['pointerup', 'pointercancel'].forEach(ev => canvas.addEventListener(ev, () => (drawing = false)));
function emitSeg(a, b) {
  const s = { x0: a.x, y0: a.y, x1: b.x, y1: b.y, c: eraser ? '#ffffff' : color, w: eraser ? size * 3 : size };
  drawSeg(s); socket.emit('draw', s);
}
socket.on('draw', drawSeg);
socket.on('clear', wipe);
socket.on('history', h => { wipe(); h.forEach(drawSeg); });

// ---------- state ----------
socket.on('state', s => { state = s; render(); });
socket.on('tick', t => { if (state) { state.timeLeft = t; setTime(); } });
socket.on('hint', h => { state.hint = h; renderHint(); });
socket.on('word', w => { myWord = w; renderHint(); renderOverlay(); });
socket.on('choices', list => showChoices(list));
socket.on('reveal', w => { myWord = null; });

function renderHint() {
  if (!state) return;
  if (state.phase === 'drawing') $('hint').textContent = isDrawer() && myWord ? myWord : state.hint;
  else if (state.phase === 'choosing') $('hint').textContent = '...';
  else $('hint').textContent = '';
}

function render() {
  $('roomInfo').textContent = `Room ${state.code}`;
  const inGame = state.phase !== 'lobby';
  $('picInfo').hidden = false;
  $('picInfo').innerHTML = inGame
    ? `<span class="pl">Picture</span><b>${state.round}</b><span class="of">of ${state.rounds}</span>`
    : `<span class="pl">Game length</span><b>${state.rounds}</b><span class="of">pictures</span>`;
  if (state.phase !== lastPhase) { lastPhase = state.phase; Music.setPlaying(state.phase === 'drawing'); maxTime = Math.max(state.timeLeft, 1); }
  setTime();
  renderHint();
  $('tools').hidden = !isDrawer();
  updateComposer();

  const list = rank(state.players);
  $('players').innerHTML = list.map(p => {
    const cls = p.id === state.drawerId ? 'drawer' : p.guessed ? 'guessed' : '';
    const status = p.id === state.drawerId ? 'Drawing' : p.guessed ? 'Guessed it' : '';
    const hue = [...p.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    return `<div class="p ${cls}"><div class="av" style="--h:${hue}">${esc([...p.name][0] || '?').toUpperCase()}</div><div class="pinfo"><div class="pname" title="${esc(p.name)}">${esc(p.name)}${p.id === me ? ' <span class="you">you</span>' : ''}</div>${status ? `<div class="pstat">${status}</div>` : ''}</div><div class="cnt" title="Pictures guessed"><b>${p.guesses || 0}</b><span>guessed</span></div></div>`;
  }).join('') + (state.phase === 'lobby' && isAdmin() ? '<button id="startBtn" class="btn-primary">Start game</button>' : '');
  const sb = $('startBtn'); if (sb) sb.onclick = () => socket.emit('start');
  if (state.phase === 'lobby') {
    const box = document.createElement('div'); box.style.marginTop = '12px';
    const opts = [5, 10, 15, 20, 25, 30].map(v => `<option value="${v}">${v} pictures</option>`).join('');
    box.innerHTML = `<div class="label" style="margin-bottom:6px">Word language</div>` + (isAdmin()
      ? `<select id="lang" class="input" style="width:100%"><option value="ru">Русский</option><option value="en">English</option></select>`
      : `<div>${state.lang === 'ru' ? 'Русский' : 'English'}</div>`) +
      `<div class="label" style="margin:12px 0 6px">Game length</div>` + (isAdmin()
      ? `<select id="pics" class="input" style="width:100%">${opts}</select>`
      : `<div>${state.rounds} pictures</div>`);
    $('players').appendChild(box);
    const sel = $('lang'); if (sel) { sel.value = state.lang; sel.onchange = () => socket.emit('setLang', sel.value); }
    const rs = $('pics'); if (rs) { rs.value = String(state.rounds); rs.onchange = () => socket.emit('setPictures', rs.value); }
  }

  renderOverlay();
}

function renderOverlay() {
  const o = $('overlay');
  if (!state) return;
  const drawer = state.players.find(p => p.id === state.drawerId);
  if (state.phase === 'lobby') {
    o.hidden = false;
    o.innerHTML = `<div>Waiting for players…</div><div class="sub">Invite colleagues to room <b>${esc(state.code)}</b>.<br>${isAdmin() ? 'Press “Start game” on the left.' : 'Waiting for the admin to start the game.'}</div>`;
  } else if (state.phase === 'choosing' && state.drawerId !== me) {
    o.hidden = false; o.innerHTML = `${esc(drawer?.name || '')} is choosing a word…`;
  } else if (state.phase === 'reveal') {
    o.hidden = false; o.innerHTML = 'Turn over…';
  } else if (state.phase === 'end') {
    const top = rank(state.players);
    const medals = ['🥇', '🥈', '🥉'];
    const slot = (p, i) => p ? `<div class="pod pod${i + 1}"><div class="medal">${medals[i]}</div><div class="pn">${esc(p.name)}</div><div class="ps">${p.guesses}</div><div class="pg">pictures guessed</div><div class="bar"></div></div>` : '';
    o.hidden = false;
    o.innerHTML = `<div>Game over</div><div class="podium">${slot(top[1], 1)}${slot(top[0], 0)}${slot(top[2], 2)}</div>` +
      (top[0] && top[0].guesses ? `<div class="sub">Most pictures guessed: <b>${esc(top[0].name)}</b> — ${top[0].guesses}</div>` : '') +
      top.slice(3).map((p, i) => `<div class="sub">${i + 4}. ${esc(p.name)} — ${p.guesses} guessed</div>`).join('');
  } else if (state.phase !== 'choosing') o.hidden = true;
}

function showChoices(list) {
  const o = $('overlay'); o.hidden = false;
  o.innerHTML = '<div>Choose a word to draw</div>';
  list.forEach(w => {
    const b = document.createElement('button'); b.textContent = w;
    b.onclick = () => { socket.emit('chooseWord', w); o.hidden = true; };
    o.appendChild(b);
  });
  const own = document.createElement('div'); own.className = 'ownWord';
  own.innerHTML = '<span class="sub">or type your own word</span><div class="ownRow"><input id="ownInput" class="input" maxlength="30" placeholder="Your own word..." autocomplete="off"><button id="ownBtn" class="btn-ghost">Use it</button></div>';
  o.appendChild(own);
  const submit = () => { const v = $('ownInput').value.trim(); if (v.length < 2) return; socket.emit('chooseWord', v); o.hidden = true; };
  $('ownBtn').onclick = submit;
  $('ownInput').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// ---------- chat ----------
$('msg').addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
socket.on('chat', m => {
  const d = document.createElement('div');
  if (m.system) {
    d.className = 'ev ' + (m.kind || 'info');
    if (m.kind === 'word') {
      d.innerHTML = `<span class="evl">The word was</span><span class="evw">${esc(m.text.replace(/^The word was:\s*/, ''))}</span>`;
    } else if (m.kind === 'correct') {
      d.innerHTML = `<span class="evl">Correct answer</span><span class="evt"><b>${esc(m.text.replace(/ guessed the word!$/, ''))}</b> guessed the word</span>`;
    } else d.textContent = m.text;
    if (m.kind === 'correct') Music.ding();
  } else {
    const mine = m.fromId === me;
    if (mine && m.wrong) flashWrong();
    d.className = 'msgRow ' + (mine ? 'mine' : 'theirs');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `<div class="bubble${m.secret ? ' secret' : ''}${m.wrong ? ' wrong' : ''}">${mine ? '' : `<div class="who">${esc(m.from)}</div>`}<div class="txt">${m.wrong ? '<span class="x">✕</span> ' : ''}${esc(m.text)}</div><div class="time">${m.secret ? 'guessers only · ' : ''}${time}</div></div>`;
  }
  const box = $('messages'); box.appendChild(d); box.scrollTop = box.scrollHeight;
});

const isAdmin = () => !!(state && state.players.find(p => p.id === me)?.isAdmin);
const rank = arr => [...arr].sort((a, b) => b.guesses - a.guesses || b.score - a.score);
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function setTime() {
  const on = state && (state.phase === 'drawing' || state.phase === 'choosing');
  $('topbar').classList.toggle('idle', !on);
  $('timer').textContent = on ? state.timeLeft : '';
  $('barFill').style.width = on ? Math.max(0, Math.min(100, (state.timeLeft / maxTime) * 100)) + '%' : '0%';
  $('topbar').classList.toggle('low', on && state.timeLeft <= 10);
}
const mb = $('muteBtn');
mb.textContent = Music.muted ? '🔇' : '🔊';
mb.onclick = () => { Music.start(); Music.setMuted(!Music.muted); mb.textContent = Music.muted ? '🔇' : '🔊'; };

$('musicBtn').onclick = () => Music.userPlay();

// reload automatically if the server was restarted/updated (avoids stale clients)
let bootId = null;
// server was updated/restarted: reload to get the new version, then re-enter the room automatically
socket.on('boot', id => { if (bootId && bootId !== id) { try { sessionStorage.setItem('rejoin', '1'); } catch (e) {} location.reload(); } bootId = id; });
try { if (sessionStorage.getItem('rejoin')) { sessionStorage.removeItem('rejoin'); socket.once('connect', () => { if ($('name').value && $('code').value) join(); }); } } catch (e) {}
// never stay silently disconnected: reconnect when the tab comes back (bfcache / sleep / background)
function ensureConnected() { if (joinedAs && !socket.connected) socket.connect(); }
window.addEventListener('pageshow', ensureConnected);
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureConnected(); });
// connection banner
const banner = document.createElement('div'); banner.id = 'conn'; banner.hidden = true; banner.textContent = 'Connection lost — reconnecting…'; document.body.appendChild(banner);
socket.on('disconnect', reason => { if (joinedAs && reason !== 'io client disconnect') banner.hidden = false; });
socket.on('connect', () => { banner.hidden = true; });
// visible feedback for my own wrong guess
function flashWrong() {
  const i = $('msg'); i.classList.remove('shake'); void i.offsetWidth; i.classList.add('shake');
}

function updateComposer() {
  const meP = state.players.find(p => p.id === me);
  let label = 'Type your guess here', ph = 'Your answer...', mode = 'guess';
  if (state.phase === 'drawing') {
    if (state.drawerId === me) { label = 'You are drawing'; ph = 'Guessers only...'; mode = 'drawer'; }
    else if (meP && meP.guessed) { label = 'You guessed it!'; ph = 'Message...'; mode = 'done'; }
  }
  $('composerLabel').textContent = label;
  $('msg').placeholder = ph;
  $('composer').className = mode;
}
function sendMsg() {
  const i = $('msg'), t = i.value.trim(); if (!t) return;
  socket.emit('chat', t); i.value = ''; i.focus();
}
$('sendBtn').onclick = sendMsg;
$('msg').addEventListener('animationend', e => e.target.classList.remove('shake'));

// this tab was replaced by a newer one from the same browser
socket.on('replaced', () => { joinedAs = null; document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8;font:16px system-ui">The game is open in another tab. Close this one or reload the page to play here.</div>'; });
window.addEventListener('beforeunload', () => socket.disconnect());
window.addEventListener('pagehide', () => socket.disconnect());
// clean exit: the server drops you from the list immediately
$('leaveBtn').onclick = () => {
  if (state && state.phase !== 'lobby' && !confirm('Leave the game?')) return;
  joinedAs = null; socket.disconnect(); location.reload();
};

// volume slider
const vs = $('volSlider');
vs.value = Math.round(Music.volume * 100);
vs.oninput = () => {
  Music.setVolume(vs.value / 100);
  if (Music.muted && vs.value > 0) { Music.start(); Music.setMuted(false); mb.textContent = '🔊'; }
};
