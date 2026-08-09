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


def fetch_kr_target_price(code: str):
    """네이버 금융 모바일 API에서 컨센서스 목표주가(평균)를 가져옵니다."""
    try:
        r = requests.get(
            f"https://m.stock.naver.com/api/stock/{code}/integration",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=10,
        )
        info = r.json().get("consensusInfo") or {}
        raw = info.get("priceTargetMean")
        if not raw:
            return None, None
        target = float(str(raw).replace(",", ""))
        recomm = info.get("recommMean")
        return target, (float(recomm) if recomm else None)
    except Exception:
        return None, None


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

    target_price, recomm_score = fetch_kr_target_price(code)

    return {
        "market": "KR",
        "code": code,
        "name": name,
        "price": float(last["close"]),
        "change_pct": float(last.get("change_pct", 0.0)),
        "volume": int(last["volume"]),
        "history": df,
        "target_price": target_price,
        "recomm_score": recomm_score,  # 1(강력매수)~5(매도), 네이버 컨센서스 기준
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
        "pbr": info.get("priceToBook"),
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
