# -*- coding: utf-8 -*-
"""
HTML 대시보드 리포트 생성
"""
import datetime
import os

import indicators

GLOSSARY = [
    ("이동평균선 (MA)", "최근 N일간의 평균 가격을 이은 선이에요. 5일선은 최근 1주일, 20일선은 한 달 정도의 평균 흐름을 보여줘요."),
    ("골든크로스", "단기 이동평균선(5일)이 중기 이동평균선(20일)을 아래에서 위로 뚫고 올라가는 것. 상승 전환 신호로 많이 해석돼요."),
    ("정배열", "5일선 > 20일선 > 60일선 순서로 놓인 상태. 상승 추세가 튼튼하다는 뜻으로 봐요."),
    ("RSI", "최근 가격이 얼마나 많이 오르고 내렸는지를 0~100 사이 숫자로 나타낸 지표예요. 70 넘으면 과매수(많이 올랐다), 30 밑이면 과매도(많이 빠졌다)로 봐요."),
    ("PER", "주가수익비율. 주가가 1주당 순이익의 몇 배인지를 나타내요. 낮을수록 '저평가'일 가능성이 있지만 업종마다 기준이 달라요."),
    ("PBR", "주가순자산비율. 주가가 1주당 순자산의 몇 배인지를 나타내요. 1보다 낮으면 회사 자산가치보다 주가가 싸다는 뜻이에요."),
    ("목표주가 (컨센서스)", "여러 증권사 애널리스트들이 제시한 목표주가의 평균값이에요. 통상 '앞으로 12개월(1년)' 정도를 내다본 전망치이고, 미래를 보장하지 않아요."),
    ("컨센서스 PER", "애널리스트들이 예상한 '내년 예상 실적' 기준으로 계산한 PER이에요. 지금 PER보다 훨씬 낮으면, 시장이 이 회사의 이익이 앞으로 크게 늘 거라고 보고 있다는 뜻이에요."),
    ("ROE (자기자본이익률)", "회사가 자기 돈(자본)을 굴려서 얼마나 이익을 냈는지 보여주는 비율이에요. 보통 15% 이상이면 돈을 효율적으로 잘 굴리는 회사로 봐요."),
    ("매출/이익 성장률", "작년 같은 기간 대비 매출과 이익이 얼마나 늘었는지예요. 둘 다 꾸준히 플러스면 회사가 커지고 있다는 뜻이에요."),
    ("부채비율", "자기자본 대비 빚이 얼마나 많은지 보여줘요. 너무 높으면(200% 이상) 금리가 오르거나 경기가 나빠질 때 위험할 수 있어요."),
]

DISCLAIMER = (
    "이 리포트는 공개된 시세·재무 데이터를 기계적으로 계산한 참고 자료이며, "
    "투자 권유나 매수/매도 추천이 아닙니다. 모든 투자 판단과 책임은 본인에게 있습니다."
)


def _fmt_price(p, market):
    if p is None:
        return "-"
    if market == "KR":
        return f"{p:,.0f}원"
    if market == "COIN":
        return f"{p:,.0f}원" if p >= 1 else f"{p:,.4f}원"
    return f"${p:,.2f}"


def _change_class(pct):
    if pct is None:
        return "flat"
    if pct > 0:
        return "up"
    if pct < 0:
        return "down"
    return "flat"


def _sparkline(history, width=140, height=40):
    if history is None or len(history) < 2:
        return ""
    closes = history["close"].tail(30).tolist()
    lo, hi = min(closes), max(closes)
    span = (hi - lo) or 1
    n = len(closes)
    pts = []
    for i, c in enumerate(closes):
        x = (i / (n - 1)) * (width - 4) + 2
        y = height - 2 - ((c - lo) / span) * (height - 4)
        pts.append(f"{x:.1f},{y:.1f}")
    color = "var(--up)" if closes[-1] >= closes[0] else "var(--down)"
    points = " ".join(pts)
    return (
        f'<svg viewBox="0 0 {width} {height}" class="spark" preserveAspectRatio="none">'
        f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round"/></svg>'
    )


def _quote_card(item):
    market = item.get("market")
    name = item.get("name") or item.get("ticker") or item.get("market_code")
    sub = item.get("code") or item.get("ticker") or item.get("market_code") or ""
    price = item.get("price")
    chg = item.get("change_pct")
    cls = _change_class(chg)
    chg_str = f"{chg:+.2f}%" if chg is not None else "-"
    spark = _sparkline(item.get("history"))

    extra_lines = []
    tgt = item.get("target_price")
    if tgt:
        extra_lines.append(f"목표주가 컨센서스(12개월): {_fmt_price(tgt, market)}")
    per, pbr = item.get("per"), item.get("pbr")
    if per or pbr:
        parts = []
        if per:
            parts.append(f"PER {per:.1f}배")
        if pbr:
            parts.append(f"PBR {pbr:.2f}배")
        extra_lines.append(" · ".join(parts))
    extra = "".join(f'<div class="meta">{line}</div>' for line in extra_lines)

    if item.get("error"):
        return f'''<div class="card error">
            <div class="name">{name}</div>
            <div class="meta">데이터를 불러오지 못했어요 ({item["error"]})</div>
        </div>'''

    return f'''<div class="card">
        <div class="card-top">
            <div>
                <div class="name">{name}</div>
                <div class="sub">{sub}</div>
            </div>
            {spark}
        </div>
        <div class="price">{_fmt_price(price, market)}</div>
        <div class="chg {cls}">{chg_str}</div>
        {extra}
    </div>'''


def _holding_card(holding, item, indicators_mod):
    name = holding.get("name") or item.get("name")
    qty = holding["qty"]
    avg_price = holding["avg_price"]
    price = item.get("price")
    market = item.get("market")

    buy_amount = qty * avg_price
    eval_amount = qty * price if price else None
    pnl = (eval_amount - buy_amount) if eval_amount is not None else None
    pnl_pct = (pnl / buy_amount * 100) if pnl is not None and buy_amount else None
    cls = _change_class(pnl)

    trend = ""
    try:
        ev = indicators_mod.evaluate(item)
        if ev.get("signals"):
            trend = ev["signals"][0]
    except Exception:
        pass

    return f'''<div class="hold-card">
        <div class="hold-top">
            <div class="name">{name}</div>
            <div class="chg {cls}">{pnl_pct:+.2f}%</div>
        </div>
        <div class="hold-grid">
            <div><span class="hold-label">보유수량</span>{qty:g}</div>
            <div><span class="hold-label">평가금액</span>{eval_amount:,.0f}원</div>
            <div><span class="hold-label">매수평균가</span>{avg_price:,.0f}원</div>
            <div><span class="hold-label">평가손익</span>{pnl:,.0f}원</div>
        </div>
        {f'<div class="meta">📊 {trend}</div>' if trend else ''}
    </div>'''


def _candidate_card(item, rank):
    market = item.get("market")
    name = item.get("name") or item.get("ticker") or item.get("market_code")
    ev = item["eval"]
    signals_html = "".join(f"<li>{s}</li>" for s in ev["signals"]) or "<li>뚜렷한 신호는 없지만 지켜볼 만해요.</li>"
    return f'''<div class="cand-card">
        <div class="cand-rank">{rank}</div>
        <div class="cand-body">
            <div class="cand-name">{name} <span class="cand-score">신호 점수 {ev["score"]}</span></div>
            <div class="cand-price">{_fmt_price(item.get("price"), market)}
                <span class="chg {_change_class(item.get('change_pct'))}">{item.get('change_pct', 0):+.2f}%</span>
            </div>
            <ul class="signals">{signals_html}</ul>
        </div>
    </div>'''


def _find_item(data, holding):
    lookup = {"coin": "coin", "kr": "kr", "us": "us"}
    bucket = data.get(lookup.get(holding["type"], "coin"), [])
    for item in bucket:
        code = item.get("code") or item.get("ticker") or item.get("market_code")
        if code == holding["code"]:
            return item
    return None


def build_report(data: dict, kr_candidates: list, us_candidates: list, coin_candidates: list,
                  out_dir: str = "reports", holdings: list = None):
    os.makedirs(out_dir, exist_ok=True)
    now = datetime.datetime.now()
    date_str = now.strftime("%Y년 %m월 %d일 (%a)")
    weekday_map = {"Mon": "월", "Tue": "화", "Wed": "수", "Thu": "목", "Fri": "금", "Sat": "토", "Sun": "일"}
    for en, kr in weekday_map.items():
        date_str = date_str.replace(en, kr)

    holdings_html = ""
    if holdings:
        cards = []
        for h in holdings:
            item = _find_item(data, h)
            if item and not item.get("error"):
                cards.append(_holding_card(h, item, indicators))
        holdings_html = "".join(cards)

    kr_cards = "".join(_quote_card(i) for i in data["kr"])
    us_cards = "".join(_quote_card(i) for i in data["us"])
    coin_cards = "".join(_quote_card(i) for i in data["coin"])

    all_candidates = []
    for rank, it in enumerate(kr_candidates + us_candidates + coin_candidates, start=1):
        all_candidates.append((it, rank))
    # re-rank overall by score
    all_candidates.sort(key=lambda x: x[0]["eval"]["score"], reverse=True)
    cand_html = "".join(_candidate_card(it, i + 1) for i, (it, _) in enumerate(all_candidates))

    glossary_html = "".join(
        f'<div class="term"><div class="term-name">{t}</div><div class="term-desc">{d}</div></div>'
        for t, d in GLOSSARY
    )

    html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>오늘의 주식비서 - {date_str}</title>
<style>
:root {{
    --bg: #f5f6f8; --card-bg: #ffffff; --text: #1a1d23; --sub-text: #6b7280;
    --border: #e5e7eb; --up: #d64545; --down: #2f6fed; --flat: #6b7280;
    --accent: #2563eb; --accent-bg: #eef2ff; --warn-bg: #fff7ed; --warn-border: #fed7aa; --warn-text: #9a3412;
}}
@media (prefers-color-scheme: dark) {{
    :root {{ --bg:#111318; --card-bg:#1b1e26; --text:#e8eaed; --sub-text:#9aa0a6; --border:#2b2f3a;
        --up:#ff6b6b; --down:#5b9dff; --flat:#9aa0a6; --accent:#7c9dff; --accent-bg:#1e2436;
        --warn-bg:#2a2115; --warn-border:#4d3418; --warn-text:#f4b473; }}
}}
:root[data-theme="dark"] {{ --bg:#111318; --card-bg:#1b1e26; --text:#e8eaed; --sub-text:#9aa0a6; --border:#2b2f3a;
    --up:#ff6b6b; --down:#5b9dff; --flat:#9aa0a6; --accent:#7c9dff; --accent-bg:#1e2436;
    --warn-bg:#2a2115; --warn-border:#4d3418; --warn-text:#f4b473; }}
:root[data-theme="light"] {{ --bg:#f5f6f8; --card-bg:#ffffff; --text:#1a1d23; --sub-text:#6b7280;
    --border:#e5e7eb; --up:#d64545; --down:#2f6fed; --flat:#6b7280; --accent:#2563eb; --accent-bg:#eef2ff;
    --warn-bg:#fff7ed; --warn-border:#fed7aa; --warn-text:#9a3412; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; font-family: -apple-system, "Pretendard", "Malgun Gothic", sans-serif; background:var(--bg); color:var(--text); }}
.wrap {{ max-width: 980px; margin: 0 auto; padding: 24px 16px 60px; }}
header h1 {{ font-size: 22px; margin: 0 0 4px; }}
header .date {{ color: var(--sub-text); font-size: 14px; margin-bottom: 16px; }}
.disclaimer {{ background: var(--warn-bg); border:1px solid var(--warn-border); color:var(--warn-text);
    padding: 10px 14px; border-radius: 10px; font-size: 13px; margin-bottom: 24px; line-height:1.5; }}
h2.section {{ font-size: 16px; margin: 28px 0 12px; padding-bottom:6px; border-bottom: 2px solid var(--border); }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }}
.card {{ background: var(--card-bg); border:1px solid var(--border); border-radius: 12px; padding: 12px 14px; }}
.card.error {{ opacity: 0.6; }}
.card-top {{ display:flex; justify-content: space-between; align-items:flex-start; gap:8px; }}
.name {{ font-weight: 600; font-size: 14px; }}
.sub {{ color: var(--sub-text); font-size: 11px; }}
.spark {{ width: 90px; height: 30px; flex-shrink:0; }}
.price {{ font-size: 18px; font-weight: 700; margin-top: 8px; }}
.chg {{ font-size: 13px; font-weight: 600; display:inline-block; margin-top:2px; }}
.chg.up {{ color: var(--up); }} .chg.down {{ color: var(--down); }} .chg.flat {{ color: var(--flat); }}
.meta {{ font-size: 12px; color: var(--sub-text); margin-top: 6px; }}
.cand-card {{ display:flex; gap:12px; background: var(--card-bg); border:1px solid var(--border);
    border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; align-items:flex-start; }}
.cand-rank {{ font-size: 20px; font-weight: 800; color: var(--accent); background: var(--accent-bg);
    width: 34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; }}
.cand-name {{ font-weight: 700; font-size: 15px; }}
.cand-score {{ font-size: 11px; color: var(--sub-text); font-weight: 500; margin-left: 6px; }}
.cand-price {{ font-size: 14px; margin: 4px 0 8px; }}
.signals {{ margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; color: var(--text); }}
.term {{ padding: 10px 0; border-bottom: 1px solid var(--border); }}
.term:last-child {{ border-bottom: none; }}
.term-name {{ font-weight: 700; font-size: 13px; color: var(--accent); }}
.term-desc {{ font-size: 13px; color: var(--sub-text); margin-top: 2px; line-height:1.5; }}
.hold-card {{ background: var(--card-bg); border:1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px; }}
.hold-top {{ display:flex; justify-content: space-between; align-items:center; margin-bottom: 8px; }}
.hold-top .name {{ font-size: 15px; font-weight: 700; }}
.hold-top .chg {{ font-size: 15px; }}
.hold-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px 12px;
    font-size: 14px; font-weight: 600; }}
.hold-label {{ display:block; font-size: 11px; font-weight: 400; color: var(--sub-text); }}
footer {{ margin-top: 32px; font-size: 12px; color: var(--sub-text); text-align:center; }}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>📈 오늘의 주식비서</h1>
<div class="date">{date_str} 아침 브리핑</div>
</header>
<div class="disclaimer">⚠️ {DISCLAIMER}</div>

{f'<h2 class="section">💼 내 보유자산</h2>{holdings_html}' if holdings_html else ''}

<h2 class="section">🌟 오늘의 주목 후보 (기업 분석 + 차트 신호 종합)</h2>
<p style="color:var(--sub-text); font-size:12px; margin:-4px 0 12px;">🏢 기업 재무/실적 분석 · 📊 차트(가격·거래량) 흐름 · 🎯 목표주가</p>
{cand_html or '<p style="color:var(--sub-text); font-size:13px;">오늘은 뚜렷한 후보가 없어요.</p>'}

<h2 class="section">🇰🇷 한국 주식 관심종목</h2>
<div class="grid">{kr_cards}</div>

<h2 class="section">🇺🇸 미국 주식 관심종목</h2>
<div class="grid">{us_cards}</div>

<h2 class="section">🪙 코인 관심목록</h2>
<div class="grid">{coin_cards}</div>

<h2 class="section">📘 초보자를 위한 용어 설명</h2>
<div class="glossary">{glossary_html}</div>

<footer>주식비서 · 데이터 출처: KRX(pykrx), Yahoo Finance, Upbit · 생성 시각 {now.strftime('%Y-%m-%d %H:%M')}</footer>
</div>
</body>
</html>"""

    fname_daily = os.path.join(out_dir, f"report_{now.strftime('%Y%m%d')}.html")
    fname_latest = os.path.join(out_dir, "latest.html")
    for path in (fname_daily, fname_latest):
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)

    return fname_daily, fname_latest


def build_summary_text(kr_candidates, us_candidates, coin_candidates, top_n=3):
    """카카오톡 등으로 보낼 200자 이내 요약 텍스트를 만듭니다."""
    now = datetime.datetime.now()
    date_str = now.strftime("%m/%d")
    weekday_map = {"Mon": "월", "Tue": "화", "Wed": "수", "Thu": "목", "Fri": "금", "Sat": "토", "Sun": "일"}
    wd = weekday_map[now.strftime("%a")]

    all_candidates = sorted(
        kr_candidates + us_candidates + coin_candidates,
        key=lambda x: x["eval"]["score"], reverse=True,
    )[:top_n]

    lines = [f"\U0001F4C8 주식비서 {date_str}({wd}) 아침브리핑", "오늘의 주목후보 TOP{}".format(len(all_candidates))]
    for i, it in enumerate(all_candidates, start=1):
        market = it.get("market")
        name = it.get("name") or it.get("ticker") or it.get("market_code")
        price = _fmt_price(it.get("price"), market)
        chg = it.get("change_pct", 0) or 0
        target = it.get("target_price")
        target_part = f"→12개월목표{_fmt_price(target, market)}" if target else ""
        lines.append(f"{i}.{name} {price}{target_part}({chg:+.1f}%)")
    lines.append("※목표가는 12개월 전망, 투자조언 아님")

    text = "\n".join(lines)
    if len(text) > 200:
        # 너무 길면 후보 수를 줄여 재구성
        return build_summary_text(kr_candidates, us_candidates, coin_candidates, top_n=max(1, top_n - 1))
    return text


def build_holdings_summary(data: dict, holdings: list):
    """보유자산 평가손익 요약 텍스트 (카카오톡용, 200자 이내)."""
    if not holdings:
        return None
    lines = ["\U0001F4BC 내 보유자산 현황"]
    total_pnl = 0
    any_ok = False
    for h in holdings:
        item = _find_item(data, h)
        if not item or item.get("error"):
            continue
        any_ok = True
        price = item.get("price")
        buy_amount = h["qty"] * h["avg_price"]
        eval_amount = h["qty"] * price
        pnl = eval_amount - buy_amount
        pnl_pct = pnl / buy_amount * 100 if buy_amount else 0
        total_pnl += pnl
        name = h.get("name") or item.get("name")
        lines.append(f"{name} {eval_amount:,.0f}원 ({pnl_pct:+.1f}%)")
    if not any_ok:
        return None
    lines.append(f"합계손익 {total_pnl:+,.0f}원")
    text = "\n".join(lines)
    return text[:200]
