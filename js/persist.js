// Sauvegarde automatique locale (IndexedDB) : une génération payée ne doit jamais
// être perdue par un rechargement de page ou un arrêt du serveur.

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
  async function getSaved() {
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

  async function save() {
    const s = App.state;
    if (!s.sourceCanvas) return;
    try {
      await put({
        savedAt: Date.now(),
        backMode: !!s.backMode,
        source: await canvasToBlob(s.sourceCanvas),
        gen: await canvasToBlob(s.genCanvas),
        faceRef: await canvasToBlob(s.faceRefCanvas),
        logoSeq: s.logoSeq || 0,
        logos: (s.logos || []).map(l => ({
          id: l.id, name: l.name, rect: l.rect, type: l.type,
          mask: l.mask ? new Uint8ClampedArray(l.mask) : null,
          maskVersion: l.maskVersion || 0,
          placement: { ...l.placement },
        })),
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

  async function restore(data) {
    const s = App.state;
    s.sourceCanvas = await blobToCanvas(data.source);
    s.genCanvas = await blobToCanvas(data.gen);
    s.faceRefCanvas = await blobToCanvas(data.faceRef);
    s.backMode = !!data.backMode;
    s.logoSeq = data.logoSeq || 0;
    const ctx = s.sourceCanvas.getContext("2d");
    s.logos = (data.logos || []).map(d => {
      const imgData = ctx.getImageData(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
      const mask = d.mask ? new Uint8ClampedArray(d.mask) : null;
      return {
        id: d.id, name: d.name, rect: d.rect, type: d.type,
        imgData, mask, maskVersion: d.maskVersion,
        cropCanvas: mask ? Masking.buildCropCanvas(imgData, mask) : null,
        placement: { ...d.placement },
      };
    });
  }

  return { save, saveSoon, getSaved, restore, clear };
})();
