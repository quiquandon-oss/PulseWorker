"""
Orchestration and report writer for "CryptoPulse V1 Research: Does AI
Capital Rotate into Crypto?"

This script is RESEARCH-ONLY. It does not touch worker.js, /stock-proxy,
the Sentiment composite, the Regime Scorecard, or any production D1 table
(research_analyses/research_hypotheses included -- this study's outputs
are written only under research/output/, a plain local directory, never
to a database).

Data availability, by construction of this environment (documented fully
in the final report's "Data sources and limitations" section):

  - BTC/ETH price history: real, pulled directly from the shared
    production D1 database (research/data/btc_daily.json,
    eth_daily.json) -- ~145 and ~131 calendar days respectively, ending
    2026-09-27. This is a hard ceiling on every window/lag/quantile
    analysis below: there is no BTC/ETH history before ~2026-05.

  - Equity (9-basket) and macro (S&P 500, USD index, 10Y yield) price
    history: fetched live from Yahoo Finance via data_sources.py. The
    interactive sandbox this script was authored in cannot reach Yahoo
    Finance (egress blocked), so this script is designed to be dispatched
    from a GitHub Actions runner (which has normal internet access) via
    `python research/run_analysis.py --fetch-live`. Running with
    `--equity-data-file` instead loads a previously-fetched JSON cache,
    for reproducibility without re-fetching.

  - US spot Bitcoin ETF net flows: best-effort fetch from a public
    source (data_sources.fetch_btc_etf_flows). If unreachable or
    unparseable, this is reported as an explicit evidence gap, per the
    task's instruction never to infer flows from price action.

Every quantitative choice with more than one reasonable convention
(basket missing-data policy, "k equity trading days ahead", the evidence
classification thresholds) is documented inline, close to the code that
implements it, and restated in the generated report -- not left implicit.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))

from baskets import (
    BASKETS, build_basket, daily_returns_from_prices, align_contemporaneous,
    lagged_pairs, window_slice,
)
from data_sources import (
    load_crypto_snapshot, fetch_all_symbols, fetch_macro_series,
    fetch_btc_etf_flows, MACRO_TICKERS,
)
from stats_lib import (
    mean, pearson_r, fisher_r_pvalue, ols_simple, ols_multivariate,
    wilson_ci, benjamini_hochberg, two_sample_test,
)

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
LAGS = [1, 2, 3, 5]
WINDOWS = [30, 90, 180]
DOWN_DAY_QUANTILE = 0.20
DOWN_DAY_HORIZONS = [1, 3, 5]
MIN_N_FOR_RELIABLE_TEST = 30  # below this, findings are flagged "insufficient evidence" regardless of p-value


def cumulative_return(returns_subset):
    """Compound product of (1+r)-1 over a dict date->return, in date
    order. Returns None for an empty subset (never 0.0 -- a window with
    no data is a gap, not a flat return)."""
    if not returns_subset:
        return None
    prod = 1.0
    for d in sorted(returns_subset):
        prod *= (1 + returns_subset[d])
    return prod - 1.0


def descriptive_windows(basket_series, crypto_returns, end_date, windows=WINDOWS):
    basket_returns_only = {d: v[0] for d, v in basket_series.items()}
    out = {}
    for w in windows:
        b_win = window_slice(basket_returns_only, end_date, w)
        c_win = window_slice(crypto_returns, end_date, w)
        out[w] = {
            "nominal_window_days": w,
            "basket_cum_return": cumulative_return(b_win),
            "basket_n_days_used": len(b_win),
            "crypto_cum_return": cumulative_return(c_win),
            "crypto_n_days_used": len(c_win),
            "truncated": len(c_win) < w * 0.5,  # flag when the crypto history itself is the binding constraint
        }
    return out


def contemporaneous_correlation(basket_series, crypto_returns):
    aligned = align_contemporaneous(basket_series, crypto_returns)
    n = len(aligned)
    if n < 3:
        return {"n": n, "r": None, "p_value": None}
    xs = [a[1] for a in aligned]
    ys = [a[2] for a in aligned]
    r = pearson_r(xs, ys)
    p = fisher_r_pvalue(r, n) if r is not None else None
    return {"n": n, "r": r, "p_value": p}


def lagged_response(basket_series, crypto_price_by_date, lags=LAGS):
    out = {}
    for k in lags:
        pairs = lagged_pairs(basket_series, crypto_price_by_date, k)
        n = len(pairs)
        if n < 4:
            out[k] = {"n": n, "r": None, "p_value": None, "slope": None, "ols_p_value": None}
            continue
        xs = [p[2] for p in pairs]
        ys = [p[3] for p in pairs]
        r = pearson_r(xs, ys)
        p = fisher_r_pvalue(r, n) if r is not None else None
        ols = ols_simple(xs, ys)
        out[k] = {
            "n": n, "r": r, "p_value": p,
            "slope": ols["slope"] if ols else None,
            "ols_p_value": ols["p_value"] if ols else None,
        }
    return out


def down_day_study(basket_series, crypto_price_by_date, quantile=DOWN_DAY_QUANTILE, horizons=DOWN_DAY_HORIZONS):
    trading_days = sorted(basket_series.keys())
    ranked = sorted(((d, basket_series[d][0]) for d in trading_days), key=lambda t: t[1])
    n_total = len(ranked)
    n_quantile = max(1, int(round(n_total * quantile))) if n_total else 0
    weakest_dates = set(d for d, _ in ranked[:n_quantile])
    strongest_dates = set(d for d, _ in ranked[-n_quantile:]) if n_quantile else set()

    out = {"n_total_days": n_total, "n_quantile": n_quantile, "horizons": {}}
    for k in horizons:
        pairs = lagged_pairs(basket_series, crypto_price_by_date, k)
        fwd_by_date = {p[0]: p[3] for p in pairs}
        weak_fwd = [fwd_by_date[d] for d in weakest_dates if d in fwd_by_date]
        strong_fwd = [fwd_by_date[d] for d in strongest_dates if d in fwd_by_date]
        all_fwd = list(fwd_by_date.values())
        weak_pos = sum(1 for v in weak_fwd if v > 0)
        strong_pos = sum(1 for v in strong_fwd if v > 0)
        all_pos = sum(1 for v in all_fwd if v > 0)
        out["horizons"][k] = {
            "weak_n": len(weak_fwd),
            "weak_mean_fwd_return": mean(weak_fwd) if weak_fwd else None,
            "weak_pct_positive_wilson_ci": wilson_ci(weak_pos, len(weak_fwd)) if weak_fwd else None,
            "strong_n": len(strong_fwd),
            "strong_mean_fwd_return": mean(strong_fwd) if strong_fwd else None,
            "strong_pct_positive_wilson_ci": wilson_ci(strong_pos, len(strong_fwd)) if strong_fwd else None,
            "unconditional_n": len(all_fwd),
            "unconditional_mean_fwd_return": mean(all_fwd) if all_fwd else None,
            "unconditional_pct_positive_wilson_ci": wilson_ci(all_pos, len(all_fwd)) if all_fwd else None,
            "weak_vs_unconditional": two_sample_test(weak_fwd, all_fwd) if len(weak_fwd) >= 2 and len(all_fwd) >= 2 else None,
            "weak_vs_strong": two_sample_test(weak_fwd, strong_fwd) if len(weak_fwd) >= 2 and len(strong_fwd) >= 2 else None,
        }
    return out


def macro_controlled_regression(basket_series, crypto_returns, macro_returns_by_name):
    dates = sorted(set(basket_series) & set(crypto_returns))
    for series in macro_returns_by_name.values():
        dates = [d for d in dates if d in series]
    if len(dates) < 10:
        return {"n": len(dates), "before_basket_coef": None, "before_p_value": None,
                "after_basket_coef": None, "after_basket_p_value": None,
                "macro_names": list(macro_returns_by_name.keys()),
                "note": "fewer than 10 fully-overlapping observations (basket, crypto and all macro series); regression skipped"}
    ys = [crypto_returns[d] for d in dates]
    basket_xs = [basket_series[d][0] for d in dates]
    before = ols_simple(basket_xs, ys)
    macro_names = list(macro_returns_by_name.keys())
    rows = [[basket_series[d][0]] + [macro_returns_by_name[name][d] for name in macro_names] for d in dates]
    after = ols_multivariate(rows, ys)
    return {
        "n": len(dates),
        "before_basket_coef": before["slope"] if before else None,
        "before_p_value": before["p_value"] if before else None,
        "after_basket_coef": after["coefficients"][1] if after else None,
        "after_basket_p_value": after["p_values"][1] if after else None,
        "macro_names": macro_names,
        "note": None,
    }


def etf_flow_response(basket_series, etf_flows_by_date, horizons=DOWN_DAY_HORIZONS, quantile=DOWN_DAY_QUANTILE):
    """Same weak-day-vs-unconditional comparison as down_day_study, but
    against forward-SUMMED US spot BTC ETF net flows (millions USD)
    instead of forward crypto price returns -- this is the "test actual
    capital flows separately" requirement, kept structurally distinct
    from the price-based down_day_study so a price effect is never
    conflated with a flow effect."""
    trading_days = sorted(basket_series.keys())
    ranked = sorted(((d, basket_series[d][0]) for d in trading_days), key=lambda t: t[1])
    n_total = len(ranked)
    n_quantile = max(1, int(round(n_total * quantile))) if n_total else 0
    weakest_dates = set(d for d, _ in ranked[:n_quantile])
    index = {d: i for i, d in enumerate(trading_days)}

    out = {"n_total_days": n_total, "n_quantile": n_quantile, "horizons": {}}
    for k in horizons:
        weak_sums, all_sums = [], []
        for d in trading_days:
            window_dates = trading_days[index[d] + 1: index[d] + 1 + k]
            if len(window_dates) < k or not all(wd in etf_flows_by_date for wd in window_dates):
                continue
            s = sum(etf_flows_by_date[wd] for wd in window_dates)
            all_sums.append(s)
            if d in weakest_dates:
                weak_sums.append(s)
        out["horizons"][k] = {
            "weak_n": len(weak_sums),
            "weak_mean_flow_musd": mean(weak_sums) if weak_sums else None,
            "unconditional_n": len(all_sums),
            "unconditional_mean_flow_musd": mean(all_sums) if all_sums else None,
            "weak_vs_unconditional": two_sample_test(weak_sums, all_sums) if len(weak_sums) >= 2 and len(all_sums) >= 2 else None,
        }
    return out


def cumulative_series_for_chart(basket_series, crypto_returns):
    """Day-by-day cumulative return series for both the basket and the
    crypto asset, rebased to 0% at the start of the aligned comparison
    window (per the task's explicit "rebase to 0% at the start of each
    comparison window" instruction), computed only over dates where both
    a basket return and a crypto return exist (the same alignment used
    by contemporaneous_correlation -- no forward-fill on either side)."""
    aligned = align_contemporaneous(basket_series, crypto_returns)
    basket_cum, crypto_cum = 1.0, 1.0
    series = []
    for date, b_ret, c_ret in aligned:
        basket_cum *= (1 + b_ret)
        crypto_cum *= (1 + c_ret)
        series.append({"date": date, "basket_cum_return": basket_cum - 1, "crypto_cum_return": crypto_cum - 1})
    return series


def analyze_basket_vs_crypto(basket_series, crypto_price_by_date, crypto_returns, macro_returns_by_name, end_date):
    return {
        "descriptive": descriptive_windows(basket_series, crypto_returns, end_date),
        "contemporaneous_correlation": contemporaneous_correlation(basket_series, crypto_returns),
        "lagged_response": lagged_response(basket_series, crypto_price_by_date),
        "down_day_study": down_day_study(basket_series, crypto_price_by_date),
        "macro_controlled_regression": macro_controlled_regression(basket_series, crypto_returns, macro_returns_by_name),
        "chart_series": cumulative_series_for_chart(basket_series, crypto_returns),
    }


def collect_pvalues_for_bh(all_results):
    """Flatten every testable p-value (contemporaneous + lagged, across
    all basket x crypto combinations) into one list for a single
    Benjamini-Hochberg correction pass, per the task's explicit
    multiple-comparisons instruction. Returns (labels, pvalues) in
    matching order."""
    labels, pvalues = [], []
    for key, result in all_results.items():
        basket_key, crypto_name = key
        labels.append(f"{basket_key}|{crypto_name}|contemporaneous")
        pvalues.append(result["contemporaneous_correlation"]["p_value"])
        for lag, lag_result in result["lagged_response"].items():
            labels.append(f"{basket_key}|{crypto_name}|lag{lag}")
            pvalues.append(lag_result["p_value"])
    return labels, pvalues


def classify_evidence(basket_results_by_key, crypto_name, has_etf_data, etf_result_primary):
    """Rule-based classification into the four predefined outcomes from
    the task. Thresholds are disclosed here (and restated in the report)
    rather than left implicit:

      - INSUFFICIENT EVIDENCE gates everything else: if the primary
        basket's (A_full_nine) contemporaneous-correlation sample size
        is below MIN_N_FOR_RELIABLE_TEST, no other classification is
        attempted -- there simply is not enough history yet.
      - CONSISTENT WITH ROTATION requires: a negative contemporaneous
        correlation (basket down <-> crypto up) AND the weakest-20%-day
        forward crypto return exceeding the unconditional forward return
        at the 3-day and 5-day horizons AND the same direction of effect
        in at least 2 of the 3 baskets (A, B, C) AND, only where ETF flow
        data exist, a positive flow response on weak days.
      - CONSISTENT WITH COMMON RISK FACTORS applies when the basket's
        regression coefficient on crypto returns loses more than half
        its magnitude, or its statistical significance, once S&P 500 /
        USD / 10Y-yield controls are added.
      - NO ROBUST RELATIONSHIP DETECTED is the default when neither of
        the above two conditions clearly holds.
    """
    primary = basket_results_by_key.get("A_full_nine")
    if primary is None:
        return "INSUFFICIENT EVIDENCE", ["Primary basket (A, full nine) could not be constructed."]

    n_contemp = primary["contemporaneous_correlation"]["n"]
    if n_contemp < MIN_N_FOR_RELIABLE_TEST:
        return "INSUFFICIENT EVIDENCE", [
            f"Only {n_contemp} contemporaneous basket/{crypto_name} observation pairs are available "
            f"(minimum required for this study: {MIN_N_FOR_RELIABLE_TEST}), reflecting the short "
            f"real-history window (BTC/ETH data begin only in mid-2026 in this system).",
        ]

    reasons = []
    r = primary["contemporaneous_correlation"]["r"]
    rotation_dir_ok = r is not None and r < 0
    reasons.append(f"Contemporaneous basket/{crypto_name} correlation r={r}, {'negative (rotation-consistent direction)' if rotation_dir_ok else 'not in the rotation-consistent direction'}.")

    dd = primary["down_day_study"]["horizons"]
    down_day_ok = all(
        dd[h]["weak_mean_fwd_return"] is not None and dd[h]["unconditional_mean_fwd_return"] is not None
        and dd[h]["weak_mean_fwd_return"] > dd[h]["unconditional_mean_fwd_return"]
        for h in (3, 5) if h in dd
    )
    reasons.append(f"Weakest-20%-day forward {crypto_name} return exceeds the unconditional forward return at the 3- and 5-day horizons: {down_day_ok}.")

    basket_agree = 0
    for key, result in basket_results_by_key.items():
        rr = result["contemporaneous_correlation"]["r"]
        if rr is not None and rr < 0:
            basket_agree += 1
    robust_across_baskets = basket_agree >= 2
    reasons.append(f"Negative contemporaneous correlation direction agrees across {basket_agree}/3 baskets (A/B/C).")

    flow_ok = True
    if has_etf_data and etf_result_primary is not None:
        f3 = etf_result_primary["horizons"].get(3, {})
        flow_ok = (f3.get("weak_mean_flow_musd") is not None and f3.get("unconditional_mean_flow_musd") is not None
                   and f3["weak_mean_flow_musd"] > f3["unconditional_mean_flow_musd"])
        reasons.append(f"ETF flow response (3-day horizon) on weak basket days exceeds unconditional flow: {flow_ok}.")
    else:
        reasons.append("ETF flow data unavailable -- flow criterion not applied (per task instructions, evidence gap only).")

    macro = primary["macro_controlled_regression"]
    weakens_after_macro = False
    if macro.get("before_basket_coef") is not None and macro.get("after_basket_coef") is not None and macro["before_basket_coef"] != 0:
        shrink = 1 - abs(macro["after_basket_coef"] / macro["before_basket_coef"])
        lost_significance = (macro.get("before_p_value") is not None and macro["before_p_value"] < 0.05
                              and macro.get("after_basket_p_value") is not None and macro["after_basket_p_value"] >= 0.05)
        weakens_after_macro = shrink > 0.5 or lost_significance
        reasons.append(f"Basket coefficient shrinkage after macro controls: {shrink:.2f} (>0.5 => common-risk-factor evidence); lost significance: {lost_significance}.")
    else:
        reasons.append("Macro-controlled regression could not be estimated (insufficient overlapping observations).")

    if rotation_dir_ok and down_day_ok and robust_across_baskets and flow_ok and not weakens_after_macro:
        return "CONSISTENT WITH ROTATION", reasons
    if weakens_after_macro:
        return "CONSISTENT WITH COMMON RISK FACTORS", reasons
    return "NO ROBUST RELATIONSHIP DETECTED", reasons


def run_full_study(symbol_price_series, macro_price_series, btc_price_by_date, eth_price_by_date,
                    etf_flows, etf_flows_gap):
    btc_returns = daily_returns_from_prices(btc_price_by_date)
    eth_returns = daily_returns_from_prices(eth_price_by_date)
    macro_returns = {name: daily_returns_from_prices(series) for name, series in macro_price_series.items()}

    all_dates_available = list(btc_price_by_date) + list(eth_price_by_date)
    for series in symbol_price_series.values():
        all_dates_available.extend(series.keys())
    end_date = max(all_dates_available) if all_dates_available else None

    baskets_built = {key: build_basket(symbol_price_series, key) for key in BASKETS}

    results = {}
    for basket_key, basket_series in baskets_built.items():
        for crypto_name, price_by_date, returns in (("BTC", btc_price_by_date, btc_returns), ("ETH", eth_price_by_date, eth_returns)):
            results[(basket_key, crypto_name)] = analyze_basket_vs_crypto(
                basket_series, price_by_date, returns, macro_returns, end_date)

    bh_labels, bh_pvalues = collect_pvalues_for_bh(results)
    bh_results = benjamini_hochberg(bh_pvalues)
    bh_by_label = dict(zip(bh_labels, bh_results))

    etf_results = {}
    if etf_flows:
        for basket_key, basket_series in baskets_built.items():
            etf_results[basket_key] = etf_flow_response(basket_series, etf_flows)

    classifications = {}
    for crypto_name in ("BTC", "ETH"):
        basket_results_for_crypto = {bk: results[(bk, crypto_name)] for bk in BASKETS}
        label, reasons = classify_evidence(
            basket_results_for_crypto, crypto_name,
            has_etf_data=bool(etf_flows), etf_result_primary=etf_results.get("A_full_nine"))
        classifications[crypto_name] = {"label": label, "reasons": reasons}

    symbol_coverage = {sym: {"n_days": len(series), "min_date": min(series) if series else None,
                              "max_date": max(series) if series else None}
                        for sym, series in symbol_price_series.items()}

    return {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "end_date": end_date,
        "symbol_coverage": symbol_coverage,
        "btc_coverage": {"n_days": len(btc_price_by_date), "min_date": min(btc_price_by_date) if btc_price_by_date else None,
                          "max_date": max(btc_price_by_date) if btc_price_by_date else None},
        "eth_coverage": {"n_days": len(eth_price_by_date), "min_date": min(eth_price_by_date) if eth_price_by_date else None,
                          "max_date": max(eth_price_by_date) if eth_price_by_date else None},
        "etf_flows_gap": etf_flows_gap,
        "etf_flows_n_days": len(etf_flows) if etf_flows else 0,
        "results": {f"{k[0]}|{k[1]}": v for k, v in results.items()},
        "bh_correction": bh_by_label,
        "etf_flow_response": etf_results,
        "classifications": classifications,
    }


def _load_equity_cache(path):
    with open(path, "r") as f:
        doc = json.load(f)
    return doc["symbols"], doc["macro"], doc.get("etf_flows", {}), doc.get("etf_flows_gap")


def _save_equity_cache(path, symbols, macro, etf_flows, etf_flows_gap):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"symbols": symbols, "macro": macro, "etf_flows": etf_flows, "etf_flows_gap": etf_flows_gap}, f)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-live", action="store_true",
                        help="Fetch equity/macro/ETF-flow data live from Yahoo Finance and Farside. "
                             "Requires network access this authoring sandbox does not have -- intended "
                             "to run from a GitHub Actions runner.")
    parser.add_argument("--equity-data-file", default=os.path.join(OUTPUT_DIR, "equity_cache.json"),
                        help="Path to load/save the fetched equity+macro+ETF-flow cache.")
    parser.add_argument("--range", default="2y", help="Yahoo Finance range parameter for --fetch-live.")
    args = parser.parse_args()

    if args.fetch_live:
        symbols = fetch_all_symbols(BASKETS["A_full_nine"]["symbols"], range_=args.range)
        macro = fetch_macro_series(range_=args.range)
        etf_flows, etf_flows_gap = fetch_btc_etf_flows()
        _save_equity_cache(args.equity_data_file, symbols, macro, etf_flows, etf_flows_gap)
    elif os.path.exists(args.equity_data_file):
        symbols, macro, etf_flows, etf_flows_gap = _load_equity_cache(args.equity_data_file)
    else:
        print(f"No equity data cache at {args.equity_data_file} and --fetch-live not given. "
              f"This study requires real equity price data; it will not proceed with synthetic "
              f"or fabricated substitutes. Run with --fetch-live from an environment with network "
              f"access to Yahoo Finance (e.g. the project's GitHub Actions runner).", file=sys.stderr)
        sys.exit(1)

    btc_price_by_date, btc_meta = load_crypto_snapshot("btc_daily.json")
    eth_price_by_date, eth_meta = load_crypto_snapshot("eth_daily.json")

    report = run_full_study(symbols, macro, btc_price_by_date, eth_price_by_date, etf_flows, etf_flows_gap)
    report["btc_source_metadata"] = btc_meta
    report["eth_source_metadata"] = eth_meta

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, "report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"Wrote {out_path}")
    print(json.dumps(report["classifications"], indent=2))


if __name__ == "__main__":
    main()
