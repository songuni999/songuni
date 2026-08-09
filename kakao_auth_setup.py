# -*- coding: utf-8 -*-
"""
카카오 로그인 1회 인증 스크립트
실행: python kakao_auth_setup.py <REST_API_KEY> <CLIENT_SECRET>
브라우저가 열리면 카카오 로그인 + 동의를 진행하세요. 완료되면 자동으로 토큰이 저장됩니다.
※ REST API 키/시크릿은 코드에 하드코딩하지 말고 실행 시 인자로 넘겨주세요 (공개 저장소 노출 방지).
"""
import json
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

REDIRECT_URI = "http://localhost:8888/oauth"
AUTH_URL = "https://kauth.kakao.com/oauth/authorize"
TOKEN_URL = "https://kauth.kakao.com/oauth/token"

auth_code_holder = {}


class OAuthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        code = qs.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        if code:
            auth_code_holder["code"] = code
            self.wfile.write("<html><body><h2>인증 완료! 이 창은 닫으셔도 됩니다.</h2></body></html>".encode("utf-8"))
        else:
            self.wfile.write("<html><body><h2>인증 실패. 콘솔을 확인하세요.</h2></body></html>".encode("utf-8"))

    def log_message(self, format, *args):
        pass  # 콘솔 로그 억제


def main():
    if len(sys.argv) < 3:
        print("사용법: python kakao_auth_setup.py <REST_API_KEY> <CLIENT_SECRET>")
        sys.exit(1)
    rest_api_key = sys.argv[1]
    client_secret = sys.argv[2]

    server = HTTPServer(("localhost", 8888), OAuthHandler)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()

    params = {
        "client_id": rest_api_key,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "talk_message",
    }
    url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
    print("브라우저에서 카카오 로그인 창이 열립니다. 동의를 완료해주세요...")
    webbrowser.open(url)

    t.join(timeout=120)
    code = auth_code_holder.get("code")
    if not code:
        print("인증 코드를 받지 못했어요. 다시 시도해주세요.")
        sys.exit(1)

    resp = requests.post(TOKEN_URL, data={
        "grant_type": "authorization_code",
        "client_id": rest_api_key,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "code": code,
    })
    if resp.status_code != 200:
        print("토큰 발급 실패:", resp.status_code, resp.text)
        sys.exit(1)
    payload = resp.json()

    secrets = {
        "rest_api_key": rest_api_key,
        "client_secret": client_secret,
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_in": payload.get("expires_in", 21599),
    }
    import time
    secrets["issued_at"] = time.time()

    with open("kakao_secrets.json", "w", encoding="utf-8") as f:
        json.dump(secrets, f, ensure_ascii=False, indent=2)

    print("인증 완료! kakao_secrets.json에 토큰을 저장했어요.")
    print("이제 'python kakao_sender.py'로 테스트 메시지를 보내볼 수 있어요.")


if __name__ == "__main__":
    main()
