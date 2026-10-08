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

설정(아래 우선순위: 명령행 > 환경변수 > pal_relay_config.json 파일 > 기본값):
    worker   Worker WebSocket 주소   예) wss://pmv.<서브도메인>.workers.dev
    room     연결 코드(폰 앱과 동일, 길고 무작위로)   예) 3f9a1c7b2e...
    key      HOST_KEY (Worker secret 설정했을 때만)
    aux_host 보조 PC 주소(기본 127.0.0.1 = 이 PC 자신)
    aux_port 보조 PC 포트(기본 58712)
    secret   보조 PC 연결 암호(SECRET, 기본 1234)

실행:
    pip install websockets
    python relay_agent.py --worker wss://... --room <코드> --secret 1234
    # 설정을 pal_relay_config.json 에 저장하고 자동시작 등록:
    python relay_agent.py --install
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
           "worker": "", "room": "", "key": ""}
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
    url = (f'{cfg["worker"].rstrip("/")}/ws?room={cfg["room"]}&role=host'
           + (f'&key={cfg["key"]}' if cfg.get("key") else ""))
    print(f"[릴레이] Worker 접속: {cfg['worker']}  room={cfg['room']}")
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
    ap.add_argument("--aux_host"); ap.add_argument("--aux_port", type=int); ap.add_argument("--secret")
    ap.add_argument("--install", action="store_true", help="설정 저장 + Windows 자동시작 등록 후 숨김 실행")
    ap.add_argument("--uninstall", action="store_true", help="자동시작 등록 해제")
    args = ap.parse_args()

    if args.uninstall:
        uninstall_autorun()
        return

    cfg = load_config(args)

    if args.install:
        if not cfg["worker"] or not cfg["room"]:
            print("--install 전에 최소한 --worker 와 --room 을 함께 지정하세요.")
            return
        save_config(cfg)
        install_autorun()
        # 지금 바로 숨김 실행도 시작
        if relaunch_hidden_if_needed():
            print("백그라운드(숨김)로 실행을 시작했습니다.")
            return

    if not cfg["worker"] or not cfg["room"]:
        print("worker 와 room 설정이 필요합니다. (--worker, --room 또는 pal_relay_config.json)")
        return

    # 자동시작(pythonw)이 아니라 콘솔로 떴고 --install 도 아니면, 그냥 포그라운드 실행
    try:
        asyncio.run(run(cfg))
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
