// Placement des logos sur le mannequin généré, contrôle 400 %, composite final et export WebP.
// Le composite pose les pixels source sans rotation, perspective ni recoloration ;
// seule l'échelle validée par l'utilisateur est appliquée.

const Placement = (() => {
  const el = id => document.getElementById(id);
  let selected = null;
  let drag = null;
  let displayScale = 1; // rapport affichage/pixels réels des canvas de placement

  // ---- Canvas effectif d'un logo (masque + fusion de bord + échelle) ----

  function effectiveCanvas(logo) {
    const key = `${logo.placement.contract}|${logo.placement.feather}|${logo.maskVersion}`;
    if (logo.effKey === key && logo.effCanvas) return logo.effCanvas;
    let alpha = logo.mask;
    const { w, h } = logo.rect;
    if (logo.placement.contract > 0 || logo.placement.feather > 0) {
      alpha = Masking.refineAlpha(logo.mask, w, h, logo.placement.contract, logo.placement.feather);
    }
    logo.effCanvas = Masking.buildCropCanvas(logo.imgData, alpha);
    logo.effKey = key;
    return logo.effCanvas;
  }

  function placedRect(logo) {
    const s = logo.placement.scale / 100;
    return {
      x: logo.placement.x,
      y: logo.placement.y,
      w: logo.rect.w * s,
      h: logo.rect.h * s,
    };
  }

  // Dessine le logo avec sa rotation éventuelle, autour du centre de sa zone posée.
  function drawPlaced(ctx, logo, scale) {
    const r = placedRect(logo);
    const rot = (logo.placement.rotation || 0) * Math.PI / 180;
    const canvas = effectiveCanvas(logo);
    if (!rot) {
      ctx.drawImage(canvas, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      return;
    }
    ctx.save();
    ctx.translate((r.x + r.w / 2) * scale, (r.y + r.h / 2) * scale);
    ctx.rotate(rot);
    ctx.drawImage(canvas, -r.w * scale / 2, -r.h * scale / 2, r.w * scale, r.h * scale);
    ctx.restore();
  }

  // ---- Rendu ----

  function renderAll() {
    const { sourceCanvas, genCanvas, logos } = App.state;
    if (!genCanvas) return;

    const srcC = el("canvas-place-src");
    const dstC = el("canvas-place-dst");
    const maxW = 640;
    displayScale = Math.min(1, maxW / sourceCanvas.width);
    for (const [c, base] of [[srcC, sourceCanvas], [dstC, genCanvas]]) {
      c.width = Math.round(base.width * displayScale);
      c.height = Math.round(base.height * displayScale);
      const ctx = c.getContext("2d");
      ctx.drawImage(base, 0, 0, c.width, c.height);
    }

    // Si la génération n'a pas les dimensions de la source (mode création),
    // un logo proposé aux coordonnées source peut être hors cadre : on le recentre.
    for (const logo of logos) {
      const r0 = placedRect(logo);
      if (r0.x >= genCanvas.width - 4 || r0.y >= genCanvas.height - 4 ||
          r0.x + r0.w <= 4 || r0.y + r0.h <= 4) {
        logo.placement.x = Math.round((genCanvas.width - r0.w) / 2);
        logo.placement.y = Math.round(genCanvas.height * 0.3);
      }
    }
    const sctx = srcC.getContext("2d");
    const dctx = dstC.getContext("2d");
    for (const logo of logos) {
      // Cadre du logo dans la source (sauf logo importé d'une photo détail).
      if (!logo.external) {
        sctx.strokeStyle = logo === selected ? "#ea580c" : "#d0a030";
        sctx.lineWidth = 2;
        sctx.strokeRect(
          logo.rect.x * displayScale, logo.rect.y * displayScale,
          logo.rect.w * displayScale, logo.rect.h * displayScale
        );
      }
      // Logo posé sur la cible.
      const r = placedRect(logo);
      drawPlaced(dctx, logo, displayScale);
      if (logo === selected) {
        dctx.strokeStyle = "#ea580c";
        dctx.lineWidth = 1.5;
        dctx.strokeRect(r.x * displayScale - 2, r.y * displayScale - 2,
          r.w * displayScale + 4, r.h * displayScale + 4);
      }
    }
    renderLoupe();
  }

  function renderLoupe() {
    const c = el("canvas-loupe");
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, c.width, c.height);
    if (!selected) return;
    const comp = compositeFullRes();
    const r = placedRect(selected);
    const zoom = 4; // contrôle à 400 %
    const vw = c.width / zoom, vh = c.height / zoom;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(comp, cx - vw / 2, cy - vh / 2, vw, vh, 0, 0, c.width, c.height);
  }

  // ---- Composite pleine résolution ----

  function compositeFullRes() {
    const { genCanvas, logos } = App.state;
    const c = Masking.makeCanvas(genCanvas.width, genCanvas.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(genCanvas, 0, 0);
    for (const logo of logos) {
      const r = placedRect(logo);
      const rot = logo.placement.rotation || 0;
      if (logo.placement.scale === 100 && !rot) {
        // Pose pixel pour pixel, sans interpolation.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(effectiveCanvas(logo), Math.round(r.x), Math.round(r.y));
      } else {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        drawPlaced(ctx, logo, 1);
      }
    }
    return c;
  }

  // ---- Interactions ----

  function hitLogo(x, y) {
    const { logos } = App.state;
    for (let i = logos.length - 1; i >= 0; i--) {
      const r = placedRect(logos[i]);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return logos[i];
    }
    return null;
  }

  function select(logo) {
    selected = logo;
    el("sel-title").textContent = logo ? "Logo : " + logo.name : "Aucun logo sélectionné";
    el("sel-controls").classList.toggle("hidden", !logo);
    if (logo) {
      el("sel-scale").value = logo.placement.scale;
      el("sel-scale-label").textContent = Math.round(logo.placement.scale) + " %";
      el("sel-rotation").value = logo.placement.rotation || 0;
      el("sel-rotation-label").textContent = Math.round(logo.placement.rotation || 0) + "°";
      el("sel-edge").value = logo.placement.contract + "," + logo.placement.feather;
    }
    renderAll();
  }

  function pos(ev, canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssScale = canvas.width / rect.width; // le canvas peut être réduit par max-width
    return {
      x: (ev.clientX - rect.left) * cssScale / displayScale,
      y: (ev.clientY - rect.top) * cssScale / displayScale,
    };
  }

  function wire() {
    const dstC = el("canvas-place-dst");
    dstC.addEventListener("pointerdown", ev => {
      const p = pos(ev, dstC);
      const logo = hitLogo(p.x, p.y);
      select(logo);
      if (logo) {
        drag = { logo, dx: p.x - logo.placement.x, dy: p.y - logo.placement.y };
        dstC.setPointerCapture(ev.pointerId);
        dstC.style.cursor = "grabbing";
      }
    });
    dstC.addEventListener("pointermove", ev => {
      if (!drag) return;
      const p = pos(ev, dstC);
      drag.logo.placement.x = p.x - drag.dx;
      drag.logo.placement.y = p.y - drag.dy;
      renderAll();
    });
    dstC.addEventListener("pointerup", () => {
      if (drag) Persist.saveSoon();
      drag = null; dstC.style.cursor = "grab";
    });
    dstC.addEventListener("wheel", ev => {
      if (!selected) return;
      ev.preventDefault();
      const next = Math.max(5, Math.min(300, selected.placement.scale * (ev.deltaY < 0 ? 1.03 : 0.97)));
      selected.placement.scale = next;
      el("sel-scale").value = next;
      el("sel-scale-label").textContent = Math.round(next) + " %";
      renderAll();
    }, { passive: false });

    el("sel-scale").addEventListener("input", () => {
      if (!selected) return;
      selected.placement.scale = +el("sel-scale").value;
      el("sel-scale-label").textContent = selected.placement.scale + " %";
      renderAll();
      Persist.saveSoon();
    });
    el("sel-rotation").addEventListener("input", () => {
      if (!selected) return;
      selected.placement.rotation = +el("sel-rotation").value;
      el("sel-rotation-label").textContent = selected.placement.rotation + "°";
      renderAll();
      Persist.saveSoon();
    });
    el("sel-rotation").addEventListener("dblclick", () => {
      if (!selected) return;
      selected.placement.rotation = 0;
      el("sel-rotation").value = 0;
      el("sel-rotation-label").textContent = "0°";
      renderAll();
      Persist.saveSoon();
    });
    el("sel-edge").addEventListener("change", () => {
      if (!selected) return;
      const [c, f] = el("sel-edge").value.split(",").map(Number);
      selected.placement.contract = c;
      selected.placement.feather = f;
      renderAll();
      Persist.saveSoon();
    });
    el("btn-sel-repair").addEventListener("click", () => {
      if (!selected) return;
      Masking.open(selected, selected.imgData, logo => {
        logo.maskVersion = (logo.maskVersion || 0) + 1;
        renderAll();
        if (typeof App.refreshLogoList === "function") App.refreshLogoList();
        Persist.saveSoon();
      });
    });
  }

  // ---- Export ----

  async function toWebPUnder(canvas, maxKB) {
    const blobAt = q => new Promise(res => canvas.toBlob(res, "image/webp", q));
    let lo = 0.4, hi = 0.98, best = null;
    const first = await blobAt(hi);
    if (first && first.size <= maxKB * 1024) return { blob: first, quality: hi };
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      const b = await blobAt(mid);
      if (b && b.size <= maxKB * 1024) { best = { blob: b, quality: mid }; lo = mid; }
      else hi = mid;
    }
    if (!best) {
      const b = await blobAt(0.4);
      return { blob: b, quality: 0.4, overweight: b.size > maxKB * 1024 };
    }
    return best;
  }

  document.addEventListener("DOMContentLoaded", wire);

  return { renderAll, select, compositeFullRes, toWebPUnder };
})();
