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


def pct_off_high(item: dict):
    """52주(코인은 조회기간) 최고가 대비 현재가가 몇 % 낮은지 계산합니다. 음수면 최고가 대비 하락."""
    high = item.get("week52_high")
    price = item.get("price")
    if not high or not price:
        return None
    return (price - high) / high * 100


def three_month_change(history: pd.DataFrame):
    """최근 약 3개월(거래일 기준 63일)간의 가격 변동률(%)을 계산합니다."""
    if history is None or len(history) < 2:
        return None
    closes = history["close"]
    lookback = min(63, len(closes) - 1)
    if lookback <= 0:
        return None
    past_price = closes.iloc[-1 - lookback]
    now_price = closes.iloc[-1]
    if not past_price:
        return None
    return (now_price - past_price) / past_price * 100


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


def evaluate_technical(item: dict):
    """차트(가격/거래량) 흐름만 보는 기술적 신호. 반환: (score, signals)"""
    history = item.get("history")
    if history is None or len(history) < 25:
        return 0, []

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
                signals.append("📊 골든크로스 발생 (5일선이 20일선을 막 돌파) — 단기 상승 전환 신호로 보는 경우가 많아요")
            else:
                score += 1
                signals.append("📊 5일 이동평균선이 20일선 위에 있어요 — 최근 흐름이 상승 쪽이에요")

    # 정배열: 5 > 20 > 60 이면 추세가 강함
    if pd.notna(ma5) and pd.notna(ma20) and pd.notna(ma60) and ma5 > ma20 > ma60:
        score += 1
        signals.append("📊 정배열 상태예요 (5일선 > 20일선 > 60일선) — 상승 추세가 이어지고 있다는 뜻이에요")

    # RSI: 과매도 구간에서 반등 가능성 / 과매수 구간 주의
    if pd.notna(rsi):
        if rsi < 30:
            score += 1
            signals.append(f"📊 RSI {rsi:.0f} — 과매도 구간이에요 (많이 빠져서 반등 기대가 나올 수 있는 구간, 반대로 더 빠질 수도 있어요)")
        elif rsi > 70:
            score -= 1
            signals.append(f"📊 RSI {rsi:.0f} — 과매수 구간이에요 (단기간 많이 올라 조정 가능성도 염두에 둬야 해요)")

    # 거래량 급증
    if "volume" in df.columns and len(df) > 20:
        avg_vol20 = df["volume"].iloc[-21:-1].mean()
        if avg_vol20 and last["volume"] > avg_vol20 * 2:
            score += 1
            signals.append("📊 최근 거래량이 평소보다 2배 이상 늘었어요 — 관심이 몰리고 있다는 신호예요")

    return score, signals


def evaluate_fundamentals(item: dict):
    """PER/PBR/ROE/성장률 등 회사 자체의 재무 상태를 보는 신호. 반환: (score, signals)"""
    score = 0
    signals = []
    market = item.get("market")
    price = item.get("price")

    per = item.get("per")
    cns_per = item.get("cns_per")  # KR: 컨센서스(향후 실적 반영) PER
    forward_per = item.get("forward_per")  # US: 향후 12개월 예상 PER
    future_per = cns_per or forward_per

    # 이익 성장 기대: 미래 PER이 현재 PER보다 훨씬 낮으면 실적 개선을 시장이 반영 중
    if per and future_per and per > 0 and future_per > 0:
        if future_per < per * 0.8:
            score += 2
            signals.append(f"🏢 실적 개선 기대: 현재 PER {per:.1f}배 → 향후(컨센서스) {future_per:.1f}배로 낮아져요 — 이익이 늘어날 걸로 시장이 보고 있어요")
        elif future_per > per * 1.2:
            score -= 1
            signals.append(f"🏢 현재 PER {per:.1f}배 → 향후(컨센서스) {future_per:.1f}배로 높아져요 — 이익 둔화가 예상돼요")

    # PBR: 장부가치 대비 저평가/고평가
    pbr = item.get("pbr")
    if pbr:
        if pbr < 1:
            score += 1
            signals.append(f"🏢 PBR {pbr:.2f}배 — 회사 장부가치보다 싸게 거래되고 있어요 (저평가 신호일 수 있어요)")
        elif pbr > 5:
            score -= 1
            signals.append(f"🏢 PBR {pbr:.2f}배 — 장부가치 대비 많이 비싸게 거래되고 있어요")

    # ROE: 자기자본이익률 (US는 직접 제공, KR은 EPS/BPS로 근사 계산)
    roe = item.get("roe")
    if roe is not None:
        roe_pct = roe * 100
    else:
        eps, bps = item.get("eps"), item.get("bps")
        roe_pct = (eps / bps * 100) if (eps and bps) else None
    if roe_pct is not None:
        if roe_pct >= 15:
            score += 1
            signals.append(f"🏢 ROE(자기자본이익률) 약 {roe_pct:.1f}% — 자기자본을 효율적으로 굴려서 이익을 내는 회사예요")
        elif roe_pct < 0:
            score -= 1
            signals.append(f"🏢 ROE(자기자본이익률) 약 {roe_pct:.1f}% — 자기자본 대비 손실을 내고 있어요")

    # 매출/이익 성장률 (US만 제공)
    rev_g = item.get("revenue_growth")
    earn_g = item.get("earnings_growth")
    if rev_g is not None or earn_g is not None:
        parts = []
        if rev_g is not None:
            parts.append(f"매출 {rev_g*100:+.1f}%")
        if earn_g is not None:
            parts.append(f"이익 {earn_g*100:+.1f}%")
        signals.append(f"🏢 최근 1년 성장률: {', '.join(parts)} (전년 대비)")
        if (rev_g or 0) > 0.1 and (earn_g or 0) > 0.1:
            score += 1
        elif (rev_g or 0) < 0 and (earn_g or 0) < 0:
            score -= 1

    # 부채비율 (US만 제공)
    dte = item.get("debt_to_equity")
    if dte is not None and dte > 200:
        score -= 1
        signals.append(f"🏢 부채비율 {dte:.0f}% — 부채가 자기자본보다 훨씬 많아요, 재무 리스크에 유의하세요")

    # 배당수익률
    div_yield = item.get("div_yield")
    if div_yield and div_yield > 0.5:
        signals.append(f"🏢 배당수익률 약 {div_yield:.1f}% — 꾸준히 배당을 주는 회사예요")

    return score, signals


def evaluate(item: dict):
    """
    개별 종목에 대해 기술적 신호 + 기업 펀더멘털 신호를 종합한 스코어를 만듭니다.
    반환: dict(score, signals=[str], summary=str)
    """
    tech_score, tech_signals = evaluate_technical(item)
    fund_score, fund_signals = evaluate_fundamentals(item)

    score = tech_score + fund_score
    signals = fund_signals + tech_signals  # 기업 분석을 먼저 보여줌

    # 목표주가 대비 상승여력 (기술/펀더멘털 어느 쪽에도 넣기 애매해 별도로 계산)
    target = item.get("target_price")
    price = item.get("price")
    market = item.get("market")
    if target and price:
        target_str = _fmt_price(target, market)
        upside = (target - price) / price * 100
        if upside > 0:
            signals.append(f"🎯 12개월 목표주가(컨센서스 평균) {target_str} — 현재가 대비 {upside:.1f}% 상승 여력 (증권사 전망치, 참고용)")
            if upside > 15:
                score += 1
        else:
            signals.append(f"🎯 12개월 목표주가(컨센서스 평균) {target_str} — 현재가가 이미 {abs(upside):.1f}% 더 높아요 (목표가 근접/초과)")

    # 최근 3개월 가격 변동률 (정보 제공용, 스코어에는 반영 안 함)
    three_mo = three_month_change(item.get("history"))
    if three_mo is not None:
        signals.append(f"📊 최근 3개월간 {three_mo:+.1f}% 움직였어요 (과거 실적, 미래를 보장하지 않아요)")

    if not signals:
        summary = "특별한 신호는 없지만 꾸준히 지켜볼 만해요."
    else:
        summary = signals[0]

    return {
        "score": score, "tech_score": tech_score, "fund_score": fund_score,
        "signals": signals, "summary": summary, "three_month_change": three_mo,
    }


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
