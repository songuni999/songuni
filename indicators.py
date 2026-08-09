# -*- coding: utf-8 -*-
"""
기술적 지표 계산 + 초보자용 스크리닝
주의: 아래 결과는 투자 조언이 아니라, 공개된 가격/거래량 데이터를 기계적으로
계산한 "참고 신호"입니다. 최종 투자 판단은 본인 책임입니다.
"""
import pandas as pd


def _fmt_price(p, market):
    if p is None:
        return "-"
    if market == "KR":
        return f"{p:,.0f}원"
    if market == "COIN":
        return f"{p:,.0f}원" if p >= 1 else f"{p:,.4f}원"
    return f"${p:,.2f}"


def compute_indicators(history: pd.DataFrame):
    """OHLCV 데이터프레임에 이동평균/RSI를 추가합니다."""
    df = history.copy()
    df["ma5"] = df["close"].rolling(5).mean()
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma60"] = df["close"].rolling(60).mean()

    delta = df["close"].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(14).mean()
    avg_loss = loss.rolling(14).mean()
    rs = avg_gain / avg_loss.replace(0, pd.NA)
    df["rsi14"] = 100 - (100 / (1 + rs))

    return df


def evaluate(item: dict):
    """
    개별 종목에 대해 스코어 + 초보자용 설명을 만듭니다.
    반환: dict(score, signals=[str], summary=str)
    """
    history = item.get("history")
    if history is None or len(history) < 25:
        return {"score": 0, "signals": [], "summary": "데이터가 부족해 분석할 수 없어요."}

    df = compute_indicators(history)
    last = df.iloc[-1]

    score = 0
    signals = []

    ma5, ma20, ma60 = last.get("ma5"), last.get("ma20"), last.get("ma60")
    price = last["close"]
    rsi = last.get("rsi14")

    # 골든크로스 근접/발생: 단기 이평선이 중기 이평선을 상향 돌파
    if pd.notna(ma5) and pd.notna(ma20):
        if ma5 > ma20:
            prev = df.iloc[-2]
            if pd.notna(prev.get("ma5")) and pd.notna(prev.get("ma20")) and prev["ma5"] <= prev["ma20"]:
                score += 2
                signals.append("골든크로스 발생 (5일선이 20일선을 막 돌파) — 단기 상승 전환 신호로 보는 경우가 많아요")
            else:
                score += 1
                signals.append("5일 이동평균선이 20일선 위에 있어요 — 최근 흐름이 상승 쪽이에요")

    # 정배열: 5 > 20 > 60 이면 추세가 강함
    if pd.notna(ma5) and pd.notna(ma20) and pd.notna(ma60) and ma5 > ma20 > ma60:
        score += 1
        signals.append("정배열 상태예요 (5일선 > 20일선 > 60일선) — 상승 추세가 이어지고 있다는 뜻이에요")

    # RSI: 과매도 구간에서 반등 가능성 / 과매수 구간 주의
    if pd.notna(rsi):
        if rsi < 30:
            score += 1
            signals.append(f"RSI {rsi:.0f} — 과매도 구간이에요 (많이 빠져서 반등 기대가 나올 수 있는 구간, 반대로 더 빠질 수도 있어요)")
        elif rsi > 70:
            score -= 1
            signals.append(f"RSI {rsi:.0f} — 과매수 구간이에요 (단기간 많이 올라 조정 가능성도 염두에 둬야 해요)")

    # 목표주가 대비 상승여력
    target = item.get("target_price")
    market = item.get("market")
    if target and price:
        target_str = _fmt_price(target, market)
        upside = (target - price) / price * 100
        if upside > 0:
            signals.append(f"12개월 목표주가(컨센서스 평균) {target_str} — 현재가 대비 {upside:.1f}% 상승 여력 (증권사 전망치, 참고용)")
            if upside > 15:
                score += 1
        else:
            signals.append(f"12개월 목표주가(컨센서스 평균) {target_str} — 현재가가 이미 {abs(upside):.1f}% 더 높아요 (목표가 근접/초과)")

    # 거래량 급증
    if "volume" in df.columns and len(df) > 20:
        avg_vol20 = df["volume"].iloc[-21:-1].mean()
        if avg_vol20 and last["volume"] > avg_vol20 * 2:
            score += 1
            signals.append("최근 거래량이 평소보다 2배 이상 늘었어요 — 관심이 몰리고 있다는 신호예요")

    if not signals:
        summary = "특별한 신호는 없지만 꾸준히 지켜볼 만해요."
    else:
        summary = signals[0]

    return {"score": score, "signals": signals, "rsi": rsi, "ma5": ma5, "ma20": ma20, "ma60": ma60, "summary": summary}


def rank_candidates(items: list, top_n: int = 5):
    """스코어 기준 상위 후보를 뽑습니다."""
    evaluated = []
    for it in items:
        if it.get("error"):
            continue
        ev = evaluate(it)
        evaluated.append({**it, "eval": ev})

    evaluated.sort(key=lambda x: x["eval"]["score"], reverse=True)
    return evaluated[:top_n]
