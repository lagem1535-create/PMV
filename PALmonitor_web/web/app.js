// ===========================================================================
//  PALmonitor 웹 클라이언트
//  - Firebase 이메일/비밀번호 로그인 → 릴레이(WebSocket) 접속 → 화면보기 + 제어
// ===========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { firebaseConfig, defaultRelayUrl, enableAnalytics } from "./firebase_config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// (선택) Analytics — firebase_config.js 의 enableAnalytics 가 true 일 때만 로드
if (enableAnalytics && firebaseConfig.measurementId) {
  import("https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js")
    .then((m) => m.getAnalytics(app)).catch(() => {});
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

// ---------- 연결 설정 저장(localStorage) ----------
const LS = "pal_web_cfg";
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
}
function saveCfg(c) { try { localStorage.setItem(LS, JSON.stringify(c)); } catch {} }
(function restore() {
  const c = loadCfg();
  if (c.email) $("email").value = c.email;
  $("relayUrl").value = c.relayUrl || defaultRelayUrl || "";
  if (c.auxHost) $("auxHost").value = c.auxHost;
  if (c.auxPort) $("auxPort").value = c.auxPort;
})();

// ---------- 상태 ----------
let ws = null;
let remoteW = 0, remoteH = 0;
let keyboardOn = false;
let connReq = null;          // 재연결용 접속 요청
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
  const relayUrl = $("relayUrl").value.trim();
  const auxHost = $("auxHost").value.trim();
  const auxPort = parseInt($("auxPort").value.trim() || "58712", 10);
  const secret = $("secret").value;

  if (!email || !password) { loginMsg.textContent = "이메일과 비밀번호를 입력하세요."; return; }
  if (!relayUrl) { loginMsg.textContent = "연결 설정에서 릴레이 서버 주소를 입력하세요."; return; }
  if (!auxHost) { loginMsg.textContent = "연결 설정에서 보조 PC 주소를 입력하세요."; return; }

  loginMsg.style.color = "var(--muted)";
  loginMsg.textContent = "로그인 중…";
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await cred.user.getIdToken();
    saveCfg({ email, relayUrl, auxHost, auxPort });
    connReq = { idToken, host: auxHost, port: auxPort, secret, relayUrl };
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

// 로그인 세션이 남아있어도, 보안상 연결 정보(secret)는 메모리에만 두므로
// 새로고침 시에는 다시 로그인 화면에서 시작합니다.
onAuthStateChanged(auth, (user) => { if (!user) showLogin(); });

// ===========================================================================
//  릴레이(WebSocket) 연결
// ===========================================================================
function connect() {
  if (!connReq) return;
  clearTimeout(reconnectTimer);
  setStatus("릴레이 접속 중…");
  let sock;
  try {
    sock = new WebSocket(connReq.relayUrl);
  } catch (e) {
    setStatus("릴레이 주소 오류: " + e.message, "bad");
    return;
  }
  sock.binaryType = "arraybuffer";
  ws = sock;

  sock.onopen = () => {
    setStatus("인증 중…");
    sock.send(JSON.stringify({
      idToken: connReq.idToken, host: connReq.host,
      port: connReq.port, secret: connReq.secret,
    }));
  };

  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleControl(JSON.parse(ev.data));
    } else {
      drawFrame(ev.data); // ArrayBuffer(JPEG)
    }
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    setStatus("연결 끊김 — 재접속 중…", "bad");
    scheduleReconnect();
  };
  sock.onerror = () => { setStatus("연결 오류", "bad"); };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    // 토큰이 만료됐을 수 있으니 갱신 후 재접속
    const u = auth.currentUser;
    if (!u) { showLogin(); return; }
    u.getIdToken().then((t) => { if (connReq) connReq.idToken = t; connect(); })
                  .catch(() => connect());
  }, 2000);
}

function teardown() {
  clearTimeout(reconnectTimer);
  connReq = null;
  if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
  remoteW = remoteH = 0;
}

function handleControl(msg) {
  const { type, data } = msg;
  if (type === "connected") {
    setStatus(`연결됨 (${data.host})`, "ok");
  } else if (type === "info") {
    remoteW = data.width; remoteH = data.height;
    canvas.width = remoteW; canvas.height = remoteH;
  } else if (type === "info_meta") {
    if (data && data.hostname) setStatus(`연결됨 (${data.hostname})`, "ok");
  } else if (type === "error") {
    setStatus("오류: " + data, "bad");
    // 치명적 오류(인증/접속 실패)는 재시도하지 않고 로그인 화면 안내
    if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
  }
}

// ---------- 프레임 렌더링 ----------
let drawing = false, pending = null;
function drawFrame(buf) {
  if (drawing) { pending = buf; return; } // 최신 프레임만 유지
  drawing = true;
  const blob = new Blob([buf], { type: "image/jpeg" });
  createImageBitmap(blob).then((bmp) => {
    if (remoteW && (canvas.width !== remoteW)) { canvas.width = remoteW; canvas.height = remoteH; }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    drawing = false;
    if (pending) { const p = pending; pending = null; drawFrame(p); }
  }).catch(() => { drawing = false; });
}

// ===========================================================================
//  입력 전송 (마우스/터치/키보드) — 좌표는 원격 픽셀 기준으로 변환
// ===========================================================================
function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
}

function toRemoteXY(clientX, clientY) {
  if (!remoteW) return null;
  const r = canvas.getBoundingClientRect();
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  const x = Math.round((clientX - r.left) / r.width * remoteW);
  const y = Math.round((clientY - r.top) / r.height * remoteH);
  return [Math.max(0, Math.min(remoteW - 1, x)), Math.max(0, Math.min(remoteH - 1, y))];
}

// --- 마우스 ---
canvas.addEventListener("mousemove", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
});
canvas.addEventListener("mousedown", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1],
                     button: e.button === 2 ? "right" : "left", pressed: true });
});
canvas.addEventListener("mouseup", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1],
                     button: e.button === 2 ? "right" : "left", pressed: false });
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  sendInput({ kind: "mouse_scroll", dx: 0, dy: e.deltaY > 0 ? -1 : 1 });
}, { passive: false });

// --- 터치 (탭=클릭, 드래그=이동, 두 손가락 스크롤) ---
let touchMoved = false, lastTouchY = 0;
canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  touchMoved = false;
  const t = e.touches[0];
  if (e.touches.length === 2) { lastTouchY = (e.touches[0].clientY + e.touches[1].clientY) / 2; return; }
  const p = toRemoteXY(t.clientX, t.clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  touchMoved = true;
  if (e.touches.length === 2) {
    const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (Math.abs(y - lastTouchY) > 6) {
      sendInput({ kind: "mouse_scroll", dx: 0, dy: y < lastTouchY ? -1 : 1 });
      lastTouchY = y;
    }
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

// --- 키보드 ---
const SPECIAL = {
  "Enter": "enter", "Escape": "esc", "Tab": "tab", "Backspace": "backspace",
  "Delete": "delete", "Insert": "insert", " ": "space",
  "Shift": "shift", "Control": "ctrl", "Alt": "alt", "Meta": "cmd",
  "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right",
  "Home": "home", "End": "end", "PageUp": "page_up", "PageDown": "page_down",
  "CapsLock": "caps_lock",
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
  $("kbBtn").textContent = keyboardOn ? "⌨ 키보드 ON" : "⌨ 키보드 OFF";
  // 모바일: 키보드를 켜면 숨은 입력에 포커스를 줘서 소프트 키보드가 올라오게 함
  if (keyboardOn && isTouch()) hiddenInput.focus();
  else hiddenInput.blur();
});

// 모바일 소프트 키보드 입력을 key 이벤트로 연결
hiddenInput.addEventListener("input", (e) => {
  if (!keyboardOn) return;
  const txt = e.data || "";
  for (const ch of txt) {
    sendInput({ kind: "key_down", key: ch });
    sendInput({ kind: "key_up", key: ch });
  }
  hiddenInput.value = "";
});
hiddenInput.addEventListener("keydown", (e) => {
  if (!keyboardOn) return;
  if (e.key === "Backspace" || e.key === "Enter") {
    const k = SPECIAL[e.key];
    sendInput({ kind: "key_down", key: k });
    sendInput({ kind: "key_up", key: k });
  }
});

function isTouch() { return "ontouchstart" in window || navigator.maxTouchPoints > 0; }

// --- 전체화면 ---
$("fsBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) viewerView.requestFullscreen?.();
  else document.exitFullscreen?.();
});
