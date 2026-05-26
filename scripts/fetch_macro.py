"""Fetch macro indicators and sector ETF rotation; synthesize a market regime.

Writes:
  data/macro.json            — regime + 6 indicators
  data/sector_rotation.json  — 13 sector ETFs ranked by Mansfield RS

Designed to fail gracefully — any single source going down sets that
indicator to null but the run still produces usable output. Intended to
run daily before refresh.py.

Sources:
  VIX, DXY, SPY, sector ETFs  : yfinance
  Fear & Greed                : CNN (primary), alternative.me (fallback)
  Net liquidity components    : FRED CSVs (WALCL, WTREGEN, RRPONTSYD)
  HY credit spread            : FRED CSV (BAMLH0A0HYM2)
"""
from __future__ import annotations

import io
import json
import logging
import math
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"

MACRO_PATH = DATA / "macro.json"
SECTOR_PATH = DATA / "sector_rotation.json"

SECTOR_ETFS: list[tuple[str, str]] = [
    ("XLK",  "Technology"),
    ("XLF",  "Financials"),
    ("XLE",  "Energy"),
    ("XLI",  "Industrials"),
    ("XLV",  "Healthcare"),
    ("XLP",  "Consumer Staples"),
    ("XLY",  "Consumer Discretionary"),
    ("XLU",  "Utilities"),
    ("XLB",  "Materials"),
    ("XLRE", "Real Estate"),
    ("XLC",  "Communications"),
    ("SMH",  "Semiconductors"),
    ("XBI",  "Biotech"),
]

USER_AGENT = "Mozilla/5.0 (stock-tracker macro fetcher)"
# CNN's production.dataviz endpoint sits behind Cloudflare-style fingerprinting
# and rejects bare Python UAs (HTTP 418). Use a full browser-like header set
# specifically for the CNN domain.
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
log = logging.getLogger("macro")


# ============ HTTP / helpers ============

def _http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _http_get_cnn(url: str, timeout: int = 20) -> bytes:
    """CNN-flavored GET — passes their bot check and transparently decompresses."""
    import gzip
    import zlib
    req = urllib.request.Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://www.cnn.com/",
        "Origin": "https://www.cnn.com",
        "sec-ch-ua-platform": '"macOS"',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        enc = resp.headers.get("Content-Encoding", "")
    if enc == "gzip":
        body = gzip.decompress(body)
    elif enc == "deflate":
        body = zlib.decompress(body)
    return body


def _safe(func: Callable[[], Any], label: str = "") -> Any:
    try:
        return func()
    except Exception as e:  # noqa: BLE001
        log.warning("[%s] failed: %s", label or "call", e)
        return None


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


# ============ FRED CSV pull ============

def _fetch_fred_csv(series_id: str) -> Optional[pd.DataFrame]:
    """Return DataFrame with columns [date, value] sorted by date asc, or None."""
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    raw = _safe(lambda: _http_get(url), label=f"FRED {series_id}")
    if raw is None:
        return None
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:  # noqa: BLE001
        log.warning("[FRED %s] CSV parse failed: %s", series_id, e)
        return None
    # First column is date (FRED varies: 'DATE', 'observation_date', etc.)
    df.rename(columns={df.columns[0]: "date"}, inplace=True)
    df.rename(columns={df.columns[1]: "value"}, inplace=True)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna().sort_values("date").reset_index(drop=True)
    return df if not df.empty else None


# ============ Indicators ============

def fetch_vix() -> dict:
    hist = _safe(lambda: yf.Ticker("^VIX").history(period="3mo", auto_adjust=False), label="VIX")
    if hist is None or hist.empty:
        return {"current": None, "sma_20d": None, "regime": None}
    close = hist["Close"].dropna()
    current = float(close.iloc[-1])
    sma_20 = float(close.rolling(20).mean().iloc[-1]) if len(close) >= 20 else None
    return {
        "current": round(current, 2),
        "sma_20d": round(sma_20, 2) if sma_20 is not None and not math.isnan(sma_20) else None,
        "regime": _vix_regime(current),
        "description": "VIX measures 30-day implied volatility on S&P 500 options. Low VIX = complacency, high VIX = stress.",
    }


def _vix_regime(v: float) -> str:
    if v < 15:  return "Complacent"
    if v < 20:  return "Normal"
    if v < 25:  return "Elevated"
    if v < 30:  return "Stressed"
    return "Panic"


def fetch_dxy() -> dict:
    hist = _safe(lambda: yf.Ticker("DX-Y.NYB").history(period="6mo", auto_adjust=False), label="DXY")
    if hist is None or hist.empty:
        return {"current": None, "sma_50d": None, "regime": None}
    close = hist["Close"].dropna()
    current = float(close.iloc[-1])
    sma_50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
    return {
        "current": round(current, 2),
        "sma_50d": round(sma_50, 2) if sma_50 is not None and not math.isnan(sma_50) else None,
        "regime": _dxy_regime(current),
        "description": "DXY = US Dollar Index. Rising DXY tightens global liquidity; rule of thumb: >105 things break, >110 historical crisis.",
    }


def _dxy_regime(v: float) -> str:
    if v < 95:   return "Risk-on fuel"
    if v < 100:  return "Neutral"
    if v < 105:  return "Mildly tight"
    if v < 110:  return "Things break"
    return "Crisis"


# Map CNN's verbose component keys to the friendly names we surface in the UI
# (macro.json, dashboard popovers, glossary).
CNN_COMPONENTS = {
    "market_momentum":    "market_momentum_sp500",
    "price_strength":     "stock_price_strength",
    "price_breadth":      "stock_price_breadth",
    "put_call_options":   "put_call_options",
    "volatility_vix":     "market_volatility_vix",
    "safe_haven_demand":  "safe_haven_demand",
    "junk_bond_demand":   "junk_bond_demand",
}


def fetch_fear_greed_and_put_call(prev_macro: dict | None = None) -> tuple[dict, dict]:
    """Returns (fear_greed_dict, put_call_dict).

    Pulls the full composite + sub-components from CNN's production endpoint.
    The endpoint does not expose multi-day history (each component's `data`
    array holds only today's value), so we accumulate a rolling 30-day history
    inside macro.json ourselves — read the prior run's history, append today's
    point if new, trim to 30. `prev_macro` is the previously-written macro.json
    contents (or None on a fresh repo).

    Failure mode (per CLAUDE.md): on any error — HTTP block, schema change,
    parse failure — return visibly-broken structures with value=None and
    rating='unknown' so the dashboard surfaces the problem instead of silently
    falling back to stale or wrong data.
    """
    try:
        return _fetch_cnn_fng_full(prev_macro)
    except Exception as e:  # noqa: BLE001
        log.error("CNN F&G endpoint failed: %s — surfacing as unknown on dashboard", e)
        return _broken_fear_greed(str(e)), _broken_put_call(str(e))


def _fetch_cnn_fng_full(prev_macro: dict | None) -> tuple[dict, dict]:
    # Path-suffix the date so CNN doesn't 404 on us (their JS does the same).
    today = date.today().isoformat()
    url = f"https://production.dataviz.cnn.io/index/fearandgreed/graphdata/{today}"
    raw = _http_get_cnn(url)
    data = json.loads(raw)

    fng = data.get("fear_and_greed") or {}
    if fng.get("score") is None:
        raise ValueError("missing fear_and_greed.score in CNN response")
    score = float(fng["score"])

    components: dict[str, dict] = {}
    for friendly, raw_key in CNN_COMPONENTS.items():
        c = data.get(raw_key) or {}
        cs = c.get("score")
        components[friendly] = {
            "score": round(float(cs), 1) if cs is not None else None,
            "rating": (c.get("rating") or "").lower() or None,
        }

    # Persist rolling history. macro.json gets rewritten each run, so we read
    # whatever was there before, append today's point, dedup by date, keep
    # last 30 entries.
    fg_history = _accumulate_daily_history(
        prev_macro, "fear_greed", "history_30d",
        date_iso=today, score=round(score, 1), rating=_fng_rating_label(score),
    )
    pc_score = components.get("put_call_options", {}).get("score")
    pc_history = _accumulate_daily_history(
        prev_macro, "put_call", "history_30d",
        date_iso=today, score=pc_score, rating=_fng_rating_label(pc_score) if pc_score is not None else None,
    )

    fear_greed = {
        "value":              round(score, 1),
        "regime":             _fng_rating_label(score),       # canonical UI label (Greed, Fear, etc.)
        "rating_raw":         (fng.get("rating") or "").lower(),  # CNN's raw label
        "prev_close":         _round1(fng.get("previous_close")),
        "prev_week":          _round1(fng.get("previous_1_week")),
        "prev_month":         _round1(fng.get("previous_1_month")),
        "prev_year":          _round1(fng.get("previous_1_year")),
        "components":         components,
        "history_30d":        fg_history,
        "data_timestamp":     fng.get("timestamp"),  # CNN's last-update marker
        "last_updated":       _utc_now_iso(),
        "source":             "CNN production.dataviz.cnn.io",
        "description":        ("CNN Fear & Greed Index — composite of 7 sub-indicators "
                               "(market momentum, price strength, breadth, put/call options, "
                               "VIX, safe-haven demand, junk bond demand). 0=Extreme Fear, 100=Extreme Greed."),
    }

    pc_component = components.get("put_call_options", {})
    put_call = {
        "cnn_score":          pc_component.get("score"),
        "cnn_rating":         pc_component.get("rating"),  # CNN's lowercase rating ("extreme greed", etc.)
        "zone":               _fng_rating_label(pc_component.get("score")) if pc_component.get("score") is not None else None,
        "interpretation":     _put_call_interpretation(pc_component.get("score")),
        "history_30d":        pc_history,
        "data_timestamp":     (data.get("put_call_options") or {}).get("timestamp"),
        "last_updated":       _utc_now_iso(),
        "source":             "CNN F&G sub-component (production.dataviz.cnn.io)",
        "note":               ("Higher score = more greedy/bullish positioning. CNN's normalized 0-100 "
                               "version of the put/call ratio — INVERTED vs the raw CBOE ratio (where "
                               "high = fear). For raw equity-only vs index breakdown, separate CBOE "
                               "feed integration would be needed (not implemented)."),
        "description":        ("Put/Call options positioning, CNN-normalized. <25 Extreme Fear / heavy "
                               "put-buying (contrarian buy zone); >75 Extreme Greed / heavy call-buying "
                               "(contrarian sell zone)."),
    }
    return fear_greed, put_call


def _broken_fear_greed(error_msg: str) -> dict:
    return {
        "value":          None,
        "regime":         "unknown",
        "rating_raw":     None,
        "prev_close":     None,
        "prev_week":      None,
        "prev_month":     None,
        "prev_year":      None,
        "components":     {},
        "history_30d":    [],
        "data_timestamp": None,
        "last_updated":   _utc_now_iso(),
        "source":         "unavailable",
        "error":          error_msg,
        "description":    f"CNN F&G endpoint failed. Error: {error_msg}",
    }


def _broken_put_call(error_msg: str) -> dict:
    return {
        "cnn_score":      None,
        "cnn_rating":     None,
        "zone":           "unknown",
        "interpretation": None,
        "history_30d":    [],
        "data_timestamp": None,
        "last_updated":   _utc_now_iso(),
        "source":         "unavailable",
        "error":          error_msg,
        "description":    f"CNN F&G endpoint failed (put/call sub-component unavailable). Error: {error_msg}",
        "note":           None,
    }


def _round1(v) -> float | None:
    return round(float(v), 1) if v is not None else None


def _accumulate_daily_history(prev_macro: dict | None, indicator_key: str,
                              history_field: str, date_iso: str,
                              score: float | None, rating: str | None) -> list[dict]:
    """Append today's score to a rolling 30-day history, deduped by date."""
    prior: list[dict] = []
    if prev_macro:
        ind = (prev_macro.get("indicators") or {}).get(indicator_key) or {}
        prior = list(ind.get(history_field) or [])
    # Drop any prior entry for today's date (re-run on the same day overwrites)
    prior = [p for p in prior if p.get("date") != date_iso]
    if score is not None:
        prior.append({"date": date_iso, "score": score, "rating": rating})
    # Keep most-recent 30 points (sorted by date ascending)
    prior.sort(key=lambda p: p.get("date") or "")
    return prior[-30:]


def _fng_rating_label(v) -> str | None:
    """Canonical UI label for an F&G or put/call score on CNN's 0-100 scale."""
    if v is None:
        return None
    v = float(v)
    if v < 25:  return "Extreme Fear"
    if v < 45:  return "Fear"
    if v < 55:  return "Neutral"
    if v < 75:  return "Greed"
    return "Extreme Greed"


def _put_call_interpretation(score) -> str | None:
    """One-sentence reading of the CNN put/call zone."""
    if score is None:
        return None
    s = float(score)
    if s < 25:  return "Extreme Fear — heavy put buying / panic hedging. Contrarian BUY zone."
    if s < 45:  return "Fear — elevated put activity / defensive positioning."
    if s < 55:  return "Neutral — balanced put/call positioning."
    if s < 75:  return "Greed — call buying outpacing puts / bullish positioning."
    return "Extreme Greed — heavy call buying / complacent. Contrarian SELL zone."


# Backwards-compat shim — older callers still expect fetch_fear_greed().
def fetch_fear_greed() -> dict:
    fg, _pc = fetch_fear_greed_and_put_call(prev_macro=None)
    return fg


def fetch_net_liquidity() -> dict:
    """Net liquidity = Fed balance sheet (WALCL) - TGA (WTREGEN) - Reverse Repo (RRPONTSYD).

    Units: WALCL is millions, WTREGEN and RRPONTSYD are billions of $. Convert all to $B.
    Output direction: 'expanding' if 4-week change positive, else 'contracting'.
    """
    walcl = _fetch_fred_csv("WALCL")
    wtregen = _fetch_fred_csv("WTREGEN")
    rrp = _fetch_fred_csv("RRPONTSYD")
    if walcl is None or wtregen is None or rrp is None:
        return {"current": None, "delta_4w": None, "delta_13w": None, "direction": None,
                "description": "Net liquidity = Fed BS − Treasury General Account − Reverse Repo. FRED fetch failed."}

    # FRED series report inconsistent units (some millions, some billions, can
    # change over time). Auto-detect by magnitude: any latest value >= 10,000
    # is millions and gets normalized to billions.
    def _to_billions(df: pd.DataFrame) -> pd.DataFrame:
        latest = df["value"].iloc[-1]
        scale = 1000.0 if latest >= 10000 else 1.0
        return df.assign(value=df["value"] / scale)

    walcl_b = _to_billions(walcl)
    wtregen_b = _to_billions(wtregen)
    rrp_b = _to_billions(rrp)

    # Align all three to a daily index (RRPONTSYD is daily; WALCL/WTREGEN are weekly).
    # Use forward-fill so each daily date carries the most recent weekly value.
    end_date = max(walcl_b["date"].iloc[-1], wtregen_b["date"].iloc[-1], rrp_b["date"].iloc[-1])
    start_date = end_date - pd.Timedelta(days=400)
    daily_idx = pd.date_range(start_date, end_date, freq="D")

    def _reindex_ff(df: pd.DataFrame, name: str) -> pd.Series:
        s = df.set_index("date")["value"].sort_index()
        return s.reindex(daily_idx, method="ffill").rename(name)

    merged = pd.concat([
        _reindex_ff(walcl_b, "walcl_b"),
        _reindex_ff(wtregen_b, "wtregen_b"),
        _reindex_ff(rrp_b, "rrp_b"),
    ], axis=1).dropna()

    if merged.empty:
        return {"current": None, "delta_4w": None, "delta_13w": None, "direction": None,
                "description": "Net liquidity: no aligned data across WALCL/WTREGEN/RRPONTSYD."}

    merged["net_liq"] = merged["walcl_b"] - merged["wtregen_b"] - merged["rrp_b"]
    current = float(merged["net_liq"].iloc[-1])
    delta_4w = float(current - merged["net_liq"].iloc[-29]) if len(merged) >= 29 else None
    delta_13w = float(current - merged["net_liq"].iloc[-92]) if len(merged) >= 92 else None

    if delta_4w is None:
        direction = None
    elif delta_4w > 0:
        direction = "expanding"
    elif delta_4w < 0:
        direction = "contracting"
    else:
        direction = "flat"

    return {
        "current": round(current, 1),
        "delta_4w": round(delta_4w, 1) if delta_4w is not None else None,
        "delta_13w": round(delta_13w, 1) if delta_13w is not None else None,
        "direction": direction,
        "units": "$B",
        "description": "Net liquidity = Fed balance sheet − Treasury General Account − Reverse Repo. Risk assets follow the trend.",
    }


def fetch_credit_spread() -> dict:
    df = _fetch_fred_csv("BAMLH0A0HYM2")
    if df is None or df.empty:
        return {"current_bps": None, "delta_4w_bps": None, "regime": None,
                "description": "ICE BofA US High Yield OAS (basis points). FRED fetch failed."}
    # FRED returns percent; convert to basis points
    df["bps"] = df["value"] * 100
    current_bps = float(df["bps"].iloc[-1])
    delta_4w = float(current_bps - df["bps"].iloc[-21]) if len(df) >= 21 else None
    return {
        "current_bps": round(current_bps, 0),
        "delta_4w_bps": round(delta_4w, 0) if delta_4w is not None else None,
        "regime": _credit_regime(current_bps),
        "description": "ICE BofA US High Yield Option-Adjusted Spread (bps). The bond market's fear gauge — leads equity stress.",
    }


def _credit_regime(bps: float) -> str:
    if bps < 300: return "Complacent"
    if bps < 500: return "Normal"
    if bps < 700: return "Stressed"
    return "Risk-off confirmed"


def fetch_spy_check(spy_hist: Optional[pd.DataFrame]) -> dict:
    if spy_hist is None or spy_hist.empty:
        return {"price": None, "dma_200": None, "above_200dma": None, "pct_from_200dma": None,
                "description": "SPY 200-day moving average — Ken Teng's primary trend filter."}
    close = spy_hist["Close"].dropna()
    if close.empty:
        return {"price": None, "dma_200": None, "above_200dma": None, "pct_from_200dma": None}
    price = float(close.iloc[-1])
    dma_200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
    if dma_200 is None or math.isnan(dma_200):
        return {"price": round(price, 2), "dma_200": None, "above_200dma": None, "pct_from_200dma": None}
    return {
        "price": round(price, 2),
        "dma_200": round(dma_200, 2),
        "above_200dma": bool(price >= dma_200),
        "pct_from_200dma": round(((price / dma_200) - 1) * 100, 2),
        "description": "SPY 200-day moving average — the primary trend filter. Above = uptrend, below = downtrend.",
    }


# ============ Sector rotation ============

def fetch_sector_rotation(spy_hist: Optional[pd.DataFrame]) -> list[dict]:
    if spy_hist is None or spy_hist.empty:
        log.warning("SPY history unavailable; cannot compute sector rotation")
        return []
    spy_close = spy_hist["Close"].dropna()
    out: list[dict] = []
    for etf, name in SECTOR_ETFS:
        hist = _safe(lambda e=etf: yf.Ticker(e).history(period="1y", auto_adjust=False),
                     label=f"sector {etf}")
        if hist is None or hist.empty:
            out.append({"etf": etf, "name": name, "mansfield_rs": None,
                        "ratio_above_sma": None, "ratio_slope_30d": None,
                        "regime_tag": "Unknown"})
            continue
        m = _compute_mansfield(hist["Close"], spy_close)
        m["etf"] = etf
        m["name"] = name
        m["regime_tag"] = _sector_tag(m.get("ratio_above_sma"), m.get("ratio_slope_30d"))
        # Don't ship the 90d ratio history in sector_rotation.json — bloat
        m.pop("ratio_history_90d", None)
        out.append(m)
    return out


def _compute_mansfield(ticker_close: pd.Series, spy_close: pd.Series) -> dict:
    """Returns mansfield_rs / ratio_above_sma / ratio_slope_30d / ratio_history_90d / etc."""
    aligned = pd.concat([ticker_close, spy_close], axis=1, join="inner").dropna()
    aligned.columns = ["t", "s"]
    if len(aligned) < 30:
        return {"ratio_vs_spy": None, "ratio_sma_52w": None, "mansfield_rs": None,
                "ratio_above_sma": None, "ratio_slope_30d": None, "ratio_history_90d": []}
    ratio = aligned["t"] / aligned["s"]
    sma_window = min(len(ratio), 252)
    sma = float(ratio.rolling(sma_window).mean().iloc[-1])
    if math.isnan(sma):
        sma = float(ratio.mean())
    current = float(ratio.iloc[-1])
    if sma <= 0:
        return {"ratio_vs_spy": None, "ratio_sma_52w": None, "mansfield_rs": None,
                "ratio_above_sma": None, "ratio_slope_30d": None, "ratio_history_90d": []}
    mansfield = ((current / sma) - 1) * 100
    above = bool(current >= sma)
    slope_30d = ((current / float(ratio.iloc[-30])) - 1) * 100 if len(ratio) >= 30 else None
    history_90 = [round(float(x), 6) for x in ratio.iloc[-90:].tolist()]
    return {
        "ratio_vs_spy": round(current, 6),
        "ratio_sma_52w": round(sma, 6),
        "mansfield_rs": round(mansfield, 2),
        "ratio_above_sma": above,
        "ratio_slope_30d": round(slope_30d, 2) if slope_30d is not None else None,
        "ratio_history_90d": history_90,
    }


def _sector_tag(above_sma: Optional[bool], slope_30d: Optional[float]) -> str:
    if above_sma is None or slope_30d is None:
        return "Unknown"
    if above_sma and slope_30d > 0:     return "Leading"
    if not above_sma and slope_30d > 0: return "Improving"
    if above_sma and slope_30d <= 0:    return "Weakening"
    return "Lagging"


# ============ Regime synthesis ============

def synthesize_regime(indicators: dict) -> dict:
    """Score the 6 indicators bullish/bearish and synthesize RISK-ON/MIXED/RISK-OFF.

    Thresholds (per spec):
      VIX <20 bull, >25 bear
      F&G >50 bull, <30 bear
      Net Liq direction expanding bull, contracting bear
      DXY <100 bull, >105 bear
      Credit spread <400bps bull, >500bps bear
      SPY > 200DMA bull, < 200DMA bear
    """
    bullish: list[str] = []
    bearish: list[str] = []

    vix = indicators.get("vix") or {}
    if vix.get("current") is not None:
        v = vix["current"]
        if v < 20:   bullish.append(f"VIX {v:.1f} ({vix['regime']})")
        elif v > 25: bearish.append(f"VIX {v:.1f} ({vix['regime']})")

    fng = indicators.get("fear_greed") or {}
    if fng.get("value") is not None:
        v = fng["value"]
        if v > 50:   bullish.append(f"F&G {v:.0f} ({fng['regime']})")
        elif v < 30: bearish.append(f"F&G {v:.0f} ({fng['regime']})")

    nl = indicators.get("net_liquidity") or {}
    d = nl.get("delta_4w")
    if nl.get("direction") == "expanding" and d is not None:
        bullish.append(f"Net Liq expanding (+${d:.0f}B / 4w)")
    elif nl.get("direction") == "contracting" and d is not None:
        bearish.append(f"Net Liq contracting (${d:.0f}B / 4w)")

    dxy = indicators.get("dxy") or {}
    if dxy.get("current") is not None:
        v = dxy["current"]
        if v < 100:   bullish.append(f"DXY {v:.1f} ({dxy['regime']})")
        elif v > 105: bearish.append(f"DXY {v:.1f} ({dxy['regime']})")

    cs = indicators.get("credit_spread") or {}
    if cs.get("current_bps") is not None:
        bps = cs["current_bps"]
        if bps < 400:   bullish.append(f"HY OAS {bps:.0f}bps ({cs['regime']})")
        elif bps > 500: bearish.append(f"HY OAS {bps:.0f}bps ({cs['regime']})")

    spy = indicators.get("spy_200dma") or {}
    if spy.get("above_200dma") is True:
        bullish.append(f"SPY > 200DMA ({spy['pct_from_200dma']:+.1f}%)")
    elif spy.get("above_200dma") is False:
        bearish.append(f"SPY < 200DMA ({spy['pct_from_200dma']:+.1f}%)")

    # Score
    n_bull, n_bear = len(bullish), len(bearish)
    if n_bull >= 5 and n_bear <= 1:
        regime = "RISK-ON"
        reasoning = f"{n_bull} of 6 signals bullish; risk appetite confirmed."
    elif n_bear >= 4:
        regime = "RISK-OFF"
        reasoning = f"{n_bear} of 6 signals bearish; de-risk."
    else:
        regime = "MIXED"
        reasoning = f"{n_bull} bullish vs {n_bear} bearish — no clear regime; watch for confirmation."

    return {
        "regime": regime,
        "regime_reasoning": reasoning,
        "signals_bullish": bullish,
        "signals_bearish": bearish,
    }


# ============ Main ============

def main() -> int:
    _configure_logging()
    log.info("fetching macro indicators...")

    # SPY history is needed by both spy_200dma + sector rotation — fetch once.
    spy_hist = _safe(lambda: yf.Ticker("SPY").history(period="1y", auto_adjust=False), label="SPY")
    if spy_hist is None or spy_hist.empty:
        log.warning("SPY history fetch failed — sector rotation will be empty")

    # Read the previous macro.json (if any) to preserve rolling 30-day history
    # for F&G + put/call — CNN's endpoint only ships today's value, so we
    # accumulate the history file-side.
    prev_macro: dict | None = None
    if MACRO_PATH.exists():
        try:
            prev_macro = json.loads(MACRO_PATH.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("could not parse prior macro.json (%s) — starting fresh history", e)

    fear_greed, put_call = fetch_fear_greed_and_put_call(prev_macro)

    indicators = {
        "vix":           fetch_vix(),
        "fear_greed":    fear_greed,
        "put_call":      put_call,
        "net_liquidity": fetch_net_liquidity(),
        "dxy":           fetch_dxy(),
        "credit_spread": fetch_credit_spread(),
        "spy_200dma":    fetch_spy_check(spy_hist),
    }

    synthesis = synthesize_regime(indicators)

    macro = {
        "last_updated":      _utc_now_iso(),
        "regime":            synthesis["regime"],
        "regime_reasoning":  synthesis["regime_reasoning"],
        "signals_bullish":   synthesis["signals_bullish"],
        "signals_bearish":   synthesis["signals_bearish"],
        "indicators":        indicators,
    }

    log.info("fetching sector rotation...")
    sectors = fetch_sector_rotation(spy_hist)
    rotation = {"last_updated": _utc_now_iso(), "sectors": sectors}

    DATA.mkdir(exist_ok=True)
    DOCS_DATA.mkdir(parents=True, exist_ok=True)
    MACRO_PATH.write_text(json.dumps(macro, indent=2) + "\n", encoding="utf-8")
    SECTOR_PATH.write_text(json.dumps(rotation, indent=2) + "\n", encoding="utf-8")
    (DOCS_DATA / "macro.json").write_text(json.dumps(macro, indent=2) + "\n", encoding="utf-8")
    (DOCS_DATA / "sector_rotation.json").write_text(json.dumps(rotation, indent=2) + "\n", encoding="utf-8")

    log.info(
        "regime: %s — %d bullish / %d bearish signals",
        synthesis["regime"], len(synthesis["signals_bullish"]), len(synthesis["signals_bearish"]),
    )
    ok = sum(1 for s in sectors if s.get("mansfield_rs") is not None)
    log.info("sector ETFs: %d/%d computed", ok, len(SECTOR_ETFS))
    return 0


def _configure_logging() -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )


if __name__ == "__main__":
    raise SystemExit(main())
