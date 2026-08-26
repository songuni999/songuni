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
    ("최근 3개월 변동률", "최근 약 3개월간 주가가 실제로 얼마나 오르내렸는지 보여주는 과거 실적이에요. 목표주가(12개월 전망)와 달리 미래 예측이 아니라 이미 일어난 일이에요."),
    ("가중평균 매수단가", "여러 번에 나눠서 산 경우(분할매수), 각 차수의 '가격×수량'을 다 더해서 전체 수량으로 나눈 평균 매수가예요. 실제 계좌에 찍히는 평단가와 같은 계산 방식이에요."),
    ("증권거래세", "국내 주식을 팔 때 매도금액에서 자동으로 떼는 세금이에요(2025년 기준 약 0.18%). 미국주식·코인에는 이 세금이 없어요."),
]

FAQ = [
    ("요즘 코인에 돈이 몰리는데, 코인에 투자하는 게 나을까요?",
     "코인은 주식보다 변동성이 훨씬 커요 — 하루에 ±10~20%씩 움직이는 일도 흔해요. '지금 몰린다'는 건 이미 많이 오른 뒤일 수도 있어서, 뒤늦게 따라 들어가면(추격매수) 고점에 물릴 위험도 커요. "
     "코인이냐 주식이냐보다, 내가 잃어도 괜찮은 돈이 얼마인지 · 변동성을 얼마나 견딜 수 있는지에 따라 비중을 정하는 게 먼저예요. 어느 한쪽에 몰빵하기보다 나눠 담는 걸 많이 권해요."),
    ("주식이랑 코인 중에 뭐가 더 안전해요?",
     "일반적으로 코인 > 성장주 > 대형 우량주 > 채권/예금 순으로 변동성(위험)이 커요. '안전'의 기준은 사람마다 달라서, 원금을 최대한 지키고 싶으면 변동성 낮은 자산 비중을 높이고, 손실을 감수하고서라도 수익을 노린다면 변동성 높은 자산 비중을 늘리는 식으로 접근해요."),
    ("지금 사도 될까요? 언제 사는 게 좋아요?",
     "정확한 저점/고점은 아무도 미리 알 수 없어요. 그래서 초보자에게는 한 번에 몰아서 사기보다, 여러 번에 나눠서 사는 분할매수(DCA)가 타이밍 실수의 리스크를 줄여주는 방법으로 많이 소개돼요. 이 리포트의 RSI·이동평균 신호는 '지금 흐름이 어떤지' 참고용이지, 매수 타이밍을 정해주는 건 아니에요."),
    ("목표주가에 도달하면 무조건 오르나요?",
     "아니요. 목표주가는 증권사 애널리스트들이 실적 전망을 바탕으로 계산한 '예상치'일 뿐이에요. 실제로는 예상보다 실적이 나빠지거나 시장 분위기가 바뀌면 목표주가와 전혀 다르게 움직이는 경우도 많아요. 참고 지표 중 하나로만 보세요."),
    ("분산투자가 뭐고, 왜 해야 해요?",
     "한 종목/자산에 모든 돈을 넣지 않고 여러 종목·자산군(주식, 코인, 현금 등)에 나눠 담는 걸 말해요. 하나가 크게 떨어져도 전체 자산이 한 번에 무너지지 않게 막아주는 효과가 있어요. '몰빵'의 반대 개념이라고 보시면 돼요."),
    ("손절/익절이 뭐예요?",
     "손절은 손실이 더 커지기 전에 정해둔 가격에서 미리 파는 것, 익절은 목표한 만큼 이익이 나면 파는 거예요. 둘 다 '감정적으로 물타기하거나 계속 들고 있다가 더 크게 잃는 것'을 막기 위한 원칙이에요. 얼마에 팔지는 투자 전에 미리 정해두는 걸 많이 권해요."),
    ("이 리포트만 보고 투자해도 되나요?",
     "이 리포트는 공개 데이터를 모아서 보여주는 참고 자료예요. 회사 뉴스, 산업 전망, 거시경제 상황처럼 숫자에 안 잡히는 정보도 많으니, 이것만으로 판단하기보다 여러 정보를 같이 참고하시는 걸 권해요. 그리고 최종 투자 판단과 책임은 항상 본인에게 있어요."),
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
    three_mo = indicators.three_month_change(item.get("history"))
    if three_mo is not None:
        extra_lines.append(f"최근 3개월 {three_mo:+.1f}%")
    off_high = indicators.pct_off_high(item)
    if off_high is not None:
        high_label = "조회기간 고점" if item.get("week52_is_approx") else "52주 고점"
        extra_lines.append(f"{high_label} 대비 {off_high:+.1f}%")
    extra = "".join(f'<div class="meta">{line}</div>' for line in extra_lines)

    if item.get("error"):
        return f'''<div class="card error">
            <div class="name">{name}</div>
            <div class="meta">데이터를 불러오지 못했어요 ({item["error"]})</div>
        </div>'''

    live_attr = f' data-live-market="{sub}"' if market == "COIN" else ""
    return f'''<div class="card"{live_attr}>
        <div class="card-top">
            <div>
                <div class="name">{name}</div>
                <div class="sub">{sub}</div>
            </div>
            {spark}
        </div>
        <div class="price" data-field="price">{_fmt_price(price, market)}</div>
        <div class="chg {cls}" data-field="chg">{chg_str}</div>
        {extra}
    </div>'''


KR_SELL_TAX_RATE = 0.0018  # 국내 주식 매도 시 증권거래세(2025년 기준 0.18%). 코인/미국주식은 미적용.


def normalize_holding(holding):
    """차수(lots)로 나눠 입력된 경우 가중평균 매수단가를 계산합니다. 단일 qty/avg_price 입력도 그대로 지원."""
    lots = holding.get("lots")
    if lots:
        total_qty = sum(l["qty"] for l in lots)
        total_cost = sum(l["qty"] * l["price"] for l in lots)
        avg_price = total_cost / total_qty if total_qty else 0
        return total_qty, avg_price, len(lots)
    return holding["qty"], holding["avg_price"], 1


def _holding_card(holding, item, indicators_mod):
    name = holding.get("name") or item.get("name")
    qty, avg_price, lot_count = normalize_holding(holding)
    price = item.get("price")
    market = item.get("market")

    buy_amount = qty * avg_price
    eval_amount = qty * price if price else None
    pnl = (eval_amount - buy_amount) if eval_amount is not None else None
    pnl_pct = (pnl / buy_amount * 100) if pnl is not None and buy_amount else None
    cls = _change_class(pnl)

    tax_note = ""
    if holding.get("type") == "kr" and eval_amount is not None:
        tax = eval_amount * KR_SELL_TAX_RATE
        net_pnl = pnl - tax
        tax_note = f'<div class="meta">매도 시 거래세 약 {tax:,.0f}원 차감 → 세후 손익 {net_pnl:,.0f}원</div>'

    lot_note = f'<div class="meta">분할매수 {lot_count}차 · 가중평균 매수단가 적용</div>' if lot_count > 1 else ""

    trend = ""
    try:
        ev = indicators_mod.evaluate(item)
        if ev.get("signals"):
            trend = ev["signals"][0]
    except Exception:
        pass

    off_high = indicators_mod.pct_off_high(item)
    high_note = ""
    if off_high is not None:
        high_label = "조회기간 고점" if item.get("week52_is_approx") else "52주 고점"
        high_note = f'<div class="meta">{high_label} 대비 {off_high:+.1f}%</div>'

    live_attr = ""
    if market == "COIN":
        market_code = item.get("market_code") or holding.get("code")
        live_attr = f' data-live-market="{market_code}" data-qty="{qty}" data-avg-price="{avg_price}"'

    return f'''<div class="hold-card"{live_attr}>
        <div class="hold-top">
            <div class="name">{name}</div>
            <div class="chg {cls}" data-field="pnl-pct">{pnl_pct:+.2f}%</div>
        </div>
        <div class="hold-grid">
            <div><span class="hold-label">보유수량</span>{qty:g}</div>
            <div><span class="hold-label">평가금액</span><span data-field="eval">{eval_amount:,.0f}</span>원</div>
            <div><span class="hold-label">매수평균가</span>{avg_price:,.0f}원</div>
            <div><span class="hold-label">평가손익</span><span data-field="pnl">{pnl:,.0f}</span>원</div>
        </div>
        {lot_note}
        {tax_note}
        {high_note}
        {f'<div class="meta">{trend}</div>' if trend else ''}
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

    faq_html = "".join(
        f'<div class="faq-item"><div class="faq-q">Q. {q}</div><div class="faq-a">{a}</div></div>'
        for q, a in FAQ
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
.faq-item {{ background: var(--card-bg); border:1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px; }}
.faq-q {{ font-weight: 700; font-size: 14px; margin-bottom: 6px; }}
.faq-a {{ font-size: 13px; color: var(--sub-text); line-height: 1.6; }}
.hold-card {{ background: var(--card-bg); border:1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px; }}
.hold-top {{ display:flex; justify-content: space-between; align-items:center; margin-bottom: 8px; }}
.hold-top .name {{ font-size: 15px; font-weight: 700; }}
.hold-top .chg {{ font-size: 15px; }}
.hold-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px 12px;
    font-size: 14px; font-weight: 600; }}
.hold-label {{ display:block; font-size: 11px; font-weight: 400; color: var(--sub-text); }}
footer {{ margin-top: 32px; font-size: 12px; color: var(--sub-text); text-align:center; }}
.header-row {{ display:flex; justify-content: space-between; align-items:flex-start; gap: 10px; flex-wrap: wrap; }}
.refresh-btn {{ background: var(--accent-bg); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    white-space: nowrap; }}
.refresh-btn:active {{ opacity: 0.7; }}
.refresh-btn[disabled] {{ opacity: 0.5; cursor: default; }}
.refresh-status {{ font-size: 12px; color: var(--sub-text); margin-top: 6px; min-height: 16px; }}
.flash {{ animation: flash-bg 0.8s ease; }}
@keyframes flash-bg {{ 0% {{ background: var(--accent-bg); }} 100% {{ background: transparent; }} }}
</style>
</head>
<body>
<div class="wrap">
<header>
<div class="header-row">
    <div>
        <h1>📈 오늘의 주식비서</h1>
        <div class="date">{date_str} 아침 브리핑</div>
    </div>
    <button id="refresh-btn" class="refresh-btn" onclick="refreshCoinPrices()">🔄 코인 실시간 새로고침</button>
</div>
<div id="refresh-status" class="refresh-status"></div>
</header>
<div class="disclaimer">⚠️ {DISCLAIMER} 코인 시세는 새로고침 버튼으로 실시간 갱신할 수 있어요(업비트 기준). 한국·미국 주식은 데이터 제공처 정책상 실시간 갱신이 안 되고, 매일 아침 리포트 생성 시점 시세로 고정돼요.</div>

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

<h2 class="section">💬 자주 묻는 질문</h2>
<p style="color:var(--sub-text); font-size:12px; margin:-4px 0 12px;">"어느 쪽에 투자하세요"가 아니라, 판단에 참고할 관점을 정리한 답변이에요. 더 궁금한 게 있으면 언제든 클로드(Claude)한테 채팅으로 물어보세요.</p>
<div class="faq">{faq_html}</div>

<h2 class="section">📘 초보자를 위한 용어 설명</h2>
<div class="glossary">{glossary_html}</div>

<footer>주식비서 · 데이터 출처: KRX(pykrx), Yahoo Finance, Upbit · 생성 시각 {now.strftime('%Y-%m-%d %H:%M')}</footer>
</div>
<script>
function fmtCoinPrice(p) {{
    if (p >= 1) return p.toLocaleString('ko-KR', {{maximumFractionDigits: 0}}) + '원';
    return p.toLocaleString('ko-KR', {{maximumFractionDigits: 4}}) + '원';
}}

function fmtSignedWon(n) {{
    const sign = n >= 0 ? '+' : '';
    return sign + Math.round(n).toLocaleString('ko-KR') + '원';
}}

function flashEl(el) {{
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('flash');
}}

async function refreshCoinPrices() {{
    const btn = document.getElementById('refresh-btn');
    const status = document.getElementById('refresh-status');
    const liveEls = document.querySelectorAll('[data-live-market]');
    if (liveEls.length === 0) {{
        status.textContent = '실시간 갱신 대상 코인이 없어요.';
        return;
    }}
    const markets = [...new Set([...liveEls].map(el => el.dataset.liveMarket))];

    btn.disabled = true;
    btn.textContent = '⏳ 불러오는 중...';
    status.textContent = '';

    try {{
        const resp = await fetch('https://api.upbit.com/v1/ticker?markets=' + markets.join(','));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const byMarket = {{}};
        data.forEach(d => {{ byMarket[d.market] = d; }});

        liveEls.forEach(el => {{
            const d = byMarket[el.dataset.liveMarket];
            if (!d) return;
            const price = d.trade_price;
            const chgPct = d.signed_change_rate * 100;

            const priceEl = el.querySelector('[data-field="price"]');
            if (priceEl) {{
                priceEl.textContent = fmtCoinPrice(price);
                flashEl(priceEl);
            }}
            const chgEl = el.querySelector('[data-field="chg"]');
            if (chgEl) {{
                chgEl.textContent = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%';
                chgEl.classList.remove('up', 'down', 'flat');
                chgEl.classList.add(chgPct > 0 ? 'up' : (chgPct < 0 ? 'down' : 'flat'));
            }}

            // 보유자산 카드: 평가금액/손익/손익률 재계산
            if (el.dataset.qty !== undefined) {{
                const qty = parseFloat(el.dataset.qty);
                const avgPrice = parseFloat(el.dataset.avgPrice);
                const evalAmount = qty * price;
                const buyAmount = qty * avgPrice;
                const pnl = evalAmount - buyAmount;
                const pnlPct = buyAmount ? (pnl / buyAmount * 100) : 0;

                const evalEl = el.querySelector('[data-field="eval"]');
                if (evalEl) {{ evalEl.textContent = Math.round(evalAmount).toLocaleString('ko-KR'); flashEl(evalEl.parentElement); }}
                const pnlEl = el.querySelector('[data-field="pnl"]');
                if (pnlEl) {{ pnlEl.textContent = fmtSignedWon(pnl); flashEl(pnlEl.parentElement); }}
                const pnlPctEl = el.querySelector('[data-field="pnl-pct"]');
                if (pnlPctEl) {{
                    pnlPctEl.textContent = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%';
                    pnlPctEl.classList.remove('up', 'down', 'flat');
                    pnlPctEl.classList.add(pnlPct > 0 ? 'up' : (pnlPct < 0 ? 'down' : 'flat'));
                }}
            }}
        }});

        const now = new Date();
        status.textContent = '마지막 실시간 갱신: ' + now.toLocaleTimeString('ko-KR') + ' (업비트 기준)';
    }} catch (e) {{
        status.textContent = '실시간 시세를 불러오지 못했어요 (' + e.message + ')';
    }} finally {{
        btn.disabled = false;
        btn.textContent = '🔄 코인 실시간 새로고침';
    }}
}}
</script>
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
        qty, avg_price, _ = normalize_holding(h)
        buy_amount = qty * avg_price
        eval_amount = qty * price
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
