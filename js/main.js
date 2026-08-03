// Studio Mannequin — orchestration : auth, wizard, génération Gemini, inventaire, export.

const App = { state: {}, refreshLogoList: null };

(() => {
  const el = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ══════════ État ══════════

  function resetPhotoState(keepModel) {
    App.state.sourceCanvas = null;
    App.state.genCanvas = null;
    App.state.logos = [];
    App.state.logoSeq = 0;
    if (!keepModel) {
      App.state.backMode = false;
      App.state.faceRefCanvas = null;
      el("form-model").reset();
    }
    el("canvas-source-preview").classList.add("hidden");
    el("source-info").textContent = "";
    el("btn-generate").disabled = true;
    el("backref-banner").classList.toggle("hidden", !App.state.backMode);
    el("link-download").classList.add("hidden");
    refreshLogoList();
  }

  // ══════════ Authentification ══════════

  let loginMode = "password";

  function wireAuth() {
    $$(".tab").forEach(t => t.addEventListener("click", () => {
      loginMode = t.dataset.tab;
      $$(".tab").forEach(x => x.classList.toggle("active", x === t));
      el("row-password").style.display = loginMode === "password" ? "" : "none";
      el("btn-login").textContent = loginMode === "password" ? "Se connecter" : "Recevoir le lien";
    }));

    el("form-login").addEventListener("submit", async ev => {
      ev.preventDefault();
      const email = el("login-email").value.trim();
      const msg = el("login-msg");
      msg.className = "msg";
      msg.textContent = "…";
      try {
        if (loginMode === "password") {
          const { error } = await sb.auth.signInWithPassword({
            email, password: el("login-password").value,
          });
          if (error) throw error;
        } else {
          const { error } = await sb.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false },
          });
          if (error) throw error;
          msg.className = "msg ok";
          msg.textContent = "Lien envoyé — vérifie ta boîte mail.";
          return;
        }
      } catch (e) {
        msg.className = "msg error";
        msg.textContent = e.message || String(e);
        return;
      }
      msg.textContent = "";
    });

    el("btn-logout").addEventListener("click", () => sb.auth.signOut());

    sb.auth.onAuthStateChange((_ev, session) => {
      const logged = !!session;
      el("screen-login").classList.toggle("hidden", logged);
      el("screen-app").classList.toggle("hidden", !logged);
      if (logged) {
        el("user-email").textContent = session.user.email;
        goStep(1);
      }
    });
  }

  // ══════════ Wizard ══════════

  function goStep(n) {
    for (let i = 1; i <= 5; i++) el("step-" + i).classList.toggle("hidden", i !== n);
    $$("#stepper .step").forEach(s => {
      const k = +s.dataset.step;
      s.classList.toggle("active", k === n);
      s.classList.toggle("done", k < n);
    });
    if (n === 3) renderInventory();
    if (n === 4) Placement.renderAll();
    if (n === 5) renderFinal();
    Persist.saveSoon();
  }

  // ══════════ Étape 1 : source ══════════

  function loadSourceFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      App.state.sourceCanvas = c;
      App.state.logos = [];
      refreshLogoList();
      const prev = el("canvas-source-preview");
      const s = Math.min(1, 520 / c.width);
      prev.width = c.width * s; prev.height = c.height * s;
      prev.getContext("2d").drawImage(c, 0, 0, prev.width, prev.height);
      prev.classList.remove("hidden");
      el("source-info").textContent = `${c.width} × ${c.height} px — ${(file.size / 1024).toFixed(0)} Ko`;
      el("btn-generate").disabled = false;
      URL.revokeObjectURL(img.src);
      Persist.saveSoon();
    };
    img.src = URL.createObjectURL(file);
  }

  function wireSource() {
    const dz = el("drop-source");
    el("btn-browse").addEventListener("click", ev => { ev.preventDefault(); el("file-source").click(); });
    el("file-source").addEventListener("change", ev => loadSourceFile(ev.target.files[0]));
    dz.addEventListener("dragover", ev => { ev.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", ev => {
      ev.preventDefault(); dz.classList.remove("over");
      loadSourceFile(ev.dataTransfer.files[0]);
    });
  }

  // ══════════ Génération ══════════

  function modelDescription() {
    const v = id => el(id).value.trim();
    return [v("m-genre"), v("m-origine"), v("m-age"), v("m-morpho"),
      v("m-cheveux"), v("m-barbe"), v("m-expression")].filter(Boolean).join(", ");
  }

  function isMinor() {
    const txt = (el("m-age").value + " " + el("m-genre").value).toLowerCase();
    if (/(enfant|ado|garçon|fille|junior)/.test(txt)) return true;
    const m = txt.match(/(\d{1,2})\s*ans/);
    return m ? +m[1] < 18 : false;
  }

  function buildPrompt(extraNote) {
    const desc = modelDescription() || "mannequin adulte au look neutre";
    const pose = el("m-pose").value.trim() || "pose e-commerce naturelle, différente de la photo source";
    const acc = el("m-accessoires").value.trim();
    const notes = el("m-notes").value.trim();

    const lines = [
      App.state.backMode
        ? "Photo e-commerce studio, VUE DOS. La première image est la photo produit vue dos à modifier ; la seconde image est la vue face déjà validée du mannequin : utilise-la comme référence absolue d'identité (silhouette, carnation, cheveux, morphologie, proportions, échelle)."
        : "Photo e-commerce studio. Modifie cette photo produit.",
      `Remplace le mannequin par : ${desc}.`,
      `Nouvelle pose : ${pose}. La tête doit être entièrement visible, cheveux et sommet du crâne inclus, avec une petite marge au-dessus.`,
      "Retire tous les accessoires visibles : lunettes, bijoux, montre, casquette, sac, écouteurs, gants et objets tenus."
        + (acc ? ` Consigne spécifique : ${acc}.` : "")
        + " Chaque membre qui touchait un accessoire retiré doit reprendre une pose naturelle et équilibrée.",
      "Conserve EXACTEMENT le vêtement porté : coupe, matière, couleur, coutures, zip, col, manches, détails réfléchissants et proportions identiques à la source.",
      "Le buste et le panneau poitrine doivent rester dans le même plan, avec la même orientation et la même inclinaison caméra que la photo source. Pas de rotation ni de redressement du buste.",
      "IMPORTANT : supprime TOUS les logos, écussons, textes, sponsors et marquages du vêtement. Le textile doit être parfaitement vierge et continu, sans logo approximatif ni logo fantôme.",
      "Fond studio uni exactement #F5F5F5 sur toute l'image, sans gradient, ombre portée, texture, horizon, vignettage ni variation de teinte.",
      "Conserve le cadrage et le format de la photo source.",
    ];
    if (isMinor()) {
      lines.push("Contexte : photo catalogue e-commerce de textile enfant/adolescent. Le mannequin mineur est entièrement habillé, dans une pose catalogue naturelle et sportive, avec une expression neutre adaptée à son âge. Aucune sexualisation, aucune pose suggestive, aucune mise en scène adulte. Cadrage commercial centré sur le produit.");
    }
    if (notes) lines.push("Consignes supplémentaires : " + notes);
    if (extraNote) lines.push("Correction demandée après contrôle : " + extraNote);
    return lines.join("\n");
  }

  function canvasToB64(canvas, maxDim) {
    let c = canvas;
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    if (scale < 1) {
      c = document.createElement("canvas");
      c.width = Math.round(canvas.width * scale);
      c.height = Math.round(canvas.height * scale);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, c.width, c.height);
    }
    const url = c.toDataURL("image/jpeg", 0.93);
    return { mimeType: "image/jpeg", data: url.split(",")[1] };
  }

  async function generate(extraNote) {
    const src = App.state.sourceCanvas;
    if (!src) return;
    showBusy("Génération du nouveau mannequin… (10 à 30 s)");
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expirée, reconnecte-toi.");
      const images = [canvasToB64(src, 1536)];
      if (App.state.backMode && App.state.faceRefCanvas) {
        images.push(canvasToB64(App.state.faceRefCanvas, 1024));
      }
      const resp = await fetch(GENERATE_FN_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + session.access_token,
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: buildPrompt(extraNote), images }),
      });
      const out = await resp.json();
      if (!resp.ok) throw new Error(out.error + (out.detail ? " — " + out.detail : ""));

      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = rej;
        img.src = `data:${out.image.mimeType};base64,${out.image.data}`;
      });
      // Ramener la génération aux dimensions exactes de la source (règle du skill).
      const gen = document.createElement("canvas");
      gen.width = src.width; gen.height = src.height;
      const ctx = gen.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, gen.width, gen.height);
      App.state.genCanvas = gen;
      Persist.save(); // sauvegarde immédiate : cette image a coûté de l'argent
      goStep(2);
      renderCompare();
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la génération : " + (e.message || e);
      goStep(App.state.genCanvas ? 2 : 1);
    } finally {
      hideBusy();
    }
  }

  function renderCompare() {
    const { sourceCanvas, genCanvas } = App.state;
    if (!genCanvas) return;
    const c = el("canvas-compare");
    const s = Math.min(1, 660 / genCanvas.width);
    c.width = genCanvas.width * s;
    c.height = genCanvas.height * s;
    const ctx = c.getContext("2d");
    ctx.drawImage(genCanvas, 0, 0, c.width, c.height);
    const op = +el("onion-opacity").value / 100;
    if (op > 0) {
      ctx.globalAlpha = op;
      ctx.drawImage(sourceCanvas, 0, 0, c.width, c.height);
      ctx.globalAlpha = 1;
    }
  }

  // ══════════ Étape 3 : inventaire ══════════

  let invZoom = 1;
  let invDrag = null;

  function renderInventory() {
    const src = App.state.sourceCanvas;
    if (!src) return;
    const c = el("canvas-inventory");
    if (!c.dataset.fitted) {
      invZoom = Math.min(1, (el("inventory-viewport").clientWidth - 20) / src.width) || 1;
      c.dataset.fitted = "1";
    }
    c.width = Math.round(src.width * invZoom);
    c.height = Math.round(src.height * invZoom);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = invZoom < 1;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    for (const logo of App.state.logos) {
      ctx.strokeStyle = logo.mask ? "#2ea25f" : "#d05050";
      ctx.lineWidth = 2;
      ctx.strokeRect(logo.rect.x * invZoom, logo.rect.y * invZoom,
        logo.rect.w * invZoom, logo.rect.h * invZoom);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.font = "12px sans-serif";
      const tw = ctx.measureText(logo.name).width + 8;
      ctx.fillRect(logo.rect.x * invZoom, logo.rect.y * invZoom - 16, tw, 15);
      ctx.fillStyle = "#fff";
      ctx.fillText(logo.name, logo.rect.x * invZoom + 4, logo.rect.y * invZoom - 4);
    }
    if (invDrag && invDrag.cur) {
      ctx.strokeStyle = "#3d82f6";
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(invDrag.x0 * invZoom, invDrag.y0 * invZoom,
        (invDrag.cur.x - invDrag.x0) * invZoom, (invDrag.cur.y - invDrag.y0) * invZoom);
      ctx.setLineDash([]);
    }
    el("zoom-label").textContent = Math.round(invZoom * 100) + " %";
  }

  function invPos(ev) {
    const c = el("canvas-inventory");
    const r = c.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / invZoom, y: (ev.clientY - r.top) / invZoom };
  }

  function wireInventory() {
    const c = el("canvas-inventory");
    c.addEventListener("pointerdown", ev => {
      const p = invPos(ev);
      invDrag = { x0: p.x, y0: p.y, cur: null };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener("pointermove", ev => {
      if (!invDrag) return;
      invDrag.cur = invPos(ev);
      renderInventory();
    });
    c.addEventListener("pointerup", () => {
      if (!invDrag || !invDrag.cur) { invDrag = null; return; }
      const src = App.state.sourceCanvas;
      const x = Math.max(0, Math.round(Math.min(invDrag.x0, invDrag.cur.x)));
      const y = Math.max(0, Math.round(Math.min(invDrag.y0, invDrag.cur.y)));
      const w = Math.min(src.width - x, Math.round(Math.abs(invDrag.cur.x - invDrag.x0)));
      const h = Math.min(src.height - y, Math.round(Math.abs(invDrag.cur.y - invDrag.y0)));
      invDrag = null;
      if (w < 6 || h < 6) { renderInventory(); return; }
      createLogo({ x, y, w, h });
    });
    el("btn-zoom-in").addEventListener("click", () => { invZoom = Math.min(8, invZoom * 1.25); renderInventory(); });
    el("btn-zoom-out").addEventListener("click", () => { invZoom = Math.max(0.1, invZoom / 1.25); renderInventory(); });
  }

  function createLogo(rect) {
    App.state.logoSeq++;
    const imgData = App.state.sourceCanvas.getContext("2d").getImageData(rect.x, rect.y, rect.w, rect.h);
    const logo = {
      id: App.state.logoSeq,
      name: "logo-" + App.state.logoSeq,
      rect, imgData,
      type: "print",
      mask: null, cropCanvas: null, maskVersion: 0,
      placement: { x: rect.x, y: rect.y, scale: 100, contract: 0, feather: 0 },
    };
    App.state.logos.push(logo);
    Masking.open(logo, imgData, l => {
      l.maskVersion++;
      refreshLogoList();
      renderInventory();
      Persist.saveSoon();
    });
    refreshLogoList();
    renderInventory();
  }

  function refreshLogoList() {
    const ul = el("logo-list");
    ul.innerHTML = "";
    const logos = App.state.logos || [];
    for (const logo of logos) {
      const li = document.createElement("li");
      const img = document.createElement("img");
      if (logo.cropCanvas) img.src = logo.cropCanvas.toDataURL();
      const span = document.createElement("span");
      span.className = "name";
      const nameInput = document.createElement("input");
      nameInput.value = logo.name;
      nameInput.title = "Renommer (ex. : logo-poitrine, écusson-poitrine, logo-short)";
      nameInput.addEventListener("change", () => {
        logo.name = nameInput.value.trim() || logo.name;
        renderInventory();
      });
      const dims = document.createElement("small");
      dims.className = "muted";
      dims.textContent = logo.rect.w + "×" + logo.rect.h + " px";
      span.append(nameInput, dims);
      const state = document.createElement("span");
      state.className = "state " + (logo.mask ? "ok" : "todo");
      state.textContent = logo.mask ? "Détouré" : "À détourer";
      const bEdit = document.createElement("button");
      bEdit.className = "btn ghost";
      bEdit.textContent = "Réparer";
      bEdit.addEventListener("click", () => Masking.open(logo, logo.imgData, l => {
        l.maskVersion++; refreshLogoList(); renderInventory(); Persist.saveSoon();
      }));
      const bDel = document.createElement("button");
      bDel.className = "btn ghost";
      bDel.textContent = "✕";
      bDel.addEventListener("click", () => {
        App.state.logos = App.state.logos.filter(l => l !== logo);
        refreshLogoList(); renderInventory(); Persist.saveSoon();
      });
      li.append(img, span, state, bEdit, bDel);
      ul.appendChild(li);
    }
    el("btn-goto-placement").disabled = !(logos.length && logos.every(l => l.mask));
  }
  App.refreshLogoList = refreshLogoList;

  // ══════════ Étape 5 : export ══════════

  function renderFinal() {
    const comp = Placement.compositeFullRes();
    App.state.masterCanvas = comp;
    const c = el("canvas-final");
    const s = Math.min(1, 760 / comp.width);
    c.width = comp.width * s; c.height = comp.height * s;
    c.getContext("2d").drawImage(comp, 0, 0, c.width, c.height);
    el("export-info").textContent =
      `Master : ${comp.width} × ${comp.height} px — ${App.state.logos.length} logo(s) posé(s).`;
  }

  async function exportWebP() {
    showBusy("Optimisation WebP…");
    try {
      const comp = App.state.masterCanvas || Placement.compositeFullRes();
      const { blob, quality, overweight } = await Placement.toWebPUnder(comp, 200);
      const url = URL.createObjectURL(blob);
      const link = el("link-download");
      link.href = url;
      link.download = App.state.backMode ? "photo-finale-dos.webp" : "photo-finale.webp";
      link.textContent = "Télécharger " + link.download;
      link.classList.remove("hidden");
      el("export-info").textContent =
        `${comp.width} × ${comp.height} px — ${(blob.size / 1024).toFixed(0)} Ko (qualité WebP ${Math.round(quality * 100)} %). ` +
        (overweight
          ? "⚠ Impossible de rester sous 200 Ko sans dégradation excessive : fichier livré au plus proche."
          : "Logos posés depuis les pixels de la photo source.");
    } finally {
      hideBusy();
    }
  }

  // ══════════ Divers ══════════

  function showBusy(msg) { el("busy-msg").textContent = msg; el("busy").classList.remove("hidden"); }
  function hideBusy() { el("busy").classList.add("hidden"); }

  function wireNav() {
    el("btn-generate").addEventListener("click", () => generate());
    el("btn-regenerate").addEventListener("click", () => generate(el("regen-notes").value.trim()));
    el("onion-opacity").addEventListener("input", renderCompare);
    el("btn-accept-gen").addEventListener("click", () => goStep(3));
    el("btn-goto-placement").addEventListener("click", () => goStep(4));
    el("btn-goto-export").addEventListener("click", () => goStep(5));
    el("btn-export").addEventListener("click", exportWebP);
    el("btn-export-png").addEventListener("click", () => {
      const comp = App.state.masterCanvas || Placement.compositeFullRes();
      comp.toBlob(b => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = App.state.backMode ? "master-dos.png" : "master.png";
        a.click();
      }, "image/png");
    });
    el("btn-back-view").addEventListener("click", () => {
      App.state.faceRefCanvas = App.state.masterCanvas || Placement.compositeFullRes();
      resetPhotoState(true);
      App.state.backMode = true;
      el("backref-banner").classList.remove("hidden");
      el("canvas-inventory").dataset.fitted = "";
      goStep(1);
    });
    el("btn-new").addEventListener("click", () => {
      resetPhotoState(false);
      Persist.clear();
      el("canvas-inventory").dataset.fitted = "";
      goStep(1);
    });
    $$("#stepper .step").forEach(s => s.addEventListener("click", () => {
      const n = +s.dataset.step;
      if (n === 1 || (n === 2 && App.state.genCanvas) ||
          (n >= 3 && App.state.genCanvas) ) goStep(n);
    }));
  }

  // ══════════ Reprise de session ══════════

  async function offerRestore() {
    let saved = null;
    try { saved = await Persist.getSaved(); } catch { return; }
    if (!saved || (!saved.gen && !(saved.logos || []).length)) return;
    const age = Math.round((Date.now() - saved.savedAt) / 60000);
    el("restore-text").textContent =
      `Session précédente retrouvée (il y a ${age < 60 ? age + " min" : Math.round(age / 60) + " h"})` +
      (saved.gen ? " avec une image générée" : "") + ".";
    el("restore-banner").classList.remove("hidden");

    el("btn-restore").onclick = async () => {
      showBusy("Restauration de la session…");
      try {
        await Persist.restore(saved);
        el("restore-banner").classList.add("hidden");
        el("backref-banner").classList.toggle("hidden", !App.state.backMode);
        const src = App.state.sourceCanvas;
        const prev = el("canvas-source-preview");
        const s = Math.min(1, 520 / src.width);
        prev.width = src.width * s; prev.height = src.height * s;
        prev.getContext("2d").drawImage(src, 0, 0, prev.width, prev.height);
        prev.classList.remove("hidden");
        el("source-info").textContent = `${src.width} × ${src.height} px (session restaurée)`;
        el("btn-generate").disabled = false;
        el("canvas-inventory").dataset.fitted = "";
        refreshLogoList();
        const logos = App.state.logos;
        if (!App.state.genCanvas) goStep(1);
        else if (!logos.length) { goStep(2); renderCompare(); }
        else if (logos.every(l => l.mask)) goStep(4);
        else goStep(3);
      } finally {
        hideBusy();
      }
    };
    el("btn-restore-dismiss").onclick = () => el("restore-banner").classList.add("hidden");
  }

  document.addEventListener("DOMContentLoaded", () => {
    resetPhotoState(false);
    wireAuth();
    wireSource();
    wireInventory();
    wireNav();
    offerRestore();
    window.addEventListener("beforeunload", ev => {
      if (App.state.genCanvas) { ev.preventDefault(); ev.returnValue = ""; }
    });
  });
})();
