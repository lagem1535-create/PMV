# -*- coding: utf-8 -*-
"""
웹 앱(web/ 폴더) 정적 파일 서버.
브라우저가 ES module(firebase_config.js 등)을 불러오려면 file:// 가 아니라
http:// 로 열어야 하므로, 이 간단한 서버로 web/ 폴더를 띄웁니다.

  python serve_web.py          # http://0.0.0.0:8000 에서 web/ 제공
  python serve_web.py 8080     # 포트 지정

릴레이 서버(relay_server.py)와는 별개입니다. 둘 다 실행해 두세요.
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(WEB_DIR)
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"웹 앱: http://0.0.0.0:{PORT}  (web/ 폴더 제공 중, Ctrl+C 로 종료)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n종료합니다.")
