// ===========================================================================
//  PALmonitor Cloudflare Worker — 폰(뷰어) <-> 집 릴레이(호스트) 중계
// ===========================================================================
//  - 정적 웹 앱(web/)은 ASSETS 바인딩으로 서빙.
//  - WebSocket 두 개를 room 코드로 짝지어 Durable Object(Room)가 중계:
//        /ws?room=<코드>&role=viewer   (폰 브라우저)
//        /ws?room=<코드>&role=host     (집 릴레이 relay_agent.py)
//  - viewer 가 보내는 메시지는 host 로, host 가 보내는 프레임/제어는 viewer 로 전달.
//  - room 코드가 사실상의 접속 비밀번호입니다(길고 무작위로 쓰세요).
//  - (선택) FIREBASE_PROJECT_ID 가 설정돼 있으면 viewer 의 Firebase ID 토큰을 검증.
// ===========================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return handleWs(request, env, url);
    }
    // 그 외 경로는 정적 자산(web/)으로
    return env.ASSETS.fetch(request);
  },
};

async function handleWs(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const room = url.searchParams.get("room") || "";
  const role = url.searchParams.get("role") || "";
  if (!room || (role !== "viewer" && role !== "host")) {
    return new Response("room and role(viewer|host) required", { status: 400 });
  }

  // viewer 인증(선택): Firebase ID 토큰 검증 + host 키 검증
  if (role === "viewer") {
    const token = url.searchParams.get("idToken") || "";
    const ok = await verifyFirebaseToken(token, env);
    if (ok === false) {
      return new Response("auth failed", { status: 401 });
    }
  } else if (role === "host") {
    // host(릴레이)는 사전 공유 키로 인증(설정된 경우)
    if (env.HOST_KEY) {
      const key = url.searchParams.get("key") || "";
      if (key !== env.HOST_KEY) {
        return new Response("host key invalid", { status: 401 });
      }
    }
  }

  const id = env.ROOM.idFromName(room);
  const stub = env.ROOM.get(id);
  return stub.fetch(request);
}

// Firebase ID 토큰 검증(WebCrypto RS256). FIREBASE_PROJECT_ID 미설정 시 검증 생략(null 반환).
async function verifyFirebaseToken(token, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return null; // 검증 꺼짐
  if (!token) return false;
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return false;
    const header = JSON.parse(b64urlToStr(h));
    const payload = JSON.parse(b64urlToStr(p));
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId) return false;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;
    if (!payload.exp || payload.exp < now) return false;
    if (!payload.sub) return false;

    const jwk = await getGoogleJwk(header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"]
    );
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64urlToBytes(s);
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
  } catch (e) {
    return false;
  }
}

// Google securetoken 공개키를 JWK 형식으로 가져와 kid 로 조회(간단 캐시).
let _jwkCache = { byKid: null, exp: 0 };
async function getGoogleJwk(kid) {
  const now = Date.now();
  if (!_jwkCache.byKid || now >= _jwkCache.exp) {
    const res = await fetch(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    );
    const body = await res.json();
    const byKid = {};
    for (const k of (body.keys || [])) byKid[k.kid] = k;
    _jwkCache = { byKid, exp: now + 60 * 60 * 1000 };
  }
  return _jwkCache.byKid[kid] || null;
}

function b64urlToBin(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}
function b64urlToStr(b64url) {
  // UTF-8 안전 디코딩
  const bin = b64urlToBin(b64url);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64urlToBytes(b64url) {
  const bin = b64urlToBin(b64url);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ===========================================================================
//  Durable Object: 한 room 안의 host/viewer 두 소켓을 중계
// ===========================================================================
export class Room {
  constructor(state, env) {
    this.state = state;
    this.host = null;
    this.viewer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === "host") {
      if (this.host) { try { this.host.close(1000, "replaced"); } catch (e) {} }
      this.host = server;
    } else {
      if (this.viewer) { try { this.viewer.close(1000, "replaced"); } catch (e) {} }
      this.viewer = server;
    }

    const other = () => (role === "host" ? this.viewer : this.host);

    // 상대가 이미 있으면 서로에게 "ready" 알림
    try {
      server.send(JSON.stringify({ type: "peer", data: other() ? "online" : "waiting" }));
      const o = other();
      if (o && o.readyState === 1) {
        o.send(JSON.stringify({ type: "peer", data: "online" }));
      }
    } catch (e) {}

    server.addEventListener("message", (ev) => {
      const o = other();
      if (o && o.readyState === 1) {
        try { o.send(ev.data); } catch (e) {}
      }
    });

    const cleanup = () => {
      const o = other();
      if (role === "host") this.host = null; else this.viewer = null;
      if (o && o.readyState === 1) {
        try { o.send(JSON.stringify({ type: "peer", data: "offline" })); } catch (e) {}
      }
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}
