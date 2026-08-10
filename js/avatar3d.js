// Avatar humain 3D temps réel : tête scannée (blendshapes ARKit) rendue en WebGL.
// - regard qui suit le curseur (yeux réels + tête avec retard), retour caméra après inactivité
// - clignements naturels, respiration, micro-mouvements
// - lip-sync sur la synthèse vocale française du navigateur (phonèmes → visèmes ARKit)
// - couche « scan holographique » légère en surimpression
// Tout est local (three.js vendorisé) ; en cas d'échec WebGL, l'avatar 2D reste le repli.

import * as THREE from "three";
import { GLTFLoader } from "../vendor/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "../vendor/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "../vendor/meshopt_decoder.module.js";
import { RoomEnvironment } from "../vendor/jsm/environments/RoomEnvironment.js";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const A3D = {
  ready: false,
  say: null,
  setStage: null,
  muted: localStorage.getItem("sm-voice-muted") === "1",
};
window.Avatar3D = A3D;

let renderer, scene, camera, model, head, eyeL, eyeR;
let dict = null, infl = null;
let container = null, overlay = null, octx = null;

// ── État d'animation ──
let t = 0;
let gazeX = 0, gazeY = 0;             // cible du regard (-1..1)
let headRX = 0, headRY = 0, hvx = 0, hvy = 0;
let lastMove = 0;
let blinkAt = 2.5, blinkPhase = -1;
let talking = false, listenUntil = 0;
const morphTarget = {};               // valeurs cibles des blendshapes
let visemeQueue = [];                 // [{at, morphs}]

// ── Résolution des noms de blendshapes (le modèle peut suffixer _L/_R…) ──
function m(...candidates) {
  if (!dict) return -1;
  for (const c of candidates) if (c in dict) return dict[c];
  return -1;
}
const M = {};
function resolveMorphs() {
  M.blinkL = m("eyeBlinkLeft", "eyeBlink_L");
  M.blinkR = m("eyeBlinkRight", "eyeBlink_R");
  M.jaw = m("jawOpen");
  M.funnel = m("mouthFunnel");
  M.pucker = m("mouthPucker");
  M.close = m("mouthClose");
  M.smileL = m("mouthSmileLeft", "mouthSmile_L");
  M.smileR = m("mouthSmileRight", "mouthSmile_R");
  M.pressL = m("mouthPressLeft", "mouthPress_L");
  M.pressR = m("mouthPressRight", "mouthPress_R");
  M.browUp = m("browInnerUp");
  M.shrug = m("mouthShrugUpper");
}

// ── Visèmes approximés depuis le texte français ──
function charViseme(ch) {
  const c = ch.toLowerCase();
  if ("aàâ".includes(c)) return { jaw: 0.55 };
  if ("eéèêë".includes(c)) return { jaw: 0.3, smile: 0.15 };
  if ("iïy".includes(c)) return { jaw: 0.16, smile: 0.4 };
  if ("oôö".includes(c)) return { jaw: 0.4, funnel: 0.65 };
  if ("uùûü".includes(c)) return { jaw: 0.2, pucker: 0.7 };
  if ("mbp".includes(c)) return { press: 0.7, jaw: 0.02 };
  if ("fv".includes(c)) return { shrug: 0.5, jaw: 0.1 };
  if ("szcx".includes(c)) return { jaw: 0.12, smile: 0.2 };
  if ("jg".includes(c)) return { jaw: 0.2, funnel: 0.3 };
  if ("tdnlkqr".includes(c)) return { jaw: 0.2 };
  return null;
}

function queueWordVisemes(word, duration) {
  const now = performance.now();
  const shapes = [];
  for (const ch of word) {
    const v = charViseme(ch);
    if (v) shapes.push(v);
  }
  if (!shapes.length) return;
  const dt = Math.min(110, duration / shapes.length);
  visemeQueue = shapes.map((v, i) => ({ at: now + i * dt, morphs: v }));
  visemeQueue.push({ at: now + shapes.length * dt, morphs: {} });
}

function applyViseme(v) {
  morphTarget[M.jaw] = v.jaw || 0;
  morphTarget[M.funnel] = v.funnel || 0;
  morphTarget[M.pucker] = v.pucker || 0;
  morphTarget[M.smileL] = morphTarget[M.smileR] = v.smile || 0;
  morphTarget[M.pressL] = morphTarget[M.pressR] = v.press || 0;
  morphTarget[M.shrug] = v.shrug || 0;
}

// ── Voix ──
let frVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  frVoice = vs.find(v => v.lang.startsWith("fr") && /amelie|thomas|audrey|marie|google/i.test(v.name))
    || vs.find(v => v.lang.startsWith("fr")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener("voiceschanged", pickVoice);
}

let typeTimer = null;

function say(text) {
  const msgEl = document.getElementById("assistant-msg");
  if (!msgEl) return;
  clearInterval(typeTimer);
  try { speechSynthesis.cancel(); } catch {}
  visemeQueue = [];

  if (reduced) { msgEl.textContent = text; return; }

  talking = true;
  msgEl.textContent = "";

  if (!A3D.muted && frVoice) {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = frVoice;
    u.lang = frVoice.lang;
    u.rate = 1.04;
    u.onboundary = ev => {
      if (ev.name !== "word" && ev.charIndex === undefined) return;
      const rest = text.slice(ev.charIndex);
      const word = (rest.match(/^[\p{L}'-]+/u) || [rest.slice(0, 6)])[0];
      msgEl.textContent = text.slice(0, ev.charIndex + word.length);
      queueWordVisemes(word, Math.max(180, word.length * 70));
    };
    u.onend = () => {
      msgEl.textContent = text;
      endTalk();
    };
    u.onerror = () => { msgEl.textContent = text; endTalk(); };
    speechSynthesis.speak(u);
  } else {
    // Sans voix : machine à écrire + visèmes estimés
    let i = 0;
    typeTimer = setInterval(() => {
      i += 2;
      msgEl.textContent = text.slice(0, i);
      const w = text.slice(Math.max(0, i - 2), i);
      queueWordVisemes(w, 130);
      if (i >= text.length) {
        clearInterval(typeTimer);
        endTalk();
      }
    }, 26);
  }
}

function endTalk() {
  talking = false;
  visemeQueue = [{ at: performance.now(), morphs: {} }];
  listenUntil = t + 2.4; // expression attentive : sourcils légèrement levés
}

// ── Scène ──
async function init() {
  container = document.getElementById("avatar-stage");
  if (!container) return;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    overlay = document.createElement("canvas");
    overlay.className = "a3d-overlay";
    container.appendChild(overlay);
    octx = overlay.getContext("2d");

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(21, 1, 0.01, 20);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

    const ktx2 = new KTX2Loader().setTranscoderPath("vendor/jsm/libs/basis/").detectSupport(renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync("assets/avatar.glb");
    model = gltf.scene;
    scene.add(model);

    // Éclairage : teinte chair chaude + lumière clé douce + contre-jour orange Lumora
    model.traverse(o => {
      if (o.isMesh && o.material) {
        o.material.envMapIntensity = 0.7;
        if (o.morphTargetDictionary) o.material.color.setHex(0xE8B48E);
      }
    });
    const key = new THREE.DirectionalLight(0xffd9b0, 1.6);
    key.position.set(-1.5, 1.2, 2.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xC65E29, 2.2);
    rim.position.set(2.2, 0.6, -1.5);
    scene.add(rim);

    // Le maillage morphable est le visage (52 blendshapes ARKit)
    head = null;
    model.traverse(o => {
      if (o.isMesh && o.morphTargetDictionary &&
          Object.keys(o.morphTargetDictionary).length >= 20) head = o;
    });
    if (!head) throw new Error("maillage du visage introuvable");
    eyeL = model.getObjectByName("grp_eyeLeft") || model.getObjectByName("eyeLeft");
    eyeR = model.getObjectByName("grp_eyeRight") || model.getObjectByName("eyeRight");
    dict = head.morphTargetDictionary;
    infl = head.morphTargetInfluences;
    resolveMorphs();

    // Cadrage automatique sur le visage (matrices d'abord : le modèle est
    // quantifié, sans cette mise à jour la boîte mesurée est ~10× trop grande)
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(head);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y) * 2.0;
    camera.position.set(c.x, c.y + size.y * 0.04, c.z + dist);
    camera.lookAt(c.x, c.y + size.y * 0.02, c.z);

    window.addEventListener("pointermove", ev => {
      gazeX = (ev.clientX / window.innerWidth) * 2 - 1;
      gazeY = (ev.clientY / window.innerHeight) * 2 - 1;
      lastMove = t;
    }, { passive: true });

    resize();
    window.addEventListener("resize", resize);
    A3D.ready = true;
    setStage(document.getElementById("step-1")?.classList.contains("hidden") ? "off" : "big");
  } catch (e) {
    console.warn("Avatar 3D indisponible, repli sur l'avatar 2D :", e);
    A3D.ready = false;
  }
}

function resize() {
  if (!renderer || !container) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  overlay.width = w * 2;
  overlay.height = h * 2;
}

// Le même rendu vit en grand (questionnaire) ou en compact (étapes 2-5)
function setStage(mode) {
  if (!container) return;
  const on = mode === "big" && A3D.ready;
  container.classList.toggle("hidden", !on);
  if (renderer) renderer.setAnimationLoop(on ? loop : null);
  if (on) requestAnimationFrame(resize);
  const card = document.getElementById("assistant");
  if (card) card.classList.toggle("no-face", on);
}

function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const cycle = t % 9;
  const activity = talking ? 0.35 : 0;
  if (cycle < 1.6 || activity) {
    const k = activity || (cycle < 0.8 ? cycle / 0.8 : (1.6 - cycle) / 0.8);
    octx.globalAlpha = 0.16 * k;
    octx.strokeStyle = "#f6efe8";
    octx.lineWidth = 2;
    octx.setLineDash([8, 12]);
    octx.lineDashOffset = -t * 60;
    for (let i = 1; i < 7; i++) {
      const lx = (w / 7) * i + Math.sin(t + i) * 6;
      octx.beginPath(); octx.moveTo(lx, h * 0.06); octx.lineTo(lx, h * 0.94); octx.stroke();
    }
    // ligne de balayage horizontale
    const sy = ((t * 0.35) % 1.3 - 0.15) * h;
    const g = octx.createLinearGradient(0, sy - 30, 0, sy + 30);
    g.addColorStop(0, "rgba(198,94,41,0)");
    g.addColorStop(0.5, `rgba(198,94,41,${0.25 * k})`);
    g.addColorStop(1, "rgba(198,94,41,0)");
    octx.fillStyle = g;
    octx.fillRect(0, sy - 30, w, 60);
    octx.setLineDash([]);
    octx.globalAlpha = 1;
  }
}

function loop() {
  t += 0.016;

  // Regard : retour caméra après 4 s d'inactivité
  const idle = t - lastMove > 4;
  const gx = idle ? 0 : gazeX;
  const gy = idle ? 0 : gazeY;

  // Yeux : réponse rapide, amplitude limitée (±0.28 rad)
  if (eyeL && eyeR) {
    const ex = THREE.MathUtils.clamp(gx * 0.3, -0.28, 0.28);
    const ey = THREE.MathUtils.clamp(gy * 0.22, -0.2, 0.24);
    for (const e of [eyeL, eyeR]) {
      e.rotation.y += (ex - e.rotation.y) * 0.18;
      e.rotation.x += (ey - e.rotation.x) * 0.18;
    }
  }

  // Tête : suit le regard avec retard (ressort), micro-mouvements permanents
  const k = 0.06, damp = 0.86;
  hvx = (hvx + (gy * 0.10 - headRX) * k) * damp;
  hvy = (hvy + (gx * 0.16 - headRY) * k) * damp;
  headRX += hvx; headRY += hvy;
  if (model) {
    model.rotation.x = headRX + Math.sin(t * 0.9) * 0.008;
    model.rotation.y = headRY + Math.sin(t * 0.55) * 0.012;
    model.rotation.z = Math.sin(t * 0.4) * 0.006;
    model.position.y = Math.sin(t * 1.05) * 0.0035; // respiration
  }

  // Clignements toutes les 3 à 7 s
  if (blinkPhase < 0 && t > blinkAt) blinkPhase = 0;
  if (blinkPhase >= 0) {
    blinkPhase += 0.016;
    const b = blinkPhase < 0.09 ? blinkPhase / 0.09 : Math.max(0, 1 - (blinkPhase - 0.09) / 0.11);
    if (M.blinkL >= 0) infl[M.blinkL] = b;
    if (M.blinkR >= 0) infl[M.blinkR] = b;
    if (blinkPhase > 0.22) { blinkPhase = -1; blinkAt = t + 3 + Math.random() * 4; }
  }

  // Visèmes programmés
  const now = performance.now();
  while (visemeQueue.length && visemeQueue[0].at <= now) {
    applyViseme(visemeQueue.shift().morphs);
  }
  // Expression : sourcils levés en parlant / écoute attentive après
  morphTarget[M.browUp] = talking ? 0.18 + Math.sin(t * 5) * 0.06 : (t < listenUntil ? 0.14 : 0.02);
  if (!talking && t >= listenUntil) {
    morphTarget[M.smileL] = Math.max(morphTarget[M.smileL] || 0, 0.08);
    morphTarget[M.smileR] = Math.max(morphTarget[M.smileR] || 0, 0.08);
  }

  // Interpolation douce vers les cibles
  for (const idx in morphTarget) {
    const i = +idx;
    if (i < 0) continue;
    infl[i] += (morphTarget[idx] - infl[i]) * 0.3;
  }

  drawOverlay();
  renderer.render(scene, camera);
}

A3D.say = say;
A3D.setStage = setStage;
A3D.toggleMute = () => {
  A3D.muted = !A3D.muted;
  localStorage.setItem("sm-voice-muted", A3D.muted ? "1" : "0");
  if (A3D.muted) { try { speechSynthesis.cancel(); } catch {} }
  return A3D.muted;
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
