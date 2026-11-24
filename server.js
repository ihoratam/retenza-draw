const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);
// Faster dead-connection detection so closed tabs disappear from the list within ~9s
const io = new Server(server, { maxHttpBufferSize: 1e6, pingInterval: 7000, pingTimeout: 9000 });
app.use(express.static('public'));

// Game length = number of pictures (turns). The first drawer is the admin who starts; whoever guesses a picture draws the next one.
const DEFAULT_PICTURES = 15;
const totalPictures = r => r.picturesSetting || DEFAULT_PICTURES;
const DRAW_TIME = 150;
const CHOOSE_TIME = 45;
const rooms = new Map();
// Only players who enter this code on the login screen are admins (can start the game).
// Change it: ADMIN_CODE=yourcode npm start
const ADMIN_CODE = process.env.ADMIN_CODE || 'retenza-admin';
const BOOT = Date.now(); // lets clients detect a restarted/updated server

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function publicState(r) {
  return {
    code: r.code, lang: r.lang, phase: r.phase, round: r.round, rounds: r.phase === 'lobby' ? totalPictures(r) : r.fixedRounds,
    drawerId: r.phase === 'lobby' ? null : r.drawerId,
    hint: r.hint, timeLeft: r.timeLeft,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, guesses: p.guesses, guessed: p.guessed, isAdmin: !!p.isAdmin }))
  };
}
const emitState = r => io.to(r.code).emit('state', publicState(r));
const sys = (r, text, kind = 'info') => io.to(r.code).emit('chat', { system: true, kind, text });

// Drop the " (2)" suffix once the other player with the same name is gone
function tidyNames(r) {
  for (const p of r.players.values()) {
    const m = p.name.match(/^(.*) \(\d+\)$/);
    if (m && ![...r.players.values()].some(q => q !== p && q.name.toLowerCase() === m[1].toLowerCase())) p.name = m[1];
  }
}

function maskHint(word, revealed) {
  return [...word].map((c, i) => (c === ' ' ? ' ' : revealed.has(i) ? c : '_')).join('');
}

function clearTimers(r) { clearInterval(r.timer); r.timer = null; }

function startGame(r, starterId) {
  r.players.forEach(p => { p.score = 0; p.guesses = 0; });
  r.round = 0;
  r.fixedRounds = totalPictures(r); // locked in at game start
  r.nextDrawer = starterId;         // the admin draws first
  r.drawerId = null;
  nextTurn(r);
}

function nextTurn(r) {
  clearTimers(r);
  if (++r.round > r.fixedRounds) return endGame(r);
  if (r.players.size < 2) { r.phase = 'lobby'; sys(r, 'At least 2 players are needed. Game stopped.'); return emitState(r); }
  // next drawer: the player who guessed the previous picture; if nobody did, a random other player
  const prev = r.drawerId;
  if (r.nextDrawer && r.players.has(r.nextDrawer)) r.drawerId = r.nextDrawer;
  else {
    const others = [...r.players.keys()].filter(id => id !== prev);
    r.drawerId = others[Math.floor(Math.random() * others.length)];
  }
  r.nextDrawer = null;
  r.players.forEach(p => (p.guessed = false));
  r.word = null; r.hint = ''; r.history = [];
  r.phase = 'choosing';
  r.timeLeft = CHOOSE_TIME;
  r.choices = pick(WORDS[r.lang], 3);
  io.to(r.code).emit('clear');
  io.to(r.drawerId).emit('choices', r.choices);
  emitState(r);
  r.timer = setInterval(() => {
    r.timeLeft--;
    io.to(r.code).emit('tick', r.timeLeft);
    if (r.timeLeft <= 0) beginDrawing(r, r.choices[0]);
  }, 1000);
}

function beginDrawing(r, word) {
  clearTimers(r);
  r.word = word;
  r.revealed = new Set();
  r.hint = maskHint(word, r.revealed);
  r.phase = 'drawing';
  r.timeLeft = DRAW_TIME;
  io.to(r.drawerId).emit('word', word);
  emitState(r);
  const hintAt = [DRAW_TIME - 60, DRAW_TIME - 90, 10]; // letters revealed: after 60s, after 90s, and when 10s are left
  r.timer = setInterval(() => {
    r.timeLeft--;
    if (hintAt.includes(r.timeLeft)) {
      const hidden = [...word].map((_, i) => i).filter(i => word[i] !== ' ' && !r.revealed.has(i));
      if (hidden.length > 1) r.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
      r.hint = maskHint(word, r.revealed);
      io.to(r.code).emit('hint', r.hint);
    }
    io.to(r.code).emit('tick', r.timeLeft);
    if (r.timeLeft <= 0) endTurn(r);
  }, 1000);
}

function endTurn(r, guesserId = null) {
  clearTimers(r);
  r.nextDrawer = guesserId; // the one who guessed draws next
  r.phase = 'reveal';
  sys(r, `The word was: ${r.word}`, 'word');
  io.to(r.code).emit('reveal', r.word);
  emitState(r);
  setTimeout(() => { if (r.phase === 'reveal') nextTurn(r); }, 4000);
}

function endGame(r) {
  clearTimers(r);
  r.phase = 'end';
  r.history = [];
  io.to(r.code).emit('clear');   // results screen stays until the admin starts a new game
  emitState(r);
}

io.on('connection', socket => {
  let room = null;
  socket.emit('boot', BOOT);

  socket.on('join', ({ name, code, admin, pid }) => {
    pid = String(pid || '').slice(0, 40);
    name = String(name || '').trim().slice(0, 20);
    code = String(code || '').trim().toUpperCase().slice(0, 12);
    if (!name || !code) return;
    let r = rooms.get(code);
    if (!r) {
      r = { code, players: new Map(), phase: 'lobby', lang: 'ru', round: 0, history: [], timer: null, away: new Map() };
      rooms.set(code, r);
    }
    // Same browser coming back (reload / reconnect): take over the old session instead of creating a new player
    let old = null;
    if (pid) for (const p of r.players.values()) if (p.pid === pid) old = p;
    if (old) {
      r.players.delete(old.id);
      if (r.drawerId === old.id) r.drawerId = socket.id;
      if (r.nextDrawer === old.id) r.nextDrawer = socket.id;
      const oldSock = io.sockets.sockets.get(old.id);
      if (oldSock) { oldSock.emit('replaced'); oldSock.disconnect(true); }
      tidyNames(r);
    }
    // returning after a dropped connection: restore score and guesses for up to 2 minutes
    let away = null;
    if (!old && pid && r.away.has(pid)) { away = r.away.get(pid); r.away.delete(pid); if (away.until < Date.now()) away = null; }
    const taken = new Set([...r.players.values()].map(p => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
    }
    r.players.set(socket.id, {
      id: socket.id, pid, name,
      score: old ? old.score : away ? away.score : 0, guesses: old ? old.guesses : away ? away.guesses : 0, guessed: old ? old.guessed : false,
      isAdmin: (!!ADMIN_CODE && String(admin || '') === ADMIN_CODE) || !!(old && old.isAdmin)
    });
    if (r.stopTimer && r.players.size >= 2) { clearTimeout(r.stopTimer); r.stopTimer = null; }
    room = r;
    socket.join(code);
    socket.emit('joined', { id: socket.id });
    socket.emit('history', r.history);
    if (r.phase === 'drawing' && r.drawerId === socket.id) socket.emit('word', r.word);
    if (r.phase === 'choosing' && r.drawerId === socket.id) socket.emit('choices', r.choices);
    if (!old) sys(r, `${name} joined the room`, 'join');
    emitState(r);
  });

  socket.on('start', () => {
    if (!room || !room.players.get(socket.id)?.isAdmin || (room.phase !== 'lobby' && room.phase !== 'end')) return;
    if (room.players.size < 2) return socket.emit('chat', { system: true, text: 'At least 2 players are needed' });
    startGame(room, socket.id);
  });

  socket.on('backToLobby', () => {
    if (!room || !room.players.get(socket.id)?.isAdmin || room.phase !== 'end') return;
    room.phase = 'lobby'; room.round = 0; emitState(room);
  });

  socket.on('setLang', l => {
    if (!room || !room.players.get(socket.id)?.isAdmin || room.phase !== 'lobby' || !WORDS[l]) return;
    room.lang = l; emitState(room);
  });

  socket.on('setPictures', v => {
    if (!room || !room.players.get(socket.id)?.isAdmin || room.phase !== 'lobby') return;
    room.picturesSetting = Math.max(3, Math.min(50, parseInt(v, 10) || DEFAULT_PICTURES));
    emitState(room);
  });

  socket.on('chooseWord', word => {
    const r = room;
    if (!r || r.phase !== 'choosing' || r.drawerId !== socket.id) return;
    word = String(word || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    // either one of the offered words or the drawer's own word (2-30 chars)
    if (!r.choices.includes(word) && !(word.length >= 2 && /^[\p{L}\p{N} \-']+$/u.test(word))) return;
    beginDrawing(r, word);
  });

  socket.on('draw', seg => {
    const r = room;
    if (!r || r.phase !== 'drawing' || r.drawerId !== socket.id) return;
    r.history.push(seg);
    socket.to(r.code).emit('draw', seg);
  });

  socket.on('clear', () => {
    const r = room;
    if (!r || r.phase !== 'drawing' || r.drawerId !== socket.id) return;
    r.history = [];
    io.to(r.code).emit('clear');
  });

  socket.on('chat', text => {
    const r = room;
    if (!r) return;
    const p = r.players.get(socket.id);
    text = String(text || '').trim().slice(0, 100);
    if (!p || !text) return;

    if (r.phase === 'drawing' && r.drawerId !== socket.id && !p.guessed) {
      if (norm(text) === norm(r.word)) {
        p.guessed = true;
        p.guesses++;
        const gain = 50 + Math.round((r.timeLeft / DRAW_TIME) * 150);
        p.score += gain;
        const drawer = r.players.get(r.drawerId);
        if (drawer) drawer.score += 30;
        sys(r, `${p.name} guessed the word!`, 'correct');
        emitState(r);
        endTurn(r, socket.id); // first correct guess ends the turn; the guesser draws next
        return;
      }
    }
    // guessed players and drawer chat only among themselves while drawing
    const secret = r.phase === 'drawing' && (p.guessed || r.drawerId === socket.id);
    const wrong = r.phase === 'drawing' && !secret; // public message during a round = wrong guess
    const msg = { from: p.name, fromId: socket.id, text, secret, wrong };
    if (secret) {
      r.players.forEach(x => { if (x.guessed || x.id === r.drawerId) io.to(x.id).emit('chat', msg); });
    } else {
      io.to(r.code).emit('chat', msg);
    }
  });

  socket.on('disconnect', () => {
    const r = room;
    if (!r) return;
    const p = r.players.get(socket.id);
    r.players.delete(socket.id);
    tidyNames(r);
    if (p && p.pid && r.phase !== 'lobby') r.away.set(p.pid, { score: p.score, guesses: p.guesses, until: Date.now() + 120000 });
    if (p) sys(r, `${p.name} left`, 'join');
    if (!r.players.size) { clearTimers(r); rooms.delete(r.code); return; }
    if (r.phase !== 'lobby' && r.phase !== 'end') {
      if (r.players.size < 2) {
        // give the other player 25s to come back (short connection drops must not kill the game)
        if (!r.stopTimer) r.stopTimer = setTimeout(() => {
          r.stopTimer = null;
          if (r.players.size < 2 && r.phase !== 'lobby' && r.phase !== 'end') { clearTimers(r); r.phase = 'lobby'; sys(r, 'Only one player left. Game stopped.'); emitState(r); }
        }, 25000);
      }
      else if (r.drawerId === socket.id && (r.phase === 'drawing' || r.phase === 'choosing')) { sys(r, 'The drawer left'); nextTurn(r); return; }
    }
    emitState(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Game running: http://localhost:${PORT}`));
