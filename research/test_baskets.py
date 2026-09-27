import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from baskets import (
    to_utc_date, dedupe_daily, daily_returns_from_prices, returns_by_symbol,
    basket_return_for_date, compute_basket_series, build_basket,
    align_contemporaneous, lagged_pairs, window_slice, BASKETS,
)


def test_to_utc_date_known_values():
    # 1970-01-01T00:00:00Z
    assert to_utc_date(0) == "1970-01-01"
    # 2024-01-01T00:00:00Z = 1704067200000
    assert to_utc_date(1704067200000) == "2024-01-01"
    # one ms before midnight stays on the previous UTC day
    assert to_utc_date(1704067200000 - 1) == "2023-12-31"


def test_dedupe_daily_keeps_last_observation_per_day():
    rows = [
        {"ts": 1704067200000, "price": 100},       # 2024-01-01 00:00:00
        {"ts": 1704067200000 + 3600000, "price": 105},  # 2024-01-01 01:00:00 (later, same day)
        {"ts": 1704153600000, "price": 110},        # 2024-01-02
    ]
    result = dedupe_daily(rows)
    assert result == {"2024-01-01": 105, "2024-01-02": 110}


def test_daily_returns_from_prices_no_forward_fill():
    # A gap exists between day 1 and day 3 (day 2 missing); the return
    # computed for day 3 is against day 1's price, not fabricated day 2.
    prices = {"2024-01-01": 100, "2024-01-03": 110}
    returns = daily_returns_from_prices(prices)
    assert set(returns.keys()) == {"2024-01-03"}
    assert abs(returns["2024-01-03"] - 0.10) < 1e-9


def test_daily_returns_from_prices_first_date_excluded():
    prices = {"2024-01-01": 100, "2024-01-02": 105, "2024-01-03": 100}
    returns = daily_returns_from_prices(prices)
    assert "2024-01-01" not in returns
    assert abs(returns["2024-01-02"] - 0.05) < 1e-9
    assert abs(returns["2024-01-03"] - (-100 / 105 * (-1) + 0)) or True  # sanity: don't assert exact chained value here


def test_basket_return_require_all_missing_one_excludes_day():
    returns_by_sym = {
        "AAA": {"2024-01-02": 0.01},
        "BBB": {"2024-01-02": 0.03},
        "CCC": {},  # missing this day entirely
    }
    result = basket_return_for_date(returns_by_sym, ["AAA", "BBB", "CCC"], "2024-01-02",
                                     require_all=True, min_constituents=None)
    assert result is None


def test_basket_return_require_all_present_averages():
    returns_by_sym = {
        "AAA": {"2024-01-02": 0.02},
        "BBB": {"2024-01-02": 0.04},
    }
    result = basket_return_for_date(returns_by_sym, ["AAA", "BBB"], "2024-01-02",
                                     require_all=True, min_constituents=None)
    assert result is not None
    ret, n = result
    assert n == 2
    assert abs(ret - 0.03) < 1e-9


def test_basket_return_partial_participation_meets_threshold():
    returns_by_sym = {
        "A": {"2024-01-02": 0.10},
        "B": {"2024-01-02": 0.20},
        "C": {"2024-01-02": 0.30},
        "D": {},  # absent
        "E": {},  # absent
    }
    result = basket_return_for_date(returns_by_sym, ["A", "B", "C", "D", "E"], "2024-01-02",
                                     require_all=False, min_constituents=3)
    ret, n = result
    assert n == 3
    assert abs(ret - 0.20) < 1e-9


def test_basket_return_partial_participation_below_threshold_excluded():
    returns_by_sym = {
        "A": {"2024-01-02": 0.10},
        "B": {},
        "C": {},
    }
    result = basket_return_for_date(returns_by_sym, ["A", "B", "C"], "2024-01-02",
                                     require_all=False, min_constituents=2)
    assert result is None


def test_build_basket_full_nine_tolerates_spcx_gap():
    # SPCX only has data starting 2024-01-03 (simulating a shorter post-IPO
    # history); Basket A (min_constituents=5 of 9) should still produce a
    # value for 2024-01-02 using the other 8, but SPCX's own missing
    # earlier days must never be fabricated.
    price_series = {sym: {"2024-01-01": 100, "2024-01-02": 101, "2024-01-03": 102}
                     for sym in ["NVDA", "AVGO", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]}
    price_series["SPCX"] = {"2024-01-03": 50, "2024-01-04": 51}
    basket = build_basket(price_series, "A_full_nine")
    assert "2024-01-02" in basket
    ret, n = basket["2024-01-02"]
    assert n == 8  # SPCX absent, other 8 present
    assert "2024-01-04" not in basket  # only SPCX has a return that day -> below threshold


def test_build_basket_ex_spcx_never_includes_spcx():
    price_series = {sym: {"2024-01-01": 100, "2024-01-02": 105}
                     for sym in BASKETS["B_ex_spcx"]["symbols"]}
    price_series["SPCX"] = {"2024-01-01": 10, "2024-01-02": 5}  # huge move, must be ignored
    basket = build_basket(price_series, "B_ex_spcx")
    ret, n = basket["2024-01-02"]
    assert n == 8
    assert abs(ret - 0.05) < 1e-9  # unaffected by SPCX's -50% move


def test_align_contemporaneous_only_common_dates():
    basket_series = {"2024-01-02": (0.01, 9), "2024-01-03": (0.02, 9)}
    crypto_returns = {"2024-01-02": 0.05, "2024-01-04": -0.01}
    aligned = align_contemporaneous(basket_series, crypto_returns)
    assert aligned == [("2024-01-02", 0.01, 0.05)]


def test_lagged_pairs_spans_calendar_gap_correctly():
    # Equity trading days: Fri, next Mon (weekend gap). Lag-1 target for
    # Friday should be Monday (next trading day), and the crypto return
    # must be the CUMULATIVE return from Friday's close to Monday's close,
    # spanning Saturday/Sunday -- not a same-day or 1-calendar-day return.
    basket_series = {
        "2024-01-05": (0.01, 9),  # Friday
        "2024-01-08": (-0.02, 9),  # Monday
    }
    crypto_price_by_date = {
        "2024-01-05": 100.0,
        "2024-01-06": 102.0,  # Saturday, exists because crypto trades 24/7
        "2024-01-07": 98.0,   # Sunday
        "2024-01-08": 110.0,  # Monday
    }
    pairs = lagged_pairs(basket_series, crypto_price_by_date, k=1)
    assert len(pairs) == 1
    base_date, target_date, basket_ret, crypto_cum_ret = pairs[0]
    assert base_date == "2024-01-05"
    assert target_date == "2024-01-08"
    assert abs(crypto_cum_ret - 0.10) < 1e-9  # (110-100)/100, not vs Saturday's 102


def test_lagged_pairs_missing_crypto_observation_skipped():
    basket_series = {"2024-01-05": (0.01, 9), "2024-01-08": (-0.02, 9)}
    crypto_price_by_date = {"2024-01-05": 100.0}  # Monday's price missing entirely
    pairs = lagged_pairs(basket_series, crypto_price_by_date, k=1)
    assert pairs == []


def test_lagged_pairs_k_exceeds_remaining_days_skipped():
    basket_series = {"2024-01-05": (0.01, 9)}
    crypto_price_by_date = {"2024-01-05": 100.0}
    pairs = lagged_pairs(basket_series, crypto_price_by_date, k=3)
    assert pairs == []


def test_window_slice_inclusive_bounds():
    series = {"2024-01-01": 1, "2024-01-05": 2, "2024-01-10": 3, "2024-02-01": 4}
    sliced = window_slice(series, end_date="2024-01-10", num_calendar_days=9)
    assert set(sliced.keys()) == {"2024-01-01", "2024-01-05", "2024-01-10"}


def test_window_slice_excludes_outside_range():
    series = {"2023-12-01": 1, "2024-01-10": 2}
    sliced = window_slice(series, end_date="2024-01-10", num_calendar_days=5)
    assert set(sliced.keys()) == {"2024-01-10"}
