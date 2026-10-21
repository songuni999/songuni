# -*- coding: utf-8 -*-
"""
업비트 모의투자(페이퍼 트레이딩) 봇 - 1회 실행 = 1사이클

※ 실제 주문은 절대 넣지 않습니다. 업비트 '공개 시세 API'(마켓 목록·현재가·캔들·호가창)만 호출합니다.
   주문/계좌 API, upbit_secrets.json, upbit_client.py 는 이 파일 어디에서도 쓰지 않습니다.

체결 방식: 매수·매도 때 실제 호가창(/v1/orderbook)을 한 칸씩 소진하며 업비트 시장가 주문처럼 계산합니다.
  - 시장가 매수(금액 지정): 주문금액 = floor(사용할 원화 / (1+수수료율)), 매도호가 낮은 가격부터 소진
  - 시장가 매도(수량 지정): 보유 수량 전량을 매수호가 높은 가격부터 소진
  - 수수료 = 체결금액 × 수수료율

사용법:
  python paper_trader.py            # 1사이클 실행 (거래 시 카톡 전송, 대시보드 갱신·필요 시 게시)
  python paper_trader.py --dry-run  # 1사이클 실행, 카톡 미전송, git 게시 생략(콘솔 출력만)
  python paper_trader.py --status   # 현재 상태만 출력
"""
import argparse
import bisect
import csv
import html
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

import paper_config as C

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "paper_state.json")
TRADES_PATH = os.path.join(BASE_DIR, "paper_trades.csv")
DASHBOARD_PATH = os.path.join(BASE_DIR, "docs", "paper.html")

API = "https://api.upbit.com/v1"
KST = timezone(timedelta(hours=9))
FOOTER = "※모의투자"
KAKAO_LIMIT = 200

TRADE_FIELDS = ["번호", "시각", "종목", "이름", "구분", "사유", "평균체결가", "수량", "체결금액", "수수료",
                "현금변화", "손익", "손익률(%)", "거래후현금", "손절가", "목표가", "매수가", "보유시간", "비고"]

# 업비트 원화마켓 호가단위 (가격 하한, 호가단위) - 위에서부터 먼저 맞는 구간 사용
KRW_TICKS = [
    (2_000_000, 1000), (1_000_000, 1000), (500_000, 500), (100_000, 100), (50_000, 50),
    (10_000, 10), (5_000, 5), (1_000, 1), (100, 1), (10, 0.1), (1, 0.01), (0.1, 0.001),
    (0.01, 0.0001), (0.001, 0.00001), (0.0001, 0.000001), (0.00001, 0.0000001), (0, 0.00000001),
]


# ───────────────────────── 공통 유틸 ─────────────────────────
def now_kst():
    return datetime.now(KST)


def floor8(x):
    # 부동소수 오차(184.12 → 184.1199999…) 때문에 아주 작은 보정값을 더한 뒤 내림
    return math.floor(x * 1e8 + 1e-6) / 1e8


def tick_size(price):
    for lo, t in KRW_TICKS:
        if price >= lo:
            return t
    return KRW_TICKS[-1][1]


def _tick_decimals(t):
    s = f"{t:.8f}".rstrip("0")
    return len(s.split(".")[1]) if "." in s else 0


def round_tick(price):
    """표시용: 호가단위로 반올림 (계산은 원값 유지)"""
    t = tick_size(price)
    return round(round(price / t) * t, 8)


def fmt_price(p):
    """호가단위로 반올림해 그 자릿수까지 표기"""
    if p is None:
        return "-"
    t = tick_size(p)
    return f"{round_tick(p):,.{_tick_decimals(t)}f}"


def fmt_won(x):
    return f"{x:,.0f}"


def fmt_signed(x):
    v = round(x)
    return f"{'+' if v >= 0 else '-'}{abs(v):,.0f}"


def fmt_qty(q, short=False):
    if short and q >= 1:
        return f"{q:,.2f}"
    s = f"{q:,.8f}".rstrip("0").rstrip(".")
    return s or "0"


def symbol(market):
    return market.split("-", 1)[1]


def fit_message(lines, droppable=()):
    """카톡 200자 제한: 넘으면 droppable 줄부터 빼고, 그래도 넘으면 자르되 꼬리말은 유지"""
    lines = list(lines)
    msg = "\n".join(lines)
    for d in droppable:
        if len(msg) <= KAKAO_LIMIT:
            break
        lines = [ln for ln in lines if not ln.startswith(d)]
        msg = "\n".join(lines)
    if len(msg) > KAKAO_LIMIT:
        body = "\n".join(lines[:-1])[:KAKAO_LIMIT - len(lines[-1]) - 2] + "…"
        msg = body + "\n" + lines[-1]
    return msg


# ───────────────────────── 시세 조회 (공개 API만) ─────────────────────────
class UpbitPublic:
    """업비트 공개 시세 API. 주문·계좌 기능 없음."""

    def __init__(self, delay=C.REQUEST_DELAY):
        self.delay = delay
        self.session = requests.Session()
        self.names = {}

    def _get(self, path, params=None, retries=5):
        url = f"{API}{path}"
        for attempt in range(retries):
            time.sleep(self.delay)
            try:
                r = self.session.get(url, params=params, timeout=10)
            except requests.RequestException as e:
                if attempt == retries - 1:
                    raise
                print(f"  네트워크 오류, 재시도: {e}")
                time.sleep(1 + attempt)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                wait = 0.5 * (2 ** attempt)
                print(f"  {r.status_code} 응답({path}), {wait:.1f}초 후 재시도")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"요청 실패(재시도 초과): {path}")

    def get_universe(self):
        """KRW 마켓 중 유의/주의 종목, EXCLUDE 제외 → (후보 목록, 제외된 목록)"""
        markets = self._get("/market/all", {"isDetails": "true"})
        ok, flagged = [], []
        for m in markets:
            code = m["market"]
            if not code.startswith("KRW-"):
                continue
            self.names[code] = m.get("korean_name", code)
            if code in C.EXCLUDE:
                continue
            ev = m.get("market_event") or {}
            caution = ev.get("caution") or {}
            # 실제 응답: market_event.warning(bool) = 투자유의,
            #           market_event.caution = {PRICE_FLUCTUATIONS: bool, ...} = 투자주의(하나라도 True면 주의)
            # 구버전 필드 market_warning("CAUTION")도 혹시 오면 제외
            warned = (bool(ev.get("warning"))
                      or (isinstance(caution, dict) and any(caution.values()))
                      or m.get("market_warning") not in (None, "NONE"))
            (flagged if warned else ok).append(code)
        return ok, flagged

    def get_tickers(self, markets):
        """{market: ticker dict}"""
        out = {}
        markets = list(dict.fromkeys(markets))
        for i in range(0, len(markets), 100):
            chunk = markets[i:i + 100]
            for t in self._get("/ticker", {"markets": ",".join(chunk)}):
                out[t["market"]] = t
        return out

    def get_orderbooks(self, markets):
        """{market: orderbook_units 리스트}  (ask_price/ask_size/bid_price/bid_size)"""
        out = {}
        markets = list(dict.fromkeys(markets))
        for i in range(0, len(markets), 20):
            chunk = markets[i:i + 20]
            for ob in self._get("/orderbook", {"markets": ",".join(chunk)}):
                out[ob["market"]] = ob.get("orderbook_units") or []
        return out

    def get_candles(self, market, now=None):
        """60분봉 → 시간순(오래된→최신) DataFrame, '완성된 봉'만 남김"""
        data = self._get("/candles/minutes/60", {"market": market, "count": C.CANDLE_COUNT})
        return candles_to_df(data, now)


def candles_to_df(data, now=None):
    df = pd.DataFrame(data)
    if df.empty:
        return df
    df["start_utc"] = pd.to_datetime(df["candle_date_time_utc"]).dt.tz_localize("UTC")
    df = df.sort_values("start_utc").reset_index(drop=True)
    df = df.rename(columns={"trade_price": "close", "candle_acc_trade_volume": "volume",
                            "opening_price": "open", "high_price": "high", "low_price": "low"})
    for col in ("open", "high", "low"):  # 시가·고가·저가가 없으면 종가로 채움
        if col not in df.columns:
            df[col] = df["close"]
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    # 진행 중인 봉(시작+1시간이 아직 안 지난 봉)은 버리고 완성봉만 사용
    cutoff = pd.Timestamp(now_utc - timedelta(hours=1))
    return df[df["start_utc"] <= cutoff].reset_index(drop=True)


# ───────────────────────── 지표·신호 ─────────────────────────
def rsi(close, period):
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100.0)


RULE_NAMES = {"cross": "상승전환", "pullback": "눌림목", "breakout": "돌파"}
RULE_SHORT = {"cross": "전환", "pullback": "눌림", "breakout": "돌파"}


def entry_score(rule, vol_x, rsi_v):
    """후보 점수 = 규칙 기본점 + min(거래량배수, 상한)×가중치 − |RSI−목표|/나눔수"""
    base = {"breakout": C.SCORE_BREAKOUT, "cross": C.SCORE_CROSS, "pullback": C.SCORE_PULLBACK}[rule]
    return base + min(vol_x, C.SCORE_VOL_CAP) * C.SCORE_VOL_WEIGHT - abs(rsi_v - C.RSI_TARGET) / C.SCORE_RSI_DIV


def analyze(df):
    """완성봉 DataFrame → 신호 dict (마지막 행 = 직전 완성봉)"""
    need = max(C.EMA_SLOW + C.CROSS_LOOKBACK + 2, C.EMA_SLOW + 5, C.BREAKOUT_LOOKBACK + 2)
    if df is None or len(df) < need:
        return {"ok": False, "why": f"봉 부족({0 if df is None else len(df)}개)"}
    close, vol = df["close"].astype(float), df["volume"].astype(float)
    opn = df["open"].astype(float) if "open" in df else close
    high = df["high"].astype(float) if "high" in df else close
    low = df["low"].astype(float) if "low" in df else close
    ef = close.ewm(span=C.EMA_FAST, adjust=False).mean()
    es = close.ewm(span=C.EMA_SLOW, adjust=False).mean()
    r = rsi(close, C.RSI_PERIOD)
    vavg = vol.rolling(C.VOLUME_AVG_BARS).mean()

    above = ef > es
    # i번째 봉에서 크로스: i봉 EMA20>EMA50 이고 i-1봉 EMA20<=EMA50
    cross = above & ~above.shift(1, fill_value=True)
    golden_now = bool(cross.iloc[-1])
    recent = cross.iloc[-C.CROSS_LOOKBACK:]
    recent_cross = bool(recent.any())
    cross_ago = (len(recent) - 1 - max(i for i, v in enumerate(recent) if v)) if recent_cross else None
    # 끝에서부터 EMA20>EMA50 연속 봉 수
    trend_bars = 0
    for v in reversed(above.tolist()):
        if not v:
            break
        trend_bars += 1

    s = {
        "ok": True,
        "bar_kst": df["start_utc"].iloc[-1].tz_convert(KST).strftime("%m-%d %H:00"),
        "close": float(close.iloc[-1]),
        "ema_fast": float(ef.iloc[-1]),
        "ema_slow": float(es.iloc[-1]),
        "rsi": float(r.iloc[-1]),
        "vol": float(vol.iloc[-1]),
        "vol_avg": float(vavg.iloc[-1]),
        "uptrend": bool(above.iloc[-1]),
        "golden_now": golden_now,
        "recent_cross": recent_cross,
        "cross_ago": cross_ago,
        "trend_bars": trend_bars,
        "open": float(opn.iloc[-1]),
    }
    s["trend_broken"] = s["ema_fast"] < s["ema_slow"]
    rv = s["rsi"]
    vol_x = s["vol"] / s["vol_avg"] if s["vol_avg"] > 0 else 0.0
    s["vol_x"] = vol_x
    rules = {}

    # 1) 상승전환(cross): 기존 규칙 그대로
    trend_ok = golden_now or (recent_cross and s["uptrend"] and s["close"] > s["ema_fast"])
    rsi_ok = C.RSI_MIN <= rv <= C.RSI_MAX
    vol_ok = s["vol"] >= s["vol_avg"] * C.VOLUME_RATIO
    miss = []
    if not trend_ok:
        miss.append("크로스 없음" if not recent_cross else "크로스 후 약세")
    if not rsi_ok:
        miss.append(f"RSI {rv:.0f}")
    if not vol_ok:
        miss.append(f"거래량 {vol_x:.1f}배")
    ago_txt = "직전봉" if cross_ago == 0 else f"{cross_ago}봉 전"
    rules["cross"] = {"on": C.ENTRY_CROSS, "hit": bool(trend_ok and rsi_ok and vol_ok), "miss": miss,
                      "reason": f"상승전환: {ago_txt} 골든크로스, RSI {rv:.0f}, 거래량 {vol_x:.1f}배"}

    # 2) 눌림목(pullback): 상승추세 유지 중 EMA20 근처까지 내려왔다가 양봉 반등
    miss = []
    if trend_bars < C.PULLBACK_TREND_BARS:
        miss.append(f"추세 {trend_bars}봉")
    k = C.PULLBACK_TOUCH_BARS
    touched = bool((low.iloc[-k:] <= ef.iloc[-k:] * (1 + C.PULLBACK_TOUCH_PCT / 100)).any())
    if not touched:
        gap = float(((low.iloc[-k:] / ef.iloc[-k:]) - 1).min() * 100)
        miss.append(f"20일선 +{gap:.1f}%")
    if not s["close"] > s["ema_fast"]:
        miss.append("종가<20일선")
    if not s["close"] > s["open"]:
        miss.append("음봉")
    if not C.PULLBACK_RSI_MIN <= rv <= C.PULLBACK_RSI_MAX:
        miss.append(f"RSI {rv:.0f}")
    if not s["vol"] >= s["vol_avg"] * C.PULLBACK_VOLUME_RATIO:
        miss.append(f"거래량 {vol_x:.1f}배")
    rules["pullback"] = {"on": C.ENTRY_PULLBACK, "hit": not miss, "miss": miss,
                         "reason": f"눌림목: 상승추세 중 20일선 근처 반등, RSI {rv:.0f}, 거래량 {vol_x:.1f}배"}

    # 3) 돌파(breakout): 직전 완성봉 종가 > 그 이전 N봉 고가의 최고값
    n = C.BREAKOUT_LOOKBACK
    prev_high = float(high.iloc[-n - 1:-1].max())
    s["prev_high"] = prev_high
    miss = []
    if not s["close"] > prev_high:
        miss.append("고점 미돌파")
    if not s["vol"] >= s["vol_avg"] * C.BREAKOUT_VOLUME_RATIO:
        miss.append(f"거래량 {vol_x:.1f}배")
    if not rv <= C.BREAKOUT_RSI_MAX:
        miss.append(f"RSI {rv:.0f} 과열")
    if not s["uptrend"]:
        miss.append("하락추세")
    rules["breakout"] = {"on": C.ENTRY_BREAKOUT, "hit": not miss, "miss": miss,
                         "reason": f"돌파: 최근 {n}시간 고점 {fmt_price(prev_high)}원 돌파, 거래량 {vol_x:.1f}배, RSI {rv:.0f}"}

    for key, ru in rules.items():
        ru["score"] = round(entry_score(key, vol_x, rv), 2)
    s["rules"] = rules
    hits = [k2 for k2, ru in rules.items() if ru["on"] and ru["hit"]]
    s["buy"] = bool(hits)
    if hits:
        best = max(hits, key=lambda k2: rules[k2]["score"])
        s["entry"], s["score"], s["reason"] = best, rules[best]["score"], rules[best]["reason"]
    else:
        s["entry"], s["score"], s["reason"] = None, None, ""

    parts = []
    parts.append("골든크로스" if golden_now else ("최근크로스" if recent_cross else ("상승추세" if s["uptrend"] else "하락추세")))
    parts.append(f"RSI {rv:.0f}")
    parts.append(f"거래량 {vol_x:.1f}배" if s["vol_avg"] > 0 else "거래량 -")
    s["desc"] = ", ".join(parts)
    # 규칙별 해당(○)/미해당(✗ 이유)/꺼짐(-)
    s["rules_desc"] = " ".join(
        f"{RULE_SHORT[k2]}{'-' if not ru['on'] else ('○' if ru['hit'] else '✗(' + ','.join(ru['miss']) + ')')}"
        for k2, ru in rules.items())
    return s


# ───────────────────────── 호가창 체결 시뮬레이션 ─────────────────────────
def simulate_market_buy(units, krw):
    """
    업비트 시장가 매수(금액 지정) 흉내.
    krw = 이번에 쓸 원화(수수료 포함). 주문금액 A = floor(krw / (1+수수료율)).
    매도호가(ask) 낮은 가격부터 소진. 각 단계 수량은 소수 8자리 내림.
    호가창이 모자라면 마지막 호가로 나머지 체결(warn=True).
    """
    order_krw = math.floor(krw / (1 + C.FEE_RATE))
    asks = sorted(((float(u["ask_price"]), float(u["ask_size"])) for u in units if u.get("ask_price")),
                  key=lambda x: x[0])
    fills, funds, warn = [], 0.0, False
    remaining = float(order_krw)
    exhausted = bool(asks)  # 호가창 전 단계를 다 먹고도 돈이 남았는지
    for p, size in asks:
        take = min(size, floor8(remaining / p))
        if take <= 0:          # 남은 돈으로 0.00000001개도 못 삼 → 끝
            exhausted = False
            break
        fills.append((p, take))
        funds += p * take
        remaining = order_krw - funds
        if take < size:        # 이 단계에서 주문금액을 다 씀
            exhausted = False
            break
    if exhausted and remaining > 0:
        p = asks[-1][0]
        take = floor8(remaining / p)
        if take > 0:
            fills.append((p, take))
            funds += p * take
            warn = True
    qty = floor8(sum(q for _, q in fills))
    fee = funds * C.FEE_RATE
    return {
        "order_krw": order_krw, "qty": qty, "funds": funds, "fee": fee,
        "avg_price": funds / qty if qty > 0 else 0.0, "levels": len(fills), "fills": fills, "warn": warn,
    }


def simulate_market_sell(units, qty):
    """
    업비트 시장가 매도(수량 지정) 흉내. 매수호가(bid) 높은 가격부터 소진.
    호가창이 모자라면 마지막 호가로 나머지 체결(warn=True).
    """
    bids = sorted(((float(u["bid_price"]), float(u["bid_size"])) for u in units if u.get("bid_price")),
                  key=lambda x: -x[0])
    fills, remain, warn = [], qty, False
    for p, size in bids:
        if remain <= 1e-12:
            break
        take = min(size, remain)
        fills.append((p, take))
        remain -= take
    if remain > 1e-12 and bids:
        fills.append((bids[-1][0], remain))
        warn = True
    funds = sum(p * q for p, q in fills)
    fee = funds * C.FEE_RATE
    return {
        "qty": qty, "funds": funds, "fee": fee, "proceeds": funds - fee,
        "avg_price": funds / qty if qty > 0 else 0.0, "levels": len(fills), "fills": fills, "warn": warn,
    }


def best_bid(units):
    bids = [float(u["bid_price"]) for u in units or [] if u.get("bid_price")]
    return max(bids) if bids else None


# ───────────────────────── 상태 파일 ─────────────────────────
def new_state():
    return {
        "cash": float(C.INITIAL_CASH),
        "initial_cash": float(C.INITIAL_CASH),
        "positions": {},
        "halted": False,
        "halted_at": None,
        "trade_day": None,
        "trades_today": 0,
        "last_summary_date": None,
        "realized_pnl": 0.0,
        "total_fees": 0.0,
        "total_trades": 0,
        "buy_count": 0,
        "sell_count": 0,
        "win_count": 0,
        "equity_history": [],
        "last_publish_at": None,
        "created": now_kst().isoformat(timespec="seconds"),
    }


def load_state():
    if not os.path.exists(STATE_PATH):
        return new_state()
    with open(STATE_PATH, encoding="utf-8") as f:
        st = json.load(f)
    base = new_state()
    base.update(st)
    return base


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE_PATH)


def log_trade(row):
    new = not os.path.exists(TRADES_PATH)
    with open(TRADES_PATH, "a", encoding="utf-8-sig" if new else "utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=TRADE_FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)


def read_trades():
    if not os.path.exists(TRADES_PATH):
        return []
    with open(TRADES_PATH, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


# ───────────────────────── 알림 ─────────────────────────
def trade_link(no):
    """카톡 '자세히 보기' → 대시보드의 해당 거래 상세 카드로 바로 이동"""
    return f"{C.DASHBOARD_URL}#t{no}"


class Notifier:
    """사이클 동안 메시지를 모아뒀다가, 대시보드가 게시된 뒤 flush()에서 보낸다.
    (먼저 보내면 링크를 눌렀을 때 페이지에 아직 그 거래가 없을 수 있음)"""

    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.sent = []
        self.queue = []

    def __call__(self, msg, link=None):
        msg = msg[:KAKAO_LIMIT]
        self.sent.append(msg)
        self.queue.append((msg, link or C.DASHBOARD_URL))
        print("─" * 30)
        print(("[카톡 미전송/dry-run]\n" if self.dry_run else "[카톡 대기]\n") + msg + f"\n(링크 {link or C.DASHBOARD_URL})")
        print("─" * 30)

    def flush(self):
        queue, self.queue = self.queue, []
        if self.dry_run or not queue:
            return
        try:
            import kakao_sender
        except Exception as e:
            print(f"  카톡 모듈 로드 실패: {e}")
            return
        for msg, link in queue:
            try:
                kakao_sender.send_text(msg, link=link)
            except Exception as e:  # 카톡 실패해도 매매 기록은 유지
                print(f"  카톡 전송 실패: {e}")
        print(f"[카톡] {len(queue)}건 전송")


# ───────────────────────── 평가·매매 ─────────────────────────
def liquidation_value(pos, bid):
    """지금 팔면 손에 쥐는 금액 = 수량 × 최우선 매수호가 × (1-수수료)"""
    return pos["qty"] * bid * (1 - C.FEE_RATE)


def equity(state, bids):
    total = state["cash"]
    for m, p in state["positions"].items():
        total += liquidation_value(p, bids.get(m) or p["entry_price"])
    return total


def unrealized(state, bids):
    return sum(liquidation_value(p, bids.get(m) or p["entry_price"]) - p["cost"]
               for m, p in state["positions"].items())


def reset_day(state, now):
    d = now.strftime("%Y-%m-%d")
    if state.get("trade_day") != d:
        state["trade_day"] = d
        state["trades_today"] = 0


def can_trade(state):
    return state["trades_today"] < C.MAX_TRADES_PER_DAY


def buy_budget(state, bids):
    """이번 매수에 쓸 원화(수수료 포함) = min(총평가 × POSITION_PCT, 현금)"""
    return min(equity(state, bids) * C.POSITION_PCT, state["cash"])


def stop_target(entry_price):
    return entry_price * (1 + C.STOP_LOSS_PCT / 100), entry_price * (1 + C.TAKE_PROFIT_PCT / 100)


def do_buy(state, market, name, units, budget, sig, now, notify):
    f = simulate_market_buy(units, budget)
    if f["qty"] <= 0 or f["order_krw"] < C.MIN_ORDER_KRW:
        return None
    cost = f["funds"] + f["fee"]
    if cost > state["cash"] + 1e-6:
        return None
    state["cash"] -= cost
    state["total_fees"] += f["fee"]
    state["positions"][market] = {
        "name": name, "qty": f["qty"], "entry_price": f["avg_price"],
        "buy_amount": f["funds"], "buy_fee": f["fee"], "cost": cost,
        "entry_time": now.isoformat(timespec="seconds"),
    }
    state["trades_today"] += 1
    state["total_trades"] += 1
    state["buy_count"] += 1
    note = "호가창 부족: 나머지는 마지막 호가로 체결" if f["warn"] else ""
    if note:
        print(f"  ⚠ {market} {note}")
    sl, tp = stop_target(f["avg_price"])
    no = state["total_trades"]
    log_trade({
        "번호": no, "시각": now.strftime("%Y-%m-%d %H:%M:%S"), "종목": market, "이름": name, "구분": "매수",
        "사유": sig.get("reason", ""), "평균체결가": round(f["avg_price"], 8), "수량": f["qty"],
        "체결금액": round(f["funds"], 2), "수수료": round(f["fee"], 2), "현금변화": round(-cost, 2),
        "손익": "", "손익률(%)": "", "거래후현금": round(state["cash"], 2),
        "손절가": round(sl, 8), "목표가": round(tp, 8), "매수가": "", "보유시간": "", "비고": note,
    })
    save_state(state)
    notify(fit_message([
        f"[모의매수] {symbol(market)}",
        f"{fmt_won(cost)}원어치 (평균 {fmt_price(f['avg_price'])}원)",
        "▶ '자세히 보기'에서 체결·수수료·손절/목표 확인",
        FOOTER,
    ]), link=trade_link(no))
    return f


def do_sell(state, market, units, reason, now, notify, counts=True):
    pos = state["positions"][market]
    f = simulate_market_sell(units, pos["qty"])
    pnl = f["proceeds"] - pos["cost"]
    pnl_pct = pnl / pos["cost"] * 100
    state["cash"] += f["proceeds"]
    state["realized_pnl"] += pnl
    state["total_fees"] += f["fee"]
    del state["positions"][market]
    if counts:
        state["trades_today"] += 1
    state["total_trades"] += 1
    state["sell_count"] += 1
    if pnl > 0:
        state["win_count"] += 1
    note = "호가창 부족: 나머지는 마지막 호가로 체결" if f["warn"] else ""
    if note:
        print(f"  ⚠ {market} {note}")
    try:
        held_h = (now - datetime.fromisoformat(pos["entry_time"])).total_seconds() / 3600
        held_txt = f"{held_h:.1f}시간"
    except Exception:
        held_txt = ""
    no = state["total_trades"]
    log_trade({
        "번호": no, "시각": now.strftime("%Y-%m-%d %H:%M:%S"), "종목": market, "이름": pos["name"], "구분": "매도",
        "사유": reason, "평균체결가": round(f["avg_price"], 8), "수량": pos["qty"],
        "체결금액": round(f["funds"], 2), "수수료": round(f["fee"], 2), "현금변화": round(f["proceeds"], 2),
        "손익": round(pnl, 2), "손익률(%)": round(pnl_pct, 2), "거래후현금": round(state["cash"], 2),
        "손절가": "", "목표가": "", "매수가": round(pos["entry_price"], 8), "보유시간": held_txt, "비고": note,
    })
    save_state(state)
    notify(fit_message([
        f"[모의매도·{reason}] {symbol(market)}",
        f"손익 {fmt_signed(pnl)}원({pnl_pct:+.2f}%)",
        "▶ '자세히 보기'에서 체결·수수료·입금액 확인",
        FOOTER,
    ]), link=trade_link(no))
    return pnl


def check_loss_limit(state, books, bids, now, notify):
    if C.LOSS_LIMIT is None:
        return False
    floor_value = C.INITIAL_CASH - C.LOSS_LIMIT
    eq = equity(state, bids)
    if eq > floor_value:
        return False
    print(f"!! 손실한도 도달: 평가 {fmt_won(eq)}원 ≤ {fmt_won(floor_value)}원 → 전량 정리 후 정지")
    for m in list(state["positions"]):
        if books.get(m):
            do_sell(state, m, books[m], "손실한도", now, notify, counts=False)
    state["halted"] = True
    state["halted_at"] = now.isoformat(timespec="seconds")
    save_state(state)
    notify(fit_message([
        "[모의투자 정지] 손실한도 도달",
        f"평가 {fmt_won(equity(state, bids))}원 (시작 {fmt_won(C.INITIAL_CASH)}원)",
        f"누적손익 {fmt_signed(equity(state, bids) - C.INITIAL_CASH)}원",
        "재개하려면 paper_state.json 삭제",
        FOOTER,
    ]))
    return True


def record_equity(state, bids, now):
    eq = equity(state, bids)
    hist = state.setdefault("equity_history", [])
    hist.append({"t": now.isoformat(timespec="seconds"), "eq": round(eq, 2)})
    if len(hist) > C.EQUITY_HISTORY_MAX:
        del hist[:len(hist) - C.EQUITY_HISTORY_MAX]
    return eq


# ───────────────────────── 1사이클 ─────────────────────────
def run_cycle(state, api, now, notify):
    """state를 갱신하며 1사이클 수행. 출력용 리포트 dict 반환."""
    report = {"universe": [], "signals": {}, "actions": [], "flagged": [], "prices": {}, "bids": {},
              "traded": False, "summary_sent": False}
    if state.get("halted"):
        print(f"정지 상태입니다({state.get('halted_at')}). 아무것도 하지 않습니다.")
        print(f"재개하려면 {STATE_PATH} 파일을 삭제하세요(초기 자금으로 새로 시작).")
        report["halted"] = True
        return report

    reset_day(state, now)
    candidates, flagged = api.get_universe()
    report["flagged"] = flagged
    held = list(state["positions"])
    tickers = api.get_tickers(candidates + held)
    names = getattr(api, "names", {})

    ranked = sorted((m for m in candidates if m in tickers),
                    key=lambda m: tickers[m].get("acc_trade_price_24h", 0), reverse=True)
    universe = ranked[:C.UNIVERSE_SIZE]
    report["universe"] = universe
    prices = {m: float(t["trade_price"]) for m, t in tickers.items()}
    report["prices"] = prices

    # 보유 종목 호가창 → 최우선 매수호가(평가·매도 판단 기준)
    books = api.get_orderbooks(held) if held else {}
    bids = {m: best_bid(u) for m, u in books.items() if best_bid(u)}
    report["bids"] = bids

    # 캔들/신호 (유니버스 + 보유 종목)
    sigs, dfs = {}, {}
    for m in dict.fromkeys(universe + held):
        try:
            dfs[m] = api.get_candles(m, now)
            sigs[m] = analyze(dfs[m])
        except Exception as e:
            sigs[m] = {"ok": False, "why": f"캔들 오류: {e}"}
    report["signals"] = sigs
    report["candles"] = {}  # 대시보드 코인 차트용(사이클 끝에 보유 중인 종목만, 추가 API 호출 없음)

    # 1) 손실한도 (LOSS_LIMIT=None 이면 꺼짐)
    if check_loss_limit(state, books, bids, now, notify):
        report["halted"] = report["traded"] = True
        return report

    # 2) 보유 종목 매도 판단 (최우선 매수호가 vs 평균체결가)
    for m in held:
        pos = state["positions"][m]
        bid = bids.get(m)
        if not bid:
            print(f"  {m}: 호가창 없음 → 매도 판단 보류")
            continue
        ret = (bid / pos["entry_price"] - 1) * 100
        hours = (now - datetime.fromisoformat(pos["entry_time"])).total_seconds() / 3600
        s = sigs.get(m, {})
        reason = None
        if ret <= C.STOP_LOSS_PCT:
            reason = "손절"
        elif ret >= C.TAKE_PROFIT_PCT:
            reason = "익절"
        elif s.get("ok") and s.get("trend_broken"):
            reason = "추세이탈"
        elif hours >= C.MAX_HOLD_HOURS:
            reason = "기간만료"
        if not reason:
            report["actions"].append(f"보유 {m} {ret:+.2f}% {hours:.0f}h")
            continue
        # 매도는 거래한도와 무관하게 항상 실행(따라하는 사람이 목표가·손절가를 놓치지 않게). 횟수에는 포함.
        pnl = do_sell(state, m, books[m], reason, now, notify, counts=True)
        bids.pop(m, None)
        report["traded"] = True
        report["actions"].append(f"매도 {m} {reason} {fmt_signed(pnl)}원")

    # 매도 후 다시 손실한도 확인
    if check_loss_limit(state, books, bids, now, notify):
        report["halted"] = report["traded"] = True
        return report

    # 3) 매수 판단
    buys = [m for m in universe
            if m not in state["positions"] and sigs.get(m, {}).get("ok") and sigs[m]["buy"]]
    buys.sort(key=lambda m: -sigs[m]["score"])  # 점수 높은 순 (같으면 거래대금 순 유지)
    for m in buys:
        if len(state["positions"]) >= C.MAX_POSITIONS:
            report["actions"].append(f"매수후보 {m} - 자리 없음")
            continue
        if not can_trade(state):
            report["actions"].append(f"매수후보 {m} - 오늘 거래한도")
            continue
        budget = buy_budget(state, bids)
        if math.floor(budget / (1 + C.FEE_RATE)) < C.MIN_ORDER_KRW:
            report["actions"].append(f"매수후보 {m} - 현금 부족(최소주문 {fmt_won(C.MIN_ORDER_KRW)}원 미만)")
            continue
        units = api.get_orderbooks([m]).get(m)
        if not units:
            report["actions"].append(f"매수후보 {m} - 호가창 없음")
            continue
        s = sigs[m]  # s["reason"]은 analyze()가 고른 규칙의 설명(예: "돌파: 최근 24시간 고점 …")
        f = do_buy(state, m, names.get(m, symbol(m)), units, budget, s, now, notify)
        if f:
            bids[m] = best_bid(units)
            report["traded"] = True
            report["actions"].append(f"매수 {m} 평균 {fmt_price(f['avg_price'])} × {fmt_qty(f['qty'])} "
                                     f"(체결 {fmt_won(f['funds'])}원+수수료 {fmt_won(f['fee'])}원, {f['levels']}단계) "
                                     f"[{s['reason']} / 점수 {s['score']:.2f}]")

    # 4) 하루 1번 요약
    today = now.strftime("%Y-%m-%d")
    if state.get("last_summary_date") != today and now.hour >= C.DAILY_SUMMARY_HOUR:
        state["last_summary_date"] = today
        eq = equity(state, bids)
        held_txt = ", ".join(
            f"{symbol(m)} {((bids.get(m) or p['entry_price']) / p['entry_price'] - 1) * 100:+.1f}%"
            for m, p in state["positions"].items()) or "없음"
        notify(fit_message([
            f"[모의투자 하루요약] {now.strftime('%m/%d')}",
            f"총평가 {fmt_won(eq)}원",
            f"누적손익 {fmt_signed(eq - C.INITIAL_CASH)}원({(eq / C.INITIAL_CASH - 1) * 100:+.2f}%)",
            f"누적수수료 {fmt_won(state['total_fees'])}원",
            f"오늘 거래 {state['trades_today']}회",
            f"보유 {held_txt}",
            FOOTER,
        ], droppable=("누적수수료",)))
        report["summary_sent"] = True

    record_equity(state, bids, now)
    save_state(state)
    report["candles"] = {m: candle_rows(dfs.get(m)) for m in state["positions"] if m in dfs}
    return report


# ───────────────────────── 대시보드 HTML ─────────────────────────
CSS = """
:root { --bg:#f5f6f8; --card-bg:#ffffff; --text:#1a1d23; --sub-text:#6b7280; --border:#e5e7eb;
  --up:#d64545; --down:#2f6fed; --flat:#6b7280; --accent:#2563eb; --accent-bg:#eef2ff;
  --warn-bg:#fff7ed; --warn-border:#fed7aa; --warn-text:#9a3412; --up-bg:#fdecec; --down-bg:#e8f0fe; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg:#111318; --card-bg:#1b1e26; --text:#e8eaed; --sub-text:#9aa0a6; --border:#2b2f3a;
    --up:#ff6b6b; --down:#5b9dff; --flat:#9aa0a6; --accent:#7c9dff; --accent-bg:#1e2436;
    --warn-bg:#2a2115; --warn-border:#4d3418; --warn-text:#f4b473; --up-bg:#3a1f22; --down-bg:#1c2a44; }
}
:root[data-theme="dark"] { --bg:#111318; --card-bg:#1b1e26; --text:#e8eaed; --sub-text:#9aa0a6; --border:#2b2f3a;
  --up:#ff6b6b; --down:#5b9dff; --flat:#9aa0a6; --accent:#7c9dff; --accent-bg:#1e2436;
  --warn-bg:#2a2115; --warn-border:#4d3418; --warn-text:#f4b473; --up-bg:#3a1f22; --down-bg:#1c2a44; }
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,"Pretendard","Malgun Gothic",sans-serif; background:var(--bg); color:var(--text); }
.wrap { max-width:980px; margin:0 auto; padding:16px 16px 60px; }
.mock { background:var(--warn-bg); border:1px solid var(--warn-border); color:var(--warn-text);
  padding:8px 12px; border-radius:10px; font-size:13px; font-weight:700; margin-bottom:14px; text-align:center; }
.header-row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
h1 { font-size:21px; margin:0 0 4px; }
.date { color:var(--sub-text); font-size:13px; }
.refresh-btn { background:var(--accent-bg); color:var(--accent); border:1px solid var(--accent); border-radius:10px;
  padding:8px 14px; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
.refresh-btn[disabled] { opacity:.5; cursor:default; }
.refresh-status { font-size:12px; color:var(--sub-text); margin-top:6px; min-height:16px; }
h2.section { font-size:16px; margin:26px 0 12px; padding-bottom:6px; border-bottom:2px solid var(--border); }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
.card { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
.card .label { font-size:12px; color:var(--sub-text); }
.card .value { font-size:18px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }
.card .value small { font-size:13px; font-weight:600; }
.card.hero { grid-column:1/-1; }
.card.hero .value { font-size:26px; }
.up { color:var(--up); } .down { color:var(--down); } .flat { color:var(--flat); }
.table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; background:var(--card-bg);
  border:1px solid var(--border); border-radius:12px; }
table { border-collapse:collapse; width:100%; font-size:13px; white-space:nowrap; font-variant-numeric:tabular-nums; }
th, td { padding:8px 10px; border-bottom:1px solid var(--border); text-align:right; }
th { font-size:12px; color:var(--sub-text); font-weight:600; background:var(--bg); position:sticky; top:0; }
td.l, th.l { text-align:left; }
tr:last-child td { border-bottom:none; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:700; }
.badge.buy { background:var(--up-bg); color:var(--up); }
.badge.sell { background:var(--down-bg); color:var(--down); }
.empty { color:var(--sub-text); font-size:13px; padding:16px; text-align:center; }
.tcard { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:14px 16px;
  margin-bottom:10px; scroll-margin-top:12px; }
.tcard:target { border:2px solid var(--accent); box-shadow:0 0 0 4px var(--accent-bg); }
.tcard .thead { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
.tcard .ttitle { font-weight:700; font-size:15px; }
.tcard dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0; font-size:13px; }
.tcard dt { color:var(--sub-text); }
.tcard dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
.tcard .reason { margin-top:10px; font-size:12px; color:var(--sub-text); line-height:1.5; }
tr.tlink { cursor:pointer; }
.sub { color:var(--sub-text); font-size:11px; }
.chart { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:10px; }
.chart svg { width:100%; height:auto; display:block; }
.note { color:var(--sub-text); font-size:12px; line-height:1.6; margin-top:10px; }
.flash { animation:flash-bg .8s ease; }
@keyframes flash-bg { 0% { background:var(--accent-bg); } 100% { background:transparent; } }
footer { margin-top:30px; font-size:12px; color:var(--sub-text); text-align:center; }
/* ── 그래프 ── 코인 고유색(--c1~4)은 상승·하락 빨강/파랑과 겹치지 않게 보라·청록·노랑·분홍 (색약 검사 통과) */
:root { --c1:#6250d6; --c2:#1baf7a; --c3:#eda100; --c4:#e87ba4; --c-other:#8a8f98; --cash:#b9bec7; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --c1:#9085e9; --c2:#199e70; --c3:#c98500; --c4:#d55181; --c-other:#7d838f; --cash:#5c6270; }
}
:root[data-theme="dark"] { --c1:#9085e9; --c2:#199e70; --c3:#c98500; --c4:#d55181; --c-other:#7d838f; --cash:#5c6270; }
.viz { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:12px; min-width:0; }
.viz-title { font-size:14px; font-weight:700; margin:0 0 8px; }
.viz-plot { position:relative; min-height:60px; transition:opacity .2s; }
.viz-plot.loading { opacity:.55; }
.viz-plot svg { display:block; max-width:100%; overflow:visible; touch-action:pan-y; -webkit-tap-highlight-color:transparent; }
.viz-plot svg:focus { outline:none; }
.viz-plot svg:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
.viz-plot svg text { font-size:11px; fill:var(--sub-text); font-family:inherit; font-variant-numeric:tabular-nums; pointer-events:none; }
.g-grid { stroke:var(--border); stroke-width:1; }
.g-base { stroke:var(--sub-text); stroke-width:1; opacity:.7; }
.a-up { fill:var(--up); opacity:.12; } .a-down { fill:var(--down); opacity:.12; }
.l-up, .l-down { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
.l-up { stroke:var(--up); } .l-down { stroke:var(--down); }
.f-up { fill:var(--up); } .f-down { fill:var(--down); } .f-ink { fill:var(--text); }
.ring { stroke:var(--card-bg); stroke-width:2; paint-order:stroke; }
.wk-up { stroke:var(--up); stroke-width:1; } .wk-down { stroke:var(--down); stroke-width:1; }
.xhair { stroke:var(--sub-text); stroke-width:1; opacity:.6; pointer-events:none; }
.lv { stroke-width:1.25; fill:none; pointer-events:none; }
.lv.lv-avg { stroke:var(--flat); } .lv.lv-sl { stroke:var(--down); stroke-dasharray:5 4; }
.lv.lv-tp { stroke:var(--up); stroke-dasharray:5 4; } .lv.lv-cur { stroke:var(--text); opacity:.35; }
.leader { stroke:var(--sub-text); stroke-width:1; fill:none; opacity:.6; }
.viz-plot svg text.lv-cur { fill:var(--text); font-weight:700; }
.viz-plot svg text.t-name { fill:var(--text); font-size:12px; font-weight:700; }
.viz-plot svg text.t-val { fill:var(--text); font-size:12px; font-weight:600; }
.viz-plot svg text.t-big { fill:var(--text); font-size:16px; font-weight:700; }
.viz-plot svg text.t-cnt { font-size:10px; }
.hit { cursor:crosshair; } .hitrow { cursor:pointer; }
.slice { cursor:pointer; transition:opacity .15s; } .slice.on, .bar.on { opacity:.78; }
.viz-tip { position:absolute; z-index:5; pointer-events:none; background:var(--card-bg); color:var(--text);
  border:1px solid var(--border); border-radius:8px; padding:6px 9px; font-size:12px; line-height:1.5;
  box-shadow:0 4px 14px rgba(0,0,0,.14); white-space:nowrap; }
.viz-tip[hidden] { display:none; }
.viz-tip .h { color:var(--sub-text); font-size:11px; }
.viz-tip .r { display:flex; align-items:center; gap:6px; }
.viz-tip b { font-variant-numeric:tabular-nums; }
.viz-tip .r span { color:var(--sub-text); }
.viz-tip .k { width:10px; height:3px; border-radius:2px; display:inline-block; }
.ccards { display:grid; gap:12px; }
.chead { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
.chead .sym { font-weight:700; font-size:15px; }
.chead .cprice { margin-left:auto; font-weight:700; font-size:16px; }
.chead .cret { font-weight:700; font-size:13px; }
.cstats { display:flex; gap:6px 14px; flex-wrap:wrap; font-size:12px; color:var(--sub-text); margin:4px 0 8px; }
.cstats b { color:var(--text); font-variant-numeric:tabular-nums; }
.swatch { width:10px; height:10px; border-radius:3px; display:inline-block; flex:none; align-self:center; }
.vlegend { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:12px; color:var(--sub-text); margin:-4px 0 10px; }
.vlegend span { display:inline-flex; align-items:center; gap:5px; }
.lk { display:inline-block; width:18px; height:0; border-top:2px solid var(--flat); }
.lk.lk-sl { border-top:2px dashed var(--down); } .lk.lk-tp { border-top:2px dashed var(--up); }
.duo { display:grid; gap:12px; }
@media (min-width:720px) { .duo { grid-template-columns:1fr 1fr; } }
.alloc-wrap { display:flex; align-items:center; gap:14px 18px; flex-wrap:wrap; justify-content:center; }
.alloc-legend { flex:1 1 170px; list-style:none; margin:0; padding:0; font-size:13px; min-width:0; }
.alloc-legend li { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); }
.alloc-legend li:last-child { border-bottom:none; }
.alloc-legend .nm { font-weight:600; }
.alloc-legend b { margin-left:auto; font-variant-numeric:tabular-nums; }
.alloc-legend .amt { color:var(--sub-text); font-size:12px; min-width:84px; text-align:right; font-variant-numeric:tabular-nums; }
"""

JS = r"""
(function(){
  var D = JSON.parse(document.getElementById('paper-data').textContent);
  D.candles = D.candles || {};
  var btn = document.getElementById('refresh-btn'), st = document.getElementById('refresh-status');
  var NS = 'http://www.w3.org/2000/svg', HOUR = 3600000, KST = 9 * HOUR;
  function won(x){ return Math.round(x).toLocaleString('ko-KR'); }
  function signed(x){ var v=Math.round(x); return (v>=0?'+':'-')+Math.abs(v).toLocaleString('ko-KR'); }
  function cls(x){ return x>0.5?'up':(x<-0.5?'down':'flat'); }
  function pcls(x){ return x>0.005?'up':(x<-0.005?'down':'flat'); }
  function pct(x){ return (x>=0?'+':'')+x.toFixed(2)+'%'; }
  function tick(p){ var T=D.ticks; for(var i=0;i<T.length;i++){ if(p>=T[i][0]) return T[i][1]; } return 1e-8; }
  function price(p){ var t=tick(p), d=0, s=t.toFixed(8).replace(/0+$/,''); if(s.indexOf('.')>=0) d=s.split('.')[1].length;
    return (Math.round(p/t)*t).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d}); }
  function set(id, txt, c, noflash){ var el=document.getElementById(id); if(!el) return; el.textContent=txt;
    if(c!==undefined && c!==null){ el.classList.remove('up','down','flat'); el.classList.add(c); }
    if(noflash) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  function hours(){ var now=Date.now(); D.pos.forEach(function(p,i){
    var h=(now-new Date(p.entry).getTime())/3600000; var el=document.getElementById('h'+i);
    if(el && h>=0) el.textContent=h.toFixed(1)+'시간'; }); }
  function curVal(p){ return p.qty*p.cur*(1-D.fee); }

  // ── 차트 공통 (라이브러리 없이 SVG 직접 그림) ──
  function E(parent, tag, attrs, text){ var e=document.createElementNS(NS, tag);
    if(attrs) for(var k in attrs) e.setAttribute(k, attrs[k]);
    if(text!==undefined && text!==null) e.textContent=text;
    if(parent) parent.appendChild(e); return e; }
  function clear(el){ while(el.firstChild) el.removeChild(el.firstChild); }
  function msg(plot, text){ clear(plot); var d=document.createElement('div'); d.className='empty'; d.textContent=text; plot.appendChild(d); }
  function mkSvg(plot, w, h, label){ var s=E(null,'svg',{viewBox:'0 0 '+w+' '+h, width:w, height:h, role:'img', 'aria-label':label}); plot.appendChild(s); return s; }
  function width(plot){ return Math.max(260, Math.floor(plot.clientWidth || 320)); }
  function textW(t){ var w=0; try{ w=t.getComputedTextLength(); }catch(e){} return w || t.textContent.length*7; }
  function man(v, step){ var d=step>=10000?0:(step>=1000?1:2);
    return (v/10000).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d})+'만'; }
  function niceStep(lo, hi, n){ var span=hi-lo; if(!(span>0)) span=Math.abs(hi)||1;
    var raw=span/Math.max(n,1), p=Math.pow(10, Math.floor(Math.log(raw)/Math.LN10)), f=raw/p;
    return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p; }
  function kd(t){ return new Date(t+KST); }
  function two(n){ return (n<10?'0':'')+n; }
  function tFull(t){ var d=kd(t); return (d.getUTCMonth()+1)+'/'+d.getUTCDate()+' '+two(d.getUTCHours())+':'+two(d.getUTCMinutes()); }
  function tTick(t, first){ var d=kd(t), h=d.getUTCHours(), mi=d.getUTCMinutes(), md=(d.getUTCMonth()+1)+'/'+d.getUTCDate();
    if(mi) return (first?md+' ':'')+two(h)+':'+two(mi);
    if(h===0) return md;
    return (first?md+' ':'')+h+'시'; }
  function timeTicks(t0, t1, maxN){ var steps=[1,2,3,6,12,24,48,96,168], s=steps[steps.length-1]*HOUR;
    for(var i=0;i<steps.length;i++){ if((t1-t0)/(steps[i]*HOUR) <= maxN){ s=steps[i]*HOUR; break; } }
    var out=[]; for(var t=Math.ceil((t0+KST)/s)*s-KST; t<=t1; t+=s) out.push(t);
    if(out.length<2) out = t1>t0 ? [t0, t1] : [t0];
    return out; }
  function xLabels(svg, ticks, xOf, y, L, R, W){ ticks.forEach(function(t, k){ var xx=xOf(t);
    var anc = xx<L+34 ? 'start' : (xx>W-R-34 ? 'end' : 'middle');
    E(svg,'text',{x:xx.toFixed(1), y:y, 'text-anchor':anc}, tTick(t, k===0)); }); }
  function tri(svg, cx, cy, up){ var s=5.5, d = up
      ? 'M'+cx+','+(cy-s)+' L'+(cx+s)+','+(cy+s*0.8)+' L'+(cx-s)+','+(cy+s*0.8)+' Z'
      : 'M'+cx+','+(cy+s)+' L'+(cx+s)+','+(cy-s*0.8)+' L'+(cx-s)+','+(cy-s*0.8)+' Z';
    return E(svg,'path',{d:d, 'class':(up?'f-up':'f-down')+' ring'}); }

  // 툴팁: 값(굵게) 먼저, 이름은 뒤에. 글자는 전부 textContent로 넣음(XSS 방지)
  var activeHide=null, activeEl=null;
  document.addEventListener('pointerdown', function(ev){ if(activeHide && activeEl && !activeEl.contains(ev.target)){ activeHide(); activeHide=null; } });
  function activate(h, el){ if(activeHide && activeHide!==h) activeHide(); activeHide=h; activeEl=el; }
  function addTip(plot){ var t=document.createElement('div'); t.className='viz-tip'; t.hidden=true; plot.appendChild(t); return t; }
  function showTip(tp, x, y, head, rows){ clear(tp);
    if(head){ var h=document.createElement('div'); h.className='h'; h.textContent=head; tp.appendChild(h); }
    rows.forEach(function(r){ var d=document.createElement('div'); d.className='r';
      if(r[3]){ var k=document.createElement('i'); k.className='k'; k.style.background=r[3]; d.appendChild(k); }
      var b=document.createElement('b'); b.textContent=r[0]; if(r[2]) b.className=r[2]; d.appendChild(b);
      if(r[1]){ var s=document.createElement('span'); s.textContent=r[1]; d.appendChild(s); }
      tp.appendChild(d); });
    tp.hidden=false;
    var pw=tp.parentNode.clientWidth, w=tp.offsetWidth, hh=tp.offsetHeight;
    var left=x+14; if(left+w>pw) left=x-14-w; if(left<0) left=Math.max(0, (pw-w)/2);
    var top=y-hh-12; if(top<0) top=y+16;
    tp.style.left=left+'px'; tp.style.top=top+'px'; }
  // 십자선 차트용: 가장 가까운 X로 스냅, 터치(탭/드래그)·마우스·키보드(←→) 모두 지원
  function hover(svg, plot, n, xOf, onIdx){
    var tp=addTip(plot), cur=-1, W=+svg.getAttribute('width'), H=+svg.getAttribute('height');
    var hit=E(svg,'rect',{x:0, y:0, width:W, height:H, fill:'transparent', 'class':'hit'});
    function nearest(px){ var best=0, bd=Infinity; for(var i=0;i<n;i++){ var d=Math.abs(xOf(i)-px); if(d<bd){ bd=d; best=i; } } return best; }
    function hide(){ tp.hidden=true; onIdx(-1); cur=-1; }
    function show(i){ activate(hide, svg); cur=i; var r=onIdx(i); showTip(tp, r.x, r.y, r.head, r.rows); }
    function px(ev){ var b=svg.getBoundingClientRect(); return (ev.clientX-b.left)*(W/(b.width||W)); }
    hit.addEventListener('pointermove', function(ev){ show(nearest(px(ev))); });
    hit.addEventListener('pointerdown', function(ev){ show(nearest(px(ev))); });
    hit.addEventListener('pointerleave', function(ev){ if(ev.pointerType==='mouse') hide(); });
    svg.setAttribute('tabindex','0');
    svg.addEventListener('keydown', function(ev){
      if(ev.key==='ArrowRight' || ev.key==='ArrowLeft'){ ev.preventDefault();
        var i = cur<0 ? n-1 : cur+(ev.key==='ArrowRight'?1:-1); show(Math.max(0, Math.min(n-1, i))); }
      else if(ev.key==='Escape') hide(); });
    svg.addEventListener('blur', hide); }

  // ① 자산 변화
  function drawEquity(){
    var plot=document.getElementById('eq-plot'); if(!plot) return;
    var P=D.eqh||[];
    if(!P.length){ msg(plot,'아직 기록이 없어요. 봇이 한 번 돌면 그래프가 생겨요.'); return; }
    clear(plot);
    var W=width(plot), H=W<520?220:260, L=48, R=14, T=14, B=26, yB=H-B;
    var t0=P[0][0], t1=P[P.length-1][0];
    if(t1-t0<HOUR){ var mid=(t0+t1)/2; t0=Math.min(t0, mid-HOUR/2); t1=Math.max(t1, mid+HOUR/2); }
    var lo=D.initial, hi=D.initial;
    P.forEach(function(p){ if(p[1]<lo) lo=p[1]; if(p[1]>hi) hi=p[1]; });
    var pad=Math.max((hi-lo)*0.12, D.initial*0.002); lo-=pad; hi+=pad;
    var step=niceStep(lo, hi, H<240?4:5); lo=Math.floor(lo/step)*step; hi=Math.ceil(hi/step)*step;
    function x(t){ return L+(t-t0)/(t1-t0)*(W-L-R); }
    function y(v){ return T+(hi-v)/(hi-lo)*(yB-T); }
    var last=P[P.length-1];
    var svg=mkSvg(plot, W, H, '총평가 변화: 시작 '+won(D.initial)+'원, 지금 '+won(last[1])+'원');
    for(var k=0; lo+k*step<=hi+step/2; k++){ var v=lo+k*step, yy=y(v);
      E(svg,'line',{x1:L, x2:W-R, y1:yy, y2:yy, 'class':'g-grid'});
      E(svg,'text',{x:L-6, y:yy+4, 'text-anchor':'end'}, man(v, step)); }
    var yb=y(D.initial), defs=E(svg,'defs');
    var cu=E(defs,'clipPath',{id:'eqcu'}); E(cu,'rect',{x:0, y:0, width:W, height:Math.max(0, yb)});
    var cd=E(defs,'clipPath',{id:'eqcd'}); E(cd,'rect',{x:0, y:yb, width:W, height:Math.max(0, H-yb)});
    var pts=P.map(function(p){ return x(p[0]).toFixed(1)+','+y(p[1]).toFixed(1); });
    if(P.length>1){
      var area='M'+x(P[0][0]).toFixed(1)+','+yb.toFixed(1)+' L'+pts.join(' L')+' L'+x(last[0]).toFixed(1)+','+yb.toFixed(1)+' Z';
      E(svg,'path',{d:area, 'class':'a-up', 'clip-path':'url(#eqcu)'});
      E(svg,'path',{d:area, 'class':'a-down', 'clip-path':'url(#eqcd)'}); }
    E(svg,'line',{x1:L, x2:W-R, y1:yb, y2:yb, 'class':'g-base'});
    E(svg,'text',{x:W-R, y:yb-5, 'text-anchor':'end'}, '시작 '+won(D.initial));
    if(P.length>1){ var line='M'+pts.join(' L');
      E(svg,'path',{d:line, 'class':'l-up', 'clip-path':'url(#eqcu)'});
      E(svg,'path',{d:line, 'class':'l-down', 'clip-path':'url(#eqcd)'}); }
    // 매수▲(점 아래)·매도▼(점 위), 같은 점에 여러 건이면 ×N
    var groups={}, byIdx={};
    (D.marks||[]).forEach(function(m){ if(!P[m.i]) return; var key=m.i+m.s; (groups[key]=groups[key]||{i:m.i, s:m.s, list:[]}).list.push(m); });
    Object.keys(groups).forEach(function(key){ var g=groups[key], up=g.s==='b', cx=x(P[g.i][0]), cy=y(P[g.i][1]);
      var my=Math.max(T+4, Math.min(yB-4, up?cy+12:cy-12));
      tri(svg, cx, my, up);
      if(g.list.length>1) E(svg,'text',{x:cx+8, y:my+4, 'class':'t-cnt'}, '×'+g.list.length);
      (byIdx[g.i]=byIdx[g.i]||[]).push(g); });
    E(svg,'circle',{cx:x(last[0]), cy:y(last[1]), r:4, 'class':(last[1]>=D.initial?'f-up':'f-down')+' ring'});
    xLabels(svg, timeTicks(P[0][0], last[0], Math.max(2, Math.floor((W-L-R)/80))), x, H-8, L, R, W);
    var xh=E(svg,'line',{y1:T, y2:yB, 'class':'xhair', visibility:'hidden'});
    var fd=E(svg,'circle',{r:4.5, 'class':'ring f-up', visibility:'hidden'});
    hover(svg, plot, P.length, function(i){ return x(P[i][0]); }, function(i){
      if(i<0){ xh.setAttribute('visibility','hidden'); fd.setAttribute('visibility','hidden'); return; }
      var p=P[i], xx=x(p[0]), yy=y(p[1]), g=p[1]-D.initial;
      xh.setAttribute('x1',xx); xh.setAttribute('x2',xx); xh.setAttribute('visibility','visible');
      fd.setAttribute('cx',xx); fd.setAttribute('cy',yy); fd.setAttribute('class','ring '+(g>=0?'f-up':'f-down')); fd.setAttribute('visibility','visible');
      var rows=[[won(p[1])+'원','총평가'], [signed(g)+'원 ('+pct(g/D.initial*100)+')','누적손익', cls(g)]];
      (byIdx[i]||[]).forEach(function(gr){ gr.list.forEach(function(m){
        rows.push([(m.s==='b'?'▲ 매수 ':'▼ 매도 ')+m.sym, '#'+m.no, m.s==='b'?'up':'down']); }); });
      return {x:xx, y:yy, head:tFull(p[0]), rows:rows}; });
  }

  // ② 보유 코인별 1시간봉 + 평균가/손절가/목표가
  function drawCandle(i){
    var p=D.pos[i], plot=document.getElementById('cplot'+i); if(!plot) return;
    var W=width(plot), all=D.candles[p.m]||[], C=all.slice(W<480?-48:-72);
    if(!C.length){ msg(plot,'캔들 데이터를 아직 못 받았어요. 🔄 실시간을 눌러 보세요.'); return; }
    clear(plot);
    var H=W<520?210:250, L=6, T=10, B=24, yB=H-B;
    var lv=[{v:p.tp, t:'목표', c:'lv-tp'}, {v:p.ep, t:'평균', c:'lv-avg'}, {v:p.sl, t:'손절', c:'lv-sl'}, {v:p.cur, t:'현재', c:'lv-cur'}];
    var svg=mkSvg(plot, W, H, p.sym+' 1시간봉 가격 차트 (현재 '+price(p.cur)+'원)');
    var labs=lv.map(function(l){ return E(svg,'text',{'class':'lv-t '+l.c}, l.t+' '+price(l.v)); });
    var lw=0; labs.forEach(function(t){ lw=Math.max(lw, textW(t)); });
    var R=Math.ceil(lw)+16;
    var lo=Infinity, hi=-Infinity;
    C.forEach(function(c){ lo=Math.min(lo, c[3]); hi=Math.max(hi, c[2]); });
    lv.forEach(function(l){ if(l.v>0){ lo=Math.min(lo, l.v); hi=Math.max(hi, l.v); } });
    var pad=(hi-lo)*0.06 || hi*0.01; lo-=pad; hi+=pad;
    var slot=(W-L-R)/C.length, bw=Math.max(1, Math.min(9, slot*0.62));
    function x(k){ return L+(k+0.5)*slot; }
    function y(v){ return T+(hi-v)/(hi-lo)*(yB-T); }
    lv.slice(0,3).forEach(function(l){ var yy=y(l.v); E(svg,'line',{x1:L, x2:W-R+2, y1:yy, y2:yy, 'class':'lv '+l.c}); });
    C.forEach(function(c, k){ var up=c[4]>=c[1], xx=x(k);
      E(svg,'line',{x1:xx, x2:xx, y1:y(c[2]), y2:y(c[3]), 'class':up?'wk-up':'wk-down'});
      var y1=y(Math.max(c[1], c[4])), y2=y(Math.min(c[1], c[4]));
      E(svg,'rect',{x:(xx-bw/2).toFixed(2), y:y1.toFixed(2), width:bw.toFixed(2), height:Math.max(1, y2-y1).toFixed(2), 'class':up?'f-up':'f-down'}); });
    // 현재가 점(오른쪽 끝)
    E(svg,'line',{x1:x(C.length-1), x2:W-R+2, y1:y(p.cur), y2:y(p.cur), 'class':'lv lv-cur'});
    E(svg,'circle',{cx:W-R+2, cy:y(p.cur), r:3.5, 'class':'f-ink ring'});
    // 오른쪽 라벨: 겹치면 아래로 밀고 짧은 연결선
    var ls=lv.map(function(l, j){ return {j:j, y:y(l.v)}; }).sort(function(a, b){ return a.y-b.y; }), gap=13;
    for(var k=1; k<ls.length; k++){ if(ls[k].y-ls[k-1].y<gap) ls[k].y=ls[k-1].y+gap; }
    if(ls[ls.length-1].y>yB){ ls[ls.length-1].y=yB; for(k=ls.length-2; k>=0; k--){ if(ls[k+1].y-ls[k].y<gap) ls[k].y=ls[k+1].y-gap; } }
    ls.forEach(function(o){ var t=labs[o.j], ly=y(lv[o.j].v);
      t.setAttribute('x', W-R+9); t.setAttribute('y', (o.y+4).toFixed(1));
      if(Math.abs(o.y-ly)>1.5) E(svg,'path',{d:'M'+(W-R+2)+','+ly.toFixed(1)+' L'+(W-R+7)+','+o.y.toFixed(1), 'class':'leader'}); });
    // 매수 시점 ▲
    var te=Date.parse(p.entry), bk=-1;
    for(k=0; k<C.length; k++){ if(te>=C[k][0] && te<C[k][0]+HOUR){ bk=k; break; } }
    if(bk>=0) tri(svg, x(bk), Math.min(yB-4, y(C[bk][3])+10), true);
    var c0=C[0][0];
    xLabels(svg, timeTicks(c0, C[C.length-1][0], Math.max(2, Math.floor((W-L-R)/80))),
      function(t){ return L+((t-c0)/HOUR+0.5)*slot; }, H-8, L, R, W);
    var xh=E(svg,'line',{y1:T, y2:yB, 'class':'xhair', visibility:'hidden'});
    hover(svg, plot, C.length, x, function(k){
      if(k<0){ xh.setAttribute('visibility','hidden'); return; }
      var c=C[k], xx=x(k), ch=(c[4]/c[1]-1)*100;
      xh.setAttribute('x1',xx); xh.setAttribute('x2',xx); xh.setAttribute('visibility','visible');
      var rows=[[price(c[4])+'원','종가 '+pct(ch), pcls(ch)], [price(c[1]),'시가'], [price(c[2]),'고가'], [price(c[3]),'저가']];
      if(k===bk) rows.push(['▲ '+price(p.ep),'이 봉에서 매수','up']);
      return {x:xx, y:y(c[2]), head:tFull(c[0])+' 시작 1시간봉', rows:rows}; });
  }
  function head(i, flash){ var p=D.pos[i], val=curVal(p), g=val-p.cost, nf=!flash;
    set('cp'+i, price(p.cur)+'원', null, nf);
    set('cr'+i, pct(g/p.cost*100), cls(g), nf);
    set('csl'+i, pct((p.sl/p.cur-1)*100), null, nf);
    set('ctp'+i, pct((p.tp/p.cur-1)*100), null, nf); }

  // ③ 자산 구성 도넛 (현금 + 코인별 평가금액)
  function drawAlloc(){
    var plot=document.getElementById('alloc-plot'); if(!plot) return;
    var items=[{n:'현금', v:Math.max(0, D.cash), c:'var(--cash)'}], other=null;
    D.pos.forEach(function(p, k){ var v=curVal(p);
      if(k<4){ items.push({n:p.sym, v:v, c:'var(--c'+(k+1)+')'}); return; }
      if(!other){ other={n:'기타', v:0, c:'var(--c-other)'}; items.push(other); } other.v+=v; });
    var total=items.reduce(function(s, it){ return s+it.v; }, 0);
    if(!(total>0)){ msg(plot,'평가금액이 없어요.'); return; }
    clear(plot);
    var wrap=document.createElement('div'); wrap.className='alloc-wrap'; plot.appendChild(wrap);
    var S=168, r=S/2-14, sw=24, CC=2*Math.PI*r, off=0, tp=addTip(plot);
    var svg=E(null,'svg',{viewBox:'0 0 '+S+' '+S, width:S, height:S, role:'img', 'aria-label':'자산 구성 도넛 차트'}); wrap.appendChild(svg);
    var g=E(svg,'g',{transform:'rotate(-90 '+S/2+' '+S/2+')'});
    var nz=items.filter(function(it){ return it.v>0; }).length;
    items.forEach(function(it){ if(it.v<=0) return;
      var len=it.v/total*CC, seg=Math.max(nz>1?len-2:len, 0.6);
      var c=E(g,'circle',{cx:S/2, cy:S/2, r:r, fill:'none', 'stroke-width':sw, 'stroke-dasharray':seg.toFixed(2)+' '+(CC-seg).toFixed(2), 'stroke-dashoffset':(-off).toFixed(2), 'class':'slice'});
      c.style.stroke=it.c; off+=len;
      function hd(){ tp.hidden=true; c.classList.remove('on'); }
      function sh(ev){ activate(hd, c); var b=plot.getBoundingClientRect(); c.classList.add('on');
        showTip(tp, ev.clientX-b.left, ev.clientY-b.top, null, [[won(it.v)+'원', it.n+' · '+(it.v/total*100).toFixed(1)+'%', '', it.c]]); }
      c.addEventListener('pointermove', sh); c.addEventListener('pointerdown', sh);
      c.addEventListener('pointerleave', function(ev){ if(ev.pointerType==='mouse') hd(); }); });
    E(svg,'text',{x:S/2, y:S/2-5, 'text-anchor':'middle'}, '총평가');
    E(svg,'text',{x:S/2, y:S/2+14, 'text-anchor':'middle', 'class':'t-big'}, man(total, 1000)+'원');
    var ul=document.createElement('ul'); ul.className='alloc-legend';
    items.forEach(function(it){ var li=document.createElement('li');
      var s=document.createElement('span'); s.className='swatch'; s.style.background=it.c; li.appendChild(s);
      var n=document.createElement('span'); n.className='nm'; n.textContent=it.n; li.appendChild(n);
      var pc=document.createElement('b'); pc.textContent=(it.v/total*100).toFixed(1)+'%'; li.appendChild(pc);
      var a=document.createElement('span'); a.className='amt'; a.textContent=won(it.v)+'원'; li.appendChild(a);
      ul.appendChild(li); });
    wrap.appendChild(ul);
  }

  // ④ 코인별 손익 (실현 + 미실현) 가로 막대
  function drawPnl(){
    var plot=document.getElementById('pnl-plot'); if(!plot) return;
    var held={}; D.pos.forEach(function(p){ held[p.m]=p; });
    var rows=(D.coins||[]).map(function(c){ var p=held[c.m], u=p?curVal(p)-p.cost:0;
      return {sym:c.sym, r:c.r, u:u, v:c.r+u, held:!!p}; });
    if(!rows.length){ msg(plot,'아직 손익을 낼 코인이 없어요.'); return; }
    clear(plot);
    var W=width(plot), rowH=36, T=6, B=6, H=T+B+rows.length*rowH, Lb=54, bh=16;
    var mn=0, mx=0; rows.forEach(function(r){ mn=Math.min(mn, r.v); mx=Math.max(mx, r.v); });
    if(mn===0 && mx===0) mx=1;
    var svg=mkSvg(plot, W, H, '코인별 손익 막대 차트');
    var vt=rows.map(function(r){ return E(svg,'text',{'class':'t-val'}, signed(r.v)+'원'); });
    var lw=0; vt.forEach(function(t){ lw=Math.max(lw, textW(t)); });
    var a0=Lb+(mn<0?lw+10:4), a1=W-(mx>0?lw+10:4);
    function X(v){ return a0+(v-mn)/(mx-mn)*(a1-a0); }
    var z=X(0), tp=addTip(plot);
    rows.forEach(function(r, k){ var top=T+k*rowH, yc=top+rowH/2, yy=yc-bh/2, xv=X(r.v);
      var a=Math.min(z, xv), b=Math.max(z, xv), len=b-a, rad=Math.min(4, len, bh/2);
      E(svg,'text',{x:0, y:yc+(r.held?4:-1), 'class':'t-name'}, r.sym);
      if(!r.held) E(svg,'text',{x:0, y:yc+12, 'class':'t-cnt'}, '정리함');
      var bar=null;
      if(len>=0.5){ var d = r.v>=0
          ? 'M'+a+','+yy+' H'+(b-rad)+' Q'+b+','+yy+' '+b+','+(yy+rad)+' V'+(yy+bh-rad)+' Q'+b+','+(yy+bh)+' '+(b-rad)+','+(yy+bh)+' H'+a+' Z'
          : 'M'+b+','+yy+' H'+(a+rad)+' Q'+a+','+yy+' '+a+','+(yy+rad)+' V'+(yy+bh-rad)+' Q'+a+','+(yy+bh)+' '+(a+rad)+','+(yy+bh)+' H'+b+' Z';
        bar=E(svg,'path',{d:d, 'class':(r.v>=0?'f-up':'f-down')+' bar'}); }
      var t=vt[k]; t.setAttribute('y', yc+4);
      if(r.v>=0){ t.setAttribute('x', b+6); } else { t.setAttribute('x', a-6); t.setAttribute('text-anchor','end'); }
      var hit=E(svg,'rect',{x:0, y:top, width:W, height:rowH, fill:'transparent', 'class':'hitrow'});
      function hd(){ tp.hidden=true; if(bar) bar.classList.remove('on'); }
      function sh(ev){ activate(hd, hit); var bb=plot.getBoundingClientRect(); if(bar) bar.classList.add('on');
        showTip(tp, ev.clientX-bb.left, ev.clientY-bb.top, r.sym, [[signed(r.v)+'원','합계', cls(r.v)], [signed(r.r)+'원','실현(판 것)', cls(r.r)], [signed(r.u)+'원','미실현(보유 중)', cls(r.u)]]); }
      hit.addEventListener('pointermove', sh); hit.addEventListener('pointerdown', sh);
      hit.addEventListener('pointerleave', function(ev){ if(ev.pointerType==='mouse') hd(); }); });
    E(svg,'line',{x1:z, x2:z, y1:T-2, y2:H-B+2, 'class':'g-base'});
  }

  function safe(f, id){ try{ f(); }catch(e){ var pl=document.getElementById(id); if(pl) msg(pl,'그래프를 그리지 못했어요.'); if(window.console) console.error(e); } }
  function drawAll(){ safe(drawEquity,'eq-plot');
    D.pos.forEach(function(p, i){ safe(function(){ drawCandle(i); }, 'cplot'+i); });
    safe(drawAlloc,'alloc-plot'); safe(drawPnl,'pnl-plot'); }
  function loading(on){ var els=document.querySelectorAll('.viz-plot'); for(var k=0;k<els.length;k++) els[k].classList.toggle('loading', on); }
  function parseCandles(rows){ return rows.map(function(c){ return [Date.parse(c.candle_date_time_utc+'Z'), c.opening_price, c.high_price, c.low_price, c.trade_price]; })
    .filter(function(c){ return c[0]>0 && c[4]>0; }).sort(function(a, b){ return a[0]-b[0]; }); }
  function getJSON(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); }); }

  function refresh(){
    hours();
    if(!D.pos.length){ st.textContent='보유 코인이 없어 갱신할 값이 없어요.'; return; }
    btn.disabled=true; st.textContent='업비트 현재가·캔들 불러오는 중…'; loading(true);
    var n=D.pos.length, ms=D.pos.map(function(p){ return p.m; }).join(',');
    var pt=getJSON('https://api.upbit.com/v1/ticker?markets='+encodeURIComponent(ms)).then(function(rows){
      var px={}; rows.forEach(function(t){ px[t.market]=t.trade_price; });
      var total=D.cash, unreal=0, got=0;
      D.pos.forEach(function(p, i){ var cur=px[p.m];
        if(cur){ got++; p.cur=cur; p.val=curVal(p);
          set('p'+i, price(cur)); set('v'+i, won(p.val));
          var pnl=p.val-p.cost; set('g'+i, signed(pnl)+' ('+pct(pnl/p.cost*100)+')', cls(pnl)); }
        total+=p.val; unreal+=p.val-p.cost; });
      var pnlAll=total-D.initial;
      set('eq', won(total)+'원');
      set('pnl', signed(pnlAll)+'원', cls(pnlAll));
      set('pnlpct', pct(pnlAll/D.initial*100), cls(pnlAll));
      set('unreal', signed(unreal)+'원', cls(unreal));
      return got; });
    var pc=Promise.all(D.pos.map(function(p){
      return getJSON('https://api.upbit.com/v1/candles/minutes/60?market='+encodeURIComponent(p.m)+'&count=72')
        .then(function(rows){ var c=parseCandles(rows||[]); if(c.length){ D.candles[p.m]=c; return 1; } return 0; })
        .catch(function(){ return 0; }); }));
    Promise.all([pt.then(function(g){ return {ok:true, g:g}; }, function(e){ return {ok:false, e:e}; }), pc]).then(function(res){
      var t=res[0], cs=res[1].reduce(function(a, b){ return a+b; }, 0);
      st.textContent = t.ok
        ? '실시간 갱신 '+new Date().toLocaleTimeString('ko-KR')+' (업비트 현재가 기준 '+t.g+'/'+n+'종목, 수수료 차감 · 캔들 '+cs+'/'+n+')'
        : '실시간 갱신 실패 — 마지막 저장값을 보여드려요. ('+t.e.message+')'+(cs?' · 캔들 '+cs+'/'+n+' 갱신':'');
      drawAll(); D.pos.forEach(function(p, i){ head(i, t.ok); });
    }).then(function(){ loading(false); btn.disabled=false; });
  }

  var lastW=0, rt=null;
  function wrapW(){ var w=document.querySelector('.wrap'); return w ? w.clientWidth : 0; }
  window.addEventListener('resize', function(){ clearTimeout(rt); rt=setTimeout(function(){ var w=wrapW(); if(w!==lastW){ lastW=w; drawAll(); } }, 150); });
  lastW=wrapW(); drawAll(); D.pos.forEach(function(p, i){ head(i, false); });
  btn.addEventListener('click', refresh);
  refresh();
})();
"""


def _cls(x):
    return "up" if x > 0.5 else ("down" if x < -0.5 else "flat")


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


CHART_CANDLES = 72   # 코인 차트에 쓰는 1시간봉 개수(좁은 화면은 최근 48개만 그림)
COIN_COLOR_SLOTS = 4  # 코인 고유색 개수(--c1~--c4). 그 뒤 종목은 '기타' 색


def coin_color(k):
    return f"var(--c{k + 1})" if k < COIN_COLOR_SLOTS else "var(--c-other)"


def candle_rows(df, n=CHART_CANDLES):
    """캔들 DataFrame → [[시작시각(ms), 시가, 고가, 저가, 종가], ...] 최근 n개 (대시보드 임베드용)"""
    if df is None or getattr(df, "empty", True):
        return []
    out = []
    for r in df.tail(n).itertuples(index=False):
        try:
            out.append([int(r.start_utc.timestamp() * 1000), float(r.open), float(r.high), float(r.low), float(r.close)])
        except (AttributeError, TypeError, ValueError):
            continue
    return out


def equity_points(history):
    """equity_history → [[시각(ms), 총평가], ...] 시간순"""
    pts = []
    for h in history or []:
        try:
            t = datetime.fromisoformat(h["t"])
            if t.tzinfo is None:
                t = t.replace(tzinfo=KST)
            pts.append([int(t.timestamp() * 1000), round(float(h["eq"]), 2)])
        except (KeyError, TypeError, ValueError):
            continue
    pts.sort(key=lambda p: p[0])
    return pts


def trade_marks(points, trades):
    """거래마다 자산 그래프에서 시각이 가장 가까운 점 번호 → [{i, s('b'/'s'), no, sym}]"""
    ts = [p[0] for p in points]
    out = []
    if not ts:
        return out
    for t in trades:
        try:
            ms = int(datetime.strptime(t.get("시각", ""), "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST).timestamp() * 1000)
        except (TypeError, ValueError):
            continue
        k = bisect.bisect_left(ts, ms)
        j = min((c for c in (k - 1, k) if 0 <= c < len(ts)), key=lambda c: abs(ts[c] - ms))
        out.append({"i": j, "s": "b" if t.get("구분") == "매수" else "s",
                    "no": str(t.get("번호", "")), "sym": t.get("종목", "").replace("KRW-", "")})
    return out


def coin_pnl(state, trades, bids):
    """코인별 손익 막대용: 실현손익(판 것 합계) + 보유 여부. 정렬은 (실현+미실현) 큰 순"""
    realized = {}
    for t in trades:
        if t.get("구분") == "매도" and t.get("손익") not in (None, ""):
            m = t.get("종목", "")
            realized[m] = realized.get(m, 0.0) + _num(t.get("손익"))
    rows = []
    for m in dict.fromkeys(list(state["positions"]) + list(realized)):
        p = state["positions"].get(m)
        u = liquidation_value(p, bids.get(m) or p["entry_price"]) - p["cost"] if p else 0.0
        rows.append({"m": m, "sym": symbol(m), "r": round(realized.get(m, 0.0), 2), "_t": realized.get(m, 0.0) + u})
    rows.sort(key=lambda r: -r["_t"])
    for r in rows:
        del r["_t"]
    return rows


CHART_LEGEND = (
    '<div class="vlegend"><span><i class="lk lk-avg"></i>평균 매수가</span>'
    '<span><i class="lk lk-sl"></i>손절가</span><span><i class="lk lk-tp"></i>목표가</span>'
    '<span><b class="up">▲</b>매수 시점</span><span><b class="up">▮</b>양봉 <b class="down">▮</b>음봉</span></div>')


def build_dashboard(state, trades, bids, now, candles=None):
    esc = html.escape
    candles = candles or {}
    initial = float(state.get("initial_cash", C.INITIAL_CASH))
    eq = equity(state, bids)
    pnl = eq - initial
    unreal = unrealized(state, bids)
    sells = state.get("sell_count", 0)
    win_txt = f"{state.get('win_count', 0) / sells * 100:.0f}% <small>({state.get('win_count', 0)}/{sells})</small>" if sells else "-"

    def card(label, value, cls="", vid=""):
        id_attr = f' id="{vid}"' if vid else ""
        return (f'<div class="card"><div class="label">{label}</div>'
                f'<div class="value {cls}"{id_attr}>{value}</div></div>')

    cards = "".join([
        f'<div class="card hero"><div class="label">현재 총평가 (지금 전부 팔면 받는 금액)</div>'
        f'<div class="value" id="eq">{fmt_won(eq)}원</div>'
        f'<div class="label" style="margin-top:4px">누적손익 <b id="pnl" class="{_cls(pnl)}">{fmt_signed(pnl)}원</b> '
        f'<b id="pnlpct" class="{_cls(pnl)}">{pnl / initial * 100:+.2f}%</b></div></div>',
        card("시작금액", f"{fmt_won(initial)}원"),
        card("현금", f"{fmt_won(state['cash'])}원"),
        card("실현손익", f"{fmt_signed(state.get('realized_pnl', 0))}원", _cls(state.get("realized_pnl", 0))),
        card("미실현손익", f"{fmt_signed(unreal)}원", _cls(unreal), "unreal"),
        card("누적 수수료", f"{fmt_won(state.get('total_fees', 0))}원"),
        card("거래횟수", f"{state.get('total_trades', 0)}회 <small>(매수 {state.get('buy_count', 0)} · 매도 {sells})</small>"),
        card("승률 (수익 매도)", win_txt),
        card("마지막 업데이트", f"<small>{now.strftime('%m/%d %H:%M')}</small>"),
    ])

    # 보유 코인
    pos_js, rows, ccards = [], [], []
    for i, (m, p) in enumerate(state["positions"].items()):
        bid = bids.get(m) or p["entry_price"]
        val = liquidation_value(p, bid)
        g = val - p["cost"]
        sl, tp = stop_target(p["entry_price"])
        h = (now - datetime.fromisoformat(p["entry_time"])).total_seconds() / 3600
        pos_js.append({"m": m, "sym": symbol(m), "qty": p["qty"], "cost": p["cost"], "val": val,
                       "entry": p["entry_time"], "ep": p["entry_price"], "sl": sl, "tp": tp, "cur": bid})
        ccards.append(
            f'<div class="viz ccard" id="cc{i}"><div class="chead">'
            f'<span class="swatch" style="background:{coin_color(i)}"></span>'
            f'<span class="sym">{esc(symbol(m))}</span> <span class="sub">{esc(p["name"])}</span>'
            f'<span class="cprice" id="cp{i}">{fmt_price(bid)}원</span>'
            f'<span class="cret {_cls(g)}" id="cr{i}">{g / p["cost"] * 100:+.2f}%</span></div>'
            f'<div class="cstats"><span>손절까지 <b id="csl{i}">{(sl / bid - 1) * 100:+.2f}%</b></span>'
            f'<span>목표까지 <b id="ctp{i}">{(tp / bid - 1) * 100:+.2f}%</b></span>'
            f'<span>평균 매수가 <b>{fmt_price(p["entry_price"])}원</b></span></div>'
            f'<div class="viz-plot" id="cplot{i}"><div class="empty">그래프 준비 중…</div></div></div>')
        rows.append(
            f'<tr><td class="l"><b>{esc(symbol(m))}</b> <span class="sub">{esc(p["name"])}</span></td>'
            f'<td>{fmt_qty(p["qty"])}</td><td>{fmt_price(p["entry_price"])}</td><td>{fmt_won(p["cost"])}</td>'
            f'<td id="p{i}">{fmt_price(bid)}</td><td id="v{i}">{fmt_won(val)}</td>'
            f'<td id="g{i}" class="{_cls(g)}">{fmt_signed(g)} ({g / p["cost"] * 100:+.2f}%)</td>'
            f'<td><span class="down">{fmt_price(sl)}</span> / <span class="up">{fmt_price(tp)}</span></td>'
            f'<td id="h{i}">{h:.1f}시간</td></tr>')
    pos_html = (
        '<div class="table-wrap"><table><thead><tr><th class="l">코인</th><th>수량</th><th>평균매수가</th>'
        '<th>매수금액<br><span class="sub">수수료 포함</span></th><th>현재가</th>'
        '<th>평가금액<br><span class="sub">수수료 차감</span></th><th>손익</th><th>손절가 / 목표가</th><th>보유시간</th>'
        f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
        if rows else '<div class="table-wrap"><div class="empty">보유 중인 코인이 없어요. 매수 신호를 기다리는 중.</div></div>')

    # 거래 내역 (최신순)
    trows = []
    for t in reversed(trades):
        is_buy = t.get("구분") == "매수"
        cash_chg = _num(t.get("현금변화"))
        pnl_t = t.get("손익")
        pnl_cell = "-"
        if not is_buy and pnl_t not in (None, ""):
            pv = _num(pnl_t)
            pnl_cell = f'<span class="{_cls(pv)}">{fmt_signed(pv)} ({_num(t.get("손익률(%)")):+.2f}%)</span>'
        note = t.get("비고") or ""
        no = esc(str(t.get("번호", "")))
        trows.append(
            f'<tr class="tlink" onclick="location.hash=\'t{no}\'"><td class="l">{esc(t.get("시각", "")[5:16])}</td>'
            f'<td class="l"><b>{esc(t.get("종목", "").replace("KRW-", ""))}</b></td>'
            f'<td class="l"><span class="badge {"buy" if is_buy else "sell"}">{"매수" if is_buy else "매도"}</span></td>'
            f'<td class="l">{esc(t.get("사유", ""))}{" ⚠" if note else ""}</td>'
            f'<td>{fmt_price(_num(t.get("평균체결가")))}</td><td>{fmt_qty(_num(t.get("수량")))}</td>'
            f'<td>{fmt_won(_num(t.get("체결금액")))}</td><td>{fmt_won(_num(t.get("수수료")))}</td>'
            f'<td class="{"up" if cash_chg > 0 else "down"}">{fmt_signed(cash_chg)}</td>'
            f'<td>{pnl_cell}</td><td>{fmt_won(_num(t.get("거래후현금")))}</td></tr>')
    trades_html = (
        '<div class="table-wrap"><table><thead><tr><th class="l">시각</th><th class="l">코인</th><th class="l">구분</th>'
        '<th class="l">사유</th><th>평균체결가</th><th>수량</th><th>체결금액</th><th>수수료</th><th>현금 변화</th>'
        f'<th>이 거래 손익</th><th>거래 후 현금</th></tr></thead><tbody>{"".join(trows)}</tbody></table></div>'
        if trows else '<div class="table-wrap"><div class="empty">아직 거래가 없어요.</div></div>')

    # 거래 상세 카드 (카톡 링크 #t번호 로 바로 이동)
    cards_d = []
    for t in reversed(trades):
        is_buy = t.get("구분") == "매수"
        no = esc(str(t.get("번호", "")))
        sym = esc(t.get("종목", "").replace("KRW-", ""))
        funds, fee = _num(t.get("체결금액")), _num(t.get("수수료"))
        rows = [
            ("시각", esc(t.get("시각", ""))),
            ("평균체결가", f'{fmt_price(_num(t.get("평균체결가")))}원'),
            ("수량", f'{fmt_qty(_num(t.get("수량")))}개'),
            ("체결금액", f"{fmt_won(funds)}원"),
            ("수수료 (0.05%)", f"{fmt_won(fee)}원"),
        ]
        if is_buy:
            rows += [
                ("총 지출 (체결+수수료)", f"{fmt_won(funds + fee)}원"),
                (f"손절가 ({C.STOP_LOSS_PCT:+.0f}%)", f'{fmt_price(_num(t.get("손절가")))}원' if t.get("손절가") else "-"),
                (f"목표가 ({C.TAKE_PROFIT_PCT:+.0f}%)", f'{fmt_price(_num(t.get("목표가")))}원' if t.get("목표가") else "-"),
            ]
        else:
            pv = _num(t.get("손익"))
            rows += [
                ("입금액 (체결−수수료)", f"{fmt_won(funds - fee)}원"),
                ("매수 평균가", f'{fmt_price(_num(t.get("매수가")))}원' if t.get("매수가") else "-"),
                ("보유 시간", esc(t.get("보유시간") or "-")),
                ("이 거래 손익", f'<span class="{_cls(pv)}">{fmt_signed(pv)}원 ({_num(t.get("손익률(%)")):+.2f}%)</span>'),
            ]
        rows.append(("거래 후 현금", f'{fmt_won(_num(t.get("거래후현금")))}원'))
        dl = "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in rows)
        reason = esc(t.get("사유", ""))
        note = esc(t.get("비고") or "")
        cards_d.append(
            f'<div class="tcard" id="t{no}"><div class="thead">'
            f'<span class="ttitle">#{no} {sym} <span class="sub">{esc(t.get("이름", ""))}</span></span>'
            f'<span class="badge {"buy" if is_buy else "sell"}">{"매수" if is_buy else "매도 · " + reason}</span></div>'
            f'<dl>{dl}</dl>'
            + (f'<div class="reason">매수 이유: {reason}</div>' if is_buy else "")
            + (f'<div class="reason">⚠ {note}</div>' if note else "")
            + '</div>')
    detail_html = "".join(cards_d) or '<div class="table-wrap"><div class="empty">아직 거래가 없어요.</div></div>'

    eqh = equity_points(state.get("equity_history", []))
    data = {"pos": pos_js, "cash": state["cash"], "initial": initial, "fee": C.FEE_RATE,
            "ticks": [[lo, t] for lo, t in KRW_TICKS],
            "eqh": eqh, "marks": trade_marks(eqh, trades),
            "candles": {m: list(candles.get(m) or [])[-CHART_CANDLES:] for m in state["positions"]},
            "coins": coin_pnl(state, trades, bids)}
    ccards_html = (CHART_LEGEND + f'<div class="ccards">{"".join(ccards)}</div>' if ccards
                   else '<div class="table-wrap"><div class="empty">보유 중인 코인이 없어서 차트가 없어요.</div></div>')
    plot_wait = '<div class="empty">그래프 준비 중…</div>'
    data_json = json.dumps(data, ensure_ascii=True).replace("<", "\\u003c").replace(">", "\\u003e")
    halted = ('<div class="mock">⛔ 손실한도 도달로 정지된 상태예요.</div>' if state.get("halted") else "")
    entry_txt = []
    if C.ENTRY_CROSS:
        entry_txt.append(f"상승전환(EMA{C.EMA_FAST}/{C.EMA_SLOW} 골든크로스 최근 {C.CROSS_LOOKBACK}봉 이내, RSI {C.RSI_MIN}~{C.RSI_MAX}, "
                         f"거래량 {C.VOLUME_RATIO:g}배↑)")
    if C.ENTRY_PULLBACK:
        entry_txt.append(f"눌림목(상승추세 {C.PULLBACK_TREND_BARS}봉↑ 중 EMA{C.EMA_FAST} +{C.PULLBACK_TOUCH_PCT:g}% 이내 터치 후 양봉, "
                         f"RSI {C.PULLBACK_RSI_MIN}~{C.PULLBACK_RSI_MAX}, 거래량 {C.PULLBACK_VOLUME_RATIO:g}배↑)")
    if C.ENTRY_BREAKOUT:
        entry_txt.append(f"돌파(직전 {C.BREAKOUT_LOOKBACK}봉 고점 돌파, 거래량 {C.BREAKOUT_VOLUME_RATIO:g}배↑, "
                         f"RSI {C.BREAKOUT_RSI_MAX} 이하, 상승추세)")
    rule = (f"매수(1시간봉, 하나라도 맞으면 점수 높은 순): {' · '.join(entry_txt) or '꺼짐'}. "
            f"총평가의 {C.POSITION_PCT * 100:.1f}%씩 최대 {C.MAX_POSITIONS}종목. "
            f"매도: 손절 {C.STOP_LOSS_PCT:g}% · 익절 +{C.TAKE_PROFIT_PCT:g}% · 추세이탈 · {C.MAX_HOLD_HOURS}시간 경과. "
            f"체결은 업비트 호가창을 소진하는 방식으로 계산하고 수수료 {C.FEE_RATE * 100:.2f}%를 매수·매도마다 뗍니다.")

    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>코인 모의투자 현황</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<div class="mock">※ 모의투자 — 실제 주문 아님</div>
{halted}
<header>
<div class="header-row">
  <div><h1>📊 업비트 코인 모의투자</h1><div class="date">마지막 봇 실행 {now.strftime('%Y-%m-%d %H:%M')} KST</div></div>
  <button id="refresh-btn" class="refresh-btn" type="button">🔄 실시간</button>
</div>
<div id="refresh-status" class="refresh-status"></div>
</header>

<h2 class="section">📊 요약</h2>
<div class="grid">{cards}</div>

<h2 class="section">📈 자산 변화 <span class="sub">가로선 = 시작금액 {fmt_won(initial)}원 · 위 빨강 수익, 아래 파랑 손실 · ▲매수 ▼매도</span></h2>
<div class="viz"><div class="viz-plot" id="eq-plot">{plot_wait}</div></div>

<h2 class="section">💰 보유 코인 차트 <span class="sub">1시간봉 · 눌러서 값 보기</span></h2>
{ccards_html}

<h2 class="section">🍩 자산 구성 · 코인별 손익</h2>
<div class="duo">
<div class="viz"><div class="viz-title">자산 구성 <span class="sub">현금 + 코인 평가금액(수수료 차감)</span></div><div class="viz-plot" id="alloc-plot">{plot_wait}</div></div>
<div class="viz"><div class="viz-title">코인별 손익 <span class="sub">판 것(실현) + 보유 중(미실현)</span></div><div class="viz-plot" id="pnl-plot">{plot_wait}</div></div>
</div>

<h2 class="section">💼 보유 코인</h2>
{pos_html}

<h2 class="section">🧾 전체 거래 내역 <span class="sub">최신순 · 행을 누르면 상세로 이동</span></h2>
{trades_html}

<h2 class="section">🔎 거래 상세 <span class="sub">카톡 '자세히 보기'로 들어오면 해당 거래가 강조돼요</span></h2>
{detail_html}

<div class="note">{esc(rule)}<br>평가금액 = 수량 × 최우선 매수호가 × (1−수수료). 🔄 실시간은 업비트 현재가(체결가)로 다시 계산해요.</div>
<footer>※ 모의투자 — 실제 주문 아님 · 투자 권유가 아닙니다</footer>
</div>
<script type="application/json" id="paper-data">{data_json}</script>
<script>{JS}</script>
</body>
</html>
"""


def write_dashboard(state, bids, now, path=None, candles=None):
    path = path or DASHBOARD_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_dashboard(state, read_trades(), bids, now, candles))
    os.replace(tmp, path)
    return path


# ───────────────────────── GitHub Pages 게시 ─────────────────────────
def should_publish(state, report, now):
    if report.get("traded") or report.get("summary_sent"):
        return True
    last = state.get("last_publish_at")
    if not last:
        return True
    try:
        return now - datetime.fromisoformat(last) >= timedelta(hours=C.PUBLISH_EVERY_HOURS)
    except ValueError:
        return True


def publish_dashboard(now):
    """docs/paper.html 만 커밋·푸시. 실패해도 예외를 던지지 않고 False 반환."""
    def run(*args):
        return subprocess.run(["git", *args], cwd=BASE_DIR, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=120)
    try:
        rel = "docs/paper.html"
        add = run("add", rel)
        if add.returncode != 0:
            print("  git add 실패:", add.stderr.strip())
            return False
        commit = run("commit", "-m", f"모의투자 갱신 {now.strftime('%Y-%m-%d %H:%M')}", "--", rel)
        out = (commit.stdout or "") + (commit.stderr or "")
        if commit.returncode != 0 and "nothing to commit" not in out and "no changes added" not in out:
            print("  git commit 실패:", out.strip())
            return False
        push = run("push", "origin", "main")
        if push.returncode != 0:
            print("  git push 실패:", push.stderr.strip())
            return False
        return True
    except Exception as e:
        print(f"  게시 실패: {type(e).__name__}: {e}")
        return False


# ───────────────────────── 출력 ─────────────────────────
def print_status(state, bids=None):
    bids = bids or {}
    eq = equity(state, bids)
    print(f"현금 {fmt_won(state['cash'])}원 | 총평가 {fmt_won(eq)}원 | "
          f"누적손익 {fmt_signed(eq - C.INITIAL_CASH)}원({(eq / C.INITIAL_CASH - 1) * 100:+.2f}%)")
    print(f"실현손익 {fmt_signed(state['realized_pnl'])}원 | 누적수수료 {fmt_won(state.get('total_fees', 0))}원 | "
          f"오늘({state.get('trade_day')}) 거래 {state['trades_today']}/{C.MAX_TRADES_PER_DAY} | "
          f"누적 거래 {state['total_trades']}회{' | ★정지 상태' if state.get('halted') else ''}")
    if not state["positions"]:
        print("보유 종목 없음")
    for m, p in state["positions"].items():
        bid = bids.get(m)
        ret = f"{(bid / p['entry_price'] - 1) * 100:+.2f}%" if bid else "호가 ?"
        print(f"  {p['name']}({m}) 수량 {fmt_qty(p['qty'])} 평균 {fmt_price(p['entry_price'])} "
              f"매수호가 {fmt_price(bid) if bid else '?'} {ret} (매수 {p['entry_time']})")


def print_report(report, prices):
    print("\n[유니버스 / 신호 (직전 완성봉 기준)]")
    for m in report["universe"]:
        s = report["signals"].get(m, {})
        if not s.get("ok"):
            print(f"  {m:<12} - {s.get('why')}")
            continue
        flag = f"★매수({RULE_NAMES[s['entry']]} {s['score']:.2f}점)" if s.get("buy") else ""
        print(f"  {m:<12} 현재 {fmt_price(prices.get(m, 0)):>14} | 봉 {s['bar_kst']} | "
              f"EMA20 {'>' if s['uptrend'] else '<'} EMA50({s.get('trend_bars', 0)}봉) | {s['desc']} | "
              f"{s.get('rules_desc', '')} {flag}")
    if report["flagged"]:
        print(f"  (유의/주의로 제외 {len(report['flagged'])}종목)")
    print("[이번 사이클 동작]")
    for a in report["actions"] or ["변동 없음"]:
        print(f"  {a}")


def main():
    # 스케줄러가 출력을 파일로 넘기면 기본 cp949가 되어 ✗ 같은 기호에서 죽는다
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="업비트 모의투자 봇 (실제 주문 없음)")
    ap.add_argument("--dry-run", action="store_true", help="카톡 미전송, git 게시 생략, 콘솔 출력만")
    ap.add_argument("--status", action="store_true", help="현재 상태만 출력")
    args = ap.parse_args()

    now = now_kst()
    print(f"\n===== 모의투자 {now.strftime('%Y-%m-%d %H:%M:%S')} KST"
          f"{' (dry-run)' if args.dry_run else ''}{' (status)' if args.status else ''} =====")
    state = load_state()
    api = UpbitPublic()

    if args.status:
        bids = {}
        if state["positions"]:
            try:
                bids = {m: best_bid(u) for m, u in api.get_orderbooks(list(state["positions"])).items()}
            except Exception as e:
                print(f"호가 조회 실패: {e}")
        print_status(state, bids)
        return 0

    notify = Notifier(args.dry_run)
    try:
        return _run_and_publish(args, state, api, now, notify)
    finally:
        notify.flush()  # 오류가 나도 이미 생긴 매매 알림은 보낸다


def wait_for_pages(no, timeout=240):
    """GitHub Pages에 거래 #no 카드가 뜰 때까지 기다린다(카톡 링크가 바로 맞게)."""
    if not no:
        return
    marker = f'id="t{no}"'
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(C.DASHBOARD_URL, params={"_": int(time.time())}, timeout=10,
                             headers={"Cache-Control": "no-cache"})
            if marker in r.text:
                print(f"[게시] 페이지 반영 확인(거래 #{no})")
                return
        except requests.RequestException:
            pass
        time.sleep(10)
    print(f"[게시] {timeout}초 안에 반영 확인 못 함 → 카톡은 그대로 전송")


def _run_and_publish(args, state, api, now, notify):
    trades_before = state.get("total_trades", 0)
    try:
        report = run_cycle(state, api, now, notify)
    except Exception as e:
        print(f"오류로 사이클 중단: {type(e).__name__}: {e}")
        return 1
    if not report.get("halted"):
        print_report(report, report.get("prices", {}))
        print("[상태]")
        print_status(state, report.get("bids", {}))

    # 대시보드: 매 실행 로컬 파일 갱신, 내용이 바뀐 실행만 게시(dry-run은 게시 단계 전체 생략)
    try:
        path = write_dashboard(state, report.get("bids", {}), now, candles=report.get("candles"))
        print(f"[대시보드] {path} 갱신")
    except Exception as e:
        print(f"[대시보드] 생성 실패: {type(e).__name__}: {e}")
        return 0
    if args.dry_run:
        print("[게시] dry-run이라 생략")
    elif should_publish(state, report, now):
        if publish_dashboard(now):
            state["last_publish_at"] = now.isoformat(timespec="seconds")
            save_state(state)
            print(f"[게시] 완료 → {C.DASHBOARD_URL}")
            if state.get("total_trades", 0) > trades_before:
                wait_for_pages(state["total_trades"])
        else:
            print("[게시] 실패 (다음 실행 때 다시 시도)")
    else:
        print("[게시] 변경 없음 → 로컬 파일만 갱신")
    return 0


if __name__ == "__main__":
    sys.exit(main())
