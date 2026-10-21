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
    df = df.rename(columns={"trade_price": "close", "candle_acc_trade_volume": "volume"})
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


def analyze(df):
    """완성봉 DataFrame → 신호 dict (마지막 행 = 직전 완성봉)"""
    need = C.EMA_SLOW + C.CROSS_LOOKBACK + 2
    if df is None or len(df) < need:
        return {"ok": False, "why": f"봉 부족({0 if df is None else len(df)}개)"}
    close, vol = df["close"].astype(float), df["volume"].astype(float)
    ef = close.ewm(span=C.EMA_FAST, adjust=False).mean()
    es = close.ewm(span=C.EMA_SLOW, adjust=False).mean()
    r = rsi(close, C.RSI_PERIOD)
    vavg = vol.rolling(C.VOLUME_AVG_BARS).mean()

    above = ef > es
    # i번째 봉에서 크로스: i봉 EMA20>EMA50 이고 i-1봉 EMA20<=EMA50
    cross = above & ~above.shift(1, fill_value=True)
    golden_now = bool(cross.iloc[-1])
    recent_cross = bool(cross.iloc[-C.CROSS_LOOKBACK:].any())

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
    }
    trend_ok = golden_now or (recent_cross and s["uptrend"] and s["close"] > s["ema_fast"])
    rsi_ok = C.RSI_MIN <= s["rsi"] <= C.RSI_MAX
    vol_ok = s["vol"] >= s["vol_avg"] * C.VOLUME_RATIO
    s["buy"] = bool(trend_ok and rsi_ok and vol_ok)
    s["trend_broken"] = s["ema_fast"] < s["ema_slow"]

    parts = []
    parts.append("골든크로스" if golden_now else ("최근크로스" if recent_cross else ("상승추세" if s["uptrend"] else "하락추세")))
    parts.append(f"RSI {s['rsi']:.0f}{'' if rsi_ok else '✗'}")
    parts.append(f"거래량 {s['vol'] / s['vol_avg']:.1f}배{'' if vol_ok else '✗'}" if s["vol_avg"] > 0 else "거래량 -")
    s["desc"] = ", ".join(parts)
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
    sigs = {}
    for m in dict.fromkeys(universe + held):
        try:
            sigs[m] = analyze(api.get_candles(m, now))
        except Exception as e:
            sigs[m] = {"ok": False, "why": f"캔들 오류: {e}"}
    report["signals"] = sigs

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
    buys.sort(key=lambda m: abs(sigs[m]["rsi"] - C.RSI_TARGET))
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
        s = sigs[m]
        s["reason"] = f"1시간봉 {'상승전환' if s['golden_now'] else '상승전환 직후'}, RSI {s['rsi']:.0f}"
        f = do_buy(state, m, names.get(m, symbol(m)), units, budget, s, now, notify)
        if f:
            bids[m] = best_bid(units)
            report["traded"] = True
            report["actions"].append(f"매수 {m} 평균 {fmt_price(f['avg_price'])} × {fmt_qty(f['qty'])} "
                                     f"(체결 {fmt_won(f['funds'])}원, {f['levels']}단계)")

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
"""

JS = r"""
(function(){
  var D = JSON.parse(document.getElementById('paper-data').textContent);
  var btn = document.getElementById('refresh-btn'), st = document.getElementById('refresh-status');
  function won(x){ return Math.round(x).toLocaleString('ko-KR'); }
  function signed(x){ var v=Math.round(x); return (v>=0?'+':'-')+Math.abs(v).toLocaleString('ko-KR'); }
  function cls(x){ return x>0.5?'up':(x<-0.5?'down':'flat'); }
  function tick(p){ var T=D.ticks; for(var i=0;i<T.length;i++){ if(p>=T[i][0]) return T[i][1]; } return 1e-8; }
  function price(p){ var t=tick(p), d=0, s=t.toFixed(8).replace(/0+$/,''); if(s.indexOf('.')>=0) d=s.split('.')[1].length;
    return (Math.round(p/t)*t).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d}); }
  function set(id, txt, c){ var el=document.getElementById(id); if(!el) return; el.textContent=txt;
    if(c!==undefined){ el.classList.remove('up','down','flat'); el.classList.add(c); }
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  function hours(){ var now=Date.now(); D.pos.forEach(function(p,i){
    var h=(now-new Date(p.entry).getTime())/3600000; var el=document.getElementById('h'+i);
    if(el && h>=0) el.textContent=h.toFixed(1)+'시간'; }); }
  function refresh(){
    hours();
    if(!D.pos.length){ st.textContent='보유 코인이 없어 갱신할 값이 없어요.'; return; }
    btn.disabled=true; st.textContent='업비트 현재가 불러오는 중…';
    var ms=D.pos.map(function(p){return p.m;}).join(',');
    fetch('https://api.upbit.com/v1/ticker?markets='+encodeURIComponent(ms))
      .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(rows){
        var px={}; rows.forEach(function(t){ px[t.market]=t.trade_price; });
        var total=D.cash, unreal=0, got=0;
        D.pos.forEach(function(p,i){
          var cur=px[p.m], val;
          if(cur){ got++; val=p.qty*cur*(1-D.fee);
            set('p'+i, price(cur)); set('v'+i, won(val));
            var pnl=val-p.cost; set('g'+i, signed(pnl)+' ('+(pnl/p.cost*100>=0?'+':'')+(pnl/p.cost*100).toFixed(2)+'%)', cls(pnl));
          } else { val=p.val; }
          total+=val; unreal+=val-p.cost;
        });
        var pnlAll=total-D.initial;
        set('eq', won(total)+'원');
        set('pnl', signed(pnlAll)+'원', cls(pnlAll));
        set('pnlpct', (pnlAll/D.initial*100>=0?'+':'')+(pnlAll/D.initial*100).toFixed(2)+'%', cls(pnlAll));
        set('unreal', signed(unreal)+'원', cls(unreal));
        st.textContent='실시간 갱신 '+new Date().toLocaleTimeString('ko-KR')+' (업비트 현재가 기준 '+got+'/'+D.pos.length+'종목, 수수료 차감)';
      })
      .catch(function(e){ st.textContent='실시간 갱신 실패 — 마지막 저장값을 보여드려요. ('+e.message+')'; })
      .then(function(){ btn.disabled=false; });
  }
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


def equity_svg(history, initial):
    pts = [(datetime.fromisoformat(h["t"]), float(h["eq"])) for h in history if h.get("t")]
    if len(pts) < 2:
        return '<div class="empty">기록이 2개 이상 쌓이면 그래프가 그려져요.</div>'
    W, H, L, R, T, B = 420, 200, 66, 8, 16, 30
    t0, t1 = pts[0][0].timestamp(), pts[-1][0].timestamp()
    vals = [v for _, v in pts] + [initial]
    lo, hi = min(vals), max(vals)
    pad = max((hi - lo) * 0.08, initial * 0.002)
    lo, hi = lo - pad, hi + pad
    span_t = max(t1 - t0, 1)

    def x(t):
        return L + (t.timestamp() - t0) / span_t * (W - L - R)

    def y(v):
        return T + (hi - v) / (hi - lo) * (H - T - B)

    line = " ".join(f"{x(t):.1f},{y(v):.1f}" for t, v in pts)
    area = f"{x(pts[0][0]):.1f},{H - B} " + line + f" {x(pts[-1][0]):.1f},{H - B}"
    color = "var(--up)" if pts[-1][1] >= initial else "var(--down)"
    yb = y(initial)
    fmt_t = lambda t: t.astimezone(KST).strftime("%m/%d %H:%M")
    return (
        f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="총평가 변화 그래프">'
        f'<polygon points="{area}" fill="{color}" opacity="0.10"/>'
        f'<line x1="{L}" y1="{yb:.1f}" x2="{W - R}" y2="{yb:.1f}" stroke="var(--sub-text)" stroke-dasharray="4 4" stroke-width="1"/>'
        f'<text x="{W - R}" y="{yb - 4:.1f}" text-anchor="end" font-size="12" fill="var(--sub-text)">시작 {fmt_won(initial)}</text>'
        f'<polyline points="{line}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"/>'
        f'<circle cx="{x(pts[-1][0]):.1f}" cy="{y(pts[-1][1]):.1f}" r="3.5" fill="{color}"/>'
        f'<text x="{L - 6}" y="{T + 10}" text-anchor="end" font-size="12" fill="var(--sub-text)">{fmt_won(hi)}</text>'
        f'<text x="{L - 6}" y="{H - B}" text-anchor="end" font-size="12" fill="var(--sub-text)">{fmt_won(lo)}</text>'
        f'<text x="{L}" y="{H - 8}" font-size="12" fill="var(--sub-text)">{fmt_t(pts[0][0])}</text>'
        f'<text x="{W - R}" y="{H - 8}" text-anchor="end" font-size="12" fill="var(--sub-text)">{fmt_t(pts[-1][0])}</text>'
        f'</svg>'
    )


def build_dashboard(state, trades, bids, now):
    esc = html.escape
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
    pos_js, rows = [], []
    for i, (m, p) in enumerate(state["positions"].items()):
        bid = bids.get(m) or p["entry_price"]
        val = liquidation_value(p, bid)
        g = val - p["cost"]
        sl, tp = stop_target(p["entry_price"])
        h = (now - datetime.fromisoformat(p["entry_time"])).total_seconds() / 3600
        pos_js.append({"m": m, "qty": p["qty"], "cost": p["cost"], "val": val, "entry": p["entry_time"]})
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

    data = {"pos": pos_js, "cash": state["cash"], "initial": initial, "fee": C.FEE_RATE,
            "ticks": [[lo, t] for lo, t in KRW_TICKS]}
    data_json = json.dumps(data, ensure_ascii=True).replace("<", "\\u003c").replace(">", "\\u003e")
    halted = ('<div class="mock">⛔ 손실한도 도달로 정지된 상태예요.</div>' if state.get("halted") else "")
    rule = (f"매수: 1시간봉 EMA{C.EMA_FAST}/{C.EMA_SLOW} 골든크로스(최근 {C.CROSS_LOOKBACK}봉 이내) + RSI {C.RSI_MIN}~{C.RSI_MAX}"
            f" + 거래량 평균의 {C.VOLUME_RATIO:g}배 이상, 총평가의 {C.POSITION_PCT * 100:.1f}%씩 최대 {C.MAX_POSITIONS}종목. "
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

<h2 class="section">📈 자산 변화</h2>
<div class="chart">{equity_svg(state.get("equity_history", []), initial)}</div>

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


def write_dashboard(state, bids, now, path=None):
    path = path or DASHBOARD_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(build_dashboard(state, read_trades(), bids, now))
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
        flag = "★매수신호" if s["buy"] else ""
        print(f"  {m:<12} 현재 {fmt_price(prices.get(m, 0)):>14} | 봉 {s['bar_kst']} | "
              f"EMA20 {'>' if s['uptrend'] else '<'} EMA50 | {s['desc']} {flag}")
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
        path = write_dashboard(state, report.get("bids", {}), now)
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
