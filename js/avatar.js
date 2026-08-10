// Avatar 3D de l'assistant : couches en profondeur (perspective CSS), tête qui suit
// le curseur avec un ressort, respiration, hochements, et articulation pendant que
// les questions s'écrivent lettre à lettre. 100 % local, uniquement transform/opacity.

const Avatar = (() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let rig = null, mouth = null, box = null;
  // Cible et état du ressort (rotations en degrés)
  let targetRX = 0, targetRY = 0, rx = 0, ry = 0, vx = 0, vy = 0;
  let talking = false;
  let phase = 0;

  function onPointer(ev) {
    const r = box.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // La tête suit le curseur, amplitude bornée pour rester naturelle.
    targetRY = Math.max(-18, Math.min(18, (ev.clientX - cx) / 26));
    targetRX = Math.max(-10, Math.min(14, -(ev.clientY - cy) / 30));
  }

  function loop() {
    if (!document.hidden) {
      phase += 0.016;
      // Ressort : le mouvement garde sa vitesse quand la cible change (interruptible).
      const k = 0.085, damp = 0.8;
      vx = (vx + (targetRX - rx) * k) * damp;
      vy = (vy + (targetRY - ry) * k) * damp;
      rx += vx;
      ry += vy;
      const idleBob = Math.sin(phase * 1.1) * 1.4;        // hochement lent
      const idleTurn = Math.sin(phase * 0.55) * 2.2;      // balayage du regard
      const breath = 1 + Math.sin(phase * 0.9) * 0.013;   // respiration
      const nod = talking ? Math.sin(phase * 13) * 1.8 : 0; // acquiescement en parlant
      rig.style.transform =
        `rotateX(${(rx + idleBob * 0.5 + nod).toFixed(2)}deg) ` +
        `rotateY(${(ry + idleTurn).toFixed(2)}deg) ` +
        `scale(${breath.toFixed(3)})`;
      if (mouth) {
        const h = talking ? 2 + Math.abs(Math.sin(phase * 15)) * 4.5 : 2.6;
        mouth.setAttribute("height", h.toFixed(2));
        mouth.setAttribute("y", (57.5 - h / 2).toFixed(2));
      }
    }
    requestAnimationFrame(loop);
  }

  let typeTimer = null;

  function say(text) {
    const msgEl = document.getElementById("assistant-msg");
    if (!msgEl) return;
    clearInterval(typeTimer);
    if (reduced || !rig) {
      msgEl.textContent = text;
      return;
    }
    talking = true;
    msgEl.textContent = "";
    let i = 0;
    typeTimer = setInterval(() => {
      i += 2; // deux caractères par tic : vif sans être illisible
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
    mouth = document.getElementById("a3-mouth-bar");
    if (!box || !rig || reduced) return;
    window.addEventListener("pointermove", onPointer, { passive: true });
    requestAnimationFrame(loop);
  }

  document.addEventListener("DOMContentLoaded", init);
  return { say };
})();
