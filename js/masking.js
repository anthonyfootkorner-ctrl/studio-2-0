// Détourage des logos : masque automatique + éditeur à pinceaux (Garder / Effacer).
// Règle du skill : on ne modifie jamais les couleurs, seulement l'alpha des pixels source.

const Masking = (() => {

  // ---- Helpers partagés ----

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function drawChecker(ctx, w, h, tile = 12) {
    for (let y = 0; y < h; y += tile) {
      for (let x = 0; x < w; x += tile) {
        ctx.fillStyle = ((x / tile + y / tile) % 2) ? "#858585" : "#bdbdbd";
        ctx.fillRect(x, y, tile, tile);
      }
    }
  }

  // Estime la couleur du tissu à partir d'un anneau de bordure du recadrage,
  // puis alpha = distance couleur → au-delà du seuil le pixel est conservé.
  function autoMask(imgData, type, threshold) {
    const { width: w, height: h, data } = imgData;
    const alpha = new Uint8ClampedArray(w * h);
    if (type === "patch") { alpha.fill(255); return alpha; }

    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const rs = [], gs = [], bs = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
        const i = (y * w + x) * 4;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
    }
    const med = arr => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
    const br = med(rs), bg = med(gs), bb = med(bs);

    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const d = Math.sqrt(
        (data[i] - br) ** 2 + (data[i + 1] - bg) ** 2 + (data[i + 2] - bb) ** 2
      );
      // Rampe douce autour du seuil pour préserver l'anticrénelage.
      const t = (d - threshold * 0.6) / (threshold * 0.8);
      alpha[p] = Math.max(0, Math.min(1, t)) * 255;
    }
    return alpha;
  }

  // Applique un masque alpha aux pixels RVB du recadrage → canvas transparent.
  function buildCropCanvas(imgData, alpha) {
    const { width: w, height: h } = imgData;
    const out = new ImageData(new Uint8ClampedArray(imgData.data), w, h);
    for (let p = 0; p < w * h; p++) out.data[p * 4 + 3] = alpha[p];
    const c = makeCanvas(w, h);
    c.getContext("2d").putImageData(out, 0, 0);
    return c;
  }

  // Fusion du bord : contraction (érosion) puis feather (flou) du masque alpha seul.
  function refineAlpha(alpha, w, h, contract, feather) {
    let a = alpha;
    for (let n = 0; n < contract; n++) {
      const b = new Uint8ClampedArray(a.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let m = 255;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.max(0, Math.min(w - 1, x + dx));
              m = Math.min(m, a[yy * w + xx]);
            }
          }
          b[y * w + x] = m;
        }
      }
      a = b;
    }
    if (feather > 0) {
      const r = Math.max(1, Math.round(feather));
      for (let pass = 0; pass < 2; pass++) {
        const b = new Uint8ClampedArray(a.length);
        // horizontal
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let dx = -r; dx <= r; dx++) {
              const xx = x + dx;
              if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; }
            }
            b[y * w + x] = s / n;
          }
        }
        // vertical
        const c = new Uint8ClampedArray(a.length);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let dy = -r; dy <= r; dy++) {
              const yy = y + dy;
              if (yy >= 0 && yy < h) { s += b[yy * w + x]; n++; }
            }
            c[y * w + x] = s / n;
          }
        }
        a = c;
      }
    }
    return a;
  }

  // ---- Éditeur modal ----

  const el = id => document.getElementById(id);
  let cur = null; // { logo, imgData, alpha, undoStack, zoom, tool, brush, onSave }

  function open(logo, imgData, onSave) {
    cur = {
      logo, imgData, onSave,
      alpha: new Uint8ClampedArray(logo.mask ? logo.mask : autoMask(imgData, logo.type, +el("mask-threshold").value)),
      undoStack: [],
      tool: "keep",
      pointer: null,
      drawing: false,
    };
    el("mask-title").textContent = "Détourage — " + logo.name;
    el("mask-type").value = logo.type;
    el("row-threshold").style.display = logo.type === "print" ? "" : "none";
    el("mask-editor").classList.remove("hidden");
    fitZoom();
    render();
  }

  function fitZoom() {
    const { width: w } = cur.imgData;
    const target = Math.min(800, Math.max(100, Math.round(48000 / w / 50) * 50));
    el("mask-zoom").value = target;
  }

  function zoom() { return +el("mask-zoom").value / 100; }
  function brushRadius() { return +el("brush-size").value / 2; }

  function render() {
    if (!cur) return;
    const { imgData, alpha, pointer } = cur;
    const w = imgData.width, h = imgData.height, z = zoom();

    // Gauche : pixels originaux, suppression en rouge translucide.
    const src = el("canvas-mask-src");
    src.width = w * z; src.height = h * z;
    const sctx = src.getContext("2d");
    sctx.imageSmoothingEnabled = z < 1;
    const full = makeCanvas(w, h);
    full.getContext("2d").putImageData(imgData, 0, 0);
    sctx.drawImage(full, 0, 0, w * z, h * z);
    const overlay = new ImageData(w, h);
    for (let p = 0; p < w * h; p++) {
      const removed = 255 - alpha[p];
      overlay.data[p * 4] = 255;
      overlay.data[p * 4 + 3] = removed * 0.55;
    }
    const ovc = makeCanvas(w, h);
    ovc.getContext("2d").putImageData(overlay, 0, 0);
    sctx.drawImage(ovc, 0, 0, w * z, h * z);

    // Droite : résultat sur damier.
    const out = el("canvas-mask-out");
    out.width = w * z; out.height = h * z;
    const octx = out.getContext("2d");
    drawChecker(octx, out.width, out.height);
    octx.imageSmoothingEnabled = z < 1;
    octx.drawImage(buildCropCanvas(imgData, alpha), 0, 0, w * z, h * z);

    // Cercle d'aperçu du pinceau (vert = Garder, rouge = Effacer).
    if (pointer) {
      for (const ctx of [sctx, octx]) {
        ctx.beginPath();
        ctx.arc(pointer.x * z, pointer.y * z, brushRadius() * z, 0, Math.PI * 2);
        ctx.strokeStyle = cur.tool === "keep" ? "#2ea25f" : "#d05050";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function applyBrush(x, y) {
    const { imgData, alpha } = cur;
    const w = imgData.width, h = imgData.height, r = brushRadius();
    const v = cur.tool === "keep" ? 255 : 0;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) alpha[yy * w + xx] = v;
      }
    }
  }

  function canvasPos(ev, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / zoom(),
      y: (ev.clientY - rect.top) / zoom(),
    };
  }

  function pushUndo() {
    cur.undoStack.push(new Uint8ClampedArray(cur.alpha));
    if (cur.undoStack.length > 25) cur.undoStack.shift();
  }

  function wire() {
    for (const id of ["canvas-mask-src", "canvas-mask-out"]) {
      const canvas = el(id);
      canvas.addEventListener("pointermove", ev => {
        if (!cur) return;
        cur.pointer = canvasPos(ev, canvas);
        if (cur.drawing) applyBrush(cur.pointer.x, cur.pointer.y);
        render();
      });
      canvas.addEventListener("pointerdown", ev => {
        if (!cur) return;
        canvas.setPointerCapture(ev.pointerId);
        pushUndo();
        cur.drawing = true;
        cur.pointer = canvasPos(ev, canvas);
        applyBrush(cur.pointer.x, cur.pointer.y);
        render();
      });
      canvas.addEventListener("pointerup", () => { if (cur) cur.drawing = false; });
      canvas.addEventListener("pointerleave", () => {
        if (!cur) return;
        cur.pointer = null; cur.drawing = false; render();
      });
    }

    el("tool-keep").addEventListener("click", () => setTool("keep"));
    el("tool-erase").addEventListener("click", () => setTool("erase"));
    el("brush-size").addEventListener("input", render);
    el("mask-zoom").addEventListener("input", render);

    el("mask-type").addEventListener("change", () => {
      if (!cur) return;
      cur.logo.type = el("mask-type").value;
      el("row-threshold").style.display = cur.logo.type === "print" ? "" : "none";
      pushUndo();
      cur.alpha = autoMask(cur.imgData, cur.logo.type, +el("mask-threshold").value);
      render();
    });
    el("btn-mask-auto").addEventListener("click", () => {
      if (!cur) return;
      pushUndo();
      cur.alpha = autoMask(cur.imgData, cur.logo.type, +el("mask-threshold").value);
      render();
    });
    el("mask-threshold").addEventListener("change", () => el("btn-mask-auto").click());

    el("btn-mask-undo").addEventListener("click", () => {
      if (!cur || !cur.undoStack.length) return;
      cur.alpha = cur.undoStack.pop();
      render();
    });
    el("btn-mask-cancel").addEventListener("click", close);
    el("btn-mask-save").addEventListener("click", () => {
      if (!cur) return;
      cur.logo.mask = cur.alpha;
      cur.logo.cropCanvas = buildCropCanvas(cur.imgData, cur.alpha);
      cur.onSave(cur.logo);
      close();
    });
  }

  function setTool(t) {
    cur.tool = t;
    el("tool-keep").classList.toggle("active", t === "keep");
    el("tool-erase").classList.toggle("active", t === "erase");
    render();
  }

  function close() {
    el("mask-editor").classList.add("hidden");
    cur = null;
  }

  document.addEventListener("DOMContentLoaded", wire);

  return { open, autoMask, buildCropCanvas, refineAlpha, makeCanvas, drawChecker };
})();
