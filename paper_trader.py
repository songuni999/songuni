# -*- coding: utf-8 -*-
"""
업비트 모의투자(페이퍼 트레이딩) 봇 - 1회 실행 = 1사이클

※ 실제 주문은 절대 넣지 않습니다. 업비트 '공개 시세 API'(마켓 목록·현재가·캔들)만 호출합니다.
   주문/계좌 API는 이 파일 어디에서도 쓰지 않습니다.

사용법:
  python paper_trader.py            # 1사이클 실행 (거래 시 카톡 전송)
  python paper_trader.py --dry-run  # 1사이클 실행, 카톡 미전송(콘솔 출력만)
  python paper_trader.py --status   # 현재 상태만 출력
"""
import argparse
import csv
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

import paper_config as C

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "paper_state.json")
TRADES_PATH = os.path.join(BASE_DIR, "paper_trades.csv")

API = "https://api.upbit.com/v1"
KST = timezone(timedelta(hours=9))
FOOTER = "※모의투자, 실제 주문 아님"

TRADE_FIELDS = ["시각", "종목", "이름", "구분", "사유", "가격", "수량", "금액", "수수료", "손익", "손익률(%)", "거래후현금"]


# ───────────────────────── 공통 유틸 ─────────────────────────
def now_kst():
    return datetime.now(KST)


def floor8(x):
    return math.floor(x * 1e8) / 1e8


def fmt_won(x):
    return f"{x:,.0f}"


def fmt_price(p):
    if p >= 100:
        return f"{p:,.0f}"
    if p >= 1:
        return f"{p:,.2f}"
    return f"{p:.4f}"


def fmt_signed(x):
    return f"{'+' if x >= 0 else '-'}{abs(x):,.0f}"


def symbol(market):
    return market.split("-", 1)[1]


# ───────────────────────── 시세 조회 (공개 API만) ─────────────────────────
class UpbitPublic:
    """업비트 공개 시세 API. 주문 기능 없음."""

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
    vol_ok = s["vol"] >= s["vol_avg"]
    s["buy"] = bool(trend_ok and rsi_ok and vol_ok)
    s["trend_broken"] = s["ema_fast"] < s["ema_slow"]

    parts = []
    parts.append("골든크로스" if golden_now else ("최근크로스" if recent_cross else ("상승추세" if s["uptrend"] else "하락추세")))
    parts.append(f"RSI {s['rsi']:.0f}{'' if rsi_ok else '✗'}")
    parts.append(f"거래량 {s['vol'] / s['vol_avg']:.1f}배{'' if vol_ok else '✗'}" if s["vol_avg"] > 0 else "거래량 -")
    s["desc"] = ", ".join(parts)
    return s


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
        "total_trades": 0,
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


# ───────────────────────── 알림 ─────────────────────────
class Notifier:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.sent = []

    def __call__(self, msg):
        msg = msg[:200]
        self.sent.append(msg)
        print("─" * 30)
        print(("[카톡 미전송/dry-run]\n" if self.dry_run else "[카톡]\n") + msg)
        print("─" * 30)
        if self.dry_run:
            return
        try:
            import kakao_sender
            kakao_sender.send_text(msg)
        except Exception as e:  # 카톡 실패해도 매매 기록은 유지
            print(f"  카톡 전송 실패: {e}")


# ───────────────────────── 체결 시뮬레이션 ─────────────────────────
def liquidation_value(pos, price):
    """지금 팔면 손에 쥐는 금액(슬리피지·수수료 차감)"""
    return pos["qty"] * price * (1 - C.SLIPPAGE) * (1 - C.FEE_RATE)


def equity(state, prices):
    total = state["cash"]
    for m, p in state["positions"].items():
        total += liquidation_value(p, prices.get(m, p["entry_price"]))
    return total


def reset_day(state, now):
    d = now.strftime("%Y-%m-%d")
    if state.get("trade_day") != d:
        state["trade_day"] = d
        state["trades_today"] = 0


def can_trade(state):
    return state["trades_today"] < C.MAX_TRADES_PER_DAY


def do_buy(state, market, name, cur_price, sig, now, notify):
    price = cur_price * (1 + C.SLIPPAGE)
    budget = C.POSITION_SIZE / (1 + C.FEE_RATE)  # 수수료 포함 POSITION_SIZE 이내
    qty = floor8(budget / price)
    amount = qty * price
    fee = amount * C.FEE_RATE
    if qty <= 0 or amount + fee > state["cash"] + 1e-9:
        return False
    state["cash"] -= amount + fee
    state["positions"][market] = {
        "name": name, "qty": qty, "entry_price": price,
        "cost": amount + fee, "entry_time": now.isoformat(timespec="seconds"),
    }
    state["trades_today"] += 1
    state["total_trades"] += 1
    log_trade({
        "시각": now.strftime("%Y-%m-%d %H:%M:%S"), "종목": market, "이름": name, "구분": "매수",
        "사유": sig.get("reason", ""), "가격": round(price, 8), "수량": qty, "금액": round(amount, 2),
        "수수료": round(fee, 2), "손익": "", "손익률(%)": "", "거래후현금": round(state["cash"], 2),
    })
    save_state(state)
    sl = price * (1 + C.STOP_LOSS_PCT / 100)
    tp = price * (1 + C.TAKE_PROFIT_PCT / 100)
    notify(f"[모의매수] {name}({market})\n"
           f"가격 {fmt_price(price)}원 / {fmt_won(amount + fee)}원어치\n"
           f"손절 {fmt_price(sl)}원 / 목표 {fmt_price(tp)}원\n"
           f"이유: {sig.get('reason', '')}\n"
           f"잔고 현금 {fmt_won(state['cash'])}원\n{FOOTER}")
    return True


def do_sell(state, market, cur_price, reason, now, notify, counts=True):
    pos = state["positions"][market]
    price = cur_price * (1 - C.SLIPPAGE)
    amount = pos["qty"] * price
    fee = amount * C.FEE_RATE
    proceeds = amount - fee
    pnl = proceeds - pos["cost"]
    pnl_pct = pnl / pos["cost"] * 100
    state["cash"] += proceeds
    state["realized_pnl"] += pnl
    del state["positions"][market]
    if counts:
        state["trades_today"] += 1
    state["total_trades"] += 1
    log_trade({
        "시각": now.strftime("%Y-%m-%d %H:%M:%S"), "종목": market, "이름": pos["name"], "구분": "매도",
        "사유": reason, "가격": round(price, 8), "수량": pos["qty"], "금액": round(amount, 2),
        "수수료": round(fee, 2), "손익": round(pnl, 2), "손익률(%)": round(pnl_pct, 2),
        "거래후현금": round(state["cash"], 2),
    })
    save_state(state)
    notify(f"[모의매도·{reason}] {pos['name']}({market})\n"
           f"가격 {fmt_price(price)}원 (매수 {fmt_price(pos['entry_price'])}원)\n"
           f"수익 {fmt_signed(pnl)}원({pnl_pct:+.1f}%)\n"
           f"잔고 현금 {fmt_won(state['cash'])}원\n{FOOTER}")
    return pnl


def check_loss_limit(state, prices, now, notify):
    floor_value = C.INITIAL_CASH - C.LOSS_LIMIT
    eq = equity(state, prices)
    if eq > floor_value:
        return False
    print(f"!! 손실한도 도달: 평가 {fmt_won(eq)}원 ≤ {fmt_won(floor_value)}원 → 전량 정리 후 정지")
    for m in list(state["positions"]):
        do_sell(state, m, prices.get(m, state["positions"][m]["entry_price"]), "손실한도", now, notify, counts=False)
    state["halted"] = True
    state["halted_at"] = now.isoformat(timespec="seconds")
    save_state(state)
    notify(f"[모의투자 정지] 손실한도 도달\n"
           f"평가 {fmt_won(state['cash'])}원 (시작 {fmt_won(C.INITIAL_CASH)}원)\n"
           f"누적손익 {fmt_signed(state['cash'] - C.INITIAL_CASH)}원\n"
           f"재개하려면 paper_state.json 삭제\n{FOOTER}")
    return True


# ───────────────────────── 1사이클 ─────────────────────────
def run_cycle(state, api, now, notify):
    """state를 갱신하며 1사이클 수행. 출력용 리포트 dict 반환."""
    report = {"universe": [], "signals": {}, "actions": [], "flagged": []}
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

    # 캔들/신호 (유니버스 + 보유 종목)
    sigs = {}
    for m in dict.fromkeys(universe + held):
        try:
            sigs[m] = analyze(api.get_candles(m, now))
        except Exception as e:
            sigs[m] = {"ok": False, "why": f"캔들 오류: {e}"}
    report["signals"] = sigs

    # 1) 손실한도
    if check_loss_limit(state, prices, now, notify):
        report["halted"] = True
        return report

    # 2) 보유 종목 매도 판단
    for m in held:
        pos = state["positions"][m]
        if m not in prices:
            print(f"  {m}: 현재가 없음 → 매도 판단 보류")
            continue
        cur = prices[m]
        ret = (cur / pos["entry_price"] - 1) * 100
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
        pnl = do_sell(state, m, cur, reason, now, notify, counts=True)
        report["actions"].append(f"매도 {m} {reason} {fmt_signed(pnl)}원")

    # 매도 후 다시 손실한도 확인
    if check_loss_limit(state, prices, now, notify):
        report["halted"] = True
        return report

    # 3) 매수 판단
    buys = [m for m in universe
            if m not in state["positions"] and sigs.get(m, {}).get("ok") and sigs[m]["buy"] and m in prices]
    buys.sort(key=lambda m: abs(sigs[m]["rsi"] - C.RSI_TARGET))
    for m in buys:
        if len(state["positions"]) >= C.MAX_POSITIONS:
            report["actions"].append(f"매수후보 {m} - 자리 없음")
            continue
        if state["cash"] < C.POSITION_SIZE:
            report["actions"].append(f"매수후보 {m} - 현금 부족")
            continue
        if not can_trade(state):
            report["actions"].append(f"매수후보 {m} - 오늘 거래한도")
            continue
        s = sigs[m]
        s["reason"] = f"1시간봉 {'상승전환' if s['golden_now'] else '상승전환 직후'}, RSI {s['rsi']:.0f}"
        if do_buy(state, m, names.get(m, symbol(m)), prices[m], s, now, notify):
            report["actions"].append(f"매수 {m} @ {fmt_price(prices[m])}")

    # 4) 하루 1번 요약
    today = now.strftime("%Y-%m-%d")
    if state.get("last_summary_date") != today and now.hour >= C.DAILY_SUMMARY_HOUR:
        state["last_summary_date"] = today
        eq = equity(state, prices)
        held_txt = ", ".join(
            f"{symbol(m)} {(prices.get(m, p['entry_price']) / p['entry_price'] - 1) * 100:+.1f}%"
            for m, p in state["positions"].items()) or "없음"
        notify(f"[모의투자 하루요약] {now.strftime('%m/%d')}\n"
               f"총평가 {fmt_won(eq)}원\n"
               f"누적손익 {fmt_signed(eq - C.INITIAL_CASH)}원({(eq / C.INITIAL_CASH - 1) * 100:+.1f}%)\n"
               f"오늘 거래 {state['trades_today']}회\n"
               f"보유 {held_txt}\n{FOOTER}")

    save_state(state)
    report["prices"] = prices
    return report


# ───────────────────────── 출력 ─────────────────────────
def print_status(state, prices=None):
    prices = prices or {}
    eq = equity(state, prices)
    print(f"현금 {fmt_won(state['cash'])}원 | 총평가 {fmt_won(eq)}원 | "
          f"누적손익 {fmt_signed(eq - C.INITIAL_CASH)}원({(eq / C.INITIAL_CASH - 1) * 100:+.2f}%)")
    print(f"실현손익 {fmt_signed(state['realized_pnl'])}원 | 오늘({state.get('trade_day')}) 거래 "
          f"{state['trades_today']}/{C.MAX_TRADES_PER_DAY} | 누적 거래 {state['total_trades']}회"
          f"{' | ★정지 상태' if state.get('halted') else ''}")
    if not state["positions"]:
        print("보유 종목 없음")
    for m, p in state["positions"].items():
        cur = prices.get(m)
        ret = f"{(cur / p['entry_price'] - 1) * 100:+.2f}%" if cur else "현재가 ?"
        print(f"  {p['name']}({m}) 수량 {p['qty']} 매수가 {fmt_price(p['entry_price'])} "
              f"현재 {fmt_price(cur) if cur else '?'} {ret} (매수 {p['entry_time']})")


def print_report(report, prices):
    print("\n[유니버스 / 신호 (직전 완성봉 기준)]")
    for m in report["universe"]:
        s = report["signals"].get(m, {})
        if not s.get("ok"):
            print(f"  {m:<12} - {s.get('why')}")
            continue
        flag = "★매수신호" if s["buy"] else ""
        print(f"  {m:<12} 현재 {fmt_price(prices.get(m, 0)):>12} | 봉 {s['bar_kst']} | "
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
    ap.add_argument("--dry-run", action="store_true", help="카톡 미전송, 콘솔 출력만")
    ap.add_argument("--status", action="store_true", help="현재 상태만 출력")
    args = ap.parse_args()

    now = now_kst()
    print(f"\n===== 모의투자 {now.strftime('%Y-%m-%d %H:%M:%S')} KST"
          f"{' (dry-run)' if args.dry_run else ''}{' (status)' if args.status else ''} =====")
    state = load_state()

    if args.status:
        prices = {}
        if state["positions"]:
            try:
                prices = {m: float(t["trade_price"])
                          for m, t in UpbitPublic().get_tickers(list(state["positions"])).items()}
            except Exception as e:
                print(f"현재가 조회 실패: {e}")
        print_status(state, prices)
        return 0

    notify = Notifier(args.dry_run)
    try:
        report = run_cycle(state, UpbitPublic(), now, notify)
    except Exception as e:
        print(f"오류로 사이클 중단: {type(e).__name__}: {e}")
        return 1
    if report.get("halted"):
        return 0
    print_report(report, report.get("prices", {}))
    print("[상태]")
    print_status(state, report.get("prices", {}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
