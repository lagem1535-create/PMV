// ===========================================================================
//  PALmonitor 웹 클라이언트 (PWA)
//  Firebase 로그인 → Cloudflare Worker(/ws, 같은 출처)에 viewer 로 접속 →
//  집 릴레이(host)가 보조 PC 화면을 중계해 줌. 화면보기 + 마우스/키보드 제어.
// ===========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { firebaseConfig, enableAnalytics } from "./firebase_config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

if (enableAnalytics && firebaseConfig.measurementId) {
  import("https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js")
    .then((m) => m.getAnalytics(app)).catch(() => {});
}

// PWA 서비스워커 등록
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const loginView = $("login-view");
const viewerView = $("viewer-view");
const loginMsg = $("loginMsg");
const statusEl = $("status");
const canvas = $("screen");
const ctx = canvas.getContext("2d");
const hiddenInput = $("hiddenInput");

// ---------- 저장(localStorage) ----------
const LS = "pal_web_cfg";
function loadCfg() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function saveCfg(c) { try { localStorage.setItem(LS, JSON.stringify(c)); } catch {} }
(function restore() {
  const c = loadCfg();
  if (c.email) $("email").value = c.email;
})();

// ---------- 상태 ----------
let ws = null;
let remoteW = 0, remoteH = 0;
let keyboardOn = false;
let conn = null;           // { idToken, room }
let reconnectTimer = null;

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

// ===========================================================================
//  로그인
// ===========================================================================
$("loginBtn").addEventListener("click", doLogin);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  loginMsg.textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) { loginMsg.textContent = "이메일과 비밀번호를 입력하세요."; return; }

  loginMsg.style.color = "var(--muted)";
  loginMsg.textContent = "로그인 중…";
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await cred.user.getIdToken();
    const room = cred.user.uid;   // 연결 코드 = 로그인 계정 UID (자동)
    saveCfg({ email });
    conn = { idToken, room };
    showViewer();
    connect();
  } catch (e) {
    loginMsg.style.color = "var(--bad)";
    loginMsg.textContent = "로그인 실패: " + friendlyAuthError(e);
  }
}

function friendlyAuthError(e) {
  const code = (e && e.code) || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") ||
      code.includes("user-not-found")) return "이메일 또는 비밀번호가 올바르지 않습니다.";
  if (code.includes("invalid-email")) return "이메일 형식이 올바르지 않습니다.";
  if (code.includes("too-many-requests")) return "시도가 많습니다. 잠시 후 다시 시도하세요.";
  if (code.includes("network")) return "네트워크 오류.";
  return (e && e.message) || "알 수 없는 오류";
}

$("logoutBtn").addEventListener("click", async () => {
  teardown();
  try { await signOut(auth); } catch {}
  showLogin();
});

function showLogin() { viewerView.classList.add("hidden"); loginView.classList.remove("hidden"); }
function showViewer() { loginView.classList.add("hidden"); viewerView.classList.remove("hidden"); }
onAuthStateChanged(auth, (user) => { if (!user) showLogin(); });

// ===========================================================================
//  Worker(/ws)에 viewer 로 접속  —  같은 출처(https면 wss)로 자동
// ===========================================================================
function wsUrl(room, idToken) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = `room=${encodeURIComponent(room)}&role=viewer&idToken=${encodeURIComponent(idToken)}`;
  return `${proto}//${location.host}/ws?${q}`;
}

function connect() {
  if (!conn) return;
  clearTimeout(reconnectTimer);
  setStatus("서버 접속 중…");
  let sock;
  try { sock = new WebSocket(wsUrl(conn.room, conn.idToken)); }
  catch (e) { setStatus("접속 오류: " + e.message, "bad"); return; }
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.onopen = () => { setStatus("릴레이(집 PC) 기다리는 중…"); };
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") handleControl(JSON.parse(ev.data));
    else drawFrame(ev.data);
  };
  sock.onclose = () => { if (ws !== sock) return; setStatus("연결 끊김 — 재접속 중…", "bad"); scheduleReconnect(); };
  sock.onerror = () => setStatus("연결 오류", "bad");
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    const u = auth.currentUser;
    if (!u) { showLogin(); return; }
    u.getIdToken().then((t) => { if (conn) conn.idToken = t; connect(); }).catch(() => connect());
  }, 2000);
}

function teardown() {
  clearTimeout(reconnectTimer);
  conn = null;
  if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
  remoteW = remoteH = 0;
}

function handleControl(msg) {
  const { type, data } = msg;
  if (type === "peer") {
    if (data === "online") setStatus("연결됨", "ok");
    else if (data === "waiting") setStatus("릴레이(집 PC) 기다리는 중…");
    else if (data === "offline") setStatus("릴레이 오프라인 — 집 PC/릴레이 확인", "bad");
  } else if (type === "info") {
    remoteW = data.width; remoteH = data.height;
    canvas.width = remoteW; canvas.height = remoteH;
  } else if (type === "info_meta") {
    if (data && data.hostname) setStatus(`연결됨 (${data.hostname})`, "ok");
  } else if (type === "error") {
    setStatus("오류: " + data, "bad");
    if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
  }
}

// ---------- 프레임 렌더링 ----------
let drawing = false, pending = null;
function drawFrame(buf) {
  if (drawing) { pending = buf; return; }
  drawing = true;
  const blob = new Blob([buf], { type: "image/jpeg" });
  createImageBitmap(blob).then((bmp) => {
    if (remoteW && canvas.width !== remoteW) { canvas.width = remoteW; canvas.height = remoteH; }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    drawing = false;
    if (pending) { const p = pending; pending = null; drawFrame(p); }
  }).catch(() => { drawing = false; });
}

// ===========================================================================
//  입력 전송
// ===========================================================================
function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
}
function toRemoteXY(clientX, clientY) {
  if (!remoteW) return null;
  const r = canvas.getBoundingClientRect();
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  const x = Math.round((clientX - r.left) / r.width * remoteW);
  const y = Math.round((clientY - r.top) / r.height * remoteH);
  return [Math.max(0, Math.min(remoteW - 1, x)), Math.max(0, Math.min(remoteH - 1, y))];
}

canvas.addEventListener("mousemove", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
});
canvas.addEventListener("mousedown", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: e.button === 2 ? "right" : "left", pressed: true });
});
canvas.addEventListener("mouseup", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: e.button === 2 ? "right" : "left", pressed: false });
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  sendInput({ kind: "mouse_scroll", dx: 0, dy: e.deltaY > 0 ? -1 : 1 });
}, { passive: false });

// 터치: 탭=클릭, 드래그=이동, 두 손가락=스크롤
let touchMoved = false, lastTouchY = 0;
canvas.addEventListener("touchstart", (e) => {
  e.preventDefault(); touchMoved = false;
  if (e.touches.length === 2) { lastTouchY = (e.touches[0].clientY + e.touches[1].clientY) / 2; return; }
  const t = e.touches[0];
  const p = toRemoteXY(t.clientX, t.clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault(); touchMoved = true;
  if (e.touches.length === 2) {
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (Math.abs(y - lastTouchY) > 6) { sendInput({ kind: "mouse_scroll", dx: 0, dy: y < lastTouchY ? -1 : 1 }); lastTouchY = y; }
    return;
  }
  const t = e.touches[0];
  const p = toRemoteXY(t.clientX, t.clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
}, { passive: false });
canvas.addEventListener("touchend", (e) => {
  e.preventDefault();
  if (!touchMoved && e.changedTouches.length) {
    const t = e.changedTouches[0];
    const p = toRemoteXY(t.clientX, t.clientY);
    if (p) {
      sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: "left", pressed: true });
      setTimeout(() => sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: "left", pressed: false }), 40);
    }
  }
}, { passive: false });

// 키보드
const SPECIAL = {
  "Enter": "enter", "Escape": "esc", "Tab": "tab", "Backspace": "backspace",
  "Delete": "delete", "Insert": "insert", " ": "space",
  "Shift": "shift", "Control": "ctrl", "Alt": "alt", "Meta": "cmd",
  "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right",
  "Home": "home", "End": "end", "PageUp": "page_up", "PageDown": "page_down", "CapsLock": "caps_lock",
};
function keyName(e) {
  if (SPECIAL[e.key]) return SPECIAL[e.key];
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toLowerCase();
  if (e.key.length === 1) return e.key;
  return null;
}
function onKey(e, down) {
  if (!keyboardOn) return;
  const k = keyName(e);
  if (!k) return;
  e.preventDefault();
  sendInput({ kind: down ? "key_down" : "key_up", key: k });
}
window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));

$("kbBtn").addEventListener("click", () => {
  keyboardOn = !keyboardOn;
  $("kbBtn").classList.toggle("active", keyboardOn);
  $("kbBtn").textContent = keyboardOn ? "⌨ ON" : "⌨ OFF";
  if (keyboardOn && isTouch()) hiddenInput.focus(); else hiddenInput.blur();
});
hiddenInput.addEventListener("input", (e) => {
  if (!keyboardOn) return;
  for (const ch of (e.data || "")) { sendInput({ kind: "key_down", key: ch }); sendInput({ kind: "key_up", key: ch }); }
  hiddenInput.value = "";
});
hiddenInput.addEventListener("keydown", (e) => {
  if (!keyboardOn) return;
  if (e.key === "Backspace" || e.key === "Enter") {
    const k = SPECIAL[e.key];
    sendInput({ kind: "key_down", key: k }); sendInput({ kind: "key_up", key: k });
  }
});
function isTouch() { return "ontouchstart" in window || navigator.maxTouchPoints > 0; }

$("fsBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) viewerView.requestFullscreen?.();
  else document.exitFullscreen?.();
});
