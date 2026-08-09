# -*- coding: utf-8 -*-
"""
주식비서 관심종목 설정 파일
------------------------------------
아래 리스트에 종목/코인을 추가하거나 지워서 나만의 관심목록을 만드세요.
"""

# 한국 주식 (코스피/코스닥) - {"code": 종목코드, "name": 종목명}
KR_STOCKS = [
    {"code": "005930", "name": "삼성전자"},
    {"code": "000660", "name": "SK하이닉스"},
    {"code": "035420", "name": "NAVER"},
    {"code": "035720", "name": "카카오"},
    {"code": "005380", "name": "현대차"},
    {"code": "051910", "name": "LG화학"},
    {"code": "068270", "name": "셀트리온"},
    {"code": "247540", "name": "에코프로비엠"},
]

# 미국 주식 - 티커 심볼
US_STOCKS = [
    "AAPL",   # Apple
    "MSFT",   # Microsoft
    "NVDA",   # NVIDIA
    "GOOGL",  # Alphabet
    "AMZN",   # Amazon
    "TSLA",   # Tesla
    "META",   # Meta
]

# 코인 (업비트 KRW 마켓 기준)
CRYPTO = [
    "KRW-BTC",
    "KRW-ETH",
    "KRW-XRP",
    "KRW-SOL",
    "KRW-DOGE",
    "KRW-ENA",
]

# 실제 보유중인 자산 - 평가손익을 계산해서 대시보드 맨 위에 보여줍니다.
# type: "coin"(업비트 마켓코드) 또는 "kr"(종목코드) / "us"(티커)
HOLDINGS = [
    {"type": "coin", "code": "KRW-ETH", "name": "이더리움", "qty": 2.07670898, "avg_price": 3369045},
    {"type": "coin", "code": "KRW-ENA", "name": "에테나", "qty": 37.5, "avg_price": 978},
]

# 스크리닝(추천 후보) 대상 유니버스 - KR_STOCKS/US_STOCKS 관심목록 외에도
# 추가로 스캔하고 싶은 종목이 있으면 여기에 넣으세요. 비워두면 관심목록만 스캔합니다.
KR_SCREEN_UNIVERSE = []   # 예: [{"code": "005930", "name": "삼성전자"}]
US_SCREEN_UNIVERSE = []   # 예: ["AAPL", "MSFT"]

# 리포트가 저장될 폴더
REPORT_DIR = "reports"
