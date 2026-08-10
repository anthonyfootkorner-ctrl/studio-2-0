// Correction de couleur ciblée : la teinte échantillonnée sur la photo source est
// appliquée à l'image générée, pondérée par la similarité de couleur (espace Lab).
// La peau, le fond et les autres couleurs restent intacts. 100 % local, gratuit.

const ColorFix = (() => {
  const el = id => document.getElementById(id);

  // ── Conversions sRGB ↔ Lab (D65) ──
  function rgb2lab(r, g, b) {
    const f = u => (u > 0.04045 ? Math.pow((u + 0.055) / 1.055, 2.4) : u / 12.92);
    const R = f(r / 255), G = f(g / 255), B = f(b / 255);
    let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const t = v => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    X = t(X); Y = t(Y); Z = t(Z);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  }
  function lab2rgb(L, a, b2) {
    const Y = (L + 16) / 116, X = a / 500 + Y, Z = Y - b2 / 200;
    const f = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
    const x = f(X) * 0.95047, y = f(Y), z = f(Z) * 1.08883;
    let R = x * 3.2406 + y * -1.5372 + z * -0.4986;
    let G = x * -0.9689 + y * 1.8758 + z * 0.0415;
    let B = x * 0.0557 + y * -0.204 + z * 1.057;
    const g = u => (u > 0.0031308 ? 1.055 * Math.pow(u, 1 / 2.4) - 0.055 : 12.92 * u);
    return [g(R) * 255, g(G) * 255, g(B) * 255];
  }

  // ── État ──
  let srcRect = null, dstRect = null, drag = null;
  let scaleSrc = 1, scaleDst = 1;
  let backup = null; // ImageData de la génération avant la dernière correction
  let onChange = null;

  function meanLab(canvas, rect) {
    const ctx = canvas.getContext("2d");
    const d = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data;
    let L = 0, a = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lab = rgb2lab(d[i], d[i + 1], d[i + 2]);
      L += lab[0]; a += lab[1]; b += lab[2]; n++;
    }
    return [L / n, a / n, b / n];
  }

  function draw() {
    const src = App.state.sourceCanvas, gen = App.state.genCanvas;
    for (const [canvasId, base, rect, scale] of [
      ["canvas-color-src", src, srcRect, scaleSrc],
      ["canvas-color-dst", gen, dstRect, scaleDst],
    ]) {
      const c = el(canvasId);
      const ctx = c.getContext("2d");
      ctx.drawImage(base, 0, 0, c.width, c.height);
      const r = (drag && drag.canvasId === canvasId && drag.cur) ? drag.toRect() : rect;
      if (r) {
        ctx.strokeStyle = "#C65E29";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
        ctx.setLineDash([]);
      }
    }
    el("color-src-state").textContent = srcRect ? "✓" : "…";
    el("color-dst-state").textContent = dstRect ? "✓" : "…";
    el("btn-color-apply").disabled = !(srcRect && dstRect);
    el("btn-color-undo").disabled = !backup;
    if (srcRect && dstRect) {
      const ms = meanLab(App.state.sourceCanvas, srcRect);
      const md = meanLab(App.state.genCanvas, dstRect);
      const dE = Math.hypot(ms[0] - md[0], ms[1] - md[1], ms[2] - md[2]);
      el("color-info").textContent = `Écart de couleur mesuré : ΔE ≈ ${dE.toFixed(1)} (2 = imperceptible, 10+ = net)`;
    }
  }

  function setupCanvas(canvasId, base) {
    const c = el(canvasId);
    const maxW = 520;
    const s = Math.min(1, maxW / base.width);
    c.width = Math.round(base.width * s);
    c.height = Math.round(base.height * s);
    c.style.cursor = "crosshair";
    return s;
  }

  function pos(ev, canvasId, scale) {
    const c = el(canvasId);
    const r = c.getBoundingClientRect();
    const cssScale = c.width / r.width;
    return { x: (ev.clientX - r.left) * cssScale / scale, y: (ev.clientY - r.top) * cssScale / scale };
  }

  function wireCanvas(canvasId, getScale, setRect) {
    const c = el(canvasId);
    c.addEventListener("pointerdown", ev => {
      const p = pos(ev, canvasId, getScale());
      drag = {
        canvasId, x0: p.x, y0: p.y, cur: null,
        toRect() {
          return {
            x: Math.round(Math.min(this.x0, this.cur.x)), y: Math.round(Math.min(this.y0, this.cur.y)),
            w: Math.round(Math.abs(this.cur.x - this.x0)), h: Math.round(Math.abs(this.cur.y - this.y0)),
          };
        },
      };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener("pointermove", ev => {
      if (!drag || drag.canvasId !== canvasId) return;
      drag.cur = pos(ev, canvasId, getScale());
      draw();
    });
    c.addEventListener("pointerup", () => {
      if (!drag || drag.canvasId !== canvasId) return;
      const r = drag.cur ? drag.toRect() : null;
      drag = null;
      if (r && r.w >= 4 && r.h >= 4) setRect(r);
      draw();
    });
  }

  function apply() {
    const gen = App.state.genCanvas;
    const ctx = gen.getContext("2d");
    const target = meanLab(App.state.sourceCanvas, srcRect);
    const current = meanLab(gen, dstRect);
    const delta = [target[0] - current[0], target[1] - current[1], target[2] - current[2]];
    const sigma = +el("color-tolerance").value;

    const W = gen.width, H = gen.height;
    const id = ctx.getImageData(0, 0, W, H);
    backup = new ImageData(new Uint8ClampedArray(id.data), W, H);
    const d = id.data;

    // La teinte (a,b) pèse plus que la luminosité (L) : les ombres et plis du
    // même tissu restent couverts, mais la peau (teinte différente) est épargnée.
    const distAt = p => {
      const i = p * 4;
      const lab = rgb2lab(d[i], d[i + 1], d[i + 2]);
      return Math.hypot(0.4 * (lab[0] - current[0]), lab[1] - current[1], lab[2] - current[2]);
    };
    const cutoff = sigma * 1.8;

    // Limitation à la zone contiguë : la correction se propage de proche en proche
    // depuis le cadre tracé et s'arrête aux frontières du panneau — le fond ou une
    // autre pièce de la même couleur ailleurs dans l'image ne sont pas touchés.
    let allow = null;
    if (el("color-contiguous").checked) {
      const labAt = p => {
        const i = p * 4;
        return rgb2lab(d[i], d[i + 1], d[i + 2]);
      };
      // Marche de couleur entre deux pixels voisins : au-delà de ce seuil, c'est une
      // frontière (bord du vêtement, contour, ombre marquée) — on ne la franchit pas.
      const EDGE = 4;
      const step = (p, n) => {
        const a = labAt(p), b = labAt(n);
        return Math.hypot(0.4 * (a[0] - b[0]), a[1] - b[1], a[2] - b[2]);
      };
      allow = new Uint8Array(W * H);
      const queue = new Int32Array(W * H);
      let head = 0, tail = 0;
      const x1 = Math.min(W - 1, dstRect.x + dstRect.w), y1 = Math.min(H - 1, dstRect.y + dstRect.h);
      for (let y = Math.max(0, dstRect.y); y <= y1; y++) {
        for (let x = Math.max(0, dstRect.x); x <= x1; x++) {
          const p = y * W + x;
          if (!allow[p] && distAt(p) <= cutoff) { allow[p] = 1; queue[tail++] = p; }
        }
      }
      const tryGrow = (p, n) => {
        if (!allow[n] && distAt(n) <= cutoff && step(p, n) <= EDGE) {
          allow[n] = 1; queue[tail++] = n;
        }
      };
      while (head < tail) {
        const p = queue[head++];
        const x = p % W, y = (p / W) | 0;
        if (x > 0) tryGrow(p, p - 1);
        if (x < W - 1) tryGrow(p, p + 1);
        if (y > 0) tryGrow(p, p - W);
        if (y < H - 1) tryGrow(p, p + W);
      }
    }

    for (let p = 0; p < W * H; p++) {
      if (allow && !allow[p]) continue;
      const i = p * 4;
      const lab = rgb2lab(d[i], d[i + 1], d[i + 2]);
      const dist = Math.hypot(0.4 * (lab[0] - current[0]), lab[1] - current[1], lab[2] - current[2]);
      if (dist > cutoff) continue; // hors tolérance : pixel intact
      // Chute quartique : pleine correction dans la tolérance, coupure rapide au-delà.
      const w = Math.exp(-Math.pow(dist / sigma, 4));
      const rgb = lab2rgb(lab[0] + w * delta[0], lab[1] + w * delta[1], lab[2] + w * delta[2]);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    ctx.putImageData(id, 0, 0);
    srcRect = null; dstRect = null;
    draw();
    if (onChange) onChange();
  }

  function undo() {
    if (!backup) return;
    App.state.genCanvas.getContext("2d").putImageData(backup, 0, 0);
    backup = null;
    draw();
    if (onChange) onChange();
  }

  function open(changeCb) {
    if (!App.state.sourceCanvas || !App.state.genCanvas) return;
    onChange = changeCb || null;
    srcRect = null; dstRect = null; backup = null;
    scaleSrc = setupCanvas("canvas-color-src", App.state.sourceCanvas);
    scaleDst = setupCanvas("canvas-color-dst", App.state.genCanvas);
    el("color-info").textContent = "";
    el("color-modal").classList.remove("hidden");
    draw();
  }

  function wire() {
    wireCanvas("canvas-color-src", () => scaleSrc, r => { srcRect = r; });
    wireCanvas("canvas-color-dst", () => scaleDst, r => { dstRect = r; });
    el("btn-color-apply").addEventListener("click", apply);
    el("btn-color-undo").addEventListener("click", undo);
    el("btn-color-close").addEventListener("click", () => el("color-modal").classList.add("hidden"));
  }

  document.addEventListener("DOMContentLoaded", wire);
  return { open };
})();
