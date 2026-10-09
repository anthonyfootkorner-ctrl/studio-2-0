// Sauvegarde automatique locale (IndexedDB) : une génération payée ne doit jamais
// être perdue par un rechargement de page ou un arrêt du serveur.
// Format v2 : projet multi-vues { version: 2, views: [...], cur }.

const Persist = (() => {
  const DB_NAME = "studio-mannequin";
  const STORE = "session";

  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function put(val) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, "current");
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getRaw() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(STORE).objectStore(STORE).get("current");
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function clear() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete("current");
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  const canvasToBlob = c => (c ? new Promise(r => c.toBlob(r, "image/png")) : Promise.resolve(null));
  async function blobToCanvas(b) {
    if (!b) return null;
    const bmp = await createImageBitmap(b);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    return c;
  }

  function serializeLogos(logos) {
    return (logos || []).map(l => ({
      id: l.id, name: l.name, rect: l.rect, type: l.type,
      external: !!l.external,
      // Un logo externe ne peut pas être re-découpé depuis la photo source :
      // ses pixels sont sauvegardés avec lui (ImageData est clonable en IndexedDB).
      imgData: l.external ? l.imgData : null,
      mask: l.mask ? new Uint8ClampedArray(l.mask) : null,
      maskVersion: l.maskVersion || 0,
      placement: { ...l.placement },
    }));
  }

  async function save() {
    if (typeof App.syncAliases === "function") App.syncAliases();
    const views = App.state.views || [];
    if (!views.length && !App.state.photos?.face) return;
    const g = id => document.getElementById(id);
    try {
      await put({
        version: 3,
        savedAt: Date.now(),
        cur: App.state.cur,
        modelDesc: (g("m-desc") || {}).value || "",
        notes: (g("m-notes") || {}).value || "",
        framing: (g("opt-framing") || {}).value || "mid",
        background: (g("opt-bg") || {}).value || "studio",
        posesExtra: App.state.posesExtra || [],
        photos: {
          face: await canvasToBlob(App.state.photos?.face),
          dos: await canvasToBlob(App.state.photos?.dos),
        },
        viewSeq: App.state.viewSeq || views.length,
        libSeq: App.state.libSeq || 0,
        logoLibrary: (App.state.logoLibrary || []).map(it => ({
          id: it.id, name: it.name, type: it.type,
          imgData: it.imgData,
          mask: it.mask ? new Uint8ClampedArray(it.mask) : null,
          maskVersion: it.maskVersion || 0,
        })),
        views: await Promise.all(views.map(async v => ({
          id: v.id,
          key: v.key,
          name: v.name,
          kind: v.kind || "worn",
          angle: v.angle || "face",
          pose: v.pose || "",
          validated: !!v.validated,
          exported: !!v.exported,
          source: await canvasToBlob(v.source),
          gen: await canvasToBlob(v.gen),
          logoSeq: v.logoSeq || 0,
          logos: serializeLogos(v.logos),
        }))),
      });
    } catch (e) {
      console.warn("Sauvegarde locale impossible :", e);
    }
  }

  let timer = null;
  function saveSoon() {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  }

  async function getSaved() {
    const raw = await getRaw();
    return raw && raw.version === 3 ? raw : null;
  }

  async function restore(data) {
    const s = App.state;
    const g = id => document.getElementById(id);
    s.views = [];
    s.viewSeq = data.viewSeq || (data.views || []).length;
    s.posesExtra = data.posesExtra || [];
    s.photos = {
      face: await blobToCanvas(data.photos?.face),
      dos: await blobToCanvas(data.photos?.dos),
    };
    if (g("m-desc")) g("m-desc").value = data.modelDesc || "";
    if (g("m-notes")) g("m-notes").value = data.notes || "";
    if (g("opt-framing")) g("opt-framing").value = data.framing || "mid";
    if (g("opt-bg")) g("opt-bg").value = data.background || "studio";
    document.querySelectorAll("#extra-poses input").forEach(c => {
      c.checked = s.posesExtra.includes(c.value);
    });
    s.libSeq = data.libSeq || 0;
    s.logoLibrary = (data.logoLibrary || []).map(it => {
      const mask = it.mask ? new Uint8ClampedArray(it.mask) : null;
      return {
        id: it.id, name: it.name, type: it.type || "print",
        imgData: it.imgData, mask,
        maskVersion: it.maskVersion || 0,
        cropCanvas: mask ? Masking.buildCropCanvas(it.imgData, mask) : null,
      };
    });
    for (const d of data.views || []) {
      const source = await blobToCanvas(d.source);
      if (!source) continue;
      const ctx = source.getContext("2d");
      const logos = (d.logos || []).map(dl => {
        const imgData = dl.external && dl.imgData
          ? dl.imgData
          : ctx.getImageData(dl.rect.x, dl.rect.y, dl.rect.w, dl.rect.h);
        const mask = dl.mask ? new Uint8ClampedArray(dl.mask) : null;
        return {
          id: dl.id, name: dl.name, rect: dl.rect, type: dl.type,
          external: !!dl.external,
          imgData, mask, maskVersion: dl.maskVersion,
          cropCanvas: mask ? Masking.buildCropCanvas(imgData, mask) : null,
          placement: { ...dl.placement },
        };
      });
      s.views.push({
        id: d.id,
        key: d.key,
        name: d.name,
        role: "vue",
        kind: d.kind || "worn",
        angle: d.angle || "face",
        pose: d.pose || "",
        validated: !!d.validated,
        exported: !!d.exported,
        source,
        gen: await blobToCanvas(d.gen),
        master: null,
        logos,
        logoSeq: d.logoSeq || 0,
      });
    }
    s.cur = -1; // forcera selectView à recharger les alias
  }

  return { save, saveSoon, getSaved, restore, clear };
})();
