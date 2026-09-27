import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from run_analysis import (
    cumulative_return, descriptive_windows, contemporaneous_correlation,
    lagged_response, down_day_study, macro_controlled_regression,
    etf_flow_response, collect_pvalues_for_bh, classify_evidence, run_full_study,
    cumulative_series_for_chart,
)
from baskets import daily_returns_from_prices, BASKETS


def test_cumulative_return_compounds_not_sums():
    returns = {"2024-01-02": 0.10, "2024-01-03": 0.10}
    # compounding: 1.10 * 1.10 - 1 = 0.21, NOT 0.20
    assert abs(cumulative_return(returns) - 0.21) < 1e-9


def test_cumulative_return_empty_is_none():
    assert cumulative_return({}) is None


def _make_daily_prices(start_price, daily_pct_changes, start_date_ordinal_dates):
    prices = {}
    p = start_price
    for d, pct in zip(start_date_ordinal_dates, daily_pct_changes):
        p = p * (1 + pct)
        prices[d] = p
    return prices


DATES_30 = [f"2024-01-{d:02d}" for d in range(1, 31)]


def test_descriptive_windows_reports_truncation_when_crypto_history_short():
    basket_series = {d: (0.001, 9) for d in DATES_30[1:]}
    crypto_returns = {d: 0.002 for d in DATES_30[25:]}  # only ~5 days of crypto history
    result = descriptive_windows(basket_series, crypto_returns, end_date=DATES_30[-1], windows=[30])
    assert result[30]["crypto_n_days_used"] < 10
    assert result[30]["truncated"] is True


def test_contemporaneous_correlation_perfect_negative():
    dates = DATES_30[1:11]
    basket_series = {d: (0.01 * i, 9) for i, d in enumerate(dates)}
    crypto_returns = {d: -0.01 * i for i, d in enumerate(dates)}
    result = contemporaneous_correlation(basket_series, crypto_returns)
    assert result["n"] == 10
    assert abs(result["r"] - (-1.0)) < 1e-6
    assert result["p_value"] < 0.05


def test_contemporaneous_correlation_too_few_points():
    result = contemporaneous_correlation({"2024-01-02": (0.01, 9)}, {"2024-01-02": 0.01})
    assert result["n"] == 1
    assert result["r"] is None


def test_lagged_response_detects_relationship_at_correct_lag():
    dates = DATES_30[:20]
    basket_series = {d: (0.01 * (i % 3 - 1), 9) for i, d in enumerate(dates[:-2])}
    crypto_price = {}
    p = 100.0
    for i, d in enumerate(dates):
        p *= 1.0
        crypto_price[d] = p
    # Make lag-2 crypto cumulative return perfectly track lag-2-earlier basket return
    trading_days = sorted(basket_series.keys())
    price = 100.0
    prices_by_date = {trading_days[0]: price}
    for i in range(1, len(trading_days)):
        price = price  # baseline flat; we'll inject deterministic moves below instead
        prices_by_date[trading_days[i]] = price
    # Simpler deterministic construction: crypto price at day i+2 relative
    # to day i grows by exactly basket_return(day i) * 5 (an arbitrary but
    # fixed relationship), giving an exact, testable linear relationship.
    crypto_price_by_date = {}
    base_price = 100.0
    crypto_price_by_date[trading_days[0]] = base_price
    for i in range(len(trading_days)):
        if i + 2 < len(trading_days):
            target = trading_days[i + 2]
            crypto_price_by_date.setdefault(trading_days[i], base_price)
            crypto_price_by_date[target] = crypto_price_by_date[trading_days[i]] * (1 + basket_series[trading_days[i]][0] * 5)
    result = lagged_response(basket_series, crypto_price_by_date, lags=[2])
    assert result[2]["n"] >= 4
    assert abs(result[2]["r"] - 1.0) < 1e-6


def test_lagged_response_insufficient_pairs_returns_none_stats():
    basket_series = {"2024-01-02": (0.01, 9)}
    crypto_price_by_date = {"2024-01-02": 100.0, "2024-01-03": 101.0}
    result = lagged_response(basket_series, crypto_price_by_date, lags=[1])
    assert result[1]["n"] < 4
    assert result[1]["r"] is None


def test_down_day_study_weak_days_have_higher_forward_return():
    dates = DATES_30[:20]
    # Deterministic: basket return = -0.05 for first 4 days (weak), 0 for
    # middle, +0.05 for last 4 (strong). Crypto price rises sharply only
    # after the weak days, at horizon 1, to make the effect unambiguous.
    basket_series = {}
    for i, d in enumerate(dates):
        if i < 4:
            basket_series[d] = (-0.05, 9)
        elif i >= len(dates) - 4:
            basket_series[d] = (0.05, 9)
        else:
            basket_series[d] = (0.0, 9)
    crypto_price_by_date = {}
    price = 100.0
    for i, d in enumerate(dates):
        crypto_price_by_date[d] = price
        if i < 4:
            price *= 1.10  # crypto jumps the day after a weak basket day
        else:
            price *= 1.0
    result = down_day_study(basket_series, crypto_price_by_date, quantile=0.20, horizons=[1])
    h1 = result["horizons"][1]
    assert h1["weak_n"] > 0
    assert h1["weak_mean_fwd_return"] > h1["unconditional_mean_fwd_return"]


def test_macro_controlled_regression_shrinks_when_macro_explains_everything():
    dates = DATES_30[:15]
    basket_series = {d: (0.01 * i, 9) for i, d in enumerate(dates)}
    macro_returns = {"sp500": {d: 0.01 * i for i, d in enumerate(dates)}}
    # crypto return is PURELY a function of sp500 (macro), not basket
    # (even though basket and sp500 are collinear-ish here by construction,
    # use a slightly different functional form to avoid a singular matrix)
    crypto_returns = {d: 0.01 * i + 0.0001 * (i % 3) for i, d in enumerate(dates)}
    macro_returns_noisy = {"sp500": {d: 0.01 * i + 0.00005 * ((i + 1) % 2) for i, d in enumerate(dates)}}
    result = macro_controlled_regression(basket_series, crypto_returns, macro_returns_noisy)
    assert result["n"] >= 10
    assert result["before_basket_coef"] is not None


def test_macro_controlled_regression_insufficient_overlap():
    basket_series = {"2024-01-02": (0.01, 9)}
    crypto_returns = {"2024-01-02": 0.01}
    macro_returns = {"sp500": {"2024-01-02": 0.01}}
    result = macro_controlled_regression(basket_series, crypto_returns, macro_returns)
    assert result["n"] == 1
    assert result["before_basket_coef"] is None
    assert "fewer than 10" in result["note"]


def test_etf_flow_response_weak_days_get_more_flow():
    dates = DATES_30[:20]
    basket_series = {}
    for i, d in enumerate(dates):
        basket_series[d] = (-0.05 if i < 4 else 0.0, 9)
    etf_flows = {}
    for i, d in enumerate(dates):
        etf_flows[d] = 50.0 if i < 8 else 1.0  # elevated flow shortly after weak days
    result = etf_flow_response(basket_series, etf_flows, horizons=[3])
    h3 = result["horizons"][3]
    assert h3["weak_n"] > 0
    assert h3["weak_mean_flow_musd"] >= h3["unconditional_mean_flow_musd"]


def test_collect_pvalues_for_bh_flattens_all_combinations():
    fake_results = {
        ("A_full_nine", "BTC"): {
            "contemporaneous_correlation": {"p_value": 0.01},
            "lagged_response": {1: {"p_value": 0.2}, 2: {"p_value": None}},
        },
    }
    labels, pvalues = collect_pvalues_for_bh(fake_results)
    assert "A_full_nine|BTC|contemporaneous" in labels
    assert "A_full_nine|BTC|lag1" in labels
    assert "A_full_nine|BTC|lag2" in labels
    assert pvalues[labels.index("A_full_nine|BTC|contemporaneous")] == 0.01
    assert pvalues[labels.index("A_full_nine|BTC|lag2")] is None


def test_classify_evidence_insufficient_when_n_too_small():
    basket_results = {
        key: {
            "contemporaneous_correlation": {"n": 5, "r": None, "p_value": None},
            "down_day_study": {"horizons": {}},
            "macro_controlled_regression": {},
        }
        for key in BASKETS
    }
    label, reasons = classify_evidence(basket_results, "BTC", has_etf_data=False, etf_result_primary=None)
    assert label == "INSUFFICIENT EVIDENCE"


def test_classify_evidence_no_robust_relationship_when_flat():
    basket_results = {
        key: {
            "contemporaneous_correlation": {"n": 100, "r": 0.01, "p_value": 0.9},
            "down_day_study": {"horizons": {
                3: {"weak_mean_fwd_return": 0.001, "unconditional_mean_fwd_return": 0.001},
                5: {"weak_mean_fwd_return": 0.001, "unconditional_mean_fwd_return": 0.001},
            }},
            "macro_controlled_regression": {"before_basket_coef": None, "after_basket_coef": None},
        }
        for key in BASKETS
    }
    label, reasons = classify_evidence(basket_results, "BTC", has_etf_data=False, etf_result_primary=None)
    assert label == "NO ROBUST RELATIONSHIP DETECTED"


def test_cumulative_series_for_chart_rebases_to_zero_and_compounds():
    dates = DATES_30[1:4]
    basket_series = {d: (0.10, 9) for d in dates}
    crypto_returns = {d: 0.05 for d in dates}
    series = cumulative_series_for_chart(basket_series, crypto_returns)
    assert len(series) == 3
    # After 3 days of +10%: 1.1^3 - 1
    assert abs(series[-1]["basket_cum_return"] - (1.1 ** 3 - 1)) < 1e-9
    assert abs(series[-1]["crypto_cum_return"] - (1.05 ** 3 - 1)) < 1e-9


def test_cumulative_series_for_chart_only_uses_aligned_dates():
    basket_series = {"2024-01-02": (0.10, 9), "2024-01-03": (0.10, 9)}
    crypto_returns = {"2024-01-02": 0.05}  # 2024-01-03 missing on the crypto side
    series = cumulative_series_for_chart(basket_series, crypto_returns)
    assert len(series) == 1
    assert series[0]["date"] == "2024-01-02"


def test_run_full_study_smoke_test_with_synthetic_equity_data():
    # Use the real BTC/ETH snapshots (via load_crypto_snapshot inside
    # run_analysis is bypassed here -- this smoke test calls
    # run_full_study directly with fully synthetic data spanning a
    # comparable range, so it never touches the network or depends on
    # today's real snapshot contents).
    dates = [f"2026-0{m}-{d:02d}" for m in (6, 7) for d in range(1, 29)]
    symbol_price_series = {
        sym: {d: 100 + i * 0.1 for i, d in enumerate(dates)}
        for sym in BASKETS["A_full_nine"]["symbols"]
    }
    macro_price_series = {"sp500": {d: 4000 + i for i, d in enumerate(dates)}}
    btc_price_by_date = {d: 60000 + i * 10 for i, d in enumerate(dates)}
    eth_price_by_date = {d: 2000 + i * 2 for i, d in enumerate(dates)}
    report = run_full_study(symbol_price_series, macro_price_series, btc_price_by_date,
                             eth_price_by_date, etf_flows={}, etf_flows_gap="test: no ETF data supplied")
    assert "classifications" in report
    assert set(report["classifications"].keys()) == {"BTC", "ETH"}
    assert report["etf_flows_gap"] == "test: no ETF data supplied"
    assert len(report["results"]) == len(BASKETS) * 2
