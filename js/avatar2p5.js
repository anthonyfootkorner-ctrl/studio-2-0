// Avatar photographe 2.5D — marionnette animée depuis l'illustration du personnage.
// États du brief : repos, suivi souris (pupilles puis tête avec retard), prise de
// parole (lip-sync procédural sur la voix), fin de question, écoute, réactions.
// Techniques : l'œil est recadré et translaté sous des paupières fixes (regard),
// paupières peintes pour les clignements, bouche transformée par visème.
// 100 % local. Version statique si prefers-reduced-motion.

const Photographe = (() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Calibrage (coordonnées dans l'image 1254×1254) ──
  const CAL = {
    eyeL: { cx: 555, cy: 389, rx: 40, ry: 20 },
    eyeR: { cx: 692, cy: 380, rx: 42, ry: 20 },
    mouth: { cx: 617, cy: 547, w: 150, h: 62 },
    headPivot: { x: 620, y: 560 },
    skinSample: { x: 555, y: 445 }, // sous l'œil : couleur des paupières
    cameraZone: { y: 980 },         // sangle + boîtier (balancement secondaire)
  };

  const A = {
    ready: false,
    muted: localStorage.getItem("sm-voice-muted") === "1",
  };
  window.Photographe = A;

  let img = null, canvas = null, ctx = null, container = null;
  let W = 1254, H = 1254;
  let skin = "#c9986f";

  // ── État ──
  let t = 0;
  let state = "idle";              // idle | speak | end | listen | react
  let stateT = 0;
  let gazeTX = 0, gazeTY = 0;      // cible du regard (-1..1)
  let gx = 0, gy = 0;              // pupilles (rapides)
  let hx = 0, hy = 0, hvx = 0, hvy = 0; // tête (ressort, en retard)
  let lastMove = -10;
  let blinkAt = 2, blinkPhase = -1;
  let viseme = { sx: 1, sy: 1, open: 0, smile: 0 };
  let visemeTarget = { sx: 1, sy: 1, open: 0, smile: 0 };
  let visemeQueue = [];
  let talking = false;
  let reactKind = null;
  let fxUntil = 0, nextFx = 8;

  // ── Visèmes procéduraux (transformations de la zone bouche) ──
  const VIS = {
    sil: { sx: 1, sy: 1, open: 0 },
    aa: { sx: 1.04, sy: 1.5, open: 0.85 },
    E: { sx: 1.1, sy: 1.22, open: 0.45 },
    I: { sx: 1.14, sy: 1.08, open: 0.25 },
    O: { sx: 0.8, sy: 1.42, open: 0.75 },
    U: { sx: 0.74, sy: 1.22, open: 0.5 },
    PP: { sx: 0.96, sy: 0.86, open: 0 },
    FF: { sx: 1.05, sy: 0.94, open: 0.12 },
    SS: { sx: 1.09, sy: 1.04, open: 0.18 },
    CH: { sx: 0.88, sy: 1.18, open: 0.35 },
    DD: { sx: 1.0, sy: 1.14, open: 0.3 },
  };

  function charViseme(ch) {
    const c = ch.toLowerCase();
    if ("aàâ".includes(c)) return VIS.aa;
    if ("eéèêë".includes(c)) return VIS.E;
    if ("iïy".includes(c)) return VIS.I;
    if ("oôö".includes(c)) return VIS.O;
    if ("uùûü".includes(c)) return VIS.U;
    if ("mbp".includes(c)) return VIS.PP;
    if ("fv".includes(c)) return VIS.FF;
    if ("szc".includes(c)) return VIS.SS;
    if ("jg".includes(c)) return VIS.CH;
    if ("tdnlkqrx".includes(c)) return VIS.DD;
    return null;
  }

  function queueWord(word, duration) {
    const now = performance.now();
    const shapes = [];
    for (const ch of word) {
      const v = charViseme(ch);
      if (v) shapes.push(v);
    }
    if (!shapes.length) return;
    const dt = Math.min(115, duration / shapes.length);
    visemeQueue = shapes.map((v, i) => ({ at: now + i * dt, v }));
    visemeQueue.push({ at: now + shapes.length * dt, v: VIS.sil });
  }

  // ── Voix ──
  let frVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    frVoice = vs.find(v => v.lang.startsWith("fr") && /amelie|thomas|audrey|marie|google/i.test(v.name))
      || vs.find(v => v.lang.startsWith("fr")) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.addEventListener("voiceschanged", pickVoice);
  }

  let typeTimer = null;

  function say(text) {
    const msgEl = document.getElementById("assistant-msg");
    if (!msgEl) return;
    clearInterval(typeTimer);
    try { speechSynthesis.cancel(); } catch {}
    visemeQueue = [];
    if (reduced || !A.ready) { msgEl.textContent = text; return; }

    setState("speak");
    talking = true;
    msgEl.textContent = "";

    if (!A.muted && frVoice) {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = frVoice;
      u.lang = frVoice.lang;
      u.rate = 1.04;
      u.onboundary = ev => {
        const rest = text.slice(ev.charIndex);
        const word = (rest.match(/^[\p{L}'-]+/u) || [rest.slice(0, 6)])[0];
        msgEl.textContent = text.slice(0, ev.charIndex + word.length);
        queueWord(word, Math.max(180, word.length * 70));
      };
      u.onend = () => { msgEl.textContent = text; endTalk(); };
      u.onerror = () => { msgEl.textContent = text; endTalk(); };
      speechSynthesis.speak(u);
    } else {
      let i = 0;
      typeTimer = setInterval(() => {
        i += 2;
        msgEl.textContent = text.slice(0, i);
        queueWord(text.slice(Math.max(0, i - 2), i), 130);
        if (i >= text.length) { clearInterval(typeTimer); endTalk(); }
      }, 26);
    }
  }

  function endTalk() {
    talking = false;
    visemeQueue = [{ at: performance.now(), v: VIS.sil }];
    setState("end"); // contact visuel ~500 ms puis tête inclinée + regard vers les réponses
  }

  function react(kind) {
    if (!A.ready || reduced) return;
    reactKind = kind || "positive";
    setState("react");
  }

  function setState(s) {
    state = s;
    stateT = 0;
  }

  // ── Rendu ──
  function drawEye(e, dx, dy, blink) {
    // L'œil (iris + blanc) est recadré et translaté sous les paupières fixes.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, 7);
    ctx.clip();
    ctx.drawImage(img, e.cx - e.rx - 12 + dx, e.cy - e.ry - 12 + dy,
      (e.rx + 12) * 2, (e.ry + 12) * 2,
      e.cx - e.rx - 12, e.cy - e.ry - 12,
      (e.rx + 12) * 2, (e.ry + 12) * 2);
    // Paupière : voile de peau qui descend au clignement
    if (blink > 0.02) {
      ctx.fillStyle = skin;
      ctx.globalAlpha = 0.98;
      ctx.beginPath();
      ctx.ellipse(e.cx, e.cy - e.ry * (1 - blink * 2), e.rx + 3, e.ry * blink * 1.6, 0, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawMouth() {
    const mo = CAL.mouth;
    const v = viseme;
    const bx = mo.cx - mo.w / 2, by = mo.cy - mo.h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(mo.cx, mo.cy, mo.w / 2, mo.h / 2, 0, 0, 7);
    ctx.clip();
    // fond : peau étirée derrière la bouche transformée
    ctx.drawImage(img, bx, by, mo.w, mo.h, bx, by, mo.w, mo.h);
    if (v.open > 0.12) {
      // bouche entrouverte : intérieur sombre derrière la zone étirée
      ctx.fillStyle = "rgba(30,12,10,0.95)";
      ctx.beginPath();
      ctx.ellipse(mo.cx, mo.cy + mo.h * 0.08, mo.w * 0.3 * v.sx, mo.h * 0.42 * v.open, 0, 0, 7);
      ctx.fill();
    }
    // la zone bouche redessinée avec l'échelle du visème (autour de la lèvre sup.)
    const sy = v.sy + (v.smile || 0) * -0.05;
    const sx = v.sx + (v.smile || 0) * 0.06;
    ctx.translate(mo.cx, mo.cy - mo.h * 0.18);
    ctx.scale(sx, sy);
    ctx.translate(-mo.cx, -(mo.cy - mo.h * 0.18));
    ctx.globalAlpha = v.open > 0.12 ? 0.9 : 1;
    ctx.drawImage(img, bx, by, mo.w, mo.h, bx, by, mo.w, mo.h);
    ctx.restore();
  }

  function drawFx() {
    // Effet « mise au point » : cadre photo + particules, entre deux questions
    if (t > fxUntil) return;
    const k = Math.min(1, (fxUntil - t) / 0.4, (t - (fxUntil - 2)) / 0.4);
    ctx.save();
    ctx.globalAlpha = 0.5 * Math.max(0, k);
    ctx.strokeStyle = "#C65E29";
    ctx.lineWidth = 5;
    const cx = CAL.headPivot.x, cy = 430, s = 330 + Math.sin(t * 2.2) * 14;
    for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + ox * s, cy + oy * s - oy * 46);
      ctx.lineTo(cx + ox * s, cy + oy * s);
      ctx.lineTo(cx + ox * s - ox * 46, cy + oy * s);
      ctx.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const a = t * 0.7 + i * 0.7;
      ctx.fillStyle = ["#C65E29", "#4C6FBF", "#8A5AB8"][i % 3];
      ctx.globalAlpha = 0.3 * Math.max(0, k);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (390 + i * 14), cy + Math.sin(a * 1.3) * 300, 7 + (i % 3) * 3, 0, 7);
      ctx.fill();
    }
    ctx.restore();
  }

  function loop() {
    if (!document.hidden && container && !container.classList.contains("hidden")) {
      t += 0.016;
      stateT += 0.016;

      // ── Cible du regard selon l'état ──
      let tx = gazeTX, ty = gazeTY;
      const idle = t - lastMove > 4;
      if (state === "speak") { tx *= 0.25; ty *= 0.25; }              // contact visuel
      else if (state === "end") {
        if (stateT > 0.5) { tx = -0.25; ty = 0.85; }                   // regarde les réponses (dessous)
        if (stateT > 2.2) setState("listen");
      } else if (state === "listen") {
        const ph = Math.sin(stateT * 0.7);
        if (ph > 0.4) { tx = -0.2; ty = 0.7; }                         // alterne réponses / utilisateur
        else { tx *= 0.4; ty *= 0.4; }
      } else if (state === "react") {
        tx = 0; ty = 0;
        if (stateT > 1.2) setState("idle");
      } else if (idle) { tx = 0; ty = 0; }                             // retour caméra

      // Pupilles d'abord (rapide), tête ensuite (ressort, retard, faible amplitude)
      gx += (tx - gx) * 0.14;
      gy += (ty - gy) * 0.14;
      const k = 0.05, damp = 0.86;
      hvx = (hvx + (gx * 0.5 - hx) * k) * damp;
      hvy = (hvy + (gy * 0.5 - hy) * k) * damp;
      hx += hvx; hy += hvy;

      // Clignements 3-7 s
      if (blinkPhase < 0 && t > blinkAt) blinkPhase = 0;
      let blink = 0;
      if (blinkPhase >= 0) {
        blinkPhase += 0.016;
        blink = blinkPhase < 0.09 ? blinkPhase / 0.09 : Math.max(0, 1 - (blinkPhase - 0.09) / 0.1);
        if (blinkPhase > 0.2) { blinkPhase = -1; blinkAt = t + 3 + Math.random() * 4; }
      }

      // Visèmes programmés
      const now = performance.now();
      while (visemeQueue.length && visemeQueue[0].at <= now) {
        visemeTarget = { ...visemeQueue.shift().v, smile: visemeTarget.smile };
      }
      // Réaction : sourire + hochement
      visemeTarget.smile = state === "react" && reactKind === "positive" ? 0.5
        : state === "listen" || state === "idle" ? 0.12 : 0;
      for (const key of ["sx", "sy", "open", "smile"]) {
        viseme[key] += ((visemeTarget[key] ?? (key === "sx" || key === "sy" ? 1 : 0)) - viseme[key]) * 0.45;
      }

      // ── Dessin ──
      const cw = canvas.width, chh = canvas.height;
      ctx.clearRect(0, 0, cw, chh);
      ctx.save();
      // cadrage : buste, ~92 % de la largeur image, centré sur le visage
      const scale = cw / (W * 0.92);
      ctx.translate(cw / 2, 0);
      ctx.scale(scale, scale);
      ctx.translate(-CAL.headPivot.x, -140);

      // tête + buste : rotation/translation subtiles (respiration incluse)
      const nod = state === "react" ? Math.sin(stateT * 9) * 0.02 * Math.max(0, 1 - stateT) : 0;
      const inhale = state === "speak" && stateT < 0.35 ? stateT / 0.35 * 0.006 : 0;
      ctx.translate(CAL.headPivot.x, CAL.headPivot.y);
      ctx.rotate(hx * 0.05 + Math.sin(t * 0.5) * 0.004 + nod * 0.4);
      const breath = 1 + Math.sin(t * 0.95) * 0.004 + inhale;
      ctx.scale(breath, breath);
      ctx.translate(-CAL.headPivot.x, -CAL.headPivot.y + hy * 6 + nod * 40);

      ctx.drawImage(img, 0, 0);
      // regard : ±9 px horizontal, ±6 px vertical (jamais aux extrémités)
      const dx = gx * 9, dy = gy * 6;
      drawEye(CAL.eyeL, dx, dy, blink);
      drawEye(CAL.eyeR, dx, dy, blink);
      drawMouth();
      ctx.restore();

      drawFx();
      // effet focus occasionnel entre les questions
      if (state === "idle" && t > nextFx) {
        fxUntil = t + 2;
        nextFx = t + 14 + Math.random() * 10;
      }
    }
    requestAnimationFrame(loop);
  }

  // ── Intégration ──
  function setStage(mode) {
    if (!container) return;
    const on = mode === "big" && A.ready;
    container.classList.toggle("hidden", !on);
    const card = document.getElementById("assistant");
    if (card) card.classList.toggle("no-face", on);
    if (on) requestAnimationFrame(resize);
  }

  function resize() {
    if (!canvas || !container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * ratio;
    canvas.height = h * ratio;
  }

  function init() {
    container = document.getElementById("avatar-stage");
    if (!container) return;
    img = new Image();
    img.src = "assets/photographe.jpg";
    img.onload = () => {
      W = img.naturalWidth; H = img.naturalHeight;
      canvas = document.createElement("canvas");
      canvas.className = "a25-canvas";
      container.appendChild(canvas);
      ctx = canvas.getContext("2d");
      // échantillonne la couleur de peau pour les paupières
      const s = document.createElement("canvas");
      s.width = s.height = 3;
      s.getContext("2d").drawImage(img, CAL.skinSample.x, CAL.skinSample.y, 3, 3, 0, 0, 3, 3);
      const px = s.getContext("2d").getImageData(1, 1, 1, 1).data;
      skin = `rgb(${px[0]},${px[1]},${px[2]})`;
      window.addEventListener("resize", resize);
      window.addEventListener("pointermove", ev => {
        gazeTX = (ev.clientX / window.innerWidth) * 2 - 1;
        gazeTY = (ev.clientY / window.innerHeight) * 2 - 1;
        lastMove = t;
      }, { passive: true });
      A.ready = true;
      if (reduced) {
        // version statique : une seule frame
        resize();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return;
      }
      setStage(document.getElementById("step-1")?.classList.contains("hidden") ? "off" : "big");
      requestAnimationFrame(loop);
    };
  }

  A.say = say;
  A.react = react;
  A.setStage = setStage;
  A.toggleMute = () => {
    A.muted = !A.muted;
    localStorage.setItem("sm-voice-muted", A.muted ? "1" : "0");
    if (A.muted) { try { speechSynthesis.cancel(); } catch {} }
    return A.muted;
  };

  document.addEventListener("DOMContentLoaded", init);
  return A;
})();
