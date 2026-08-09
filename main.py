# -*- coding: utf-8 -*-
"""
주식비서 - 매일 아침 브리핑 생성
실행: python main.py
"""
import sys
import time

import config
import data_fetch
import indicators
import report


def main():
    t0 = time.time()
    print("[1/3] 시세 데이터 수집 중...")
    data = data_fetch.fetch_all(config.KR_STOCKS, config.US_STOCKS, config.CRYPTO)

    ok_kr = sum(1 for x in data["kr"] if not x.get("error"))
    ok_us = sum(1 for x in data["us"] if not x.get("error"))
    ok_coin = sum(1 for x in data["coin"] if not x.get("error"))
    print(f"    한국주식 {ok_kr}/{len(data['kr'])}, 미국주식 {ok_us}/{len(data['us'])}, 코인 {ok_coin}/{len(data['coin'])} 수집 완료")

    print("[2/3] 스크리닝 중...")
    kr_universe = data["kr"]
    us_universe = data["us"]
    coin_universe = data["coin"]
    kr_candidates = indicators.rank_candidates(kr_universe, top_n=3)
    us_candidates = indicators.rank_candidates(us_universe, top_n=3)
    coin_candidates = indicators.rank_candidates(coin_universe, top_n=2)

    print("[3/4] 리포트 생성 중...")
    daily_path, latest_path = report.build_report(
        data, kr_candidates, us_candidates, coin_candidates,
        out_dir=config.REPORT_DIR, holdings=getattr(config, "HOLDINGS", None)
    )

    print("[4/4] 카카오톡 전송 중...")
    try:
        import kakao_sender
        holdings_summary = report.build_holdings_summary(data, getattr(config, "HOLDINGS", None))
        if holdings_summary:
            kakao_sender.send_text(holdings_summary)
        summary = report.build_summary_text(kr_candidates, us_candidates, coin_candidates)
        kakao_sender.send_text(summary)
        print("    카카오톡 전송 완료")
    except FileNotFoundError:
        print("    카카오 인증이 아직 안 돼있어요 (kakao_auth_setup.py 먼저 실행하세요). 건너뜁니다.")
    except Exception as e:
        print(f"    카카오톡 전송 실패: {e}")

    print(f"완료! ({time.time()-t0:.1f}s)")
    print(f" - {daily_path}")
    print(f" - {latest_path}")
    return latest_path


if __name__ == "__main__":
    main()
