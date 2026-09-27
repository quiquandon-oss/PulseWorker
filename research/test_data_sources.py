import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from data_sources import (
    load_crypto_snapshot, parse_yahoo_chart_json, fetch_yahoo_daily_series,
    fetch_all_symbols, fetch_macro_series, fetch_btc_etf_flows,
    parse_farside_html_table,
)


def test_load_crypto_snapshot_btc_real_file():
    price_by_date, metadata = load_crypto_snapshot("btc_daily.json")
    assert len(price_by_date) > 100
    assert "source" in metadata and "btc_data" in metadata["source"]
    assert "rows" not in metadata
    # spot-check a known date/price from the file
    assert price_by_date.get("2026-09-27") == 84460


def test_load_crypto_snapshot_eth_real_file():
    price_by_date, metadata = load_crypto_snapshot("eth_daily.json")
    assert len(price_by_date) > 100
    assert "eth_data" in metadata["source"]


def _make_yahoo_payload(timestamps_sec, closes, adjcloses=None):
    indicators = {"quote": [{"close": closes}]}
    if adjcloses is not None:
        indicators["adjclose"] = [{"adjclose": adjcloses}]
    return json.dumps({
        "chart": {"result": [{
            "timestamp": timestamps_sec,
            "indicators": indicators,
        }]}
    })


def test_parse_yahoo_chart_json_basic_close():
    payload = _make_yahoo_payload([1704067200, 1704153600], [100.0, 105.0])
    result = parse_yahoo_chart_json(payload)
    assert result == {"2024-01-01": 100.0, "2024-01-02": 105.0}


def test_parse_yahoo_chart_json_prefers_adjclose():
    payload = _make_yahoo_payload([1704067200], [100.0], adjcloses=[99.5])
    result = parse_yahoo_chart_json(payload)
    assert result == {"2024-01-01": 99.5}


def test_parse_yahoo_chart_json_skips_null_observations():
    payload = _make_yahoo_payload([1704067200, 1704153600], [None, 105.0])
    result = parse_yahoo_chart_json(payload)
    assert result == {"2024-01-02": 105.0}


def test_parse_yahoo_chart_json_malformed_returns_empty():
    assert parse_yahoo_chart_json("not json at all") == {}
    assert parse_yahoo_chart_json(json.dumps({"chart": {"result": None}})) == {}
    assert parse_yahoo_chart_json(json.dumps({"unexpected": "shape"})) == {}


def test_fetch_yahoo_daily_series_uses_injected_http_get():
    payload = _make_yahoo_payload([1704067200], [50.0])
    captured_urls = []

    def fake_http_get(url):
        captured_urls.append(url)
        return payload

    result = fetch_yahoo_daily_series("NVDA", range_="2y", http_get=fake_http_get)
    assert result == {"2024-01-01": 50.0}
    assert len(captured_urls) == 1
    assert "NVDA" in captured_urls[0]
    assert "range=2y" in captured_urls[0]


def test_fetch_all_symbols_includes_failed_symbol_as_empty_dict():
    def fake_http_get(url):
        if "GOOD" in url:
            return _make_yahoo_payload([1704067200], [10.0])
        raise RuntimeError("simulated network failure")

    def safe_http_get(url):
        try:
            return fake_http_get(url)
        except RuntimeError:
            return "{}"

    result = fetch_all_symbols(["GOOD", "BAD"], http_get=safe_http_get)
    assert result["GOOD"] == {"2024-01-01": 10.0}
    assert result["BAD"] == {}


def test_fetch_macro_series_maps_names_to_tickers():
    def fake_http_get(url):
        return _make_yahoo_payload([1704067200], [4000.0])

    result = fetch_macro_series(http_get=fake_http_get)
    assert set(result.keys()) == {"sp500", "dollar_index", "treasury_10y_yield"}
    assert result["sp500"] == {"2024-01-01": 4000.0}


def test_parse_farside_html_table_extracts_rows():
    html = """
    <table>
    <tr><td>01 Jan 2024</td><td>10.5</td><td>(2.3)</td><td>8.2</td></tr>
    <tr><td>02 Jan 2024</td><td>-1.1</td><td>0.0</td><td>-1.1</td></tr>
    </table>
    """
    flows = parse_farside_html_table(html)
    assert flows.get("2024-01-01") == 8.2
    assert flows.get("2024-01-02") == -1.1


def test_parse_farside_html_table_unparseable_returns_empty():
    assert parse_farside_html_table("<html><body>no table here</body></html>") == {}


def test_fetch_btc_etf_flows_network_failure_is_evidence_gap():
    def failing_http_get(url):
        raise RuntimeError("connection refused")

    flows, gap = fetch_btc_etf_flows(http_get=failing_http_get)
    assert flows == {}
    assert gap is not None
    assert "fetch failed" in gap


def test_fetch_btc_etf_flows_unparseable_page_is_evidence_gap():
    def empty_http_get(url):
        return "<html>nothing useful</html>"

    flows, gap = fetch_btc_etf_flows(http_get=empty_http_get)
    assert flows == {}
    assert gap is not None


def test_fetch_btc_etf_flows_success_returns_no_gap():
    html = "<tr><td>03 Jan 2024</td><td>5.0</td></tr>"

    def working_http_get(url):
        return html

    flows, gap = fetch_btc_etf_flows(http_get=working_http_get)
    assert gap is None
    assert flows.get("2024-01-03") == 5.0
