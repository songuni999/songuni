# -*- coding: utf-8 -*-
"""
시세 데이터 수집 모듈
- 한국 주식: pykrx (KRX 공개 데이터)
- 미국 주식: yfinance (Yahoo Finance)
- 코인: Upbit 공개 API
"""
import datetime
import time

import pandas as pd
import requests
import yfinance as yf
from pykrx import stock as krx


def _today_str():
    return datetime.datetime.now().strftime("%Y%m%d")


def _days_ago_str(days):
    return (datetime.datetime.now() - datetime.timedelta(days=days)).strftime("%Y%m%d")


def _parse_num(raw):
    if raw is None:
        return None
    try:
        return float(str(raw).replace(",", "").replace("배", "").replace("%", "").replace("원", "").strip())
    except (ValueError, TypeError):
        return None


def fetch_kr_naver_data(code: str):
    """네이버 금융 모바일 API에서 목표주가 컨센서스 + 재무 펀더멘털을 한 번에 가져옵니다."""
    result = {}
    try:
        r = requests.get(
            f"https://m.stock.naver.com/api/stock/{code}/integration",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=10,
        )
        data = r.json()

        consensus = data.get("consensusInfo") or {}
        target = _parse_num(consensus.get("priceTargetMean"))
        recomm = _parse_num(consensus.get("recommMean"))
        result["target_price"] = target
        result["recomm_score"] = recomm  # 1(강력매수)~5(매도)

        total = {item.get("code"): item for item in (data.get("totalInfos") or [])}
        result["per"] = _parse_num(total.get("per", {}).get("value"))
        result["eps"] = _parse_num(total.get("eps", {}).get("value"))
        result["cns_per"] = _parse_num(total.get("cnsPer", {}).get("value"))  # 컨센서스(미래 실적 반영) PER
        result["cns_eps"] = _parse_num(total.get("cnsEps", {}).get("value"))  # 컨센서스 EPS(내년 예상 실적)
        result["pbr"] = _parse_num(total.get("pbr", {}).get("value"))
        result["bps"] = _parse_num(total.get("bps", {}).get("value"))
        result["div_yield"] = _parse_num(total.get("dividendYieldRatio", {}).get("value"))
        result["week52_high"] = _parse_num(total.get("highPriceOf52Weeks", {}).get("value"))
        result["week52_low"] = _parse_num(total.get("lowPriceOf52Weeks", {}).get("value"))
    except Exception:
        pass
    return result


def fetch_kr_stock(code: str, name: str, lookback_days: int = 120):
    """한국 주식 OHLCV + 기본 정보를 반환합니다."""
    end = _today_str()
    start = _days_ago_str(lookback_days)
    try:
        df = krx.get_market_ohlcv(start, end, code)
    except Exception as e:
        return {"code": code, "name": name, "error": str(e)}

    if df is None or df.empty:
        return {"code": code, "name": name, "error": "데이터 없음"}

    df = df.rename(columns={
        "시가": "open", "고가": "high", "저가": "low",
        "종가": "close", "거래량": "volume", "등락률": "change_pct",
    })
    last = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else last

    fundamentals = {}
    try:
        fdf = krx.get_market_fundamental(end, end, code)
        if fdf is not None and not fdf.empty:
            frow = fdf.iloc[-1]
            fundamentals = {
                "per": float(frow.get("PER", 0)) or None,
                "pbr": float(frow.get("PBR", 0)) or None,
                "div_yield": float(frow.get("DIV", 0)) or None,
            }
    except Exception:
        pass

    naver_data = fetch_kr_naver_data(code)
    fundamentals.update({k: v for k, v in naver_data.items() if v is not None})

    return {
        "market": "KR",
        "code": code,
        "name": name,
        "price": float(last["close"]),
        "change_pct": float(last.get("change_pct", 0.0)),
        "volume": int(last["volume"]),
        "history": df,
        **fundamentals,
    }


def fetch_us_stock(ticker: str):
    """미국 주식 가격 + 애널리스트 목표주가 컨센서스를 반환합니다."""
    try:
        t = yf.Ticker(ticker)
        info = t.info
        hist = t.history(period="4mo", interval="1d")
    except Exception as e:
        return {"ticker": ticker, "error": str(e)}

    if hist is None or hist.empty:
        return {"ticker": ticker, "error": "데이터 없음"}

    hist = hist.rename(columns={
        "Open": "open", "High": "high", "Low": "low",
        "Close": "close", "Volume": "volume",
    })
    last_close = float(hist["close"].iloc[-1])
    prev_close = float(hist["close"].iloc[-2]) if len(hist) > 1 else last_close
    change_pct = (last_close - prev_close) / prev_close * 100 if prev_close else 0.0

    return {
        "market": "US",
        "ticker": ticker,
        "name": info.get("shortName") or ticker,
        "price": info.get("currentPrice") or last_close,
        "change_pct": change_pct,
        "volume": int(hist["volume"].iloc[-1]) if not pd.isna(hist["volume"].iloc[-1]) else 0,
        "history": hist,
        "target_price": info.get("targetMeanPrice"),
        "target_high": info.get("targetHighPrice"),
        "target_low": info.get("targetLowPrice"),
        "recommendation": info.get("recommendationKey"),
        "per": info.get("trailingPE"),
        "forward_per": info.get("forwardPE"),
        "pbr": info.get("priceToBook"),
        "roe": info.get("returnOnEquity"),
        "revenue_growth": info.get("revenueGrowth"),
        "earnings_growth": info.get("earningsGrowth"),
        "profit_margin": info.get("profitMargins"),
        "debt_to_equity": info.get("debtToEquity"),
        "div_yield": info.get("dividendYield"),
        "week52_high": info.get("fiftyTwoWeekHigh"),
        "week52_low": info.get("fiftyTwoWeekLow"),
    }


def fetch_crypto(market: str, lookback_days: int = 120):
    """업비트 공개 API로 코인 시세/캔들을 가져옵니다."""
    try:
        ticker_res = requests.get(
            "https://api.upbit.com/v1/ticker", params={"markets": market}, timeout=10
        ).json()
        candle_res = requests.get(
            "https://api.upbit.com/v1/candles/days",
            params={"market": market, "count": lookback_days},
            timeout=10,
        ).json()
    except Exception as e:
        return {"market_code": market, "error": str(e)}

    if not ticker_res or not candle_res:
        return {"market_code": market, "error": "데이터 없음"}

    t = ticker_res[0]
    candles = list(reversed(candle_res))  # 오래된 순으로 정렬
    df = pd.DataFrame(candles)
    df["date"] = pd.to_datetime(df["candle_date_time_kst"])
    df = df.set_index("date")
    df = df.rename(columns={
        "opening_price": "open", "high_price": "high", "low_price": "low",
        "trade_price": "close", "candle_acc_trade_volume": "volume",
    })

    return {
        "market": "COIN",
        "market_code": market,
        "name": market.replace("KRW-", "") ,
        "price": t["trade_price"],
        "change_pct": t["signed_change_rate"] * 100,
        "volume": t["acc_trade_volume_24h"],
        "history": df[["open", "high", "low", "close", "volume"]],
        "target_price": None,  # 코인은 애널리스트 목표가 개념이 없음
        "week52_high": float(df["high"].max()),  # 조회 기간(최근 120일) 내 최고가
        "week52_low": float(df["low"].min()),
        "week52_is_approx": True,  # 진짜 52주가 아니라 조회기간 내 최고/최저임을 표시
    }


def fetch_all(kr_stocks, us_stocks, crypto_markets, throttle=0.15):
    """설정된 관심목록 전체를 수집합니다."""
    results = {"kr": [], "us": [], "coin": []}

    for s in kr_stocks:
        results["kr"].append(fetch_kr_stock(s["code"], s["name"]))
        time.sleep(throttle)

    for tkr in us_stocks:
        results["us"].append(fetch_us_stock(tkr))
        time.sleep(throttle)

    for m in crypto_markets:
        results["coin"].append(fetch_crypto(m))
        time.sleep(throttle)

    return results
