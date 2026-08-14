# -*- coding: utf-8 -*-
"""
주식비서 - 매일 아침 브리핑 생성
실행: python main.py
"""
import os
import shutil
import subprocess
import sys
import time

import config
import data_fetch
import indicators
import report

REPO_DIR = os.path.dirname(os.path.abspath(__file__))


def publish_to_github_pages(latest_path):
    """docs/index.html을 갱신하고 GitHub Pages에 자동 배포합니다."""
    docs_dir = os.path.join(REPO_DIR, "docs")
    os.makedirs(docs_dir, exist_ok=True)
    shutil.copyfile(latest_path, os.path.join(docs_dir, "index.html"))

    def run(*args):
        return subprocess.run(
            ["git", *args], cwd=REPO_DIR, capture_output=True,
            text=True, encoding="utf-8", errors="replace"
        )

    run("add", "docs/index.html")
    commit = run("commit", "-m", f"자동 리포트 갱신 {time.strftime('%Y-%m-%d %H:%M')}")
    if commit.returncode != 0 and "nothing to commit" not in commit.stdout:
        print("    git commit 실패:", commit.stderr.strip())
        return False
    push = run("push", "origin", "main")
    if push.returncode != 0:
        print("    git push 실패:", push.stderr.strip())
        return False
    return True


def main():
    t0 = time.time()
    print("[1/3] 시세 데이터 수집 중...")
    data = data_fetch.fetch_all(config.KR_STOCKS, config.US_STOCKS, config.CRYPTO)

    ok_kr = sum(1 for x in data["kr"] if not x.get("error"))
    ok_us = sum(1 for x in data["us"] if not x.get("error"))
    ok_coin = sum(1 for x in data["coin"] if not x.get("error"))
    print(f"    한국주식 {ok_kr}/{len(data['kr'])}, 미국주식 {ok_us}/{len(data['us'])}, 코인 {ok_coin}/{len(data['coin'])} 수집 완료")

    # 스크리닝 대상은 관심목록보다 넓게 - 다양한 섹터에서 후보를 찾기 위함
    kr_screen_extra = getattr(config, "KR_SCREEN_UNIVERSE", [])
    us_screen_extra = getattr(config, "US_SCREEN_UNIVERSE", [])
    if kr_screen_extra or us_screen_extra:
        print(f"    후보 스크리닝 확장: 한국 +{len(kr_screen_extra)}종목, 미국 +{len(us_screen_extra)}종목 수집 중...")
        extra_data = data_fetch.fetch_all(kr_screen_extra, us_screen_extra, [])
        ok_kr_extra = sum(1 for x in extra_data["kr"] if not x.get("error"))
        ok_us_extra = sum(1 for x in extra_data["us"] if not x.get("error"))
        print(f"    확장 스캔 완료: 한국 {ok_kr_extra}/{len(extra_data['kr'])}, 미국 {ok_us_extra}/{len(extra_data['us'])}")
    else:
        extra_data = {"kr": [], "us": []}

    print("[2/3] 스크리닝 중...")
    kr_universe = data["kr"] + extra_data["kr"]
    us_universe = data["us"] + extra_data["us"]
    coin_universe = data["coin"]
    kr_candidates = indicators.rank_candidates(kr_universe, top_n=3)
    us_candidates = indicators.rank_candidates(us_universe, top_n=3)
    coin_candidates = indicators.rank_candidates(coin_universe, top_n=2)

    print("[3/5] 리포트 생성 중...")
    daily_path, latest_path = report.build_report(
        data, kr_candidates, us_candidates, coin_candidates,
        out_dir=config.REPORT_DIR, holdings=getattr(config, "HOLDINGS", None)
    )

    print("[4/5] GitHub Pages 배포 중...")
    try:
        if publish_to_github_pages(latest_path):
            print("    배포 완료")
    except Exception as e:
        print(f"    배포 실패: {e}")

    print("[5/5] 카카오톡 전송 중...")
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
