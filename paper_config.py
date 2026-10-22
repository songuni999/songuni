# -*- coding: utf-8 -*-
"""
업비트 모의투자(페이퍼 트레이딩) 설정 파일
- 숫자만 바꿔서 쓰세요. 실제 주문은 절대 나가지 않습니다(공개 시세·호가창 조회만 함).
- 금액 단위는 모두 원(KRW)입니다.
- 설정을 크게 바꿨으면 paper_state.json / paper_trades.csv 를 지우고 새로 시작하세요.
"""

# ── 자금 ──────────────────────────────────────────────
INITIAL_CASH = 1_000_000     # 시작 현금 (원)
LOSS_LIMIT = None            # 누적 손실 한도 (원). None이면 손실한도 정지 기능 꺼짐.
                             # 숫자를 넣으면 평가총액이 INITIAL_CASH - LOSS_LIMIT 이하일 때 전부 팔고 정지.
                             # (None이어도 평가총액이 최소주문금액보다 작아지면 자연히 더 못 삽니다)
POSITION_PCT = 0.333         # 한 번 매수할 때 쓸 돈 = 매수 시점 '총평가액'의 33.3% (수수료 포함).
                             # 현금이 그보다 적으면 남은 현금 전액. 최소주문금액 미만이면 매수 안 함.
MAX_POSITIONS = 3            # 동시에 들고 있을 최대 종목 수
MAX_TRADES_PER_DAY = 10      # 하루 최대 거래 횟수 (매수+매도 합산). 한도가 차면 새 매수만 막고, 매도는 항상 실행

# ── 매도 규칙 ─────────────────────────────────────────
STOP_LOSS_PCT = -5.0         # 손절선 (%). 평균체결가 대비 최우선 매수호가가 이 값 이하이면 손절
TAKE_PROFIT_PCT = 10.0       # 익절선 (%). 평균체결가 대비 최우선 매수호가가 이 값 이상이면 익절
MAX_HOLD_HOURS = 48          # 최대 보유 시간. 넘으면 기간만료 매도

# ── 매수 규칙 (1시간봉 기준) ──────────────────────────
EMA_FAST = 20                # 빠른 이동평균(EMA) 기간
EMA_SLOW = 50                # 느린 이동평균(EMA) 기간
RSI_PERIOD = 14              # RSI 기간
RSI_MIN = 40                 # 상승전환 규칙의 RSI 하한
RSI_MAX = 75                 # 상승전환 규칙의 RSI 상한
RSI_TARGET = 55              # 점수 계산 때 RSI가 이 값에 가까울수록 유리(아래 SCORE_* 참고)
VOLUME_AVG_BARS = 20         # 거래량 평균 계산 봉 수
VOLUME_RATIO = 0.8           # 상승전환: 직전 봉 거래량이 평균의 이 배수 이상 (0.8 = 평균의 80%)
CROSS_LOOKBACK = 6           # 최근 몇 봉 안의 골든크로스까지 인정할지

# ── 매수 규칙 켜기/끄기 (셋 중 하나라도 맞으면 매수 후보) ──
ENTRY_CROSS = True           # 상승전환: 최근 골든크로스 + RSI_MIN~RSI_MAX + 거래량 VOLUME_RATIO배 이상
ENTRY_PULLBACK = True        # 눌림목: 상승추세 중 20일선(EMA20) 근처까지 내려왔다가 양봉으로 반등
ENTRY_BREAKOUT = True        # 돌파: 최근 고점을 거래량 실어 뚫음

# 눌림목 수치
PULLBACK_TREND_BARS = 10     # EMA20 > EMA50 상태가 최근 이 봉 수 이상 연속 유지돼야 '상승추세'로 인정
PULLBACK_TOUCH_BARS = 3      # 최근 몇 봉 안에서 EMA20 근처까지 내려온 봉을 찾을지
PULLBACK_TOUCH_PCT = 0.5     # 저가가 그 봉 EMA20의 +0.5% 이내(또는 아래)면 'EMA20 근처까지 내려옴'
PULLBACK_RSI_MIN = 42        # 눌림목 RSI 하한
PULLBACK_RSI_MAX = 68        # 눌림목 RSI 상한
PULLBACK_VOLUME_RATIO = 0.7  # 직전 봉 거래량 ≥ 평균 × 이 배수
# (직전 완성봉 종가는 EMA20 위, 그 봉은 양봉(종가>시가)이어야 함)

# 돌파 수치
BREAKOUT_LOOKBACK = 24       # 직전 완성봉 종가가 '그 이전 24봉 고가의 최고값'보다 높으면 돌파
BREAKOUT_VOLUME_RATIO = 1.5  # 직전 봉 거래량 ≥ 평균 × 이 배수
BREAKOUT_RSI_MAX = 78        # RSI가 이 값보다 높으면 과열로 보고 안 삼
# (EMA20 > EMA50 상승추세일 때만)

# 후보 점수 (높은 순서로 매수) = 규칙 기본점 + min(거래량배수, 3) × 0.5 − |RSI − RSI_TARGET| / 20
SCORE_BREAKOUT = 3.0         # 돌파 기본점
SCORE_CROSS = 2.5            # 상승전환 기본점
SCORE_PULLBACK = 2.0         # 눌림목 기본점
SCORE_VOL_CAP = 3.0          # 거래량배수 보너스는 이 배수까지만 인정
SCORE_VOL_WEIGHT = 0.5       # 거래량배수 1배당 보너스
SCORE_RSI_DIV = 20           # RSI가 RSI_TARGET에서 이만큼 멀어질 때마다 1점 감점

# ── 체결 비용 ─────────────────────────────────────────
FEE_RATE = 0.0005            # 수수료율 (업비트 원화마켓 0.05%, 매수·매도 각각)
MIN_ORDER_KRW = 5000         # 업비트 최소 주문금액 (원). 이보다 작으면 매수 안 함
# 슬리피지 가정값은 없앴습니다. 매수·매도 때 실제 호가창을 한 칸씩 소진하며 체결가를 계산합니다.

# ── 종목 선정 ─────────────────────────────────────────
UNIVERSE_SIZE = 15           # 24시간 거래대금 상위 몇 종목을 볼지
EXCLUDE = ["KRW-USDT", "KRW-USDC", "KRW-USDS"]   # 제외할 종목 (스테이블코인 등)

# ── 기타 ──────────────────────────────────────────────
CANDLE_COUNT = 200           # 불러올 1시간봉 개수
REQUEST_DELAY = 0.15         # API 요청 사이 대기 시간(초)
DAILY_SUMMARY_HOUR = 9       # 이 시각(시) 이후 그날 첫 실행 때 하루 요약 카톡 전송
TRADE_ALERTS = False         # True면 매수·매도할 때마다 카톡. False면 하루요약 1통만 (거래는 대시보드에서 확인)

# ── 대시보드 게시 ─────────────────────────────────────
DASHBOARD_URL = "https://songuni999.github.io/songuni/paper.html"  # 카톡 '자세히 보기' 링크
PUBLISH_EVERY_HOURS = 6      # 거래·하루요약이 없어도 마지막 게시 후 이 시간이 지나면 다시 게시(git push)
EQUITY_HISTORY_MAX = 5000    # 자산 그래프용 기록 최대 개수(오래된 것부터 버림)
