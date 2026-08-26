# -*- coding: utf-8 -*-
"""
업비트 Open API 연동 - 실제 보유 코인 잔고/평균매수가 조회 (조회 전용)
사전 준비: upbit_secrets.json에 {"access_key": "...", "secret_key": "..."} 저장
"""
import json
import os
import uuid

import jwt
import requests

SECRETS_PATH = os.path.join(os.path.dirname(__file__), "upbit_secrets.json")
API_URL = "https://api.upbit.com/v1/accounts"


def _load_secrets():
    if not os.path.exists(SECRETS_PATH):
        raise FileNotFoundError(
            "upbit_secrets.json이 없어요. Access Key/Secret Key를 먼저 저장해야 해요."
        )
    with open(SECRETS_PATH, encoding="utf-8") as f:
        return json.load(f)


def fetch_balances():
    """업비트 계좌의 보유 자산 목록을 가져옵니다. (조회 전용, 잔고 0인 자산은 제외)"""
    secrets = _load_secrets()
    payload = {
        "access_key": secrets["access_key"],
        "nonce": str(uuid.uuid4()),
    }
    token = jwt.encode(payload, secrets["secret_key"])
    headers = {"Authorization": f"Bearer {token}"}

    resp = requests.get(API_URL, headers=headers, timeout=10)
    if resp.status_code != 200:
        raise RuntimeError(f"업비트 API 오류: {resp.status_code} {resp.text}")

    accounts = resp.json()
    holdings = []
    for acc in accounts:
        currency = acc.get("currency")
        balance = float(acc.get("balance", 0)) + float(acc.get("locked", 0))
        avg_price = float(acc.get("avg_buy_price", 0))
        if currency == "KRW" or balance <= 0:
            continue
        holdings.append({
            "type": "coin",
            "code": f"KRW-{currency}",
            "name": currency,
            "qty": balance,
            "avg_price": avg_price,
        })
    return holdings


if __name__ == "__main__":
    for h in fetch_balances():
        print(h)
