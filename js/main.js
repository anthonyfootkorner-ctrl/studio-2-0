// Studio 3.0 — pipeline du skill « créer packshots et mannequin » :
// photos face/dos → PACKSHOTS (vêtement seul, fond uni, sans logos, validés)
// → vues portées qui utilisent le packshot comme référence absolue du produit
// (le décor des photos ne touche plus jamais la génération portée)
// → logos reposés depuis les pixels originaux → export WebP 1080×1350 ≤ 200 Ko.

const App = { state: {}, refreshLogoList: null };

(() => {
  const el = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  let curStep = 1;

  // ══════════ État ══════════
  // Les « vues » sont les LIVRABLES du pipeline (packshot-face, packshot-dos,
  // mannequin-face, mannequin-dos, mannequin-<pose>…), dérivés des deux photos.
  // App.state.sourceCanvas / genCanvas / logos / logoSeq restent des alias de la
  // vue courante (lus par placement.js et masking.js) — muter logos en place.

  const isVue = v => !v.role || v.role === "vue";

  function resetProject(keepModel) {
    App.state.photos = { face: null, dos: null };
    App.state.posesExtra = [];
    App.state.views = [];
    App.state.cur = -1;
    App.state.viewSeq = 0;
    App.state.logoLibrary = [];
    App.state.libSeq = 0;
    App.state.sourceCanvas = null;
    App.state.genCanvas = null;
    App.state.masterCanvas = null;
    App.state.logos = [];
    App.state.logoSeq = 0;
    if (!keepModel) {
      el("m-desc").value = "";
      el("m-notes").value = "";
      el("opt-framing").value = "mid";
      el("opt-bg").value = "studio";
    }
    $$("#extra-poses input").forEach(c => { c.checked = false; });
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
        if (el("user-email")) el("user-email").textContent = session.user.email;
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
    if (n === 1) syncPrepare();
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


  // Charge une photo dans l'emplacement FACE ou DOS (canvas plafonné à 2048 px).
  function addPhotoFile(slotKey, file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
    if (/logo/i.test(file.name)) { addLibraryFile(file, false); return; }
    const img = new Image();
    img.onload = () => {
      const MAX_DIM = 2048;
      const sc = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * sc);
      c.height = Math.round(img.naturalHeight * sc);
      const cctx = c.getContext("2d");
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      App.state.photos[slotKey] = c;
      syncSlots();
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
    for (const key of ["face", "dos"]) {
      const ph = el("ph-" + key);
      if (!ph) continue;
      const photo = App.state.photos[key];
      ph.classList.toggle("filled", !!photo);
      ph.innerHTML = "";
      if (photo) {
        const img = document.createElement("img");
        img.src = thumbnail(photo, 180);
        const bDel = document.createElement("button");
        bDel.type = "button";
        bDel.className = "slot-del";
        bDel.textContent = "✕";
        bDel.title = "Retirer cette photo";
        bDel.addEventListener("click", ev => {
          ev.stopPropagation();
          App.state.photos[key] = null;
          syncSlots();
          Persist.saveSoon();
        });
        ph.append(img, bDel);
      } else {
        const span = document.createElement("span");
        span.textContent = "Glisser une photo ou cliquer";
        ph.appendChild(span);
      }
    }
  }

  // ══════════ Pipeline : livrables et étapes ══════════

  const BG_DEFS = {
    studio: { label: "Studio", hex: "#F5F5F5", rgb: [245, 245, 245] },
    white: { label: "Blanc pur", hex: "#FFFFFF", rgb: [255, 255, 255] },
    grey: { label: "Gris", hex: "#E3E3E3", rgb: [227, 227, 227] },
  };
  const currentBg = () => BG_DEFS[el("opt-bg").value] || BG_DEFS.studio;

  const POSES_EXTRA = [
    { key: "troisquarts", label: "Trois-quarts", pose: "Debout en léger trois-quarts, épaules tournées, regard vers l'objectif" },
    { key: "poche", label: "Main dans la poche", pose: "Debout, une main dans la poche, attitude détendue" },
    { key: "croises", label: "Bras croisés", pose: "Debout, bras croisés sur la poitrine" },
    { key: "marche", label: "En marche", pose: "En marche naturelle vers l'objectif" },
    { key: "ajuste", label: "Ajuste le col", pose: "En train d'ajuster le col ou la manche du vêtement, geste naturel" },
  ];

  // Descriptions réutilisables fournies par l'utilisateur (modèles de mannequin).
  const DESC_PRESETS = [
    { label: "Homme streetwear", desc: "Homme 20-25 ans, peau brune, cheveux courts crépus soignés (petit afro), silhouette athlétique élancée, mâchoire marquée, regard calme et assuré." },
    { label: "Homme urbain", desc: "Homme 20-25 ans, teint métis clair, dégradé court sur les côtés, traits fins, carrure athlétique, allure urbaine confiante." },
    { label: "Femme rooftop", desc: "Femme 20-25 ans, peau hâlée/olive, longs cheveux bruns ondulés, traits marqués, silhouette sportive, regard direct." },
    { label: "Homme salle", desc: "Homme 20-25 ans, teint métis, cheveux bouclés courts, allure sportive posée, look performance." },
  ];

  // Fait correspondre les livrables aux photos présentes et aux poses cochées.
  // Un livrable déjà généré (payé) n'est jamais supprimé.
  function syncSlots() {
    const wanted = [];
    if (App.state.photos.face) {
      wanted.push({ key: "packshot-face", kind: "packshot", angle: "face", photo: "face" });
    }
    if (App.state.photos.dos) {
      wanted.push({ key: "packshot-dos", kind: "packshot", angle: "dos", photo: "dos" });
    }
    if (App.state.photos.face) {
      wanted.push({ key: "mannequin-face", kind: "worn", angle: "face", photo: "face" });
    }
    if (App.state.photos.dos) {
      wanted.push({ key: "mannequin-dos", kind: "worn", angle: "dos", photo: "dos" });
    }
    for (const pk of App.state.posesExtra) {
      const p = POSES_EXTRA.find(x => x.key === pk);
      if (p && App.state.photos.face) {
        wanted.push({ key: "mannequin-" + p.key, kind: "worn", angle: "face", photo: "face", pose: p.pose });
      }
    }
    const old = App.state.views || [];
    const views = [];
    for (const w of wanted) {
      let v = old.find(x => x.key === w.key);
      if (!v) {
        App.state.viewSeq = (App.state.viewSeq || 0) + 1;
        v = {
          id: App.state.viewSeq, key: w.key, name: w.key, role: "vue",
          kind: w.kind, angle: w.angle, pose: w.pose || "",
          source: null, gen: null, master: null, logos: [], logoSeq: 0, exported: false,
        };
      }
      // La photo source suit l'emplacement tant que la vue n'est pas générée.
      if (!v.gen) v.source = App.state.photos[w.photo];
      views.push(v);
    }
    for (const v of old) {
      if (v.gen && !views.some(x => x.key === v.key)) views.push(v); // payé : conservé
    }
    App.state.views = views;
    if (App.state.cur >= views.length || App.state.cur < 0) {
      const i = views.findIndex(isVue);
      if (i >= 0) selectView(i, { force: true });
      else App.state.cur = -1;
    }
    renderViewsList();
    renderViewSwitcher();
    updateGenerateButton();
  }

  // Prochaine phase du pipeline : packshots → porté face (validation identité) → le reste.
  function pipelineStage() {
    const slots = App.state.views || [];
    const packshots = slots.filter(v => v.kind === "packshot");
    if (!packshots.length) return null;
    const p = packshots.filter(v => !v.gen);
    if (p.length) return { phase: "packshots", targets: p };
    const face = slots.find(v => v.key === "mannequin-face");
    if (face && !face.gen) return { phase: "porte-face", targets: [face] };
    const rest = slots.filter(v => v.kind === "worn" && !v.gen);
    if (rest.length) return { phase: "reste", targets: rest };
    return { phase: "fini", targets: [] };
  }

  const euro = n => (n * 0.10).toFixed(2).replace(".", ",") + " €";

  function stageLabel(st) {
    if (!st) return "Charge au moins la photo FACE";
    if (st.phase === "packshots") {
      return `Créer ${st.targets.length > 1 ? "les " + st.targets.length + " packshots" : "le packshot"} (~${euro(st.targets.length)})`;
    }
    if (st.phase === "porte-face") return "Créer la vue portée FACE (~" + euro(1) + ")";
    if (st.phase === "reste") {
      return `Créer ${st.targets.length > 1 ? "les " + st.targets.length + " vues restantes" : "la dernière vue"} avec ce mannequin (~${euro(st.targets.length)})`;
    }
    return "Toutes les vues sont générées";
  }

  function updateGenerateButton() {
    const st = pipelineStage();
    const btn = el("btn-generate");
    btn.disabled = !st || st.phase === "fini" ||
      (st.phase !== "packshots" && !el("m-desc").value.trim());
    btn.textContent = (st && st.phase !== "packshots" && !el("m-desc").value.trim())
      ? "⚠ Décris d'abord le mannequin"
      : stageLabel(st);
    renderRecap();
  }

  const FRAMING_LABELS = { mid: "mi-cuisses", full: "plein pied", low: "bas (sans tête)" };

  function renderRecap() {
    const r = el("q-recap");
    if (!r) return;
    const slots = App.state.views || [];
    if (!slots.length) { r.textContent = ""; return; }
    const faits = slots.filter(v => v.gen).length;
    const parts = [
      slots.map(v => v.key).join(" · "),
      `${slots.length} visuel${slots.length > 1 ? "s" : ""}` + (faits ? ` (${faits} généré${faits > 1 ? "s" : ""})` : ""),
      "cadrage " + (FRAMING_LABELS[el("opt-framing").value] || "mi-cuisses"),
      "fond " + currentBg().label.toLowerCase(),
    ];
    r.textContent = "Livrables — " + parts.join(" · ");
  }

  function syncPrepare() {
    renderViewsList();
    updateGenerateButton();
  }

  function wirePrepare() {
    for (const key of ["face", "dos"]) {
      const slot = el("slot-" + key);
      const input = el("file-" + key);
      slot.addEventListener("click", ev => {
        if (ev.target.closest(".slot-del")) return;
        input.click();
      });
      input.addEventListener("change", () => {
        intake(input.files, f => addPhotoFile(key, f));
        input.value = "";
      });
      slot.addEventListener("dragover", ev => { ev.preventDefault(); slot.classList.add("drag"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
      slot.addEventListener("drop", ev => {
        ev.preventDefault();
        slot.classList.remove("drag");
        intake(ev.dataTransfer.files, f => addPhotoFile(key, f));
      });
    }
    const chips = el("desc-chips");
    DESC_PRESETS.forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = p.label;
      b.addEventListener("click", () => {
        el("m-desc").value = p.desc;
        updateGenerateButton();
        Persist.saveSoon();
      });
      chips.appendChild(b);
    });
    const posesBox = el("extra-poses");
    POSES_EXTRA.forEach(p => {
      const lab = document.createElement("label");
      lab.className = "chip";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.key;
      cb.addEventListener("change", () => {
        App.state.posesExtra = $$("#extra-poses input:checked").map(c => c.value);
        syncSlots();
        Persist.saveSoon();
      });
      lab.append(cb, document.createTextNode(" " + p.label));
      posesBox.appendChild(lab);
    });
    el("m-desc").addEventListener("input", () => { updateGenerateButton(); Persist.saveSoon(); });
    el("opt-framing").addEventListener("change", () => { renderRecap(); Persist.saveSoon(); });
    el("opt-bg").addEventListener("change", () => { renderRecap(); Persist.saveSoon(); });
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

  // ══════════ Génération ══════════

  function modelDescription() {
    return el("m-desc").value.trim();
  }

  function isMinor() {
    const txt = modelDescription().toLowerCase();
    if (/(enfant|ado|garçon|garcon|fille|junior)/.test(txt)) return true;
    const m = txt.match(/(\d{1,2})\s*ans/);
    return m ? +m[1] < 18 : false;
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

  // ── Prompts du pipeline ──

  function framingLines(framing) {
    if (framing === "full") {
      return "CADRAGE OBLIGATOIRE : plein pied — le mannequin est visible EN ENTIER, de la tête aux chaussures (baskets blanches neutres sauf consigne contraire), avec une petite marge au-dessus de la tête et sous les pieds. Rien n'est coupé.";
    }
    if (framing === "low") {
      return "CADRAGE OBLIGATOIRE : photo e-commerce de BAS — cadrée du bas du torse jusqu'aux pieds, chaussures comprises (baskets neutres). La tête et le visage sont HORS cadre, coupés au niveau du torse. Le bas du corps est le sujet principal. En haut, t-shirt uni neutre sauf consigne contraire.";
    }
    return "CADRAGE OBLIGATOIRE : l'image est COUPÉE À MI-CUISSES. La tête est entièrement visible en haut, cheveux compris, avec une petite marge ; le bas de l'image s'arrête à mi-cuisses. Genoux, mollets et pieds sont HORS CHAMP, coupés par le bord de l'image. INTERDIT : mannequin en pied, pieds ou chaussures visibles.";
  }

  function buildPrompt(view, hasIdentity, extraNote) {
    const bg = currentBg();
    const lines = [];
    if (view.kind === "packshot") {
      lines.push(
        `TÂCHE : PACKSHOT e-commerce. ÉDITE l'image 1 — un canevas vide uni ${bg.hex}, format portrait 4:5. Place dessus le VÊTEMENT SEUL visible sur l'image 2, à plat, parfaitement centré, redressé et symétrique, entier avec de petites marges uniformes.`,
        view.angle === "dos"
          ? "C'est la face ARRIÈRE du produit : montre le DOS du vêtement exactement comme sur l'image 2."
          : "C'est la face AVANT du produit, exactement comme sur l'image 2.",
        "AUCUN cintre, mannequin, corps, main ou accessoire, et AUCUN élément du décor de l'image 2 (table, sol, planches, pièce, objets) : seul le vêtement apparaît, posé sur le fond uni.",
        "Si l'image 2 montre le vêtement porté ou en volume, représente-le SEUL, à plat.",
        "Lisse les gros plis de manutention mais conserve la texture naturelle du tissu et les ombres internes du vêtement.",
        "FIDÉLITÉ ABSOLUE : couleurs exactes (teinte, saturation, luminosité), coupe, proportions, coutures, zips, empiècements, panneaux de couleur, cordons — rien d'inventé, rien d'omis, rien de simplifié.",
        "SUPPRIME tous les logos, textes, écussons, étiquettes et marquages du vêtement (ils seront reposés ensuite depuis les pixels originaux) : le textile est parfaitement vierge, sans trace, relief ni logo fantôme.",
        `Fond uni exactement ${bg.hex} sur toute l'image, jusqu'aux bords et dans les coins, sans ombre portée, dégradé, texture ni vignettage.`,
        "NETTETÉ : le vêtement est parfaitement NET, détouré franchement — aucun flou, aucun halo lumineux, aucun contour fantôme autour du vêtement.",
        "ÉCHEC À ÉVITER : si le résultat montre une table, un sol, un mur, un objet de la scène d'origine, ou un vêtement flou fondu dans le fond, c'est RATÉ. Seul le vêtement net sur le fond uni est accepté."
      );
    } else {
      lines.push(
        `TÂCHE : PHOTO E-COMMERCE PORTÉE. ÉDITE l'image 1 — un fond studio vide uni ${bg.hex}, format portrait 4:5. AJOUTE un mannequin portant EXACTEMENT le vêtement de l'image 2.`,
        "L'image 2 est le PACKSHOT de référence : c'est la référence ABSOLUE du produit — reproduis couleurs, coupe, matière, construction, coutures, empiècements et détails à l'IDENTIQUE. N'invente aucun élément absent du packshot.",
        "CONSTRUCTION DU VÊTEMENT : replace chaque panneau de couleur à sa position anatomique une fois le vêtement porté. Une capuche pend derrière le cou et le dos — ne la transforme jamais en couleur d'épaules ou de manches. La géométrie portée diffère naturellement du vêtement à plat : ne pas plaquer la largeur totale des manches du packshot sur le corps.",
        `Le mannequin : ${modelDescription()}.`,
        view.angle === "dos"
          ? "VUE : DE DOS — on voit la nuque, l'arrière des cheveux et le DOS du vêtement ; le visage est INVISIBLE, la tête tournée dans le même sens que le corps, bras relâchés le long du corps."
          : "VUE : DE FACE — torse frontal, épaules équilibrées, regard vers l'objectif.",
        view.pose
          ? `Pose : ${view.pose}.`
          : "Pose naturelle de catalogue : bras et mains naturels, sans raideur.",
        framingLines(el("opt-framing").value)
      );
      if (hasIdentity) {
        lines.push("CONTRAINTE PRIORITAIRE : l'image 3 montre le mannequin DÉJÀ VALIDÉ — le résultat montre EXACTEMENT LA MÊME PERSONNE : même visage, mêmes cheveux (coupe, couleur, volume), même carnation, même morphologie, même largeur d'épaules, même pantalon, même échelle et même éclairage. NE RECOPIE PAS sa pose, son angle ni son cadrage : seuls la VUE et le CADRAGE demandés ci-dessus font foi.");
      }
      lines.push(
        "Si le produit est un haut et qu'aucun bas n'apparaît sur le packshot : pantalon noir sobre sans marque. Aucun accessoire, bijou, montre, casquette ni objet tenu.",
        "AUCUN logo, texte, écusson ou marquage généré sur le vêtement : il est porté VIERGE (les logos originaux seront reposés ensuite pixel pour pixel).",
        "INTÉGRATION NATURELLE : aucun liseré, halo ou contour clair autour du mannequin — pas d'effet d'autocollant ni de détourage. Le fond touche directement les cheveux, la peau et le vêtement, avec au plus une ombre de contact très douce.",
        `Fond uni exactement ${bg.hex} sur toute l'image, sans dégradé, ombre portée marquée, horizon ni vignettage.`
      );
      if (isMinor()) {
        lines.push("Contexte : photo catalogue e-commerce de textile enfant/adolescent. Le mannequin mineur est entièrement habillé, dans une pose catalogue naturelle, expression neutre adaptée à son âge. Aucune sexualisation, aucune mise en scène adulte.");
      }
    }
    const notes = el("m-notes").value.trim();
    if (notes) lines.push("Consignes supplémentaires : " + notes);
    if (extraNote) lines.push("Correction demandée après contrôle : " + extraNote);
    return lines.join("\n");
  }

  // ── Appel Gemini pour une vue ──

  // Prépare une photo produit avant l'envoi : recadrage serré sur le vêtement
  // (le décor — bureau, table, sol — disparaît presque entièrement du cadre),
  // puis neutralisation du fond restant. Le modèle ne peut plus s'ancrer sur la
  // scène de la photo. Les couleurs du vêtement ne sont JAMAIS modifiées ; en
  // cas de doute la fonction rend la photo telle quelle.
  function neutralizeDecor(canvas) {
    const maxDim = 1024;
    const sc = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const W = Math.round(canvas.width * sc), H = Math.round(canvas.height * sc);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;

    // Couleurs de fond : médiane de chaque coin (murs, moquette, table peuvent différer).
    const PATCH = Math.max(16, (Math.min(W, H) * 0.06) | 0);
    const cornerMed = (x0, y0) => {
      const r = [], g = [], b = [];
      for (let y = y0; y < y0 + PATCH; y++) {
        for (let x = x0; x < x0 + PATCH; x++) {
          const i = (y * W + x) * 4;
          r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]);
        }
      }
      const m = a => a.sort((u, v) => u - v)[a.length >> 1];
      return [m(r), m(g), m(b)];
    };
    const bgs = [
      cornerMed(0, 0), cornerMed(W - PATCH, 0),
      cornerMed(0, H - PATCH), cornerMed(W - PATCH, H - PATCH),
    ];
    const TOL = 95;
    const isBg = p => {
      const i = p * 4;
      for (const [r, g, b] of bgs) {
        if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < TOL) return true;
      }
      return false;
    };

    // Boîte du vêtement : lignes/colonnes contenant assez de pixels non-fond.
    const rowHits = new Int32Array(H), colHits = new Int32Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isBg(y * W + x)) { rowHits[y]++; colHits[x]++; }
      }
    }
    const firstIdx = (hits, len, thr) => { for (let i = 0; i < len; i++) if (hits[i] > thr) return i; return -1; };
    const lastIdx = (hits, len, thr) => { for (let i = len - 1; i >= 0; i--) if (hits[i] > thr) return i; return -1; };
    let y0 = firstIdx(rowHits, H, W * 0.02), y1 = lastIdx(rowHits, H, W * 0.02);
    let x0 = firstIdx(colHits, W, H * 0.02), x1 = lastIdx(colHits, W, H * 0.02);
    let cw = W, chh = H, ox = 0, oy = 0;
    let out = c, octx = ctx;
    if (y0 >= 0 && x0 >= 0) {
      const mx = ((x1 - x0) * 0.04) | 0, my = ((y1 - y0) * 0.04) | 0;
      x0 = Math.max(0, x0 - mx); x1 = Math.min(W - 1, x1 + mx);
      y0 = Math.max(0, y0 - my); y1 = Math.min(H - 1, y1 + my);
      const area = (x1 - x0) * (y1 - y0) / (W * H);
      if (area > 0.10 && area < 0.96) {
        cw = x1 - x0 + 1; chh = y1 - y0 + 1; ox = x0; oy = y0;
        out = document.createElement("canvas");
        out.width = cw; out.height = chh;
        octx = out.getContext("2d");
        octx.drawImage(c, x0, y0, cw, chh, 0, 0, cw, chh);
      }
    }

    // Neutralisation du fond restant dans le cadre recadré.
    const id2 = octx.getImageData(0, 0, cw, chh);
    const d2 = id2.data;
    const isBg2 = p => {
      const i = p * 4;
      for (const [r, g, b] of bgs) {
        if (Math.abs(d2[i] - r) + Math.abs(d2[i + 1] - g) + Math.abs(d2[i + 2] - b) < TOL) return true;
      }
      return false;
    };
    const STEP = 24;
    const stepOk = (a, b) => {
      const i = a * 4, j = b * 4;
      return Math.abs(d2[i] - d2[j]) + Math.abs(d2[i + 1] - d2[j + 1]) + Math.abs(d2[i + 2] - d2[j + 2]) < STEP;
    };
    const seen = new Uint8Array(cw * chh);
    const queue = new Int32Array(cw * chh);
    let head = 0, tail = 0;
    const seed = p => { if (!seen[p] && isBg2(p)) { seen[p] = 1; queue[tail++] = p; } };
    const grow = (from, p) => { if (!seen[p] && isBg2(p) && stepOk(from, p)) { seen[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < cw; x++) { seed(x); seed((chh - 1) * cw + x); }
    for (let y = 0; y < chh; y++) { seed(y * cw); seed(y * cw + cw - 1); }
    while (head < tail) {
      const p = queue[head++];
      const x = p % cw, y = (p / cw) | 0;
      if (x > 0) grow(p, p - 1);
      if (x < cw - 1) grow(p, p + 1);
      if (y > 0) grow(p, p - cw);
      if (y < chh - 1) grow(p, p + cw);
    }
    // Le cœur de l'image touché = vêtement mangé : on garde le recadrage, pas la neutralisation.
    let central = 0;
    const bx0 = (cw * 0.3) | 0, bx1 = (cw * 0.7) | 0, by0 = (chh * 0.3) | 0, by1 = (chh * 0.7) | 0;
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) if (seen[y * cw + x]) central++;
    }
    const applied = central / ((bx1 - bx0) * (by1 - by0)) <= 0.25;
    if (applied) {
      for (let p = 0; p < cw * chh; p++) {
        if (seen[p]) { const i = p * 4; d2[i] = 245; d2[i + 1] = 245; d2[i + 2] = 245; }
      }
      octx.putImageData(id2, 0, 0);
    }
    // Score de propreté : l'anneau extérieur fin (la marge du recadrage, hors
    // vêtement par construction) doit être débarrassé du décor. S'il y reste des
    // pixels de scène (grain de plancher, moquette…), le nettoyage local est
    // jugé insuffisant → détourage IA.
    const ring = Math.max(6, (Math.min(cw, chh) * 0.02) | 0);
    let frame = 0, dirty = 0;
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        if (x >= ring && x < cw - ring && y >= ring && y < chh - ring) continue;
        frame++;
        const p = y * cw + x;
        if (!(applied && seen[p]) && !isBg2(p)) dirty++;
      }
    }
    out.__cleaned = applied && dirty / frame < 0.15;
    return out;
  }

  function baseCanvas() {
    const c = document.createElement("canvas");
    c.width = 1536; c.height = 1920; // portrait 4:5
    const ctx = c.getContext("2d");
    ctx.fillStyle = currentBg().hex;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function slot(key) { return (App.state.views || []).find(v => v.key === key) || null; }

  async function generateView(view, extraNote) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Session expirée, reconnecte-toi.");
    const images = [canvasToB64(baseCanvas(), 2048)];
    let hasIdentity = false;
    if (view.kind === "packshot") {
      // Pré-nettoyage local éprouvé : recadrage sur le vêtement + décor neutralisé.
      // Gemini ne voit presque plus la scène, le prompt packshot fait le reste.
      images.push(canvasToB64(neutralizeDecor(view.source), 1536));
    } else {
      const pack = slot("packshot-" + view.angle) || slot("packshot-face");
      if (!pack || !pack.gen) throw new Error("Génère et valide d'abord le packshot " + view.angle + ".");
      images.push(canvasToB64(pack.gen, 1536));
      const face = slot("mannequin-face");
      if (face && face.gen && view.key !== "mannequin-face") {
        images.push(canvasToB64(face.gen, 1024));
        hasIdentity = true;
      }
    }
    const resp = await fetch(GENERATE_FN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + session.access_token,
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: buildPrompt(view, hasIdentity, extraNote),
        images,
        aspectRatio: "4:5",
        debug: {
          op: extraNote ? "regen" : "gen",
          version: document.getElementById("app-version")?.textContent || "?",
          type: view.kind,
          framing: el("opt-framing").value,
          angle: view.angle,
          creation: true,
          n: images.length,
          vue: view.key,
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
    const gen = document.createElement("canvas");
    gen.width = img.naturalWidth;
    gen.height = img.naturalHeight;
    gen.getContext("2d").drawImage(img, 0, 0);
    view.gen = gen;
    view.exported = false;
    if (view === currentView()) App.state.genCanvas = gen;
  }

  async function generateAll() {
    const st = pipelineStage();
    if (!st || !st.targets.length) return;
    if (st.phase !== "packshots" && !modelDescription()) { goStep(1); updateGenerateButton(); return; }
    el("gen-msg").className = "msg";
    el("gen-msg").textContent = "";
    let done = 0;
    let generated = null;
    try {
      for (const v of st.targets) {
        done++;
        showBusy(`Génération ${done}/${st.targets.length} — « ${v.key} »… (10 à 30 s)`);
        await generateView(v);
        generated = v;
        await Persist.save(); // chaque image payée est sauvegardée immédiatement
        renderViewSwitcher();
        updateGenerateButton();
      }
      selectView(App.state.views.indexOf(generated ?? st.targets[0]), { force: true });
      goStep(2);
      const next = pipelineStage();
      el("gen-msg").className = "msg ok";
      if (st.phase === "packshots") {
        el("gen-msg").textContent =
          "Packshots créés. Contrôle-les (couleurs, construction, aucune trace de logo), régénère si besoin, puis clique sur « " + stageLabel(next) + " ».";
      } else if (st.phase === "porte-face") {
        el("gen-msg").textContent =
          "Vue portée FACE créée. Valide le mannequin (visage, vêtement conforme au packshot), puis clique sur « " + stageLabel(next) + " » : les autres vues reprendront exactement cette personne.";
      } else {
        el("gen-msg").textContent = "Toutes les vues sont générées. Passe aux logos, puis au placement et à l'export.";
      }
    } catch (e) {
      el("gen-msg").className = "msg error";
      el("gen-msg").textContent = "Échec de la génération : " + (e.message || e);
      goStep(currentView()?.gen ? 2 : 1);
    } finally {
      hideBusy();
      updateGenerateButton();
      updateStep2Buttons();
    }
  }

  function updateStep2Buttons() {
    const st = pipelineStage();
    const btn = el("btn-generate-rest");
    const pending = st && st.phase !== "fini";
    btn.classList.toggle("hidden", !pending);
    if (pending) btn.textContent = stageLabel(st);
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
      if (v.kind === "packshot" && App.state.views.some(x => x.kind === "worn" && x.gen)) {
        el("gen-msg").textContent = "Packshot régénéré — les vues portées déjà créées reposent sur l'ancien : régénère-les si le produit a changé.";
      } else if (v.key === "mannequin-face" && App.state.views.some(x => x.kind === "worn" && x.key !== "mannequin-face" && x.gen)) {
        el("gen-msg").textContent = "Vue d'identité régénérée — les autres vues portées gardent l'ancien mannequin ; régénère-les si besoin.";
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
    return (v.key || slug(v.name) || "visuel") + ".webp";
  }

  // Normalise le composite au format livrable : 1080×1350 (4:5), letterbox sur le
  // fond choisi, puis fond corrigé à la couleur EXACTE (tolérance 2 niveaux/canal,
  // flood depuis les bords qui s'arrête aux frontières nettes du sujet).
  function finalize45(comp) {
    const [br, bgc, bb] = currentBg().rgb;
    const W = 1080, H = 1350;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = currentBg().hex;
    ctx.fillRect(0, 0, W, H);
    const sc = Math.min(W / comp.width, H / comp.height);
    const dw = Math.round(comp.width * sc), dh = Math.round(comp.height * sc);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(comp, (W - dw) / 2, (H - dh) / 2, dw, dh);

    const id = ctx.getImageData(0, 0, W, H);
    const d = id.data;
    const off = p => p * 4;
    const nearBg = p => {
      const i = off(p);
      return Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) < 75;
    };
    const exact = p => {
      const i = off(p);
      return Math.abs(d[i] - br) <= 2 && Math.abs(d[i + 1] - bgc) <= 2 && Math.abs(d[i + 2] - bb) <= 2;
    };
    // Dérive de fond détectée aux coins ? → correction par flood borné.
    const corners = [0, W - 1, (H - 1) * W, (H - 1) * W + W - 1];
    if (!corners.every(exact)) {
      const STEP = 24;
      const stepOk = (a, b2) => {
        const i = off(a), j = off(b2);
        return Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) < STEP;
      };
      const seen = new Uint8Array(W * H);
      const queue = new Int32Array(W * H);
      let head = 0, tail = 0;
      const seed = p => { if (!seen[p] && nearBg(p)) { seen[p] = 1; queue[tail++] = p; } };
      const grow = (f, p) => { if (!seen[p] && nearBg(p) && stepOk(f, p)) { seen[p] = 1; queue[tail++] = p; } };
      for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
      while (head < tail) {
        const p = queue[head++];
        const x = p % W, y = (p / W) | 0;
        if (x > 0) grow(p, p - 1);
        if (x < W - 1) grow(p, p + 1);
        if (y > 0) grow(p, p - W);
        if (y < H - 1) grow(p, p + W);
      }
      for (let p = 0; p < W * H; p++) {
        if (seen[p]) { const i = off(p); d[i] = br; d[i + 1] = bgc; d[i + 2] = bb; }
      }
      ctx.putImageData(id, 0, 0);
    }
    return c;
  }

  function renderFinal() {
    if (!App.state.genCanvas) return;
    const comp = Placement.compositeFullRes();
    App.state.masterCanvas = comp;
    syncAliases();
    const final = finalize45(comp);
    const c = el("canvas-final");
    const sc = Math.min(1, 620 / final.width);
    c.width = final.width * sc; c.height = final.height * sc;
    c.getContext("2d").drawImage(final, 0, 0, c.width, c.height);
    const v = currentView();
    el("export-info").textContent =
      `« ${exportName(v)} » — 1080 × 1350 (4:5), fond ${currentBg().hex}, ${App.state.logos.length} logo(s) posé(s).`;
  }

  async function exportCurrent() {
    const v = currentView();
    if (!v) return;
    showBusy("Optimisation WebP…");
    try {
      const comp = App.state.masterCanvas || Placement.compositeFullRes();
      const final = finalize45(comp);
      const { blob, quality, overweight } = await Placement.toWebPUnder(final, 200);
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
        `1080 × 1350 — ${(blob.size / 1024).toFixed(0)} Ko (qualité WebP ${Math.round(quality * 100)} %). ` +
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
    showBusy("Export de tous les visuels…");
    try {
      for (const v of ready) {
        selectView(App.state.views.indexOf(v), { force: true });
        const comp = Placement.compositeFullRes();
        App.state.masterCanvas = comp;
        syncAliases();
        const { blob } = await Placement.toWebPUnder(finalize45(comp), 200);
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
        `${ready.length} visuel(s) exporté(s) en 1080 × 1350. Si le navigateur n'a téléchargé que le premier, autorise les téléchargements multiples pour ce site.`;
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
        syncSlots();
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
    wirePrepare();
    resetProject(false);
    wireAuth();
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
