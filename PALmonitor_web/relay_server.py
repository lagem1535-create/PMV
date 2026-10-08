# -*- coding: utf-8 -*-
"""
PALmonitor 웹 릴레이 서버 (relay_server.py)
=================================================

브라우저(웹 앱) <--WebSocket--> 이 릴레이 <--TCP--> auxiliary_server.py

웹 앱은 보조 PC의 TCP 포트(58712)에 직접 붙을 수 없어서(브라우저는 raw TCP 불가),
이 파이썬 릴레이를 "경유"해서 화면을 받고 입력을 보냅니다.

  - 브라우저는 이 릴레이의 WebSocket(기본 0.0.0.0:58080)에 접속합니다.
  - 첫 메시지로 접속 대상(host/port/secret)과 Firebase ID 토큰을 보냅니다.
  - 릴레이는 보조 PC의 auxiliary_server.py 에 TCP로 붙어 auth 핸드셰이크를 하고,
    화면 프레임(JPEG)을 브라우저로 "바이너리" WS 프레임으로 그대로 흘려보냅니다.
  - 그 외 제어 메시지(info / info_meta / cmd_result / pong 등)는 "텍스트(JSON)"로 보냅니다.
  - 브라우저가 보내는 입력/명령(JSON 텍스트)은 auxiliary 프로토콜 메시지로 바꿔서 TCP로 전달합니다.

실행:
  pip install -r requirements.txt
  python relay_server.py
환경변수(선택):
  PAL_RELAY_HOST       릴레이 WS 바인드 주소 (기본 0.0.0.0)
  PAL_RELAY_PORT       릴레이 WS 포트 (기본 58080)
  PAL_AUX_PORT         보조 PC 기본 TCP 포트 (기본 58712)
  FIREBASE_PROJECT_ID  설정하면 브라우저가 보낸 Firebase ID 토큰을 실제로 검증함(권장).
                       비워두면 토큰 검증을 건너뜀(개발/내부망 전용).
  PAL_ALLOWED_EMAILS   쉼표로 구분한 허용 이메일 목록(설정 시 이 사용자만 접속 허용).
"""

import asyncio
import json
import os
import struct
import sys
import time

try:
    import websockets
except ImportError:
    print("[오류] 'websockets' 패키지가 필요합니다.  pip install websockets", file=sys.stderr)
    raise

# ----- 설정 -----
RELAY_HOST = os.environ.get("PAL_RELAY_HOST", "0.0.0.0")
RELAY_PORT = int(os.environ.get("PAL_RELAY_PORT", "58080"))
DEFAULT_AUX_PORT = int(os.environ.get("PAL_AUX_PORT", "58712"))
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("PAL_ALLOWED_EMAILS", "").split(",")
    if e.strip()
}

# 브라우저가 올려보낼 수 있는(=auxiliary 로 그대로 전달 허용할) 메시지 타입.
# 화이트리스트로 제한해서, 웹 클라이언트가 임의의 메시지 타입을 보조 PC로
# 흘려보내지 못하게 합니다. (메인 화면보기/제어에 필요한 것만 허용)
ALLOWED_UPSTREAM_TYPES = {"input", "cmd", "ping"}


# ============ auxiliary 프로토콜 (asyncio 버전) ============
async def aux_send(writer: asyncio.StreamWriter, msg_type: str, payload: bytes):
    header = json.dumps({"type": msg_type, "len": len(payload)}).encode("utf-8")
    writer.write(struct.pack(">I", len(header)) + header + payload)
    await writer.drain()


async def _read_exact(reader: asyncio.StreamReader, n: int):
    try:
        return await reader.readexactly(n)
    except asyncio.IncompleteReadError:
        return None


async def aux_recv(reader: asyncio.StreamReader):
    raw_hlen = await _read_exact(reader, 4)
    if raw_hlen is None:
        return None
    hlen = struct.unpack(">I", raw_hlen)[0]
    header_raw = await _read_exact(reader, hlen)
    if header_raw is None:
        return None
    header = json.loads(header_raw.decode("utf-8"))
    payload = b""
    if header["len"] > 0:
        payload = await _read_exact(reader, header["len"])
        if payload is None:
            return None
    return header["type"], payload


# ============ Firebase ID 토큰 검증 ============
_jwks_cache = {"keys": None, "exp": 0}


def _verify_firebase_token(id_token: str) -> dict:
    """
    FIREBASE_PROJECT_ID 가 설정돼 있으면 Firebase ID 토큰을 실제로 검증합니다.
    성공하면 토큰 클레임(dict)을 반환, 실패하면 ValueError.
    설정이 없으면 검증을 건너뛰고 빈 dict 를 반환합니다(개발/내부망 전용).
    """
    if not FIREBASE_PROJECT_ID:
        return {}
    try:
        import jwt  # PyJWT
        import urllib.request
    except ImportError:
        raise ValueError(
            "토큰 검증에 'pyjwt[crypto]' 가 필요합니다. pip install 'pyjwt[crypto]' "
            "(또는 FIREBASE_PROJECT_ID 를 비워 검증을 끄세요)"
        )
    if not id_token:
        raise ValueError("ID 토큰이 없습니다 (로그인 후 다시 시도).")

    now = time.time()
    if not _jwks_cache["keys"] or now >= _jwks_cache["exp"]:
        url = ("https://www.googleapis.com/robot/v1/metadata/x509/"
               "securetoken@system.gserviceaccount.com")
        with urllib.request.urlopen(url, timeout=10) as resp:
            certs = json.loads(resp.read().decode("utf-8"))
            cc = resp.headers.get("Cache-Control", "")
        max_age = 3600
        for part in cc.split(","):
            part = part.strip()
            if part.startswith("max-age="):
                try:
                    max_age = int(part.split("=", 1)[1])
                except ValueError:
                    pass
        _jwks_cache["keys"] = certs
        _jwks_cache["exp"] = now + max_age

    header = jwt.get_unverified_header(id_token)
    kid = header.get("kid")
    cert_pem = _jwks_cache["keys"].get(kid)
    if not cert_pem:
        # 키가 바뀌었을 수 있으니 캐시 무효화 후 1회 재시도 유도
        _jwks_cache["exp"] = 0
        raise ValueError("토큰 서명 키를 찾을 수 없습니다. 다시 시도하세요.")
    public_key = _pem_to_key(cert_pem)
    claims = jwt.decode(
        id_token,
        public_key,
        algorithms=["RS256"],
        audience=FIREBASE_PROJECT_ID,
        issuer=f"https://securetoken.google.com/{FIREBASE_PROJECT_ID}",
    )
    return claims


def _pem_to_key(cert_pem: str):
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"), default_backend())
    return cert.public_key()


# ============ WS <-> TCP 브리지 ============
async def _tcp_to_ws(reader, ws):
    """보조 PC(TCP) -> 브라우저(WS). frame 은 바이너리, 그 외는 JSON 텍스트."""
    while True:
        msg = await aux_recv(reader)
        if msg is None:
            break
        msg_type, payload = msg
        if msg_type == "frame":
            await ws.send(payload)  # JPEG 바이트 그대로 (바이너리 프레임)
        else:
            # 제어 메시지: 텍스트로. payload 가 JSON 이면 그대로, 아니면 utf-8 문자열로.
            try:
                data = json.loads(payload.decode("utf-8")) if payload else None
            except (ValueError, UnicodeDecodeError):
                data = payload.decode("utf-8", errors="replace")
            await ws.send(json.dumps({"type": msg_type, "data": data}))


async def _ws_to_tcp(ws, writer):
    """브라우저(WS) -> 보조 PC(TCP). 허용된 타입만 전달."""
    async for raw in ws:
        if isinstance(raw, bytes):
            continue  # 업스트림은 JSON 텍스트만 사용
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        mtype = obj.get("type")
        if mtype not in ALLOWED_UPSTREAM_TYPES:
            continue
        data = obj.get("data")
        if mtype == "input":
            await aux_send(writer, "input", json.dumps(data).encode("utf-8"))
        elif mtype == "cmd":
            await aux_send(writer, "cmd", str(data or "").encode("utf-8"))
        elif mtype == "ping":
            await aux_send(writer, "ping", b"")


async def handle_ws(ws):
    peer = getattr(ws, "remote_address", None)
    print(f"[+] 웹 클라이언트 접속: {peer}")
    writer = None
    try:
        # 1) 첫 메시지 = 접속 요청(JSON)
        try:
            first = await asyncio.wait_for(ws.recv(), timeout=30)
        except asyncio.TimeoutError:
            await ws.send(json.dumps({"type": "error", "data": "접속 정보 수신 시간 초과"}))
            return
        try:
            req = json.loads(first)
        except ValueError:
            await ws.send(json.dumps({"type": "error", "data": "잘못된 접속 요청"}))
            return

        # 2) Firebase 토큰 검증 (설정된 경우)
        try:
            claims = _verify_firebase_token(req.get("idToken", ""))
        except ValueError as e:
            await ws.send(json.dumps({"type": "error", "data": f"인증 실패: {e}"}))
            return
        email = (claims.get("email") or "").lower()
        if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
            await ws.send(json.dumps({"type": "error", "data": "허용되지 않은 계정입니다."}))
            return

        host = req.get("host")
        port = int(req.get("port") or DEFAULT_AUX_PORT)
        secret = req.get("secret", "")
        if not host:
            await ws.send(json.dumps({"type": "error", "data": "보조 PC 주소(host)가 없습니다."}))
            return

        # 3) 보조 PC 로 TCP 접속 + auth 핸드셰이크
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=8)
        except (OSError, asyncio.TimeoutError) as e:
            await ws.send(json.dumps({"type": "error", "data": f"보조 PC 접속 실패: {e}"}))
            return

        await aux_send(writer, "auth", secret.encode("utf-8"))
        resp = await aux_recv(reader)
        if not resp or resp[0] != "auth_ok":
            await ws.send(json.dumps({"type": "error",
                                      "data": "인증 실패. 연결 암호(SECRET)를 확인하세요."}))
            return
        await ws.send(json.dumps({"type": "connected", "data": {"host": host, "port": port}}))
        print(f"[+] 보조 PC({host}:{port}) 인증 성공 → 브리지 시작")

        # 4) 양방향 중계
        await asyncio.gather(
            _tcp_to_ws(reader, ws),
            _ws_to_tcp(ws, writer),
        )
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        try:
            await ws.send(json.dumps({"type": "error", "data": f"릴레이 오류: {e}"}))
        except Exception:
            pass
        import traceback
        traceback.print_exc()
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        print(f"[-] 웹 클라이언트 종료: {peer}")


async def main():
    mode = ("검증 ON (project=%s)" % FIREBASE_PROJECT_ID) if FIREBASE_PROJECT_ID else "검증 OFF(개발용)"
    print("=" * 56)
    print("  PALmonitor 웹 릴레이 서버")
    print(f"  WebSocket: ws://{RELAY_HOST}:{RELAY_PORT}")
    print(f"  보조 PC 기본 포트: {DEFAULT_AUX_PORT}")
    print(f"  Firebase 토큰: {mode}")
    if ALLOWED_EMAILS:
        print(f"  허용 계정: {', '.join(sorted(ALLOWED_EMAILS))}")
    print("=" * 56)
    async with websockets.serve(handle_ws, RELAY_HOST, RELAY_PORT, max_size=None,
                                ping_interval=20, ping_timeout=20):
        await asyncio.Future()  # 영원히 대기


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n종료합니다.")
