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

  // Un « vrai » sujet à générer (par opposition aux références produit et pantalons)
  const isVue = v => !v.role || v.role === "vue";

  function resetProject(keepModel) {
    App.state.views = [];
    App.state.cur = -1;
    App.state.viewSeq = 0;
    App.state.logoLibrary = [];
    App.state.libSeq = 0;
    App.state.projectType = null; // choix obligatoire : pas de défaut silencieux
    App.state.framing = "source";
    $$("#project-type .type-card").forEach(b => b.classList.remove("active"));
    el("project-framing").value = "source";
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
    cleanRect = null;
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
    if (n === 1) syncQuestionnaire();
    else assistantSay(STEP_MESSAGES[n]);
    if (n === 2) { renderCompare(); updateStep2Buttons(); }
    if (n === 3) { renderInventory(); renderLogoLibrary(); }
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
    const entries = (App.state.views || [])
      .map((v, i) => ({ v, i }))
      .filter(e => isVue(e.v));
    const show = entries.length > 1 && curStep >= 2;
    bar.classList.toggle("hidden", !show);
    if (!show) return;
    bar.innerHTML = "";
    entries.forEach(({ v, i }) => {
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

  function detectAngle(name) {
    const n = name.toLowerCase();
    if (/dos|back|arri/.test(n)) return "dos";
    if (/face|front|avant|devant/.test(n)) return "face";
    if (/profil|side|cote|côté/.test(n)) return "profil";
    return null;
  }

  function addViewFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
    // Un fichier nommé « logo… » est un logo à détourer, pas une vue à générer.
    if (/logo/i.test(file.name)) { addLibraryFile(file, false); return; }
    const img = new Image();
    img.onload = () => {
      // Les photos iPhone (jusqu'à 48 Mpx) sont plafonnées : au-delà, tout devient
      // lourd (sauvegardes, composites) sans gain pour l'e-commerce.
      const MAX_DIM = 2048; // aligné sur la sortie 2K du modèle
      const sc = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * sc);
      c.height = Math.round(img.naturalHeight * sc);
      const cctx = c.getContext("2d");
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      App.state.viewSeq++;
      const defaults = ["face", "dos", "profil"];
      const nVues = App.state.views.filter(isVue).length;
      const fromFile = file.name.replace(/\.[^.]+$/, "").trim();
      const v = {
        id: App.state.viewSeq,
        name: fromFile || defaults[nVues] || "vue-" + App.state.viewSeq,
        angle: detectAngle(file.name) || defaults[nVues] || "face",
        role: "vue",
        source: c, gen: null, master: null,
        logos: [], logoSeq: 0, exported: false,
      };
      App.state.views.push(v);
      if (App.state.views.filter(isVue).length === 1) {
        selectView(App.state.views.indexOf(v), { force: true });
      }
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
      const isRef = !isVue(v);
      const firstVueIdx = App.state.views.findIndex(isVue);
      const dims = document.createElement("small");
      dims.className = "muted";
      dims.textContent = `${v.source.width} × ${v.source.height} px` +
        (!isRef && i === firstVueIdx ? " — référence identité" : "") +
        (v.role === "pant" ? " — sera porté par le mannequin" : "") +
        (v.gen ? " — générée" : "");
      const roleSel = document.createElement("select");
      roleSel.innerHTML =
        '<option value="vue">Vue à générer</option>' +
        '<option value="ref">Photo produit (référence seule)</option>' +
        '<option value="pant">Pantalon à ajouter au mannequin</option>';
      roleSel.value = v.role || "vue";
      roleSel.addEventListener("change", () => {
        v.role = roleSel.value;
        if (!isVue(v) && currentView() === v) {
          const j = App.state.views.findIndex(isVue);
          if (j >= 0) selectView(j, { force: true });
        }
        renderViewsList();
        renderViewSwitcher();
        updateGenerateButton();
        Persist.saveSoon();
      });
      const angleSel = document.createElement("select");
      angleSel.innerHTML =
        '<option value="face">Angle : face</option>' +
        '<option value="dos">Angle : dos</option>' +
        '<option value="profil">Angle : profil</option>';
      angleSel.value = v.angle || "face";
      angleSel.addEventListener("change", () => {
        v.angle = angleSel.value;
        Persist.saveSoon();
      });
      box.append(nameInput, dims, roleSel);
      if (!isRef && v.role !== "pant") box.append(angleSel);
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
    if (el("qs3-next")) updateQNav();
    if (curQ === 4) renderRecap();
    const vues = (App.state.views || []).filter(isVue);
    const todo = vues.filter(v => !v.gen).length;
    const btn = el("btn-generate");
    btn.disabled = todo === 0;
    const hasIdentity = vues.some(v => v.gen);
    const typeChoisi = !!document.querySelector("#project-type .type-card.active");
    if (!typeChoisi) btn.disabled = true;
    if (!typeChoisi && vues.length > 0) {
      btn.textContent = "⚠ Choisis d'abord le type de projet (porté / à plat / ghost)";
      return;
    }
    btn.textContent = vues.length === 0
      ? "Générer toutes les vues"
      : todo === 0
        ? "Toutes les vues sont générées"
        : !hasIdentity && todo > 1
          ? `Générer la 1re vue — valider le mannequin, puis les ${todo - 1} autre(s)`
          : `Générer ${todo} vue${todo > 1 ? "s" : ""} (~${(todo * 0.09).toFixed(2).replace(".", ",")} €)`;
  }

  const MODEL_PRESETS = {
    h20: { genre: "Homme", origine: "", age: "Environ 20 ans", morpho: "Sportif", cheveux: "Bruns courts et texturés", barbe: "Sans barbe", expression: "Expression calme" },
    h30: { genre: "Homme", origine: "", age: "Environ 30 ans", morpho: "Athlétique", cheveux: "Bruns courts", barbe: "Barbe courte soignée", expression: "Expression confiante" },
    f25: { genre: "Femme", origine: "", age: "Environ 25 ans", morpho: "Sportive", cheveux: "Châtains attachés en queue de cheval", barbe: "", expression: "Expression naturelle" },
    ado: { genre: "Garçon", origine: "", age: "Environ 15 ans", morpho: "Sportif", cheveux: "Bruns courts", barbe: "", expression: "Expression calme, pose catalogue naturelle" },
  };

  // ══════════ Assistant ══════════

  const Q_MESSAGES = {
    1: "Quel type de photo as-tu ?",
    2: "Quel cadrage veux-tu pour la photo finale ?",
    3: "Ajoute-moi les photos du produit — toutes les faces m'aident à être fidèle.",
    4: "Décris-moi le mannequin, ou choisis un profil type.",
  };
  const STEP_MESSAGES = {
    2: "Contrôle bien : mannequin, vêtement, fond. Une trace de logo ? Encadre-la, je nettoie.",
    3: "Trace un cadre sur chaque marquage de la source — zoome pour les petits logos ton sur ton.",
    4: "Place chaque logo à sa position exacte. Vérifie à la loupe, elle est à 400 %.",
    5: "Dernier contrôle et export : je te sors un WebP optimisé de 200 Ko max.",
  };

  function assistantSay(text) {
    const msg = el("assistant-msg");
    if (!msg || msg.dataset.last === text) return;
    msg.dataset.last = text;
    if (window.Avatar) Avatar.say(text);
    else msg.textContent = text;
  }

  // ══════════ Questionnaire de l'étape 1 ══════════

  let curQ = 1;

  function goQ(n) {
    curQ = n;
    for (let i = 1; i <= 4; i++) el("qs-" + i).classList.toggle("hidden", i !== n);
    if (n === 4) renderRecap();
    updateQNav();
    assistantSay(Q_MESSAGES[n]);
  }

  function updateQNav() {
    el("qs3-next").disabled = (App.state.views || []).filter(isVue).length === 0;
  }

  const FRAMING_LABELS = {
    source: "identique à la source", full: "plein pied",
    mid: "plan américain", low: "cadré sur le bas",
  };
  const TYPE_LABELS = { worn: "photo portée", flat: "produit à plat", ghost: "photo ghost" };

  function renderRecap() {
    const type = document.querySelector("#project-type .type-card.active")?.dataset.type;
    const views = App.state.views || [];
    const vues = views.filter(isVue).length;
    const refs = views.filter(v => v.role === "ref").length;
    const pants = views.filter(v => v.role === "pant").length;
    const libs = (App.state.logoLibrary || []).length;
    const parts = [
      "Type : " + (TYPE_LABELS[type] || "non choisi"),
      "Cadrage : " + (FRAMING_LABELS[el("project-framing").value] || "?"),
      `${vues} vue${vues > 1 ? "s" : ""} à générer`,
    ];
    if (refs) parts.push(`${refs} référence${refs > 1 ? "s" : ""}`);
    if (pants) parts.push(`${pants} pantalon${pants > 1 ? "s" : ""}`);
    if (libs) parts.push(`${libs} logo${libs > 1 ? "s" : ""} en bibliothèque`);
    el("q-recap").textContent = "Récapitulatif — " + parts.join(" · ");
  }

  // Reprend le questionnaire au bon endroit (retour à l'étape 1, restauration…)
  function syncQuestionnaire() {
    const typeOk = !!document.querySelector("#project-type .type-card.active");
    const hasVues = (App.state.views || []).filter(isVue).length > 0;
    goQ(!typeOk ? 1 : hasVues ? 4 : 3);
  }

  function wireQuestionnaire() {
    $$(".qnav [data-back]").forEach(b =>
      b.addEventListener("click", () => goQ(+b.dataset.back)));
    el("qs2-next").addEventListener("click", () => goQ(3));
    el("qs3-next").addEventListener("click", () => goQ(4));
  }

  function wirePresets() {
    el("model-preset").addEventListener("change", () => {
      const key = el("model-preset").value;
      if (key === "perso" || !key) {
        if (key === "perso") el("model-details").open = true;
        return;
      }
      const p = MODEL_PRESETS[key];
      el("m-genre").value = p.genre;
      el("m-origine").value = p.origine;
      el("m-age").value = p.age;
      el("m-morpho").value = p.morpho;
      el("m-cheveux").value = p.cheveux;
      el("m-barbe").value = p.barbe;
      el("m-expression").value = p.expression;
      Persist.saveSoon();
    });
  }

  function wireProject() {
    $$("#project-type .type-card").forEach(b => b.addEventListener("click", () => {
      App.state.projectType = b.dataset.type;
      $$("#project-type .type-card").forEach(x => x.classList.toggle("active", x === b));
      updateGenerateButton();
      Persist.saveSoon();
      // Esprit questionnaire : choisir une carte fait avancer (délai = feedback tactile)
      if (curQ === 1) setTimeout(() => goQ(2), 220);
    }));
    el("project-framing").addEventListener("change", () => {
      App.state.framing = el("project-framing").value;
      Persist.saveSoon();
    });
  }

  // ══════════ Conversion HEIC (photos iPhone) ══════════
  // Entièrement locale : vendor/libheif-bundle.js (wasm embarqué, aucun appel réseau).

  const isHeic = f => /image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name);

  async function canvasToJpegFile(c, name) {
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.95));
    return new File([blob], name.replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
  }

  async function toCompatible(file) {
    if (!isHeic(file)) return file;
    // 1) Décodage natif du navigateur (Safari lit le HEIC directement ;
    //    couvre aussi les fichiers JPEG mal renommés en .heic).
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      return await canvasToJpegFile(c, file.name);
    } catch { /* le navigateur ne sait pas décoder ce HEIC : on passe à libheif */ }
    // 2) Décodeur libheif à jour (local, vendorisé). La bibliothèque expose une
    //    fabrique : on instancie le module une seule fois.
    App._libheif = App._libheif || window.libheif();
    const buf = await file.arrayBuffer();
    const decoder = new App._libheif.HeifDecoder();
    const imgs = decoder.decode(buf);
    if (!imgs || !imgs.length) throw new Error("aucune image décodable dans ce fichier");
    const img = imgs[0];
    const w = img.get_width(), h = img.get_height();
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(w, h);
    await new Promise((res, rej) =>
      img.display(id, ok => ok ? res() : rej(new Error("décodage HEIC échoué"))));
    imgs.forEach(i => { try { i.free && i.free(); } catch {} });
    ctx.putImageData(id, 0, 0);
    return await canvasToJpegFile(c, file.name);
  }

  async function intake(fileList, handler) {
    const files = Array.from(fileList);
    const nHeic = files.filter(isHeic).length;
    if (nHeic) showBusy(`Conversion de ${nHeic} photo(s) HEIC… (quelques secondes)`);
    try {
      for (const f of files) handler(await toCompatible(f), files.length === 1);
    } catch (e) {
      console.error("Conversion HEIC impossible :", e);
      alert("Conversion HEIC impossible pour un fichier : " + (e.message || e) +
        "\n\nAstuce : repartage la photo par Mail/AirDrop (conversion auto), ou sur iPhone : Réglages → Appareil photo → Formats → « Le plus compatible ».");
    } finally {
      if (nHeic) hideBusy();
    }
  }

  function wireSource() {
    const dz = el("drop-source");
    el("btn-browse").addEventListener("click", ev => { ev.preventDefault(); el("file-source").click(); });
    el("file-source").addEventListener("change", ev => {
      intake(ev.target.files, addViewFile);
      ev.target.value = "";
    });
    dz.addEventListener("dragover", ev => { ev.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", ev => {
      ev.preventDefault(); dz.classList.remove("over");
      intake(ev.dataTransfer.files, addViewFile);
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

  function buildPrompt(view, meta, extraNote) {
    const desc = modelDescription() || "mannequin adulte au look neutre";
    const pose = el("m-pose").value.trim() || "pose e-commerce naturelle, différente de la photo source";
    const acc = el("m-accessoires").value.trim();
    const notes = el("m-notes").value.trim();
    // L'interface est la source de vérité (évite tout état obsolète).
    const type = document.querySelector("#project-type .type-card.active")?.dataset.type
      || App.state.projectType || "worn";
    const framing = el("project-framing").value || App.state.framing || "source";
    // Cadrage « bas » : la tête est volontairement hors champ, ne pas l'exiger.
    const headPhrase = framing === "low"
      ? ""
      : " La tête doit être entièrement visible, cheveux et sommet du crâne inclus, avec une petite marge au-dessus.";
    const withRef = meta.some(m => m.kind === "identity");
    const pantCount = meta.filter(m => m.kind === "pant").length;
    const productCount = meta.filter(m => m.kind === "product").length;

    const refPhrase = "L'image « mannequin de référence » montre le mannequin déjà validé : utilise-la comme référence absolue d'identité (silhouette, carnation, cheveux, morphologie, proportions, échelle).";
    const lines = [];
    if (type === "flat" || type === "ghost") {
      const intro = type === "ghost"
        ? "packshots « ghost » (vêtement en volume, porté par personne)"
        : "photos du produit à plat, non porté";
      lines.push("TÂCHE : ÉDITE l'image 1 — un fond studio VIDE (gris #F5F5F5). AJOUTE sur ce fond un mannequin portant le produit des références. Le résultat est l'image 1 remplie avec le mannequin en pied de photo e-commerce — rien d'autre.");
      lines.push("Les autres images sont des références produit (" + intro + ") : reproduis-en fidèlement le VÊTEMENT, mais n'en réutilise NI le décor, NI la table, NI le sol, NI la composition. Aucun élément de leurs arrière-plans ne doit apparaître." + (withRef ? " " + refPhrase : ""));
      lines.push(`Le mannequin : ${desc}.`);
      lines.push(`VUE À PRODUIRE : « ${view.angle || "face"} ». Génère le mannequin sous cet angle, en te basant sur la face correspondante du produit. Face = mannequin vu DE FACE. Dos = mannequin vu DE DOS : on voit sa nuque, l'arrière de ses cheveux et le DOS du vêtement — son visage n'est PAS visible. Profil = vu de côté.`);
      lines.push("Le produit peut être un ENSEMBLE présenté sur plusieurs photos (par exemple le haut et le bas d'un survêtement photographiés séparément) : le mannequin doit porter l'ensemble COMPLET, chaque pièce reproduite depuis sa photo.");
      lines.push(`Pose : ${pose}.${headPhrase} Le panneau du vêtement montré doit être bien face caméra, plat et sans distorsion.`);
      lines.push("Reproduis EXACTEMENT le vêtement des photos : couleur, coupe, matière, coutures, motifs, longueur, détails et proportions strictement identiques. N'invente aucun élément absent des photos.");
      lines.push("Aucun accessoire : pas de lunettes, bijoux, montre, casquette, sac ni objet tenu." + (acc ? ` Consigne spécifique : ${acc}.` : ""));
    } else {
      lines.push(withRef
        ? "Photo e-commerce studio. La première image est la photo produit à modifier (une autre vue du même produit : dos, profil ou autre angle). " + refPhrase + " Le visage peut être peu visible selon l'angle, mais tout doit correspondre au même mannequin."
        : "Photo e-commerce studio. Modifie cette photo produit.");
      lines.push(`Remplace le mannequin par : ${desc}.`);
      lines.push(`Nouvelle pose : ${pose}. Respecte cependant l'angle et l'orientation du buste propres à cette photo source.${headPhrase}`);
      lines.push("Retire tous les accessoires visibles : lunettes, bijoux, montre, casquette, sac, écouteurs, gants et objets tenus."
        + (acc ? ` Consigne spécifique : ${acc}.` : "")
        + " Chaque membre qui touchait un accessoire retiré doit reprendre une pose naturelle et équilibrée.");
      lines.push("Conserve EXACTEMENT le vêtement porté : coupe, matière, couleur, coutures, zip, col, manches, détails réfléchissants et proportions identiques à la source.");
      lines.push("Le buste et le panneau poitrine doivent rester dans le même plan, avec la même orientation et la même inclinaison caméra que la photo source. Pas de rotation ni de redressement du buste.");
    }

    // Rôles explicites et numérotés de chaque image fournie.
    const roleTxt = {
      base: "le FOND STUDIO VIDE de la photo finale — c'est la base à éditer : place le mannequin dessus, ne change ni la couleur ni l'uniformité du fond.",
      main: (type === "flat" || type === "ghost")
        ? "la référence produit principale (la face du vêtement correspondant à la vue à produire). RÉFÉRENCE UNIQUEMENT : ne pas retoucher, ne pas réutiliser son décor ni sa composition."
        : "la photo produit source à transformer",
      identity: "le mannequin de référence DÉJÀ VALIDÉ. CONTRAINTE PRIORITAIRE : le résultat doit montrer EXACTEMENT LA MÊME PERSONNE — même visage, même coupe et couleur de cheveux, même carnation, même morphologie, même âge. ATTENTION : cette image sert UNIQUEMENT à l'identité de la personne. NE RECOPIE PAS cette image : pas sa pose, pas son angle de vue, pas son cadrage, pas sa composition. Le résultat correspond à l'image 1 et à la VUE À PRODUIRE, jamais à cette image de référence.",
      pant: "le PANTALON que le mannequin doit porter — reproduis-le à l'identique (couleur, coupe, matière, coutures, détails), correctement ajusté au bas du corps.",
      product: "autre face du MÊME produit (référence vêtement uniquement — dos, côtés, autres pièces d'un ensemble). Ne pas la recopier telle quelle.",
    };
    lines.push("Rôles des images fournies :\n- " +
      meta.map((m, i) => `Image ${i + 1}${m.name ? ` (« ${m.name} »)` : ""} : ${roleTxt[m.kind]}`).join("\n- "));

    if (pantCount > 0) {
      lines.push("PANTALON : même si la photo source est coupée à la taille ou ne montre pas le bas du corps, le mannequin doit porter le pantalon fourni en référence, reproduit exactement. Ne pas inventer un autre bas.");
    }

    lines.push(
      "FIDÉLITÉ ABSOLUE AU PRODUIT : reproduis les couleurs EXACTES du vêtement (teinte, saturation, luminosité) telles qu'elles apparaissent sur les photos — sans embellir, sans réchauffer ni adoucir, sans modifier la balance des blancs. Reproduis aussi TOUS les éléments graphiques : bandes, traits, lignes contrastées, empiècements, panneaux de couleur, surpiqûres — n'en supprime, déplace ni simplifie AUCUN, même petit ou discret.");
    lines.push(
      "IMPORTANT : supprime TOUS les logos, écussons, textes, sponsors et marquages du vêtement (pantalon compris). Inspecte et nettoie chaque zone : poitrine gauche et droite, les deux manches, col, côtés, bas du vêtement, ceinture et jambes. Les petits marquages brodés ou ton sur ton (blanc sur gris, gris sur gris) doivent disparaître COMPLÈTEMENT — sans trace, sans relief, sans zone floue ni logo fantôme. Le textile doit être parfaitement vierge et continu.",
      "Fond studio uni exactement #F5F5F5 sur toute l'image, sans gradient, ombre portée, texture, horizon, vignettage ni variation de teinte. Le décor de la photo source (table, sol, objets, pièce, vêtement posé) doit TOTALEMENT disparaître : rien de la scène d'origine ne subsiste sur le résultat.",
      "BORDS ET BAS DE L'IMAGE impeccables : le fond reste uniforme jusqu'aux quatre bords et dans les coins (aucun sol, parquet, mur ou objet). Si un short ou un bas neutre est visible en bas de l'image, il est NET, uni et sans tache, flou ni artefact — comme le reste de la photo.",
    );
    const creation = type === "flat" || type === "ghost";
    const formatPhrase = creation
      ? "Format de sortie : portrait vertical 3:4, photo studio e-commerce."
      : "Conserve le format (ratio) de la première image.";
    if (framing === "full") {
      lines.push("CADRAGE : plein pied — le mannequin est visible en entier, de la tête aux chaussures (baskets blanches neutres sauf consigne contraire), avec une petite marge au-dessus de la tête et sous les pieds. " + formatPhrase);
    } else if (framing === "mid") {
      lines.push("CADRAGE : plan américain e-commerce — cadré de la tête à mi-cuisse, le pantalon bien visible. " + formatPhrase);
    } else if (framing === "low") {
      lines.push("CADRAGE : photo e-commerce de PANTALON — cadrée du bas du torse jusqu'aux pieds, chaussures comprises (baskets neutres sauf consigne contraire). La tête et le visage sont HORS cadre, coupés au niveau du torse, comme une photo produit de bas. Le pantalon est le sujet principal, visible en entier de la ceinture aux chevilles. En haut, le mannequin porte un t-shirt uni neutre (sauf consigne contraire). " + formatPhrase);
    } else if (creation) {
      lines.push("CADRAGE : de la tête à mi-cuisse environ, cadrage e-commerce standard centré sur le produit. " + formatPhrase);
    } else {
      lines.push("Conserve le cadrage et le format de la première image." +
        (pantCount > 0 ? " Si la source est coupée à la taille, élargis légèrement vers le bas pour montrer le haut du pantalon." : ""));
    }
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

  function isCreationProject() {
    const t = document.querySelector("#project-type .type-card.active")?.dataset.type;
    return t === "flat" || t === "ghost";
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
    const creation = isCreationProject();
    // Ordre des images : [fond studio vierge en création], source, [identité],
    // pantalons, autres photos produit (plafond de 5 images).
    // Astuce anti-décor : le modèle « édite » toujours la première image reçue —
    // en mode création on lui donne donc un fond studio VIDE comme base à éditer.
    const meta = [];
    const images = [];
    if (creation) {
      const base = document.createElement("canvas");
      base.width = 1536; base.height = 2048; // portrait 3:4
      const bctx = base.getContext("2d");
      bctx.fillStyle = "#F5F5F5";
      bctx.fillRect(0, 0, base.width, base.height);
      images.push(canvasToB64(base, 2048));
      meta.push({ kind: "base" });
    }
    images.push(canvasToB64(view.source, creation ? 1024 : 1536));
    meta.push({ kind: creation ? "product" : "main", name: creation ? view.name : undefined });
    if (ref) { images.push(canvasToB64(ref, 1024)); meta.push({ kind: "identity" }); }
    const others = App.state.views.filter(v => v !== view)
      .sort((a, b) => (a.role === "pant" ? -1 : 0) - (b.role === "pant" ? -1 : 0));
    for (const v of others) {
      if (images.length >= 5) break;
      images.push(canvasToB64(v.source, 1024));
      meta.push({ kind: v.role === "pant" ? "pant" : "product", name: v.name });
    }
    const resp = await fetch(GENERATE_FN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + session.access_token,
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: buildPrompt(view, meta, extraNote),
        images,
        aspectRatio: isCreationProject() ? "3:4" : undefined,
        debug: {
          op: extraNote ? "regen" : "gen",
          version: document.getElementById("app-version")?.textContent || "?",
          type: document.querySelector("#project-type .type-card.active")?.dataset.type || "aucun",
          framing: el("project-framing").value,
          angle: view.angle || "?",
          creation: isCreationProject(),
          n: images.length,
        },
      }),
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out.error + (out.detail ? " — " + out.detail : ""));

    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = `data:${out.image.mimeType};base64,${out.image.data}`;
    });
    // Photo portée : la génération reprend les dimensions exactes de la source.
    // Projet à plat/ghost : c'est une CRÉATION — on garde le format natif (portrait 3:4),
    // pas celui de la photo de référence posée sur une table.
    const gen = document.createElement("canvas");
    if (isCreationProject()) {
      gen.width = img.naturalWidth;
      gen.height = img.naturalHeight;
      gen.getContext("2d").drawImage(img, 0, 0);
    } else {
      gen.width = view.source.width;
      gen.height = view.source.height;
      const ctx = gen.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, gen.width, gen.height);
    }
    view.gen = gen;
    view.exported = false;
    if (view === currentView()) App.state.genCanvas = gen;
    // Le visage du mannequin généré devient le portrait scanné de l'assistant.
    if (window.Avatar && Avatar.adopt && isVue(view) && (view.angle || "face") === "face") {
      try { Avatar.adopt(gen); } catch {}
    }
  }

  async function generateAll() {
    const vues = (App.state.views || []).filter(isVue);
    if (!vues.length) return;
    const hasIdentity = vues.some(v => v.gen);
    // Sans mannequin validé : générer UNIQUEMENT la première vue, la faire valider,
    // puis générer les autres avec cette référence — sinon chaque vue invente son mannequin.
    const targets = hasIdentity
      ? vues.filter(v => !v.gen)
      : vues.filter(v => !v.gen).slice(0, 1);
    if (!targets.length) return;
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    let done = 0;
    let generated = null;
    try {
      for (const v of targets) {
        done++;
        showBusy(`Génération ${done}/${targets.length} — vue « ${v.name} »… (10 à 30 s)`);
        await generateView(v);
        generated = v;
        await Persist.save(); // chaque image payée est sauvegardée immédiatement
        renderViewsList();
        updateGenerateButton();
      }
      selectView(App.state.views.indexOf(generated ?? targets[0]), { force: true });
      goStep(2);
      const remaining = vues.filter(v => !v.gen).length;
      if (!hasIdentity && remaining > 0) {
        el("gen-msg").className = "msg ok";
        el("gen-msg").textContent =
          `Mannequin créé. Valide cette vue (identité, pose, vêtement) puis clique sur « Générer les ${remaining} vue(s) restante(s) » : elles reprendront exactement ce mannequin.`;
      }
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la génération : " + (e.message || e);
      goStep(currentView()?.gen ? 2 : 1);
    } finally {
      hideBusy();
      updateGenerateButton();
      renderViewsList();
      updateStep2Buttons();
    }
  }

  function updateStep2Buttons() {
    const vues = (App.state.views || []).filter(isVue);
    const remaining = vues.filter(v => !v.gen).length;
    const btn = el("btn-generate-rest");
    btn.classList.toggle("hidden", remaining === 0 || !vues.some(v => v.gen));
    btn.textContent = `Générer les ${remaining} vue(s) restante(s) avec ce mannequin`;
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
      cleanRect = null;
      await Persist.save();
      renderCompare();
      renderViewSwitcher();
      const firstVue = App.state.views.findIndex(isVue);
      if (App.state.cur === firstVue && App.state.views.some((x, i) => i !== firstVue && isVue(x) && x.gen)) {
        el("gen-msg").textContent = "Vue de référence régénérée — les autres vues déjà générées gardent l'ancienne identité ; régénère-les si besoin.";
      }
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la régénération : " + (e.message || e);
    } finally {
      hideBusy();
    }
  }

  // Zone de nettoyage (coordonnées pleine résolution de l'image générée)
  let cleanRect = null;
  let cleanDrag = null;

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
    const r = cleanDrag && cleanDrag.cur ? cleanDrag.toRect() : cleanRect;
    if (r) {
      ctx.strokeStyle = "#d33d33";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
      ctx.setLineDash([]);
    }
    el("btn-clean-zone").disabled = !cleanRect;
  }

  function comparePos(ev) {
    const c = el("canvas-compare");
    const rect = c.getBoundingClientRect();
    const scale = App.state.genCanvas.width / c.width;
    const cssScale = c.width / rect.width;
    return {
      x: (ev.clientX - rect.left) * cssScale * scale,
      y: (ev.clientY - rect.top) * cssScale * scale,
    };
  }

  function wireCleanZone() {
    const c = el("canvas-compare");
    c.style.cursor = "crosshair";
    c.addEventListener("pointerdown", ev => {
      if (!App.state.genCanvas) return;
      const p = comparePos(ev);
      cleanDrag = {
        x0: p.x, y0: p.y, cur: null,
        toRect() {
          return {
            x: Math.min(this.x0, this.cur.x), y: Math.min(this.y0, this.cur.y),
            w: Math.abs(this.cur.x - this.x0), h: Math.abs(this.cur.y - this.y0),
          };
        },
      };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener("pointermove", ev => {
      if (!cleanDrag) return;
      cleanDrag.cur = comparePos(ev);
      renderCompare();
    });
    c.addEventListener("pointerup", () => {
      if (!cleanDrag) return;
      const r = cleanDrag.cur ? cleanDrag.toRect() : null;
      cleanDrag = null;
      cleanRect = r && r.w > 8 && r.h > 8 ? r : null; // mini-tracé = effacer la zone
      renderCompare();
    });
  }

  async function cleanZone() {
    const v = currentView();
    if (!v || !v.gen || !cleanRect) return;
    showBusy("Nettoyage de la zone encadrée… (10 à 30 s)");
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Session expirée, reconnecte-toi.");
      // Incruste un cadre rouge sur une copie : le marqueur visuel localise la retouche.
      const marked = document.createElement("canvas");
      marked.width = v.gen.width; marked.height = v.gen.height;
      const ctx = marked.getContext("2d");
      ctx.drawImage(v.gen, 0, 0);
      ctx.strokeStyle = "#ff0000";
      ctx.lineWidth = Math.max(4, Math.round(marked.width * 0.005));
      ctx.strokeRect(cleanRect.x, cleanRect.y, cleanRect.w, cleanRect.h);
      const prompt = [
        "Cette photo e-commerce contient un cadre rouge tracé par-dessus l'image.",
        "À L'INTÉRIEUR du cadre rouge, il reste un logo, un marquage ou une trace de logo sur le textile : efface-le COMPLÈTEMENT. Le tissu doit y être continu et uniforme, avec exactement la même texture, couleur et éclairage que le textile immédiatement autour du cadre.",
        "Ne modifie RIEN d'autre : même mannequin, même visage, même pose, même vêtement, même fond. Supprime aussi le cadre rouge : il ne doit pas apparaître sur le résultat.",
      ].join("\n");
      const resp = await fetch(GENERATE_FN_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + session.access_token,
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          images: [canvasToB64(marked, 1536)],
          debug: { op: "clean", version: document.getElementById("app-version")?.textContent || "?" },
        }),
      });
      const out = await resp.json();
      if (!resp.ok) throw new Error(out.error + (out.detail ? " — " + out.detail : ""));
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = rej;
        img.src = `data:${out.image.mimeType};base64,${out.image.data}`;
      });
      const gen = document.createElement("canvas");
      gen.width = v.gen.width; gen.height = v.gen.height;
      const gctx = gen.getContext("2d");
      gctx.imageSmoothingQuality = "high";
      gctx.drawImage(img, 0, 0, gen.width, gen.height);
      v.gen = gen;
      if (v === currentView()) App.state.genCanvas = gen;
      cleanRect = null;
      await Persist.save();
      renderCompare();
      el("gen-msg").className = "msg ok";
      el("gen-msg").textContent = "Zone nettoyée — contrôle le résultat, tu peux encadrer une autre zone si besoin.";
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec du nettoyage : " + (e.message || e);
    } finally {
      hideBusy();
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
      ctx.strokeStyle = "#C65E29";
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
      intake(ev.target.files, (f, seul) => addLibraryFile(f, seul));
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

  // ══════════ Bibliothèque de logos ══════════
  // Une photo détail (packshot, gros plan, fichier « logo… ») est détourée UNE fois
  // dans la bibliothèque, puis peut être posée sur n'importe quelle vue générée.

  function addLibraryFile(file, autoOpen) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
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
      App.state.libSeq = (App.state.libSeq || 0) + 1;
      const item = {
        id: App.state.libSeq,
        name: file.name.replace(/\.[^.]+$/, "").trim() || "logo-" + App.state.libSeq,
        imgData: ctx.getImageData(0, 0, c.width, c.height),
        type: "print",
        mask: null, cropCanvas: null, maskVersion: 0,
      };
      App.state.logoLibrary.push(item);
      renderLogoLibrary();
      Persist.saveSoon();
      if (autoOpen !== false) openLibraryEditor(item);
    };
    img.src = URL.createObjectURL(file);
  }

  function openLibraryEditor(item) {
    Masking.open(item, item.imgData, () => {
      item.maskVersion++;
      renderLogoLibrary();
      Persist.saveSoon();
    });
  }

  function placeLibraryLogo(item) {
    const base = App.state.sourceCanvas;
    if (!base || !item.mask) return;
    App.state.logoSeq++;
    const w = item.imgData.width;
    const initScale = Math.max(5, Math.min(300, Math.round((base.width * 0.22 / w) * 100)));
    App.state.logos.push({
      id: App.state.logoSeq,
      name: item.name,
      external: true,
      rect: { x: 0, y: 0, w, h: item.imgData.height },
      imgData: item.imgData,
      type: item.type,
      mask: new Uint8ClampedArray(item.mask), // copie : réparable par vue sans toucher la bibliothèque
      cropCanvas: item.cropCanvas,
      maskVersion: 1,
      placement: {
        x: Math.round(base.width * 0.39),
        y: Math.round(base.height * 0.3),
        scale: initScale, contract: 0, feather: 0,
      },
    });
    syncAliases();
    refreshLogoList();
    renderViewSwitcher();
    Persist.saveSoon();
  }

  function renderLogoLibrary() {
    const box = el("logo-library-box");
    const ul = el("logo-library");
    const lib = App.state.logoLibrary || [];
    box.classList.toggle("hidden", lib.length === 0);
    ul.innerHTML = "";
    for (const item of lib) {
      const li = document.createElement("li");
      const img = document.createElement("img");
      if (item.cropCanvas) img.src = item.cropCanvas.toDataURL();
      const span = document.createElement("span");
      span.className = "name";
      const nameInput = document.createElement("input");
      nameInput.value = item.name;
      nameInput.addEventListener("change", () => {
        item.name = nameInput.value.trim() || item.name;
        Persist.saveSoon();
      });
      const state = document.createElement("span");
      state.className = "state " + (item.mask ? "ok" : "todo");
      state.textContent = item.mask ? "Détouré" : "À détourer";
      span.append(nameInput);
      const bEdit = document.createElement("button");
      bEdit.className = "btn ghost";
      bEdit.textContent = item.mask ? "Réparer" : "Détourer";
      bEdit.addEventListener("click", () => openLibraryEditor(item));
      const bPlace = document.createElement("button");
      bPlace.className = "btn";
      bPlace.textContent = "Poser";
      bPlace.disabled = !item.mask;
      bPlace.title = "Poser ce logo sur la vue courante";
      bPlace.addEventListener("click", () => placeLibraryLogo(item));
      const bDel = document.createElement("button");
      bDel.className = "btn ghost";
      bDel.textContent = "✕";
      bDel.addEventListener("click", () => {
        App.state.logoLibrary = App.state.logoLibrary.filter(x => x !== item);
        renderLogoLibrary();
        Persist.saveSoon();
      });
      li.append(img, span, state, bEdit, bPlace, bDel);
      ul.appendChild(li);
    }
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
    const ready = App.state.views.filter(v => isVue(v) && v.gen);
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
    el("btn-generate-rest").addEventListener("click", generateAll);
    el("btn-clean-zone").addEventListener("click", cleanZone);
    el("btn-color-fix").addEventListener("click", () => ColorFix.open(() => {
      syncAliases();
      renderCompare();
      Persist.saveSoon();
    }));
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
        let idx = saved.cur >= 0 ? saved.cur : 0;
        if (!App.state.views[idx] || !isVue(App.state.views[idx])) {
          idx = Math.max(0, App.state.views.findIndex(isVue));
        }
        selectView(idx, { force: true });
        renderLogoLibrary();
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

  function tickClock() {
    const d = new Date();
    const t = el("cap-time"), dt = el("cap-date");
    if (t) t.textContent = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    if (dt) dt.textContent = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    tickClock();
    setInterval(tickClock, 30000);
    resetProject(false);
    wireAuth();
    wireProject();
    wirePresets();
    wireQuestionnaire();
    wireSource();
    wireInventory();
    wireCleanZone();
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
