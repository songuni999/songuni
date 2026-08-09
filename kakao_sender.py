# -*- coding: utf-8 -*-
"""
카카오톡 '나에게 보내기' 자동 전송 모듈
사전 준비: kakao_auth_setup.py를 한 번 실행해서 kakao_secrets.json을 만들어야 합니다.
"""
import json
import os
import time

import requests

SECRETS_PATH = os.path.join(os.path.dirname(__file__), "kakao_secrets.json")
TOKEN_URL = "https://kauth.kakao.com/oauth/token"
SEND_URL = "https://kapi.kakao.com/v2/api/talk/memo/default/send"


def _load_secrets():
    if not os.path.exists(SECRETS_PATH):
        raise FileNotFoundError(
            "kakao_secrets.json이 없어요. 먼저 kakao_auth_setup.py를 실행해서 인증을 완료하세요."
        )
    with open(SECRETS_PATH, encoding="utf-8") as f:
        return json.load(f)


def _save_secrets(secrets):
    with open(SECRETS_PATH, "w", encoding="utf-8") as f:
        json.dump(secrets, f, ensure_ascii=False, indent=2)


def _refresh_access_token(secrets):
    data = {
        "grant_type": "refresh_token",
        "client_id": secrets["rest_api_key"],
        "refresh_token": secrets["refresh_token"],
    }
    if secrets.get("client_secret"):
        data["client_secret"] = secrets["client_secret"]
    resp = requests.post(TOKEN_URL, data=data, timeout=10)
    resp.raise_for_status()
    payload = resp.json()
    secrets["access_token"] = payload["access_token"]
    if "refresh_token" in payload:  # 카카오가 리프레시 토큰을 갱신해줄 때가 있음
        secrets["refresh_token"] = payload["refresh_token"]
    secrets["issued_at"] = time.time()
    secrets["expires_in"] = payload.get("expires_in", 21599)
    _save_secrets(secrets)
    return secrets


def _get_valid_access_token():
    secrets = _load_secrets()
    issued_at = secrets.get("issued_at", 0)
    expires_in = secrets.get("expires_in", 0)
    if time.time() > issued_at + expires_in - 300:  # 만료 5분 전이면 미리 갱신
        secrets = _refresh_access_token(secrets)
    return secrets["access_token"]


REPORT_LINK = "https://songuni999.github.io/songuni/"


def send_text(message: str, link: str = None):
    """카카오톡 '나에게 보내기'로 텍스트 메시지를 전송합니다. (최대 200자 권장)"""
    access_token = _get_valid_access_token()
    link = link or REPORT_LINK
    template = {
        "object_type": "text",
        "text": message[:200],
        "link": {"web_url": link, "mobile_web_url": link},
    }
    resp = requests.post(
        SEND_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        data={"template_object": json.dumps(template, ensure_ascii=False)},
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"카카오톡 전송 실패: {resp.status_code} {resp.text}")
    return resp.json()


if __name__ == "__main__":
    result = send_text("주식비서 테스트 메시지예요. 카톡 자동 전송이 정상 연결됐어요!")
    print(result)
