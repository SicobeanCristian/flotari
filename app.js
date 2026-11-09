import { PushupCounter } from "./counter.mjs";

const STORE_KEY = "flotari.v1";
const UNLOCK_OPTIONS = [1, 5, 10, 20];
const SKELETON = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

const $ = (id) => document.getElementById(id);

function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function loadState() {
  const empty = {
    settings: { repsPerBlock: 5, minutesPerBlock: 1, dailyFree: 30 },
    earned: 0,
    days: {},
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return saved ? { ...empty, ...saved } : empty;
  } catch {
    return empty;
  }
}

const state = loadState();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Fără stocare, soldul rămâne valabil doar până la închiderea paginii.
  }
}

function today() {
  const key = dayKey();
  state.days[key] ??= { reps: 0, used: 0, freeUsed: 0 };
  return state.days[key];
}

function freeLeft() {
  return Math.max(state.settings.dailyFree - today().freeUsed, 0);
}

// Fracțiile adunate (0.2 + 0.2 ...) pot da 2.9999999 în loc de 3.
function wholeMinutes(value) {
  return Math.floor(value + 1e-9);
}

function available() {
  return wholeMinutes(freeLeft() + state.earned);
}

function addRep() {
  const { repsPerBlock, minutesPerBlock } = state.settings;
  today().reps += 1;
  state.earned += minutesPerBlock / repsPerBlock;
  save();
}

function spend(minutes) {
  const fromFree = Math.min(freeLeft(), minutes);
  const day = today();
  day.freeUsed += fromFree;
  day.used += minutes;
  state.earned = Math.max(state.earned - (minutes - fromFree), 0);
  save();
}

function runShortcut(minutes) {
  location.href = `shortcuts://run-shortcut?name=Deblocare&input=text&text=${minutes}`;
}

// --- Ecranul principal ---

function renderHome() {
  $("balance").textContent = available();
  $("balanceDetail").textContent =
    `${wholeMinutes(freeLeft())} gratuite azi + ${wholeMinutes(state.earned)} câștigate`;

  const total = available();
  const buttons = UNLOCK_OPTIONS.map((minutes) => {
    const button = document.createElement("button");
    button.textContent = `${minutes} min`;
    button.disabled = total < minutes;
    button.addEventListener("click", () => {
      spend(minutes);
      renderHome();
      runShortcut(minutes);
    });
    return button;
  });
  $("unlockButtons").replaceChildren(...buttons);
  $("unlockHint").textContent = "După deblocare, deschide din nou aplicația limitată.";

  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const day = state.days[dayKey(date)] ?? { reps: 0, used: 0 };
    const row = document.createElement("tr");
    const label = i === 0 ? "Azi" : date.toLocaleDateString("ro-RO", { weekday: "short", day: "numeric" });
    for (const value of [label, day.reps, Math.round(day.used)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    rows.push(row);
  }
  $("history").replaceChildren(...rows);
}

function bindSetting(id, min, max) {
  const input = $(id);
  input.value = state.settings[id];
  input.addEventListener("change", () => {
    const value = Math.round(Number(input.value));
    if (Number.isFinite(value)) state.settings[id] = Math.min(Math.max(value, min), max);
    input.value = state.settings[id];
    save();
    renderHome();
  });
}

// --- Antrenamentul ---

let landmarker = null;
let stream = null;
let running = false;
let wakeLock = null;
let audio = null;

async function createLandmarker() {
  if (landmarker) return landmarker;
  const { FilesetResolver, PoseLandmarker } = await import("./vendor/vision_bundle.mjs");
  const files = await FilesetResolver.forVisionTasks(new URL("vendor/wasm", location.href).href);
  const create = (delegate) =>
    PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "vendor/pose_landmarker_lite.task", delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  landmarker = await create("GPU").catch(() => create("CPU"));
  return landmarker;
}

function beep() {
  if (!audio) return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.25;
  oscillator.frequency.value = 880;
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.12);
}

function drawPose(points) {
  const canvas = $("overlay");
  const video = $("video");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!points) return;

  ctx.strokeStyle = "#c8f04b";
  ctx.lineWidth = Math.max(canvas.width / 120, 3);
  ctx.lineCap = "round";
  for (const [a, b] of SKELETON) {
    if ((points[a].visibility ?? 0) < 0.5 || (points[b].visibility ?? 0) < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(points[a].x * canvas.width, points[a].y * canvas.height);
    ctx.lineTo(points[b].x * canvas.width, points[b].y * canvas.height);
    ctx.stroke();
  }
}

async function startWorkout() {
  $("home").hidden = true;
  $("workout").hidden = false;
  $("reps").textContent = "0";
  $("earned").textContent = "";
  $("hint").textContent = "Se pregătește camera...";

  // iOS pornește sunetul doar dintr-un gest al utilizatorului, deci înainte de primul await.
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    audio ??= new AudioContextClass();
    audio.resume();
  }
  navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {});

  running = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    $("hint").textContent = "Se încarcă detecția...";
    await createLandmarker();
  } catch (error) {
    console.error(error);
    running = false;
    releaseCamera();
    $("hint").textContent = error.name === "NotAllowedError"
      ? "Permite accesul la cameră din setările Safari."
      : "Camera sau detecția nu au pornit pe acest telefon.";
    return;
  }
  if (running) detectLoop(new PushupCounter());
}

function detectLoop(counter) {
  const video = $("video");
  let lastVideoTime = -1;

  const tick = () => {
    if (!running) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const points = landmarker.detectForVideo(video, now).landmarks[0];
      drawPose(points);

      const before = counter.count;
      const { count, hint } = counter.update(points, video.videoWidth / video.videoHeight, now);
      if (count > before) {
        addRep();
        beep();
        $("reps").textContent = count;
        const { repsPerBlock, minutesPerBlock } = state.settings;
        $("earned").textContent = `+${Math.floor((count * minutesPerBlock) / repsPerBlock)} minute câștigate`;
      }
      $("hint").textContent = hint;
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function releaseCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  $("video").srcObject = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function stopWorkout() {
  running = false;
  releaseCamera();
  $("workout").hidden = true;
  $("home").hidden = false;
  renderHome();
}

// --- Pornire ---

bindSetting("repsPerBlock", 1, 200);
bindSetting("minutesPerBlock", 1, 120);
bindSetting("dailyFree", 0, 600);

const blockUrl = new URL(location.href);
blockUrl.search = "?blocat=1";
blockUrl.hash = "";
$("blockUrl").textContent = blockUrl.href;
$("blocked").hidden = !new URLSearchParams(location.search).has("blocat");

$("startWorkout").addEventListener("click", startWorkout);
$("stopWorkout").addEventListener("click", stopWorkout);
$("testShortcut").addEventListener("click", () => runShortcut(0));

// Pagina poate rămâne deschisă peste noapte, iar alocația se schimbă la miezul nopții.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !running) renderHome();
});

renderHome();
