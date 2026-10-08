// ===========================================================================
//  PALmonitor 웹 클라이언트 (PWA)
//  Firebase 로그인 → Cloudflare Worker(/ws, 같은 출처)에 viewer 로 접속 →
//  집 릴레이(host)가 보조 PC 화면을 중계해 줌. 화면보기 + 마우스/키보드 제어.
// ===========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { firebaseConfig, enableAnalytics, ROOM } from "./firebase_config.js";

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
  statusEl.title = text;                       // 사이드바의 점에 마우스 올리면 상태 표시
  statusEl.className = "dot" + (cls ? " " + cls : "");
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
    saveCfg({ email });
    conn = { idToken, room: ROOM };   // 연결 코드는 고정값(자동)
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
  sock.onclose = () => { if (ws !== sock) return; ws = null; setStatus("다시 연결 중…"); scheduleReconnect(); };
  sock.onerror = () => { /* onclose 가 이어서 처리 */ };
}

function scheduleReconnect(delay = 1000) {
  if (!conn) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    const u = auth.currentUser;
    if (!u) { showLogin(); return; }
    u.getIdToken().then((t) => { if (conn) conn.idToken = t; connect(); }).catch(() => connect());
  }, delay);
}

// 폰 화면을 다시 켜거나(백그라운드→포그라운드) 네트워크가 돌아오면 즉시 재연결
function reconnectNow() {
  if (!conn) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  scheduleReconnect(200);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) reconnectNow(); });
window.addEventListener("online", reconnectNow);
window.addEventListener("focus", reconnectNow);

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
    else if (data === "offline") setStatus("집 PC 잠시 끊김 — 다시 연결 중…");  // 화면은 유지
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

// ---------- 화면 확대/이동 (로컬 뷰 변환) ----------
let zoom = 1, panX = 0, panY = 0;
function applyTransform() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}
function setZoom(z) {
  zoom = Math.max(1, Math.min(5, z));
  if (zoom === 1) { panX = 0; panY = 0; }
  applyTransform();
}

// ===========================================================================
//  입력 전송
// ===========================================================================
function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
}
// 좌표 변환: 캔버스의 화면상 사각형(확대/이동이 반영됨)을 기준으로 원격 픽셀로.
function toRemoteXY(clientX, clientY) {
  if (!remoteW) return null;
  const r = canvas.getBoundingClientRect();
  const x = Math.round((clientX - r.left) / r.width * remoteW);
  const y = Math.round((clientY - r.top) / r.height * remoteH);
  return [Math.max(0, Math.min(remoteW - 1, x)), Math.max(0, Math.min(remoteH - 1, y))];
}
function moveTo(clientX, clientY) {
  const p = toRemoteXY(clientX, clientY);
  if (p) sendInput({ kind: "mouse_move", x: p[0], y: p[1] });
  return p;
}
function clickAt(p, button) {
  if (!p) return;
  sendInput({ kind: "mouse_click", x: p[0], y: p[1], button, pressed: true });
  sendInput({ kind: "mouse_click", x: p[0], y: p[1], button, pressed: false });
}

// 우클릭 1회 예약(다음 클릭/탭을 우클릭으로)
let armRight = false;
function setArmRight(on) {
  armRight = on;
  $("rclickBtn").classList.toggle("active", on);
}

// ---------- 마우스(PC) ----------
canvas.addEventListener("mousemove", (e) => moveTo(e.clientX, e.clientY));
canvas.addEventListener("mousedown", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (!p) return;
  const button = (e.button === 2 || armRight) ? "right" : "left";
  sendInput({ kind: "mouse_click", x: p[0], y: p[1], button, pressed: true });
  canvas._downBtn = button;
});
canvas.addEventListener("mouseup", (e) => {
  const p = toRemoteXY(e.clientX, e.clientY);
  if (!p) return;
  const button = canvas._downBtn || ((e.button === 2) ? "right" : "left");
  sendInput({ kind: "mouse_click", x: p[0], y: p[1], button, pressed: false });
  canvas._downBtn = null;
  if (armRight) setArmRight(false);
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  sendInput({ kind: "mouse_scroll", dx: 0, dy: e.deltaY > 0 ? -1 : 1 });
}, { passive: false });

// ---------- 터치 ----------
// 1손가락: 탭=클릭, 이동=커서 이동, 길게누름=드래그(버튼 누른 채 이동)
// 2손가락: 핀치=화면 확대/축소, 함께 이동=화면 이동(패닝)
let tmode = null;          // '1' | '2'
let tStart = null, tMoved = false, tDrag = false, lpTimer = null;
let pinch = null;          // { dist0, zoom0, cx0, cy0, panX0, panY0 }

function dist2(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length >= 2) {
    // 2손가락 시작 → 1손가락 동작 취소
    clearTimeout(lpTimer); tDrag = false; tmode = "2";
    const [a, b] = [e.touches[0], e.touches[1]];
    pinch = { dist0: dist2(a, b), zoom0: zoom,
              cx0: (a.clientX + b.clientX) / 2, cy0: (a.clientY + b.clientY) / 2,
              panX0: panX, panY0: panY };
    return;
  }
  if (tmode === "2") return;
  tmode = "1";
  const t = e.touches[0];
  tStart = { x: t.clientX, y: t.clientY }; tMoved = false; tDrag = false;
  moveTo(t.clientX, t.clientY);
  lpTimer = setTimeout(() => {                 // 길게 누르면 드래그 시작
    if (tmode === "1" && !tMoved) {
      tDrag = true;
      const p = toRemoteXY(tStart.x, tStart.y);
      if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: "left", pressed: true });
    }
  }, 500);
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (tmode === "2" && e.touches.length >= 2 && pinch) {
    const [a, b] = [e.touches[0], e.touches[1]];
    const d = dist2(a, b);
    const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
    setZoomRaw(pinch.zoom0 * (d / pinch.dist0));
    if (zoom > 1) {
      panX = pinch.panX0 + (cx - pinch.cx0);
      panY = pinch.panY0 + (cy - pinch.cy0);
    }
    applyTransform();
    return;
  }
  if (tmode === "1" && e.touches.length === 1) {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > 12) { tMoved = true; clearTimeout(lpTimer); }
    moveTo(t.clientX, t.clientY);
  }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
  e.preventDefault();
  if (tmode === "2") {
    if (e.touches.length === 0) { tmode = null; pinch = null; }
    return;
  }
  if (tmode === "1") {
    clearTimeout(lpTimer);
    if (tDrag) {
      const t = e.changedTouches[0];
      const p = toRemoteXY(t.clientX, t.clientY) || toRemoteXY(tStart.x, tStart.y);
      if (p) sendInput({ kind: "mouse_click", x: p[0], y: p[1], button: "left", pressed: false });
    } else if (!tMoved) {
      const p = toRemoteXY(tStart.x, tStart.y);
      clickAt(p, armRight ? "right" : "left");
      if (armRight) setArmRight(false);
    }
    tmode = null;
  }
}, { passive: false });

function setZoomRaw(z) { zoom = Math.max(1, Math.min(5, z)); if (zoom === 1) { panX = 0; panY = 0; } }

// ---------- 키보드 ----------
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

// 한 글자씩 원격으로 타이핑(유니코드 그대로 전송 → 보조 PC가 그 문자를 입력)
function typeString(s) {
  for (const ch of (s || "")) {
    sendInput({ kind: "key_down", key: ch });
    sendInput({ kind: "key_up", key: ch });
  }
}
// 모바일 한글/일본어/중국어는 "조합(IME)" 방식이라, 조합이 끝났을 때(compositionend)
// 완성된 글자를 보내야 제대로 입력됨. 조합 중(input, isComposing)엔 보내지 않음.
let composing = false;
hiddenInput.addEventListener("compositionstart", () => { composing = true; });
hiddenInput.addEventListener("compositionend", (e) => {
  composing = false;
  if (keyboardOn) typeString(e.data || "");
  hiddenInput.value = "";
});
hiddenInput.addEventListener("input", (e) => {
  if (!keyboardOn) return;
  if (composing || e.isComposing) return;                 // 조합 중은 compositionend 에서 처리
  if (e.inputType === "insertCompositionText") return;
  if (e.inputType === "deleteContentBackward") {          // 백스페이스
    sendInput({ kind: "key_down", key: "backspace" });
    sendInput({ kind: "key_up", key: "backspace" });
  } else if (e.data) {
    typeString(e.data);                                   // 영문/숫자/기호 등
  } else if (e.inputType === "insertLineBreak") {
    sendInput({ kind: "key_down", key: "enter" });
    sendInput({ kind: "key_up", key: "enter" });
  }
  hiddenInput.value = "";
});
hiddenInput.addEventListener("keydown", (e) => {
  if (!keyboardOn || composing || e.isComposing) return;
  if (e.key === "Backspace" || e.key === "Enter") {
    const k = SPECIAL[e.key];
    sendInput({ kind: "key_down", key: k }); sendInput({ kind: "key_up", key: k });
  }
});
function isTouch() { return "ontouchstart" in window || navigator.maxTouchPoints > 0; }

// ---------- 사이드바 버튼 ----------
$("kbBtn").addEventListener("click", () => {
  keyboardOn = !keyboardOn;
  $("kbBtn").classList.toggle("active", keyboardOn);
  if (keyboardOn && isTouch()) hiddenInput.focus(); else hiddenInput.blur();
});

$("rclickBtn").addEventListener("click", () => setArmRight(!armRight));

// Ctrl 토글: 켜면 원격에서 Ctrl 을 누른 상태로 유지 → Ctrl+클릭 / Ctrl+C 등 가능
let ctrlOn = false;
$("ctrlBtn").addEventListener("click", () => {
  ctrlOn = !ctrlOn;
  $("ctrlBtn").classList.toggle("active", ctrlOn);
  sendInput({ kind: ctrlOn ? "key_down" : "key_up", key: "ctrl" });
});

// 스크롤 버튼(누르고 있으면 반복)
function holdRepeat(btn, fn) {
  let to = null, iv = null;
  const start = (e) => { e.preventDefault(); fn(); to = setTimeout(() => { iv = setInterval(fn, 110); }, 300); };
  const stop = () => { clearTimeout(to); clearInterval(iv); to = iv = null; };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
}
holdRepeat($("scrollUpBtn"),   () => sendInput({ kind: "mouse_scroll", dx: 0, dy: 1 }));
holdRepeat($("scrollDownBtn"), () => sendInput({ kind: "mouse_scroll", dx: 0, dy: -1 }));

$("zoomInBtn").addEventListener("click", () => setZoom(zoom * 1.3));
$("zoomOutBtn").addEventListener("click", () => setZoom(zoom / 1.3));

$("fsBtn").addEventListener("click", () => {
  const el = viewerView;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl) {
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (req) { try { req.call(el); } catch (e) {} }
    else { document.body.classList.add("immersive"); }   // iOS 등 미지원 시 CSS로 최대화
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) { try { exit.call(document); } catch (e) {} }
    document.body.classList.remove("immersive");
  }
});
