// Studio 2.0 — orchestration : auth, file multi-vues, génération Gemini, inventaire, export.
// Le projet est une liste de « vues » (face, dos, profil…). La première vue générée sert
// de référence d'identité pour toutes les autres : même mannequin sur chaque photo.

const App = { state: {}, refreshLogoList: null };

(() => {
  const el = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  let curStep = 1;

  // ══════════ État : vues ══════════
  // Vue = { id, name, source, gen, master, logos[], logoSeq, exported }
  // App.state.sourceCanvas / genCanvas / logos / logoSeq sont des alias de la vue
  // courante (lus par placement.js et masking.js). Ne jamais réassigner logos
  // ailleurs que dans selectView — muter le tableau en place (push/splice).

  function resetProject(keepModel) {
    App.state.views = [];
    App.state.cur = -1;
    App.state.viewSeq = 0;
    App.state.sourceCanvas = null;
    App.state.genCanvas = null;
    App.state.masterCanvas = null;
    App.state.logos = [];
    App.state.logoSeq = 0;
    if (!keepModel) el("form-model").reset();
    el("link-download").classList.add("hidden");
    renderViewsList();
    renderViewSwitcher();
    refreshLogoList();
    updateGenerateButton();
  }

  function currentView() {
    return App.state.views[App.state.cur] || null;
  }

  function syncAliases() {
    const v = currentView();
    if (!v) return;
    v.gen = App.state.genCanvas;
    v.master = App.state.masterCanvas;
    v.logos = App.state.logos;
    v.logoSeq = App.state.logoSeq;
  }

  function selectView(i, opts) {
    if (i === App.state.cur && !(opts && opts.force)) return;
    syncAliases();
    const v = App.state.views[i];
    if (!v) return;
    App.state.cur = i;
    App.state.sourceCanvas = v.source;
    App.state.genCanvas = v.gen;
    App.state.masterCanvas = v.master;
    App.state.logos = v.logos;
    App.state.logoSeq = v.logoSeq;
    el("canvas-inventory").dataset.fitted = "";
    el("link-download").classList.add("hidden");
    renderViewSwitcher();
    refreshLogoList();
  }

  const slug = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
    curStep = n;
    for (let i = 1; i <= 5; i++) el("step-" + i).classList.toggle("hidden", i !== n);
    $$("#stepper .step").forEach(s => {
      const k = +s.dataset.step;
      s.classList.toggle("active", k === n);
      s.classList.toggle("done", k < n);
    });
    renderViewSwitcher();
    if (n === 2) renderCompare();
    if (n === 3) renderInventory();
    if (n === 4) Placement.renderAll();
    if (n === 5) renderFinal();
    Persist.saveSoon();
  }

  // ══════════ Sélecteur de vues (étapes 2-5) ══════════

  function viewStateLabel(v) {
    if (!v.gen) return { txt: "à générer", cls: "todo" };
    if (v.exported) return { txt: "exportée ✓", cls: "ok" };
    const masked = v.logos.filter(l => l.mask).length;
    if (v.logos.length === 0) return { txt: "générée", cls: "gen" };
    return { txt: `${masked}/${v.logos.length} logos`, cls: masked === v.logos.length ? "ok" : "gen" };
  }

  function renderViewSwitcher() {
    const bar = el("view-switcher");
    const views = App.state.views || [];
    const show = views.length > 1 && curStep >= 2;
    bar.classList.toggle("hidden", !show);
    if (!show) return;
    bar.innerHTML = "";
    views.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = "view-pill" + (i === App.state.cur ? " active" : "");
      const st = viewStateLabel(v);
      b.innerHTML = "";
      const name = document.createElement("span");
      name.textContent = v.name;
      const badge = document.createElement("small");
      badge.className = st.cls;
      badge.textContent = st.txt;
      b.append(name, badge);
      b.addEventListener("click", () => {
        selectView(i);
        goStep(v.gen ? curStep : 1);
      });
      bar.appendChild(b);
    });
  }

  // ══════════ Étape 1 : vues sources ══════════

  function addViewFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      App.state.viewSeq++;
      const defaults = ["face", "dos", "profil"];
      const v = {
        id: App.state.viewSeq,
        name: defaults[App.state.views.length] || "vue-" + App.state.viewSeq,
        source: c, gen: null, master: null,
        logos: [], logoSeq: 0, exported: false,
      };
      App.state.views.push(v);
      if (App.state.views.length === 1) selectView(0, { force: true });
      renderViewsList();
      renderViewSwitcher();
      updateGenerateButton();
      Persist.saveSoon();
    };
    img.src = URL.createObjectURL(file);
  }

  function thumbnail(canvas, h = 56) {
    const t = document.createElement("canvas");
    t.height = h;
    t.width = Math.max(1, Math.round(canvas.width * h / canvas.height));
    t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL("image/jpeg", 0.7);
  }

  function renderViewsList() {
    const ul = el("views-list");
    ul.innerHTML = "";
    (App.state.views || []).forEach((v, i) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = thumbnail(v.source);
      const box = document.createElement("span");
      box.className = "name";
      const nameInput = document.createElement("input");
      nameInput.value = v.name;
      nameInput.title = "Nom de la vue (sert au nom du fichier exporté)";
      nameInput.addEventListener("change", () => {
        v.name = nameInput.value.trim() || v.name;
        renderViewSwitcher();
        Persist.saveSoon();
      });
      const dims = document.createElement("small");
      dims.className = "muted";
      dims.textContent = `${v.source.width} × ${v.source.height} px` +
        (i === 0 ? " — référence identité" : "") + (v.gen ? " — générée" : "");
      const flatLabel = document.createElement("label");
      flatLabel.className = "inline flat";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!v.flat;
      cb.addEventListener("change", () => { v.flat = cb.checked; Persist.saveSoon(); });
      flatLabel.append(cb, document.createTextNode(" produit à plat (non porté)"));
      box.append(nameInput, dims, flatLabel);
      const bDel = document.createElement("button");
      bDel.className = "btn ghost";
      bDel.textContent = "✕";
      bDel.title = "Retirer cette vue";
      bDel.addEventListener("click", () => {
        App.state.views.splice(i, 1);
        if (App.state.cur >= App.state.views.length) App.state.cur = App.state.views.length - 1;
        if (App.state.views.length) selectView(Math.max(0, App.state.cur), { force: true });
        else resetProject(true);
        renderViewsList();
        updateGenerateButton();
        Persist.saveSoon();
      });
      li.append(img, box, bDel);
      ul.appendChild(li);
    });
  }

  function updateGenerateButton() {
    const views = App.state.views || [];
    const todo = views.filter(v => !v.gen).length;
    const btn = el("btn-generate");
    btn.disabled = todo === 0;
    btn.textContent = views.length === 0
      ? "Générer toutes les vues"
      : todo === 0
        ? "Toutes les vues sont générées"
        : `Générer ${todo} vue${todo > 1 ? "s" : ""} (~${(todo * 0.04).toFixed(2).replace(".", ",")} €)`;
  }

  function wireSource() {
    const dz = el("drop-source");
    el("btn-browse").addEventListener("click", ev => { ev.preventDefault(); el("file-source").click(); });
    el("file-source").addEventListener("change", ev => {
      Array.from(ev.target.files).forEach(addViewFile);
      ev.target.value = "";
    });
    dz.addEventListener("dragover", ev => { ev.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", ev => {
      ev.preventDefault(); dz.classList.remove("over");
      Array.from(ev.dataTransfer.files).forEach(addViewFile);
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

  function buildPrompt(view, withRef, extraPhotos, extraNote) {
    const desc = modelDescription() || "mannequin adulte au look neutre";
    const pose = el("m-pose").value.trim() || "pose e-commerce naturelle, différente de la photo source";
    const acc = el("m-accessoires").value.trim();
    const notes = el("m-notes").value.trim();

    const refPhrase = "La seconde image est la vue de référence déjà générée du mannequin : utilise-la comme référence absolue d'identité (silhouette, carnation, cheveux, morphologie, proportions, échelle).";
    const lines = [];
    if (view.flat) {
      // Photo à plat : on habille un mannequin, il n'y a pas de mannequin à remplacer.
      lines.push(withRef
        ? "Photo e-commerce studio. La première image montre le produit à plat, non porté. " + refPhrase
        : "Photo e-commerce studio. Cette photo montre le produit à plat, non porté.");
      lines.push(`Crée un mannequin portant ce vêtement : ${desc}.`);
      lines.push(`VUE À PRODUIRE : « ${view.name} ». Génère le mannequin sous cet angle (face = de face, dos = de dos, profil = de profil), en te basant sur la face correspondante du produit.`);
      lines.push(`Pose : ${pose}. Tête entièrement visible, cheveux et sommet du crâne inclus, avec une petite marge au-dessus. Le panneau du vêtement montré doit être bien face caméra, plat et sans distorsion.`);
      lines.push("Reproduis EXACTEMENT le vêtement des photos : couleur, coupe, matière, coutures, motifs, longueur, détails et proportions strictement identiques. N'invente aucun élément absent des photos.");
      lines.push("Aucun accessoire : pas de lunettes, bijoux, montre, casquette, sac ni objet tenu." + (acc ? ` Consigne spécifique : ${acc}.` : ""));
    } else {
      lines.push(withRef
        ? "Photo e-commerce studio. La première image est la photo produit à modifier (une autre vue du même produit : dos, profil ou autre angle). " + refPhrase + " Le visage peut être peu visible selon l'angle, mais tout doit correspondre au même mannequin."
        : "Photo e-commerce studio. Modifie cette photo produit.");
      lines.push(`Remplace le mannequin par : ${desc}.`);
      lines.push(`Nouvelle pose : ${pose}. Respecte cependant l'angle et l'orientation du buste propres à cette photo source. La tête doit être entièrement visible, cheveux et sommet du crâne inclus, avec une petite marge au-dessus.`);
      lines.push("Retire tous les accessoires visibles : lunettes, bijoux, montre, casquette, sac, écouteurs, gants et objets tenus."
        + (acc ? ` Consigne spécifique : ${acc}.` : "")
        + " Chaque membre qui touchait un accessoire retiré doit reprendre une pose naturelle et équilibrée.");
      lines.push("Conserve EXACTEMENT le vêtement porté : coupe, matière, couleur, coutures, zip, col, manches, détails réfléchissants et proportions identiques à la source.");
      lines.push("Le buste et le panneau poitrine doivent rester dans le même plan, avec la même orientation et la même inclinaison caméra que la photo source. Pas de rotation ni de redressement du buste.");
    }
    if (extraPhotos > 0) {
      lines.push(
        `Les ${extraPhotos} dernière(s) image(s) fournie(s) montrent le MÊME produit sous d'autres faces ou angles (à plat ou porté). ` +
        "Utilise-les uniquement comme références pour reproduire fidèlement le vêtement sous tous ses angles — notamment les parties non visibles sur la première image (dos, côtés, col, intérieur). Ne les recopie pas telles quelles."
      );
    }
    lines.push(
      "IMPORTANT : supprime TOUS les logos, écussons, textes, sponsors et marquages du vêtement. Le textile doit être parfaitement vierge et continu, sans logo approximatif ni logo fantôme.",
      "Fond studio uni exactement #F5F5F5 sur toute l'image, sans gradient, ombre portée, texture, horizon, vignettage ni variation de teinte.",
      "Conserve le cadrage et le format de la première image.",
    );
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

  function identityRef(excludeView) {
    for (const v of App.state.views) {
      if (v !== excludeView && v.gen) return v.gen;
    }
    return null;
  }

  async function generateView(view, extraNote) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Session expirée, reconnecte-toi.");
    const ref = identityRef(view);
    const images = [canvasToB64(view.source, 1536)];
    if (ref) images.push(canvasToB64(ref, 1024));
    // Toutes les autres photos du produit servent de référence vêtement :
    // le devant à plat renseigne la vue face, le dos à plat renseigne la vue dos, etc.
    let extraPhotos = 0;
    for (const v of App.state.views) {
      if (v === view || images.length >= 5) continue;
      images.push(canvasToB64(v.source, 1024));
      extraPhotos++;
    }
    const resp = await fetch(GENERATE_FN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + session.access_token,
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: buildPrompt(view, !!ref, extraPhotos, extraNote), images }),
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
    gen.width = view.source.width;
    gen.height = view.source.height;
    const ctx = gen.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, gen.width, gen.height);
    view.gen = gen;
    view.exported = false;
    if (view === currentView()) App.state.genCanvas = gen;
  }

  async function generateAll() {
    const views = App.state.views || [];
    if (!views.length) return;
    const todo = views.filter(v => !v.gen);
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    let done = 0;
    try {
      for (const v of views) {
        if (v.gen) continue;
        done++;
        showBusy(`Génération ${done}/${todo.length} — vue « ${v.name} »… (10 à 30 s)`);
        await generateView(v);
        await Persist.save(); // chaque image payée est sauvegardée immédiatement
        renderViewsList();
        updateGenerateButton();
      }
      selectView(0, { force: true });
      goStep(2);
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la génération : " + (e.message || e);
      goStep(currentView()?.gen ? 2 : 1);
    } finally {
      hideBusy();
      updateGenerateButton();
      renderViewsList();
    }
  }

  async function regenerateCurrent() {
    const v = currentView();
    if (!v) return;
    const note = el("regen-notes").value.trim();
    showBusy(`Régénération de la vue « ${v.name} »… (10 à 30 s)`);
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    try {
      await generateView(v, note);
      await Persist.save();
      renderCompare();
      renderViewSwitcher();
      if (App.state.cur === 0 && App.state.views.length > 1 && App.state.views.some((x, i) => i > 0 && x.gen)) {
        el("gen-msg").textContent = "Vue de référence régénérée — les autres vues déjà générées gardent l'ancienne identité ; régénère-les si besoin.";
      }
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la régénération : " + (e.message || e);
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
      if (logo.external) continue; // pas de cadre : le logo ne vient pas de cette photo
      ctx.strokeStyle = logo.mask ? "#1a9a55" : "#d33d33";
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
      ctx.strokeStyle = "#ea580c";
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
    el("btn-add-detail").addEventListener("click", () => el("file-detail").click());
    el("file-detail").addEventListener("change", ev => {
      Array.from(ev.target.files).forEach(addExternalLogoFile);
      ev.target.value = "";
    });
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
    syncAliases();
    Masking.open(logo, imgData, l => {
      l.maskVersion++;
      refreshLogoList();
      renderInventory();
      renderViewSwitcher();
      Persist.saveSoon();
    });
    refreshLogoList();
    renderInventory();
  }

  // Logo importé depuis une photo détail (packshot, gros plan) : détouré avec les
  // mêmes pinceaux, posé sur le mannequin avec une taille initiale raisonnable.
  function addExternalLogoFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
    const base = App.state.sourceCanvas;
    if (!base) return;
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const maxDim = 1024; // assez pour un logo, évite de gonfler la sauvegarde locale
      const sc = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * sc));
      c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const imgData = ctx.getImageData(0, 0, c.width, c.height);
      App.state.logoSeq++;
      const initScale = Math.max(5, Math.min(300, Math.round((base.width * 0.22 / c.width) * 100)));
      const logo = {
        id: App.state.logoSeq,
        name: "logo-détail-" + App.state.logoSeq,
        external: true,
        rect: { x: 0, y: 0, w: c.width, h: c.height },
        imgData,
        type: "print",
        mask: null, cropCanvas: null, maskVersion: 0,
        placement: {
          x: Math.round(base.width * 0.39),
          y: Math.round(base.height * 0.3),
          scale: initScale, contract: 0, feather: 0,
        },
      };
      App.state.logos.push(logo);
      syncAliases();
      Masking.open(logo, imgData, l => {
        l.maskVersion++;
        refreshLogoList();
        renderViewSwitcher();
        Persist.saveSoon();
      });
      refreshLogoList();
    };
    img.src = URL.createObjectURL(file);
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
      dims.textContent = logo.rect.w + "×" + logo.rect.h + " px" +
        (logo.external ? " — photo détail" : "");
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
        const idx = App.state.logos.indexOf(logo);
        if (idx >= 0) App.state.logos.splice(idx, 1);
        refreshLogoList(); renderInventory(); renderViewSwitcher(); Persist.saveSoon();
      });
      li.append(img, span, state, bEdit, bDel);
      ul.appendChild(li);
    }
    el("btn-goto-placement").disabled = !(logos.length && logos.every(l => l.mask));
  }
  App.refreshLogoList = refreshLogoList;

  // ══════════ Étape 5 : export ══════════

  function exportName(v) {
    const s = slug(v.name);
    return "photo-finale" + (s ? "-" + s : "") + ".webp";
  }

  function renderFinal() {
    if (!App.state.genCanvas) return;
    const comp = Placement.compositeFullRes();
    App.state.masterCanvas = comp;
    syncAliases();
    const c = el("canvas-final");
    const s = Math.min(1, 760 / comp.width);
    c.width = comp.width * s; c.height = comp.height * s;
    c.getContext("2d").drawImage(comp, 0, 0, c.width, c.height);
    const v = currentView();
    el("export-info").textContent =
      `Vue « ${v.name} » — master ${comp.width} × ${comp.height} px, ${App.state.logos.length} logo(s) posé(s).`;
  }

  async function exportCurrent() {
    const v = currentView();
    if (!v) return;
    showBusy("Optimisation WebP…");
    try {
      const comp = App.state.masterCanvas || Placement.compositeFullRes();
      const { blob, quality, overweight } = await Placement.toWebPUnder(comp, 200);
      const url = URL.createObjectURL(blob);
      const link = el("link-download");
      link.href = url;
      link.download = exportName(v);
      link.textContent = "Télécharger " + link.download;
      link.classList.remove("hidden");
      v.exported = true;
      renderViewSwitcher();
      Persist.saveSoon();
      el("export-info").textContent =
        `${comp.width} × ${comp.height} px — ${(blob.size / 1024).toFixed(0)} Ko (qualité WebP ${Math.round(quality * 100)} %). ` +
        (overweight
          ? "⚠ Impossible de rester sous 200 Ko sans dégradation excessive : fichier livré au plus proche."
          : "Logos posés depuis les pixels de la photo source.");
    } finally {
      hideBusy();
    }
  }

  async function exportAll() {
    syncAliases();
    const ready = App.state.views.filter(v => v.gen);
    if (!ready.length) return;
    showBusy("Export de toutes les vues…");
    try {
      for (const v of ready) {
        selectView(App.state.views.indexOf(v), { force: true });
        const comp = Placement.compositeFullRes();
        App.state.masterCanvas = comp;
        syncAliases();
        const { blob } = await Placement.toWebPUnder(comp, 200);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = exportName(v);
        a.click();
        v.exported = true;
        await new Promise(r => setTimeout(r, 400));
      }
      renderViewSwitcher();
      renderFinal();
      Persist.saveSoon();
      el("export-info").textContent =
        `${ready.length} vue(s) exportée(s). Si le navigateur n'a téléchargé que la première, autorise les téléchargements multiples pour ce site.`;
    } finally {
      hideBusy();
    }
  }

  // ══════════ Divers ══════════

  function showBusy(msg) { el("busy-msg").textContent = msg; el("busy").classList.remove("hidden"); }
  function hideBusy() { el("busy").classList.add("hidden"); }

  function wireNav() {
    el("btn-generate").addEventListener("click", generateAll);
    el("btn-regenerate").addEventListener("click", regenerateCurrent);
    el("onion-opacity").addEventListener("input", renderCompare);
    el("btn-accept-gen").addEventListener("click", () => goStep(3));
    el("btn-goto-placement").addEventListener("click", () => goStep(4));
    el("btn-goto-export").addEventListener("click", () => goStep(5));
    el("btn-export").addEventListener("click", exportCurrent);
    el("btn-export-png").addEventListener("click", () => {
      const v = currentView();
      const comp = App.state.masterCanvas || Placement.compositeFullRes();
      comp.toBlob(b => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "master-" + (slug(v?.name) || "vue") + ".png";
        a.click();
      }, "image/png");
    });
    el("btn-export-all").addEventListener("click", exportAll);
    el("btn-new").addEventListener("click", () => {
      resetProject(false);
      Persist.clear();
      goStep(1);
    });
    $$("#stepper .step").forEach(s => s.addEventListener("click", () => {
      const n = +s.dataset.step;
      if (n === 1 || App.state.genCanvas) goStep(n);
    }));
  }

  // ══════════ Reprise de session ══════════

  async function offerRestore() {
    let saved = null;
    try { saved = await Persist.getSaved(); } catch { return; }
    if (!saved) return;
    const views = saved.views || [];
    const nGen = views.filter(v => v.gen).length;
    if (!nGen && !views.some(v => (v.logos || []).length)) return;
    const age = Math.round((Date.now() - saved.savedAt) / 60000);
    el("restore-text").textContent =
      `Projet précédent retrouvé (il y a ${age < 60 ? age + " min" : Math.round(age / 60) + " h"}) : ` +
      `${views.length} vue(s), dont ${nGen} générée(s).`;
    el("restore-banner").classList.remove("hidden");

    el("btn-restore").onclick = async () => {
      showBusy("Restauration du projet…");
      try {
        await Persist.restore(saved);
        el("restore-banner").classList.add("hidden");
        selectView(saved.cur >= 0 ? saved.cur : 0, { force: true });
        renderViewsList();
        updateGenerateButton();
        const v = currentView();
        if (!v || !v.gen) goStep(1);
        else if (!v.logos.length) goStep(2);
        else if (v.logos.every(l => l.mask)) goStep(4);
        else goStep(3);
      } finally {
        hideBusy();
      }
    };
    el("btn-restore-dismiss").onclick = () => el("restore-banner").classList.add("hidden");
  }

  document.addEventListener("DOMContentLoaded", () => {
    resetProject(false);
    wireAuth();
    wireSource();
    wireInventory();
    wireNav();
    offerRestore();
    window.addEventListener("beforeunload", ev => {
      if ((App.state.views || []).some(v => v.gen && !v.exported)) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  });

  App.syncAliases = syncAliases;
})();
