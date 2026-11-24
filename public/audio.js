// Background music from a local file (public/music.mp3), started automatically when a round starts.
const Music = (() => {
  const FILE = 'music.mp3';
  const START_AT = 33;   // seconds: where the track starts when the game begins
  const VOLUME = 0.35;
  let loaded = false, muted = false, want = false, fresh = true, available = true, ctx = null;
  try { muted = localStorage.getItem('muted') === '1'; } catch (e) {}

  const audio = new Audio();
  audio.src = FILE; audio.loop = true; audio.preload = 'auto'; audio.volume = VOLUME;
  audio.addEventListener('error', () => { available = false; hint(false); });
  audio.addEventListener('ended', () => { audio.currentTime = START_AT; audio.play().catch(() => {}); });

  function hint(show) { const b = document.getElementById('musicBtn'); if (b) b.hidden = !show; }

  function apply() {
    if (!available) return;
    if (want && !muted) {
      if (fresh) {
        const go = () => { try { audio.currentTime = START_AT; } catch (e) {} };
        if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
        fresh = false;
      }
      clearInterval(fadeTimer); audio.volume = VOLUME;
      audio.play().then(() => hint(false)).catch(() => hint(true)); // blocked by browser -> show button
    } else { fadeOut(); hint(false); }
  }

  let fadeTimer = null;
  function fadeOut() {
    clearInterval(fadeTimer);
    fadeTimer = setInterval(() => {
      audio.volume = Math.max(0, audio.volume - VOLUME / 8);
      if (audio.volume <= 0.001) { clearInterval(fadeTimer); audio.pause(); audio.volume = VOLUME; }
    }, 60);
  }

  function start() { // call from a click (Join) to unlock audio
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
    if (!loaded) { audio.load(); loaded = true; } // load once; reloading would stop playback
  }
  function setPlaying(b) { if (!b) fresh = true; want = b; apply(); }
  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('muted', m ? '1' : '0'); } catch (e) {}
    apply();
  }
  function userPlay() { apply(); }
  function ding() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    [[84, 0], [91, 0.1]].forEach(([m, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.25, t + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
      o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.7);
    });
  }
  return { start, setMuted, setPlaying, userPlay, ding, get muted() { return muted; } };
})();
