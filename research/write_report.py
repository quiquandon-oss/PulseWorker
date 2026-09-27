"""
Renders research/output/report.json (produced by run_analysis.py) into
the final human-readable deliverables:

  - research/output/report.md   -- the full research report (9 required
    sections: executive summary + classification, data-source inventory,
    charts, correlation/lag tables, down-day comparisons, ETF-flow
    analysis, robustness across baskets, rotation-vs-correlation
    conclusion, and a pointer to the reproducible script/tests).
  - research/output/charts/*.svg -- cumulative-return comparison charts
    (basket vs BTC, basket vs ETH, for each of the three baskets),
    rendered as plain hand-built SVG so no charting dependency is added.

This script performs NO analysis of its own -- it only formats numbers
that run_analysis.py already computed. Keeping formatting and analysis
in separate files means a report layout change can never accidentally
alter a statistical result.
"""

import json
import os
import sys

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
CHARTS_DIR = os.path.join(OUTPUT_DIR, "charts")

BASKET_LABELS = {
    "A_full_nine": "Basket A - full nine (NVDA, AVGO, AAPL, MSFT, GOOGL, AMZN, META, TSLA, SPCX)",
    "B_ex_spcx": "Basket B - eight established names (ex-SPCX)",
    "C_ai_infra": "Basket C - AI-infrastructure-sensitive (NVDA, AVGO, MSFT, GOOGL, AMZN)",
}


def fmt_pct(x, decimals=2):
    return "n/a" if x is None else f"{x * 100:.{decimals}f}%"


def fmt_num(x, decimals=3):
    return "n/a" if x is None else f"{x:.{decimals}f}"


def fmt_ci(ci):
    if ci is None:
        return "n/a"
    p, lo, hi = ci
    return f"{p*100:.1f}% [{lo*100:.1f}%, {hi*100:.1f}%]"


def render_svg_chart(chart_series, basket_label, crypto_name, title):
    if not chart_series:
        return f'<svg width="640" height="60"><text x="10" y="30">No overlapping data available for {title}.</text></svg>'
    width, height, pad = 640, 320, 48
    dates = [p["date"] for p in chart_series]
    basket_vals = [p["basket_cum_return"] for p in chart_series]
    crypto_vals = [p["crypto_cum_return"] for p in chart_series]
    all_vals = basket_vals + crypto_vals
    vmin, vmax = min(all_vals), max(all_vals)
    if vmin == vmax:
        vmin -= 0.01
        vmax += 0.01
    span = vmax - vmin
    n = len(chart_series)

    def x_at(i):
        return pad + (i / max(1, n - 1)) * (width - 2 * pad)

    def y_at(v):
        return height - pad - ((v - vmin) / span) * (height - 2 * pad)

    def polyline(vals, color):
        points = " ".join(f"{x_at(i):.1f},{y_at(v):.1f}" for i, v in enumerate(vals))
        return f'<polyline fill="none" stroke="{color}" stroke-width="2" points="{points}" />'

    zero_y = y_at(0.0)
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<rect width="{width}" height="{height}" fill="white" />',
        f'<text x="{pad}" y="20" font-family="sans-serif" font-size="14" fill="#111">{title}</text>',
        f'<line x1="{pad}" y1="{zero_y:.1f}" x2="{width-pad}" y2="{zero_y:.1f}" stroke="#ccc" stroke-dasharray="4,3" />',
        polyline(basket_vals, "#c0392b"),
        polyline(crypto_vals, "#2980b9"),
        f'<text x="{pad}" y="{height-20}" font-family="sans-serif" font-size="11" fill="#555">{dates[0]} to {dates[-1]} ({n} aligned trading days)</text>',
        f'<rect x="{width-190}" y="30" width="10" height="10" fill="#c0392b" /><text x="{width-175}" y="39" font-family="sans-serif" font-size="11">{basket_label}</text>',
        f'<rect x="{width-190}" y="46" width="10" height="10" fill="#2980b9" /><text x="{width-175}" y="55" font-family="sans-serif" font-size="11">{crypto_name} cumulative return</text>',
        "</svg>",
    ]
    return "\n".join(svg)


def write_charts(report):
    os.makedirs(CHARTS_DIR, exist_ok=True)
    chart_paths = {}
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        series = result.get("chart_series", [])
        title = f"{BASKET_LABELS.get(basket_key, basket_key)} vs {crypto_name}"
        svg = render_svg_chart(series, basket_key, crypto_name, title)
        fname = f"{basket_key}_{crypto_name}.svg"
        with open(os.path.join(CHARTS_DIR, fname), "w") as f:
            f.write(svg)
        chart_paths[key] = f"charts/{fname}"
    return chart_paths


def render_data_inventory(report):
    lines = ["## 2. Data-source inventory and limitations", ""]
    lines.append(f"- **BTC**: {report['btc_coverage']['n_days']} daily observations, "
                 f"{report['btc_coverage']['min_date']} to {report['btc_coverage']['max_date']}. "
                 "Source: CryptoPulse production D1 database (`sentiment-history`, table `btc_data`), "
                 "not an exchange-published close -- see `research/data/btc_daily.json` for the exact "
                 "extraction method and disclosed collection-frequency artifacts.")
    lines.append(f"- **ETH**: {report['eth_coverage']['n_days']} daily observations, "
                 f"{report['eth_coverage']['min_date']} to {report['eth_coverage']['max_date']}. "
                 "Same source/method as BTC (`eth_data` table); ETH's shorter, sparser history is the "
                 "binding constraint on how far back this entire study can go.")
    lines.append("- **Equity (9-basket) daily prices**: fetched live from Yahoo Finance "
                 "(`query1.finance.yahoo.com/v8/finance/chart`) at analysis time -- NOT the existing "
                 "`/stock-proxy` endpoint, which was confirmed by reading `worker.js` to expose only a "
                 "close-only, 3-month, non-cached, non-persisted series unsuitable for this study. "
                 "`/stock-proxy` itself was not modified.")
    lines.append("- **Macro controls (S&P 500, US dollar index, 10-year Treasury yield)**: fetched the "
                 "same way, tickers ^GSPC, DX-Y.NYB, ^TNX.")
    for sym, cov in report["symbol_coverage"].items():
        lines.append(f"  - `{sym}`: {cov['n_days']} days, {cov['min_date']} to {cov['max_date']}")
    lines.append("- **US spot Bitcoin ETF net flows**: " + (
        f"evidence gap -- {report['etf_flows_gap']}" if report.get("etf_flows_gap")
        else f"{report['etf_flows_n_days']} daily observations retrieved (best-effort public source; "
             "treat as informational, not authoritative)."))
    lines.append("- No stock/equity historical table, ETF-flow table, or macro-data table exists anywhere "
                 "in the shared production D1 schema (confirmed by enumerating `sqlite_master`); all "
                 "equity/macro/ETF data above come from this study's own fetch, not from production storage.")
    return "\n".join(lines)


def render_classification(report):
    lines = ["## 1. Executive summary and evidence classification", ""]
    for crypto in ("BTC", "ETH"):
        c = report["classifications"][crypto]
        lines.append(f"### {crypto}: **{c['label']}**")
        for r in c["reasons"]:
            lines.append(f"- {r}")
        lines.append("")
    lines.append("These are evidence classifications describing what the available data show, "
                 "not trading recommendations or price predictions.")
    return "\n".join(lines)


def render_charts_section(report, chart_paths):
    lines = ["## 3. Cumulative return charts", ""]
    for key, path in chart_paths.items():
        basket_key, crypto_name = key.split("|")
        lines.append(f"**{BASKET_LABELS.get(basket_key, basket_key)} vs {crypto_name}**")
        lines.append(f"![{key}]({path})")
        lines.append("")
    return "\n".join(lines)


def render_correlation_and_lag_tables(report):
    lines = ["## 4. Correlation and lagged-response tables", ""]
    lines.append("| Basket | Crypto | Contemp. r | n | p | BH-adj p | reject@0.05 |")
    lines.append("|---|---|---|---|---|---|---|")
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        cc = result["contemporaneous_correlation"]
        bh = report["bh_correction"].get(f"{basket_key}|{crypto_name}|contemporaneous", (None, False))
        lines.append(f"| {basket_key} | {crypto_name} | {fmt_num(cc['r'])} | {cc['n']} | "
                     f"{fmt_num(cc['p_value'], 4)} | {fmt_num(bh[0], 4)} | {bh[1]} |")
    lines.append("")
    lines.append("| Basket | Crypto | Lag (equity trading days) | r | n | p | BH-adj p | reject@0.05 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        for lag, lag_result in result["lagged_response"].items():
            bh = report["bh_correction"].get(f"{basket_key}|{crypto_name}|lag{lag}", (None, False))
            lines.append(f"| {basket_key} | {crypto_name} | {lag} | {fmt_num(lag_result['r'])} | "
                         f"{lag_result['n']} | {fmt_num(lag_result['p_value'], 4)} | "
                         f"{fmt_num(bh[0], 4)} | {bh[1]} |")
    lines.append("")
    lines.append("_Lag convention: \"k equity trading days ahead\" means the crypto return is measured "
                 "from equity trading-day close i to trading-day close i+k, a cumulative return over "
                 "whatever calendar span (including weekends/holidays) separates them -- not k calendar "
                 "days. p-values use a normal approximation (Fisher z-transform), not exact Student-t; "
                 "documented in `stats_lib.py`. BH = Benjamini-Hochberg correction across all "
                 "contemporaneous + lagged tests in this report.**")
    return "\n".join(lines)


def render_down_day_section(report):
    lines = ["## 5. Down-day vs unconditional return comparison", ""]
    lines.append("| Basket | Crypto | Horizon | Weak n | Weak mean fwd ret | Weak %>0 (Wilson CI) | "
                 "Unconditional n | Unconditional mean | Unconditional %>0 (Wilson CI) | Strong mean | "
                 "weak-vs-uncond p |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        for h, hr in result["down_day_study"]["horizons"].items():
            wvu = hr["weak_vs_unconditional"]
            lines.append(
                f"| {basket_key} | {crypto_name} | {h}d | {hr['weak_n']} | "
                f"{fmt_pct(hr['weak_mean_fwd_return'])} | {fmt_ci(hr['weak_pct_positive_wilson_ci'])} | "
                f"{hr['unconditional_n']} | {fmt_pct(hr['unconditional_mean_fwd_return'])} | "
                f"{fmt_ci(hr['unconditional_pct_positive_wilson_ci'])} | "
                f"{fmt_pct(hr['strong_mean_fwd_return'])} | "
                f"{fmt_num(wvu['p_value'], 4) if wvu else 'n/a'} |"
            )
    return "\n".join(lines)


def render_etf_section(report):
    lines = ["## 6. ETF-flow analysis", ""]
    if report.get("etf_flows_gap") or not report.get("etf_flow_response"):
        lines.append(f"**Evidence gap**: {report.get('etf_flows_gap') or 'no ETF flow data available'}. "
                     "Per the task instructions, no flow figures are fabricated or inferred from price "
                     "action; this is reported as a gap in evidence, not a null result.")
        return "\n".join(lines)
    lines.append("| Basket | Horizon | Weak n | Weak mean flow (US$mm) | Unconditional n | "
                 "Unconditional mean flow (US$mm) | p |")
    lines.append("|---|---|---|---|---|---|---|")
    for basket_key, br in report["etf_flow_response"].items():
        for h, hr in br["horizons"].items():
            wvu = hr["weak_vs_unconditional"]
            lines.append(f"| {basket_key} | {h}d | {hr['weak_n']} | {fmt_num(hr['weak_mean_flow_musd'], 1)} | "
                         f"{hr['unconditional_n']} | {fmt_num(hr['unconditional_mean_flow_musd'], 1)} | "
                         f"{fmt_num(wvu['p_value'], 4) if wvu else 'n/a'} |")
    lines.append("")
    lines.append("Flow data source is a best-effort public fetch (see data-source inventory); treat as "
                 "informational. Flow figures are distinct from, and never derived from, BTC price or "
                 "volume changes.")
    return "\n".join(lines)


def render_descriptive_section(report):
    lines = ["## Appendix: descriptive window returns", ""]
    lines.append("| Basket | Crypto | Nominal window | Basket cum. return (n days) | "
                 "Crypto cum. return (n days) | truncated? |")
    lines.append("|---|---|---|---|---|---|")
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        for w, wr in result["descriptive"].items():
            lines.append(f"| {basket_key} | {crypto_name} | {w}d | "
                         f"{fmt_pct(wr['basket_cum_return'])} ({wr['basket_n_days_used']}) | "
                         f"{fmt_pct(wr['crypto_cum_return'])} ({wr['crypto_n_days_used']}) | "
                         f"{wr['truncated']} |")
    return "\n".join(lines)


def render_macro_section(report):
    lines = ["## 7. Macro-controlled regression (before / after S&P 500, USD index, 10Y yield)", ""]
    lines.append("| Basket | Crypto | n | Basket coef (before) | p (before) | Basket coef (after) | p (after) |")
    lines.append("|---|---|---|---|---|---|---|")
    for key, result in report["results"].items():
        basket_key, crypto_name = key.split("|")
        m = result["macro_controlled_regression"]
        note = f" _{m['note']}_" if m.get("note") else ""
        lines.append(f"| {basket_key} | {crypto_name} | {m['n']} | {fmt_num(m['before_basket_coef'])} | "
                     f"{fmt_num(m['before_p_value'], 4)} | {fmt_num(m['after_basket_coef'])} | "
                     f"{fmt_num(m['after_basket_p_value'], 4)} |{note}")
    return "\n".join(lines)


def render_discussion_and_limitations():
    return """## 8. Correlation vs. capital rotation: required discussion

- **Reverse causality**: a crypto rally attracting speculative flows out
  of high-beta AI/tech names (rather than AI weakness pushing capital
  into crypto) would produce the same statistical signature. Nothing in
  this study's design -- contemporaneous correlation, lead-lag tests, or
  the down-day study -- can rule this direction out on its own; only the
  lagged tests (basket move BEFORE crypto move) offer any directional
  evidence, and even there, both assets can simply be reacting to the
  same overnight news with different speeds.
- **Common liquidity / risk-factor effects**: broad risk-on/risk-off
  regimes move both speculative tech equities and crypto together, which
  would produce a POSITIVE (not negative) contemporaneous correlation,
  the opposite of a pure-rotation signature; but if rotation and a
  shared risk factor operate simultaneously, they can partially offset
  or mask each other in a naive correlation. This is exactly what the
  macro-controlled regression (Section 7) is designed to isolate: rotation
  evidence must survive controlling for the S&P 500, US dollar and
  Treasury-yield moves that proxy for the shared factor.
- **Market-regime dependence**: this entire dataset spans a single ~4-5
  month window (mid-2026). Any relationship found may be specific to that
  period's regime (rate expectations, AI-capex narrative, crypto ETF
  flows at the time) and may not generalize.
- **Survivorship / constituent-selection bias**: the nine-stock basket
  was chosen by CryptoPulse's own product logic (`NINE_MAG_SYMBOLS` in
  `worker.js`), not by this study, and is not a neutral or exhaustive
  proxy for "AI capital." It overweights a handful of large-cap US names,
  excludes non-US and private AI investment entirely, and its
  composition could itself reflect survivorship (names added/kept because
  they performed well).
- **The nine-stock basket as an AI-investment proxy**: even setting
  selection bias aside, equity price moves in these nine names conflate
  many unrelated drivers (idiosyncratic earnings, general tech
  sentiment, index-fund flows) with anything specifically "AI capital"
  related. A basket-level price move is, at best, a noisy, indirect proxy
  for the hypothesis being tested.
- **Correlation is not observed capital movement**: even a statistically
  robust, macro-control-surviving, basket-robust relationship shows that
  basket weakness is FOLLOWED BY crypto strength (and, where data exist,
  by ETF inflows) -- it does not show that the same investors, or the
  same dollars, moved from one to the other. No claim of an individual
  capital-movement event is made anywhere in this report.
"""


def render_report(report, chart_paths):
    sections = [
        "# CryptoPulse V1 Research: Does AI Capital Rotate into Crypto?",
        "",
        f"_Generated {report['generated_utc']}. Research-only; no production code, tables, or "
        "deployment were changed. See `research/run_analysis.py --fetch-live` for the reproducible "
        "pipeline and `research/test_*.py` for the deterministic test suite._",
        "",
        render_classification(report),
        render_data_inventory(report),
        render_charts_section(report, chart_paths),
        render_correlation_and_lag_tables(report),
        render_down_day_section(report),
        render_etf_section(report),
        "## 9. Robustness across basket definitions",
        "",
        "See the per-basket rows in every table above (Basket A = full nine, B = ex-SPCX, "
        "C = AI-infrastructure-sensitive) -- robustness is reported by direct comparison across rows, "
        "not summarized separately, so that no basket's result can be selectively highlighted.",
        "",
        render_macro_section(report),
        render_discussion_and_limitations(),
        render_descriptive_section(report),
    ]
    return "\n\n".join(sections)


def main():
    report_path = os.path.join(OUTPUT_DIR, "report.json")
    if not os.path.exists(report_path):
        print(f"No {report_path} -- run run_analysis.py first.", file=sys.stderr)
        sys.exit(1)
    with open(report_path) as f:
        report = json.load(f)
    chart_paths = write_charts(report)
    md = render_report(report, chart_paths)
    out_path = os.path.join(OUTPUT_DIR, "report.md")
    with open(out_path, "w") as f:
        f.write(md)
    print(f"Wrote {out_path} and {len(chart_paths)} charts under {CHARTS_DIR}")


if __name__ == "__main__":
    main()
