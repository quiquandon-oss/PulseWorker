"""
Data loading for the AI-capital-rotation research study.

This module deliberately separates PARSING (pure, synchronous-data-in ->
dict-out, fully unit-testable offline) from FETCHING (an injectable
`http_get(url) -> str` callable, defaulting to `urllib.request` but never
imported eagerly at call time in a way that breaks testability). This
mirrors the "local-mirror/injected-fetcher pattern" already used by this
project's sister research tooling (PulseWorkerV2's research/ scripts).

Why this split matters here specifically: the interactive sandbox this
module was authored in cannot reach Yahoo Finance or Farside (outbound
egress to those hosts is denied by the sandbox's proxy allowlist) -- but a
GitHub Actions runner dispatched against this branch CAN. Every fetch
function here is written so it runs correctly from that runner while
still being fully testable right now, offline, by passing a fake
`http_get`.

Local static snapshots (research/data/btc_daily.json, eth_daily.json)
were pulled directly from the production D1 database (a tool this
environment CAN reach) and are loaded here with no network call at all.
"""

import json
import os
import urllib.request

from baskets import to_utc_date

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

MACRO_TICKERS = {
    "sp500": "^GSPC",
    "dollar_index": "DX-Y.NYB",
    "treasury_10y_yield": "^TNX",
}


def _default_http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def load_crypto_snapshot(filename):
    """Load one of research/data/{btc_daily,eth_daily}.json. Returns
    (price_by_date, metadata) where metadata is the file's own
    source/method/notes block, carried through so the final report can
    cite it verbatim rather than re-describing it from memory."""
    path = os.path.join(DATA_DIR, filename)
    with open(path, "r") as f:
        doc = json.load(f)
    price_by_date = {}
    for row in doc["rows"]:
        d = to_utc_date(row["ts"])
        # Rows are already one-per-UTC-day by construction (see the
        # file's own "method" field); if a duplicate date still shows up
        # keep the latest ts, same rule as baskets.dedupe_daily.
        if d not in price_by_date or row["ts"] > price_by_date[d][0]:
            price_by_date[d] = (row["ts"], row["price"])
    price_by_date = {d: v[1] for d, v in price_by_date.items()}
    metadata = {k: v for k, v in doc.items() if k != "rows"}
    return price_by_date, metadata


def parse_yahoo_chart_json(raw_json, prefer_adjclose=True):
    """Parse a Yahoo Finance `v8/finance/chart` JSON payload (the same
    endpoint /stock-proxy already uses -- see worker.js -- but requested
    here with a longer `range` than /stock-proxy's 3mo) into a
    price_by_date dict. Returns {} if the payload has no usable result
    (e.g. an error response), never raises on malformed input -- a
    research script must degrade to "no data for this symbol" rather
    than crash the whole run over one bad ticker.
    """
    try:
        data = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
        result = data["chart"]["result"][0]
        timestamps = result["timestamp"]
        quote = result["indicators"]["quote"][0]
        closes = quote.get("close", [None] * len(timestamps))
        adj = None
        if prefer_adjclose and "adjclose" in result["indicators"]:
            adj = result["indicators"]["adjclose"][0].get("adjclose")
        price_by_date = {}
        for i, ts in enumerate(timestamps):
            price = None
            if adj is not None and i < len(adj) and adj[i] is not None:
                price = adj[i]
            elif i < len(closes) and closes[i] is not None:
                price = closes[i]
            if price is None:
                continue  # missing observation: skip, never interpolate
            d = to_utc_date(ts * 1000)
            price_by_date[d] = price
        return price_by_date
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        return {}


def fetch_yahoo_daily_series(symbol, range_="2y", http_get=None):
    """Fetch a longer-range daily close series for one symbol from
    Yahoo's chart API. `http_get` is injectable for testing; defaults to
    a real HTTPS GET (only reachable from an environment with network
    access to Yahoo, e.g. the GitHub Actions runner this is meant to run
    from -- not this authoring sandbox)."""
    http_get = http_get or _default_http_get
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?range={range_}&interval=1d"
    )
    raw = http_get(url)
    return parse_yahoo_chart_json(raw)


def fetch_all_symbols(symbols, range_="2y", http_get=None):
    """Fetch daily series for each symbol; returns dict symbol ->
    price_by_date. A symbol whose fetch fails or parses to {} is
    included with an empty dict rather than omitted, so downstream
    reporting can explicitly show which symbols have zero history
    instead of silently vanishing them from the basket."""
    return {sym: fetch_yahoo_daily_series(sym, range_=range_, http_get=http_get) for sym in symbols}


def fetch_macro_series(range_="2y", http_get=None):
    """Fetch the macro control series (S&P 500, US dollar index,
    10-year Treasury yield) the same way as the equity symbols."""
    return {name: fetch_yahoo_daily_series(ticker, range_=range_, http_get=http_get)
            for name, ticker in MACRO_TICKERS.items()}


def fetch_btc_etf_flows(http_get=None):
    """Best-effort fetch of historical US spot Bitcoin ETF net flows
    from Farside Investors' public CSV export. This is explicitly
    best-effort: Farside's page layout, URL, or CSV schema can change
    without notice, and this sandbox has never been able to verify the
    parser against a live response (egress to farside.co.uk is blocked
    here; only a GitHub Actions runner dispatched for this study can
    actually exercise the network path).

    Returns (flows_by_date_millions_usd, evidence_gap) where exactly one
    of the two is populated:
      - On success: (dict date_str -> net_flow_usd_millions, None).
      - On any failure (network error, unexpected schema, empty body):
        ({}, "<human-readable reason>"). Callers MUST treat a non-None
        evidence_gap as "no ETF flow data available" and report it as
        exactly that in the final research report -- never as zero
        flow, and never by falling back to inferring flows from price
        changes (the task instructions explicitly forbid that).
    """
    http_get = http_get or _default_http_get
    url = "https://farside.co.uk/bitcoin-etf-flow-all-data/"
    try:
        raw = http_get(url)
    except Exception as exc:  # noqa: BLE001 - any network failure is an evidence gap, not a crash
        return {}, f"fetch failed: {exc}"
    flows = parse_farside_html_table(raw)
    if not flows:
        return {}, "fetched page but found no parseable daily flow rows (schema may have changed)"
    return flows, None


def parse_farside_html_table(html):
    """Minimal, defensive parser for Farside's flow table. Farside
    publishes an HTML table (date, per-ETF flow columns, total column)
    rather than a clean CSV/JSON API, so this uses a narrow regex-based
    extraction rather than pulling in an HTML parser dependency. Returns
    {} (never raises) if the expected structure is not found -- this is
    intentionally conservative: a wrong/garbled parse of financial flow
    data is worse than an honest empty result.
    """
    import re

    flows = {}
    # Expect rows like: <tr>...<td>DD MMM YYYY</td>...<td>TOTAL_NUMBER</td></tr>
    # This is deliberately narrow; if Farside's markup doesn't match, we
    # return {} rather than guessing.
    row_pattern = re.compile(
        r"(\d{1,2}\s+\w{3}\s+\d{4}).*?<td[^>]*>\s*\(?(-?[\d,]+\.?\d*)\)?\s*</td>\s*</tr>",
        re.IGNORECASE | re.DOTALL,
    )
    months = {m: i + 1 for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
    for date_str, value_str in row_pattern.findall(html):
        try:
            day, mon, year = date_str.split()
            month = months.get(mon[:3].title())
            if month is None:
                continue
            iso_date = f"{int(year):04d}-{month:02d}-{int(day):02d}"
            value = float(value_str.replace(",", ""))
            flows[iso_date] = value
        except (ValueError, KeyError):
            continue
    return flows
