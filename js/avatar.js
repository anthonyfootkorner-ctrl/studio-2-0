// Avatar « scan 3D » de l'assistant : portrait rendu en particules qui se
// désintègrent et se reforment en boucle, balayé par un maillage filaire et des
// lignes de scan — inspiré des heros « digital human ». 100 % canvas local.
// Quand une génération réussit, le visage du mannequin devient le portrait scanné.

const Avatar = (() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const S = 220; // résolution interne du canvas (affiché ~110 px)
  let box = null, rig = null, canvas = null, ctx = null;
  let portrait = null;      // canvas 220×220 du portrait courant
  let particles = [];
  let t = 0;                // horloge du cycle
  let talking = false;
  // Ressort du suivi souris
  let targetRX = 0, targetRY = 0, rx = 0, ry = 0, vx = 0, vy = 0;

  // ── Portrait par défaut : la silhouette stylisée à lunettes ──
  function makeDefaultPortrait() {
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const x = c.getContext("2d");
    const g = x.createRadialGradient(S * 0.38, S * 0.26, 10, S * 0.5, S * 0.5, S * 0.62);
    g.addColorStop(0, "#D97742");
    g.addColorStop(0.55, "#C65E29");
    g.addColorStop(1, "#2c1004");
    x.fillStyle = g;
    x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, 7); x.fill();
    x.fillStyle = "#20100a";
    x.beginPath(); x.ellipse(S / 2, S * 0.38, S * 0.17, S * 0.19, 0, 0, 7); x.fill();
    x.beginPath();
    x.moveTo(S * 0.12, S * 0.94); x.quadraticCurveTo(S / 2, S * 0.58, S * 0.88, S * 0.94);
    x.lineTo(S * 0.88, S); x.lineTo(S * 0.12, S); x.closePath(); x.fill();
    x.fillStyle = "#0d0603";
    const rr = (px, py, w, h, r) => { x.beginPath(); x.roundRect(px, py, w, h, r); x.fill(); };
    rr(S * 0.29, S * 0.30, S * 0.18, S * 0.105, S * 0.05);
    rr(S * 0.53, S * 0.30, S * 0.18, S * 0.105, S * 0.05);
    rr(S * 0.45, S * 0.335, S * 0.10, S * 0.026, S * 0.013);
    x.fillStyle = "#3a2413";
    rr(S * 0.30, S * 0.31, S * 0.16, S * 0.085, S * 0.042);
    rr(S * 0.54, S * 0.31, S * 0.16, S * 0.085, S * 0.042);
    return c;
  }

  // ── Adoption du visage d'un mannequin généré ──
  function adopt(genCanvas) {
    if (!genCanvas) return;
    // Cadre carré sur la tête : centré, haut de l'image (marge ~4 %)
    const side = Math.min(genCanvas.width * 0.5, genCanvas.height * 0.34);
    const sx = (genCanvas.width - side) / 2;
    const sy = genCanvas.height * 0.04;
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const x = c.getContext("2d");
    x.save();
    x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, 7); x.clip();
    x.imageSmoothingQuality = "high";
    x.drawImage(genCanvas, sx, sy, side, side, 0, 0, S, S);
    // Le fond studio (gris clair neutre) devient sombre : le visage ressort
    // sur fond noir comme dans la référence, sans toucher peau ni vêtement.
    const id = x.getImageData(0, 0, S, S);
    const dd = id.data;
    for (let i = 0; i < dd.length; i += 4) {
      const r = dd[i], g = dd[i + 1], b = dd[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 165 && mx - mn < 22) { // gris clair neutre = fond studio
        const f = Math.min(1, (mn - 165) / 40) * 0.94;
        dd[i] = r + (10 - r) * f;
        dd[i + 1] = g + (7 - g) * f;
        dd[i + 2] = b + (5 - b) * f;
      }
    }
    x.putImageData(id, 0, 0);
    // Vignettage : le fond studio clair fond dans le noir, comme la référence.
    const v = x.createRadialGradient(S / 2, S * 0.42, S * 0.22, S / 2, S / 2, S * 0.52);
    v.addColorStop(0, "rgba(10,6,4,0)");
    v.addColorStop(0.75, "rgba(10,6,4,0.45)");
    v.addColorStop(1, "rgba(10,6,4,0.92)");
    x.fillStyle = v;
    x.fillRect(0, 0, S, S);
    x.restore();
    setPortrait(c);
  }

  function setPortrait(c) {
    portrait = c;
    buildParticles();
  }

  function buildParticles() {
    particles = [];
    const d = portrait.getContext("2d").getImageData(0, 0, S, S).data;
    const step = 4;
    for (let y = 0; y < S; y += step) {
      for (let x = 0; x < S; x += step) {
        const i = (y * S + x) * 4;
        if (d[i + 3] < 40) continue;
        const ang = Math.random() * Math.PI * 2;
        const spd = 14 + Math.random() * 34;
        particles.push({
          x, y,
          c: `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`,
          dx: Math.cos(ang) * spd,
          dy: Math.sin(ang) * spd * 0.7 - 6,
          w: Math.random() * 6,
        });
      }
    }
  }

  const easeIO = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

  // Facteur de dispersion 0..1 selon la position dans le cycle (~5,6 s)
  function dispersal(ct) {
    const m = ct % 5.6;
    if (m < 2.4) return 0;                          // portrait net
    if (m < 3.2) return easeIO((m - 2.4) / 0.8);    // désintégration
    if (m < 3.7) return 1;                          // dispersé
    if (m < 4.7) return 1 - easeIO((m - 3.7) / 1);  // reformation
    return 0;
  }

  function draw() {
    ctx.clearRect(0, 0, S, S);
    const k = dispersal(t);
    if (k === 0) {
      ctx.drawImage(portrait, 0, 0);
    } else {
      for (const p of particles) {
        const px = p.x + p.dx * k + Math.sin(t * 3 + p.w) * 4 * k;
        const py = p.y + p.dy * k + Math.cos(t * 2.6 + p.w) * 3 * k;
        ctx.globalAlpha = 1 - k * 0.45;
        ctx.fillStyle = p.c;
        ctx.fillRect(px, py, 3, 3);
      }
      ctx.globalAlpha = 1;
    }

    // Maillage filaire : lignes verticales + contours du visage
    const wire = Math.max(k, talking ? 0.5 + Math.sin(t * 10) * 0.25 : 0);
    if (wire > 0.02) {
      ctx.globalAlpha = wire * 0.5;
      ctx.strokeStyle = "#f6efe8";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = -t * 40;
      for (let i = 0; i < 7; i++) {
        const lx = S * 0.2 + i * S * 0.1;
        ctx.beginPath(); ctx.moveTo(lx, S * 0.06); ctx.lineTo(lx, S * 0.7); ctx.stroke();
      }
      ctx.setLineDash([3, 5]);
      for (let e = 0; e < 3; e++) {
        ctx.beginPath();
        ctx.ellipse(S / 2, S * 0.4, S * (0.14 + e * 0.05), S * (0.19 + e * 0.05),
          Math.sin(t * 0.8) * 0.15, 0, 7);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Ligne de scan périodique quand le portrait est net
    const sm = t % 5.6;
    if (k === 0 && sm > 0.4 && sm < 1.2) {
      const sy = ((sm - 0.4) / 0.8) * S;
      const grad = ctx.createLinearGradient(0, sy - 14, 0, sy + 14);
      grad.addColorStop(0, "rgba(246,239,232,0)");
      grad.addColorStop(0.5, "rgba(246,239,232,0.35)");
      grad.addColorStop(1, "rgba(246,239,232,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, sy - 14, S, 28);
    }
  }

  function onPointer(ev) {
    const r = box.getBoundingClientRect();
    targetRY = Math.max(-16, Math.min(16, (ev.clientX - (r.left + r.width / 2)) / 30));
    targetRX = Math.max(-9, Math.min(12, -(ev.clientY - (r.top + r.height / 2)) / 34));
  }

  function loop() {
    if (!document.hidden) {
      t += 0.016;
      const kk = 0.085, damp = 0.8;
      vx = (vx + (targetRX - rx) * kk) * damp;
      vy = (vy + (targetRY - ry) * kk) * damp;
      rx += vx; ry += vy;
      const bob = Math.sin(t * 1.1) * 1.2;
      const breath = 1 + Math.sin(t * 0.9) * 0.012;
      rig.style.transform =
        `rotateX(${(rx + bob * 0.4).toFixed(2)}deg) rotateY(${(ry + Math.sin(t * 0.55) * 2).toFixed(2)}deg) scale(${breath.toFixed(3)})`;
      draw();
    }
    requestAnimationFrame(loop);
  }

  let typeTimer = null;

  function say(text) {
    const msgEl = document.getElementById("assistant-msg");
    if (!msgEl) return;
    clearInterval(typeTimer);
    if (reduced || !ctx) {
      msgEl.textContent = text;
      return;
    }
    talking = true;
    msgEl.textContent = "";
    let i = 0;
    typeTimer = setInterval(() => {
      i += 2;
      msgEl.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(typeTimer);
        talking = false;
      }
    }, 22);
  }

  function init() {
    box = document.getElementById("avatar3d");
    rig = document.getElementById("a3-rig");
    canvas = document.getElementById("a3-canvas");
    if (!box || !rig || !canvas) return;
    ctx = canvas.getContext("2d");
    setPortrait(makeDefaultPortrait());
    if (reduced) { draw(); return; } // image fixe, pas d'animation
    window.addEventListener("pointermove", onPointer, { passive: true });
    requestAnimationFrame(loop);
  }

  document.addEventListener("DOMContentLoaded", init);
  return { say, adopt };
})();
