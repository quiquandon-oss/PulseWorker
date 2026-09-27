"""
Basket construction, return calculation and UTC date alignment for the
AI-capital-rotation research study (research/run_analysis.py).

Design notes (documented here because they are load-bearing decisions the
final report must restate, not incidental implementation detail):

1. No forward-fill, ever. A symbol's daily return is computed against ITS
   OWN previous available observation, not against a shared calendar day.
   If a symbol is missing a trading day, that gap is simply absent from
   its own return series -- it is never filled with a stale price, and it
   never silently turns into a multi-day return mislabeled as one day.

2. Basket A (all 9 constituents) tolerates partial participation: a day's
   basket return is the equal-weighted mean of whichever constituents
   have a valid return that day, provided at least `min_constituents`
   (default a bare majority, 5 of 9) are present. This is what makes
   Basket A usable across SPCX's shorter post-IPO history without
   fabricating SPCX data for the days before it existed.

3. Baskets B (ex-SPCX, 8 names) and C (AI-infrastructure-sensitive, 5
   names) are strict: ALL named constituents must have a valid return
   that day, or the day is dropped entirely. These are meant as clean,
   fully-populated comparison baskets, so partial participation is not
   allowed to quietly change their composition day to day.

4. Market-cap weighting is intentionally NOT implemented as a computed
   basket-weighting method here. The only market-cap data available
   anywhere in this codebase (/stock-proxy's `marketCap` field) is a
   CURRENT snapshot, not a historical time series, and the task
   instructions explicitly forbid treating current weights as if they
   were historical. Equal weighting is the only historical weighting
   method used; the absence of historical market-cap weighting is a
   reported data limitation, not an oversight.

5. "k equity trading days ahead" (used by the lagged-response test and
   the down-day study) means: take the equity trading-day calendar
   (the sorted list of dates on which at least one equity return exists),
   and for equity date d_i, the lag-k target is trading-day d_(i+k) --
   NOT calendar date d_i + k days. The crypto return over that horizon is
   the cumulative crypto return from d_i's close to d_(i+k)'s close,
   which may span an intervening weekend or holiday. This is the only
   way to make "predicts BTC/ETH returns at lags of 1..5 equity trading
   days" well-defined given that crypto trades 24/7 and equities do not.
"""

BASKET_A = ["NVDA", "AVGO", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "SPCX"]
BASKET_B = ["NVDA", "AVGO", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]  # ex-SPCX
BASKET_C = ["NVDA", "AVGO", "MSFT", "GOOGL", "AMZN"]  # AI-infrastructure-sensitive

BASKETS = {
    "A_full_nine": {"symbols": BASKET_A, "require_all": False, "min_constituents": 5},
    "B_ex_spcx": {"symbols": BASKET_B, "require_all": True, "min_constituents": None},
    "C_ai_infra": {"symbols": BASKET_C, "require_all": True, "min_constituents": None},
}


def to_utc_date(ts_ms):
    """Epoch milliseconds -> 'YYYY-MM-DD' UTC calendar date string, via
    plain integer arithmetic (no datetime timezone ambiguity)."""
    days = ts_ms // 86400000
    # Proleptic Gregorian civil-from-days algorithm (Howard Hinnant),
    # UTC/epoch-day based, no external dependency.
    z = days + 719468
    era = z // 146097 if z >= 0 else -((-z + 146096) // 146097)
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    y = y + 1 if m <= 2 else y
    return f"{y:04d}-{m:02d}-{d:02d}"


def dedupe_daily(rows, ts_key="ts", price_key="price"):
    """Given rows with (possibly multiple-per-day, unsorted) timestamps,
    keep the LAST row per UTC calendar date (highest ts) and return a
    dict {date_str: price} sorted-safe (callers should sort keys)."""
    by_date = {}
    for row in rows:
        d = to_utc_date(row[ts_key])
        if d not in by_date or row[ts_key] > by_date[d][0]:
            by_date[d] = (row[ts_key], row[price_key])
    return {d: v[1] for d, v in by_date.items()}


def daily_returns_from_prices(price_by_date):
    """price_by_date: dict date_str -> price. Returns dict date_str ->
    pct return, keyed by the LATER date of each consecutive-in-the-series
    pair (consecutive in the data, not necessarily consecutive calendar
    days -- see module docstring point 1). The first date in the series
    has no return and is excluded."""
    dates = sorted(price_by_date.keys())
    returns = {}
    for prev, cur in zip(dates, dates[1:]):
        p0, p1 = price_by_date[prev], price_by_date[cur]
        if p0:
            returns[cur] = (p1 - p0) / p0
    return returns


def returns_by_symbol(symbol_price_series):
    """symbol_price_series: dict symbol -> dict date_str -> close price.
    Returns dict symbol -> dict date_str -> daily return."""
    return {sym: daily_returns_from_prices(prices) for sym, prices in symbol_price_series.items()}


def basket_return_for_date(returns_by_sym, symbols, date, require_all, min_constituents):
    values = [returns_by_sym[s][date] for s in symbols if s in returns_by_sym and date in returns_by_sym[s]]
    n = len(values)
    if require_all:
        if n < len(symbols):
            return None
    else:
        threshold = min_constituents if min_constituents is not None else 1
        if n < threshold:
            return None
    return (sum(values) / n, n)


def compute_basket_series(returns_by_sym, symbols, require_all=True, min_constituents=None):
    """Returns dict date_str -> (equal_weighted_return, n_constituents_used),
    over the union of all dates on which ANY named symbol has a return."""
    all_dates = set()
    for s in symbols:
        all_dates.update(returns_by_sym.get(s, {}).keys())
    out = {}
    for d in sorted(all_dates):
        r = basket_return_for_date(returns_by_sym, symbols, d, require_all, min_constituents)
        if r is not None:
            out[d] = r
    return out


def build_basket(symbol_price_series, basket_key):
    """Convenience wrapper: build one of the three predefined baskets
    (see BASKETS) from raw per-symbol price series. Returns
    dict date_str -> (return, n_constituents_used)."""
    cfg = BASKETS[basket_key]
    rbs = returns_by_symbol(symbol_price_series)
    return compute_basket_series(rbs, cfg["symbols"], cfg["require_all"], cfg["min_constituents"])


def align_contemporaneous(basket_series, crypto_returns):
    """basket_series: dict date -> (return, n); crypto_returns: dict
    date -> return. Returns a list of (date, basket_return, crypto_return)
    for dates present in both, sorted ascending -- the input to
    contemporaneous correlation."""
    dates = sorted(set(basket_series) & set(crypto_returns))
    return [(d, basket_series[d][0], crypto_returns[d]) for d in dates]


def lagged_pairs(basket_series, crypto_price_by_date, k):
    """Lag-k equity-trading-day pairs (see module docstring point 5).

    `basket_series`: dict date -> (return, n) -- its own sorted keys
    define the equity trading-day calendar used for the lag.
    `crypto_price_by_date`: dict date -> price (NOT returns -- prices,
    because the target is a cumulative return possibly spanning more
    than one calendar day).

    Returns a list of (base_date, target_date, basket_return_at_base,
    crypto_cum_return_base_to_target). A pair is only emitted when the
    basket has a valid return at the base date AND crypto prices exist
    at both the base and target UTC dates; no forward-fill or
    substitution is used to patch a missing observation.
    """
    trading_days = sorted(basket_series.keys())
    index = {d: i for i, d in enumerate(trading_days)}
    pairs = []
    for base_date in trading_days:
        i = index[base_date]
        j = i + k
        if j >= len(trading_days):
            continue
        target_date = trading_days[j]
        if base_date not in crypto_price_by_date or target_date not in crypto_price_by_date:
            continue
        p0 = crypto_price_by_date[base_date]
        p1 = crypto_price_by_date[target_date]
        if not p0:
            continue
        crypto_cum_return = (p1 - p0) / p0
        pairs.append((base_date, target_date, basket_series[base_date][0], crypto_cum_return))
    return pairs


def window_slice(series_dict, end_date, num_calendar_days):
    """Return the sub-dict of `series_dict` (date -> anything) whose keys
    fall within [end_date - num_calendar_days, end_date] inclusive, using
    plain ISO string comparison (safe because 'YYYY-MM-DD' sorts
    lexicographically the same as chronologically)."""
    y, m, d = (int(x) for x in end_date.split("-"))
    # Convert to an epoch day count via the same civil calendar used in
    # to_utc_date, then filter by date-string comparison against the
    # start date computed the same way, to avoid pulling in `datetime`.
    start_ts_ms = _date_to_epoch_ms(end_date) - num_calendar_days * 86400000
    start_date = to_utc_date(start_ts_ms)
    return {k: v for k, v in series_dict.items() if start_date <= k <= end_date}


def _date_to_epoch_ms(date_str):
    y, m, d = (int(x) for x in date_str.split("-"))
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    jdn = d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045
    epoch_jdn = 2440588  # JDN for 1970-01-01
    return (jdn - epoch_jdn) * 86400000
