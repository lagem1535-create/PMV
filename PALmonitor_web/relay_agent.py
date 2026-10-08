# -*- coding: utf-8 -*-
"""
PALmonitor 릴레이 에이전트 (relay_agent.py)
=================================================

집(보조 PC와 같은 네트워크)에서 돌아가는 "밖으로 접속하는" 릴레이입니다.
Cloudflare Worker 에 host 로 붙고, 폰(viewer)과 Worker 가 짝지어지면
그때 보조 PC(auxiliary_server.py, TCP 58712)에 접속해 화면/입력을 중계합니다.

    폰(PWA)  <--wss-->  Cloudflare Worker(Room DO)  <--wss(밖으로)-->  이 릴레이  <--TCP-->  보조 PC

이 방식의 장점:
  - 릴레이가 "밖으로만" 접속하므로 공유기 포트포워딩/인증서가 필요 없습니다.
  - 폰은 항상 https/wss(Cloudflare)로만 붙으므로 앱(PWA) 설치가 되고 ws:// 차단이 없습니다.
  - --install 로 Windows 시작프로그램에 등록하면 부팅 시 자동(숨김) 실행됩니다.
    → 터미널/파이썬 창을 계속 띄워 둘 필요가 없습니다.

연결 코드(room)는 자동입니다: 폰 앱에서 로그인한 계정과 "같은 계정"의 이메일/
비밀번호를 여기 릴레이에도 한 번 넣어주면, 그 계정의 UID를 자동으로 알아내서
연결 코드로 사용합니다. 즉 직접 코드를 정하거나 맞출 필요가 없습니다.

설정(우선순위: 명령행 > 환경변수 > pal_relay_config.json 파일 > 기본값):
    worker   Worker WebSocket 주소   예) wss://pmv.<서브도메인>.workers.dev
    email    폰 앱과 같은 Firebase 계정 이메일
    password 그 계정 비밀번호
    key      HOST_KEY (Worker secret 설정했을 때만)
    aux_host 보조 PC 주소(기본 127.0.0.1 = 이 PC 자신)
    aux_port 보조 PC 포트(기본 58712)
    secret   보조 PC 연결 암호(SECRET, 기본 1234)
    room     (보통 비워둠) 연결 코드를 직접 지정하고 싶을 때만

실행(가장 쉬움): 이 폴더의  원격_켜기.bat  을 더블클릭.
  → Worker 주소와 연결 코드(room)가 코드에 이미 박혀 있어, 아무 옵션 없이
    python relay_agent.py --install  만으로 자동시작 등록 + 숨김 실행됩니다.
  → 보조 PC가 다른 PC면 한 번만:  python relay_agent.py --install --aux_host <보조PC_IP>
"""

import argparse
import asyncio
import json
import os
import struct
import sys

try:
    import websockets
except ImportError:
    print("[오류] 'websockets' 패키지가 필요합니다.  pip install websockets", file=sys.stderr)
    raise

SCRIPT_PATH = os.path.abspath(__file__)
CONFIG_PATH = os.path.join(os.path.dirname(SCRIPT_PATH), "pal_relay_config.json")
AUTORUN_VALUE = "PALmonitor_RelayAgent"
AUTORUN_REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"

ALLOWED_UPSTREAM = {"input", "cmd", "ping"}

# 폰 앱과 같은 Firebase 프로젝트(fir-2-f3b80)의 웹 API 키(공개값).
DEFAULT_API_KEY = "AIzaSyCXqCgMZV-8bRwy3cqT21mFToAkd2o4kiA"

# ↓↓↓ 이미 코드에 박혀 있는 기본값 — 보통 그대로 두면 됩니다(설정 불필요) ↓↓↓
DEFAULT_WORKER = "wss://pmv.lagem1535.workers.dev"   # Cloudflare 배포 주소
DEFAULT_ROOM = "palmon-7qk2m9xz4rt8lw"               # 폰 앱(firebase_config.js의 ROOM)과 동일


# ---------- auxiliary 프로토콜 (asyncio) ----------
async def aux_send(writer, msg_type, payload: bytes):
    header = json.dumps({"type": msg_type, "len": len(payload)}).encode("utf-8")
    writer.write(struct.pack(">I", len(header)) + header + payload)
    await writer.drain()


async def _read_exact(reader, n):
    try:
        return await reader.readexactly(n)
    except asyncio.IncompleteReadError:
        return None


async def aux_recv(reader):
    raw = await _read_exact(reader, 4)
    if raw is None:
        return None
    hlen = struct.unpack(">I", raw)[0]
    hraw = await _read_exact(reader, hlen)
    if hraw is None:
        return None
    header = json.loads(hraw.decode("utf-8"))
    payload = b""
    if header["len"] > 0:
        payload = await _read_exact(reader, header["len"])
        if payload is None:
            return None
    return header["type"], payload


# ---------- 설정 ----------
def load_config(args):
    cfg = {"aux_host": "127.0.0.1", "aux_port": 58712, "secret": "1234",
           "worker": DEFAULT_WORKER, "room": DEFAULT_ROOM, "key": "",
           "email": "", "password": "", "apikey": DEFAULT_API_KEY}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    for k in cfg:
        env = os.environ.get("PAL_" + k.upper())
        if env:
            cfg[k] = int(env) if k == "aux_port" else env
    for k in cfg:
        v = getattr(args, k, None)
        if v is not None:
            cfg[k] = v
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"설정 저장: {CONFIG_PATH}")


def resolve_room(cfg):
    """연결 코드(room) 결정: 이미 있으면 그대로, 없으면 이메일/비번으로 계정 UID 조회."""
    if cfg.get("room"):
        return cfg["room"]
    email, password = cfg.get("email"), cfg.get("password")
    apikey = cfg.get("apikey") or DEFAULT_API_KEY
    if not email or not password:
        raise RuntimeError("room(연결 코드)을 정할 수 없습니다. --email 과 --password 를 지정하세요.")
    import urllib.request
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={apikey}"
    body = json.dumps({"email": email, "password": password,
                       "returnSecureToken": True}).encode("utf-8")
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    uid = data.get("localId")
    if not uid:
        raise RuntimeError("계정 UID 조회 실패(이메일/비밀번호 확인).")
    return uid


# ---------- Windows 자동시작 ----------
def install_autorun():
    if os.name != "nt":
        print("자동시작 등록은 Windows 전용입니다. (지금은 그냥 python relay_agent.py 로 실행하세요)")
        return
    import winreg
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = pyw if os.path.exists(pyw) else sys.executable
    cmd = f'"{exe}" "{SCRIPT_PATH}"'
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTORUN_REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, AUTORUN_VALUE, 0, winreg.REG_SZ, cmd)
    print("Windows 시작프로그램 등록 완료. 다음 부팅부터 자동(숨김) 실행됩니다.")
    print(f"  {cmd}")


def uninstall_autorun():
    if os.name != "nt":
        print("Windows 전용입니다.")
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTORUN_REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, AUTORUN_VALUE)
        print("자동시작 등록 해제 완료.")
    except FileNotFoundError:
        print("등록된 자동시작 항목이 없습니다.")


def relaunch_hidden_if_needed():
    """python.exe(콘솔)로 떠 있으면 pythonw.exe(콘솔 없음)로 재실행."""
    if os.name != "nt":
        return False
    if os.path.basename(sys.executable).lower() == "pythonw.exe":
        return False
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pyw):
        return False
    import subprocess
    subprocess.Popen([pyw, SCRIPT_PATH] + sys.argv[1:],
                     close_fds=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return True


# ---------- 중계 본체 ----------
async def bridge_aux(ws, cfg):
    """viewer 가 온라인인 동안 보조 PC에 붙어 양방향 중계. 끝나면 반환."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(cfg["aux_host"], int(cfg["aux_port"])), timeout=8)
    except Exception as e:
        await ws.send(json.dumps({"type": "error", "data": f"보조 PC 접속 실패: {e}"}))
        return
    try:
        await aux_send(writer, "auth", str(cfg["secret"]).encode("utf-8"))
        resp = await aux_recv(reader)
        if not resp or resp[0] != "auth_ok":
            await ws.send(json.dumps({"type": "error", "data": "보조 PC 인증 실패(SECRET 확인)"}))
            return

        stop = asyncio.Event()

        async def aux_to_ws():
            while not stop.is_set():
                msg = await aux_recv(reader)
                if msg is None:
                    break
                mtype, payload = msg
                if mtype == "frame":
                    await ws.send(payload)  # 바이너리 그대로
                else:
                    try:
                        data = json.loads(payload.decode("utf-8")) if payload else None
                    except (ValueError, UnicodeDecodeError):
                        data = payload.decode("utf-8", errors="replace")
                    await ws.send(json.dumps({"type": mtype, "data": data}))
            stop.set()

        async def ws_to_aux():
            try:
                while not stop.is_set():
                    raw = await ws.recv()
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    try:
                        obj = json.loads(raw)
                    except ValueError:
                        continue
                    t = obj.get("type")
                    if t == "peer":
                        if obj.get("data") == "offline":  # 폰이 나감 → 보조 접속 종료
                            stop.set()
                            break
                        continue
                    if t not in ALLOWED_UPSTREAM:
                        continue
                    d = obj.get("data")
                    if t == "input":
                        await aux_send(writer, "input", json.dumps(d).encode("utf-8"))
                    elif t == "cmd":
                        await aux_send(writer, "cmd", str(d or "").encode("utf-8"))
                    elif t == "ping":
                        await aux_send(writer, "ping", b"")
            except websockets.ConnectionClosed:
                stop.set()

        await asyncio.gather(aux_to_ws(), ws_to_aux())
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def run(cfg):
    room = cfg["room"]
    url = (f'{cfg["worker"].rstrip("/")}/ws?room={room}&role=host'
           + (f'&key={cfg["key"]}' if cfg.get("key") else ""))
    print(f"[릴레이] Worker 접속: {cfg['worker']}  room={room}")
    backoff = 1
    while True:
        try:
            async with websockets.connect(url, max_size=None, ping_interval=20) as ws:
                print("[릴레이] Worker 연결됨. 폰(viewer) 접속 대기…")
                backoff = 1
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    try:
                        obj = json.loads(raw)
                    except ValueError:
                        continue
                    if obj.get("type") == "peer" and obj.get("data") == "online":
                        print("[릴레이] 폰 접속 → 보조 PC 중계 시작")
                        await bridge_aux(ws, cfg)
                        print("[릴레이] 중계 종료. 다시 대기…")
        except Exception as e:
            print(f"[릴레이] 연결 끊김: {e} — {backoff}s 후 재시도")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker"); ap.add_argument("--room"); ap.add_argument("--key")
    ap.add_argument("--email"); ap.add_argument("--password"); ap.add_argument("--apikey")
    ap.add_argument("--aux_host"); ap.add_argument("--aux_port", type=int); ap.add_argument("--secret")
    ap.add_argument("--install", action="store_true", help="설정 저장 + Windows 자동시작 등록 후 숨김 실행")
    ap.add_argument("--uninstall", action="store_true", help="자동시작 등록 해제")
    args = ap.parse_args()

    if args.uninstall:
        uninstall_autorun()
        return

    cfg = load_config(args)

    if args.install:
        if not cfg["worker"]:
            print("--install 전에 --worker 를 지정하세요.")
            return
        try:
            cfg["room"] = resolve_room(cfg)   # 이메일/비번 → 계정 UID 자동
        except Exception as e:
            print(f"연결 코드 자동 설정 실패: {e}")
            return
        print(f"연결 코드(room) = 계정 UID 자동 설정: {cfg['room']}")
        # 비밀번호는 저장하지 않음(UID만 저장). 이메일은 참고용으로만 남김.
        to_save = dict(cfg); to_save["password"] = ""
        save_config(to_save)
        install_autorun()
        if relaunch_hidden_if_needed():
            print("백그라운드(숨김)로 실행을 시작했습니다.")
            return

    if not cfg["worker"]:
        print("worker 설정이 필요합니다. (--worker 또는 pal_relay_config.json)")
        return
    if not cfg.get("room"):
        try:
            cfg["room"] = resolve_room(cfg)
        except Exception as e:
            print(f"연결 코드를 정할 수 없습니다: {e}")
            return

    # 콘솔로 떴고 --install 도 아니면 그냥 포그라운드 실행
    try:
        asyncio.run(run(cfg))
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
