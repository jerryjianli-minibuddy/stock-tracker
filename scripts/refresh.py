"""Fetch latest snapshots for every ticker in data/tickers.json, write
data/snapshots.json, and append today's snapshot to data/history.json
(keeping the most recent 90 entries per ticker chronologically).

Runs daily under .github/workflows/daily-refresh.yml.

Per-ticker failures degrade gracefully — missing fields become None,
a totally-failed ticker is skipped in snapshots.json with prior history
untouched, and the script always exits 0 so the workflow still commits
whatever data we did get.
"""
from __future__ import annotations

import json
import logging
import math
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import yfinance as yf
from rich.console import Console
from rich.table import Table

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"   # mirror for GitHub Pages
TICKERS_PATH = DATA / "tickers.json"
SNAPSHOTS_PATH = DATA / "snapshots.json"
HISTORY_PATH = DATA / "history.json"
HISTORY_MAX = 90

SPY_TICKER = "SPY"
THROTTLE_SECONDS = 0.5
RETRIES = 1
BACKOFF_BASE = 1.0

# Snapshot field order (also the order they appear in JSON output).
SNAPSHOT_FIELDS = [
    # Price + valuation
    "price",
    "market_cap",
    "pe_forward",
    "pe_trailing",
    "ps_ratio",
    "ev_to_sales",
    "ev_to_ebitda",
    "peg_ratio",
    # Growth + margins
    "rev_growth_yoy",
    "eps_growth_yoy",
    "gross_margin",
    "op_margin",
    # Cash + balance
    "fcf_ttm",
    "debt_to_equity",
    # Technicals
    "dma_50",
    "dma_150",
    "dma_200",
    "high_52w",
    "low_52w",
    "volume_avg_30d",
    "rs_proxy",
    # Mansfield Relative Strength vs SPY
    "ratio_vs_spy",
    "ratio_sma_52w",
    "mansfield_rs",
    "ratio_above_sma",
    "ratio_slope_30d",
    "ratio_history_90d",
]

# Fields excluded from per-day history rows (history.json) — keeps history light.
HISTORY_EXCLUDED_FIELDS = {"ratio_history_90d"}

log = logging.getLogger("refresh")
console = Console()


# ---------- entry point ----------

def main() -> int:
    _configure_logging()
    tickers = _load_tickers()
    if not tickers:
        log.warning("data/tickers.json is empty; writing empty snapshots and exiting")
        _write_snapshots({})
        return 0

    symbols = [t["ticker"].upper() for t in tickers]
    log.info("refreshing %d ticker(s): %s", len(symbols), ", ".join(symbols))

    # Read prior history BEFORE writing — used for the price-change column.
    today = date.today().isoformat()
    prior_history = _load_history()
    prior_price: dict[str, Optional[float]] = {
        sym: _last_price_before(prior_history.get(sym, []), today)
        for sym in symbols
    }

    spy_hist = _fetch_spy_history()
    spy_6mo = _spy_6mo_return_from_hist(spy_hist)
    if spy_hist is None or getattr(spy_hist, "empty", True):
        log.warning("SPY benchmark unavailable; rs_proxy and Mansfield RS will be null this run")
    else:
        log.info("SPY 1y history cached (%d rows); 6mo return: %+.2f%%",
                 len(spy_hist), (spy_6mo or 0) * 100)

    snapshots: dict[str, dict] = {}
    for i, sym in enumerate(symbols):
        if i > 0:
            time.sleep(THROTTLE_SECONDS)
        try:
            snap = _fetch_one(sym, spy_6mo, spy_hist)
            snapshots[sym] = snap
            n_ok = sum(1 for k in SNAPSHOT_FIELDS if snap.get(k) is not None)
            log.info("  %s: %d/%d fields", sym, n_ok, len(SNAPSHOT_FIELDS))
        except Exception as e:  # noqa: BLE001
            log.error("  %s: fetch failed: %s", sym, e)

    _write_snapshots(snapshots)
    _append_history(snapshots, prior_history)
    _mirror_to_docs()
    log.info("wrote %d snapshot(s); history.json updated; docs/data/ mirrored", len(snapshots))

    _print_summary(symbols, snapshots, prior_price)
    return 0


def _mirror_to_docs() -> None:
    """Copy data/*.json into docs/data/*.json so GitHub Pages can serve them.

    Pages publishes only what's under /docs/, and won't follow symlinks
    pointing outside the published tree. We keep /data/ as the canonical
    location and treat /docs/data/ as a deployable mirror. Mirrors all
    JSON files so new schemas (reports.json, bottlenecks.json, ...) are
    automatically picked up without touching this script.
    """
    DOCS_DATA.mkdir(parents=True, exist_ok=True)
    for src in DATA.glob("*.json"):
        (DOCS_DATA / src.name).write_bytes(src.read_bytes())


# ---------- IO ----------

def _load_tickers() -> list[dict]:
    if not TICKERS_PATH.exists():
        return []
    with open(TICKERS_PATH, encoding="utf-8") as f:
        return json.load(f)


def _load_history() -> dict[str, list[dict]]:
    if not HISTORY_PATH.exists():
        return {}
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        log.error("history.json corrupt (%s); rebuilding from scratch", e)
        return {}


def _last_price_before(rows: list[dict], target_date: str) -> Optional[float]:
    """Return the most recent row's price whose date < target_date."""
    candidates = [r for r in rows if r.get("date", "") < target_date]
    if not candidates:
        return None
    candidates.sort(key=lambda r: r.get("date", ""))
    return candidates[-1].get("price")


def _write_snapshots(snaps: dict[str, dict]) -> None:
    payload = {
        "last_updated": _utc_now_iso(),
        "data": snaps,
    }
    SNAPSHOTS_PATH.write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )


def _append_history(snaps: dict[str, dict], history: dict[str, list[dict]]) -> None:
    """Append today's snapshot to each ticker's list; keep last 90 by date.

    Idempotent: re-running on the same day replaces today's entry. Tickers
    no longer in tickers.json keep their existing history untouched.
    """
    today = date.today().isoformat()
    for sym, snap in snaps.items():
        entry: dict[str, Any] = {"date": today}
        for k in SNAPSHOT_FIELDS:
            if k in HISTORY_EXCLUDED_FIELDS:
                continue
            entry[k] = snap.get(k)
        rows = history.get(sym, [])
        rows = [r for r in rows if r.get("date") != today]
        rows.append(entry)
        rows.sort(key=lambda r: r.get("date") or "")
        history[sym] = rows[-HISTORY_MAX:]

    HISTORY_PATH.write_text(
        json.dumps(history, indent=2) + "\n", encoding="utf-8"
    )


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


# ---------- yfinance fetch ----------

def _fetch_one(sym: str, spy_6mo_return: Optional[float], spy_hist=None) -> dict:
    t = yf.Ticker(sym)
    info = _safe(lambda: t.info) or {}
    hist_1y = _with_retry(
        lambda: t.history(period="1y", auto_adjust=False),
        label=f"{sym} 1y history",
    )
    hist_6mo = _safe(lambda: t.history(period="6mo", auto_adjust=False))
    q_income = _safe(lambda: t.quarterly_income_stmt)
    q_cash = _safe(lambda: t.quarterly_cashflow)

    snap: dict[str, Any] = {k: None for k in SNAPSHOT_FIELDS}
    # ratio_history_90d defaults to [] not None so it serializes as an array
    snap["ratio_history_90d"] = []
    snap["price"] = _safe(lambda: float(hist_1y["Close"].iloc[-1]))
    snap["market_cap"] = _info_float(info, "marketCap")
    snap["pe_forward"] = _info_float(info, "forwardPE")
    snap["pe_trailing"] = _info_float(info, "trailingPE")
    snap["ps_ratio"] = _info_float(info, "priceToSalesTrailing12Months")
    snap["ev_to_sales"] = _info_float(info, "enterpriseToRevenue")
    snap["ev_to_ebitda"] = _info_float(info, "enterpriseToEbitda")
    snap["peg_ratio"] = _info_float(info, "pegRatio")
    snap["debt_to_equity"] = _info_float(info, "debtToEquity")

    snap["rev_growth_yoy"] = _safe(
        lambda: _yoy_growth(q_income, ["Total Revenue", "TotalRevenue"])
    )
    snap["eps_growth_yoy"] = _safe(
        lambda: _yoy_growth(
            q_income, ["Diluted EPS", "DilutedEPS", "Basic EPS"]
        )
    )
    snap["gross_margin"] = _safe(
        lambda: _latest_margin(
            q_income,
            num_rows=["Gross Profit", "GrossProfit"],
            den_rows=["Total Revenue", "TotalRevenue"],
        )
    )
    snap["op_margin"] = _safe(
        lambda: _latest_margin(
            q_income,
            num_rows=["Operating Income", "OperatingIncome"],
            den_rows=["Total Revenue", "TotalRevenue"],
        )
    )
    snap["fcf_ttm"] = _safe(lambda: _ttm_fcf(q_cash))

    snap["dma_50"] = _safe(
        lambda: float(hist_1y["Close"].rolling(50).mean().iloc[-1])
    )
    snap["dma_150"] = _safe(
        lambda: float(hist_1y["Close"].rolling(150).mean().iloc[-1])
    )
    snap["dma_200"] = _safe(
        lambda: float(hist_1y["Close"].rolling(200).mean().iloc[-1])
    )
    snap["high_52w"] = _safe(lambda: float(hist_1y["High"].max()))
    snap["low_52w"] = _safe(lambda: float(hist_1y["Low"].min()))
    snap["volume_avg_30d"] = _safe(
        lambda: float(hist_1y["Volume"].tail(30).mean())
    )

    stock_6mo = _safe(lambda: _period_return(hist_6mo))
    if stock_6mo is not None and spy_6mo_return is not None:
        snap["rs_proxy"] = stock_6mo - spy_6mo_return

    # Mansfield Relative Strength vs SPY (52w ratio + 30d slope + 90d history)
    mansfield = _compute_mansfield(hist_1y, spy_hist)
    if mansfield:
        snap.update(mansfield)

    snap["fetched_at"] = _utc_now_iso()
    return snap


def _fetch_spy_history():
    """Fetch SPY 1-year daily history once per run; cached implicitly via main()."""
    try:
        return yf.Ticker(SPY_TICKER).history(period="1y", auto_adjust=False)
    except Exception as e:  # noqa: BLE001
        log.warning("SPY benchmark fetch failed: %s", e)
        return None


def _spy_6mo_return_from_hist(spy_hist) -> Optional[float]:
    """Derive 6-month return from the cached 1y history (last ~126 trading days)."""
    if spy_hist is None or getattr(spy_hist, "empty", True):
        return None
    close = spy_hist["Close"].dropna()
    if len(close) < 2:
        return None
    slice_6mo = close.iloc[-126:] if len(close) >= 126 else close
    first, last = float(slice_6mo.iloc[0]), float(slice_6mo.iloc[-1])
    if first == 0 or math.isnan(first) or math.isnan(last):
        return None
    return (last - first) / first


def _compute_mansfield(ticker_hist, spy_hist) -> Optional[dict]:
    """Compute Mansfield Relative Strength against SPY.

    Returns dict with ratio_vs_spy / ratio_sma_52w / mansfield_rs /
    ratio_above_sma / ratio_slope_30d / ratio_history_90d, or None on
    failure. Same math as scripts/fetch_macro.py — kept in sync deliberately.
    """
    if ticker_hist is None or spy_hist is None:
        return None
    if getattr(ticker_hist, "empty", True) or getattr(spy_hist, "empty", True):
        return None
    try:
        import pandas as pd  # local import — pandas comes in transitively via yfinance
        aligned = pd.concat(
            [ticker_hist["Close"], spy_hist["Close"]], axis=1, join="inner"
        ).dropna()
        aligned.columns = ["t", "s"]
        if len(aligned) < 30:
            return None
        ratio = aligned["t"] / aligned["s"]
        sma_window = min(len(ratio), 252)
        sma = float(ratio.rolling(sma_window).mean().iloc[-1])
        if math.isnan(sma):
            sma = float(ratio.mean())
        current = float(ratio.iloc[-1])
        if sma <= 0 or math.isnan(current):
            return None
        mansfield = ((current / sma) - 1) * 100
        slope_30d = ((current / float(ratio.iloc[-30])) - 1) * 100 if len(ratio) >= 30 else None
        history_90 = [round(float(x), 6) for x in ratio.iloc[-90:].tolist()]
        return {
            "ratio_vs_spy": round(current, 6),
            "ratio_sma_52w": round(sma, 6),
            "mansfield_rs": round(mansfield, 2),
            "ratio_above_sma": bool(current >= sma),
            "ratio_slope_30d": round(slope_30d, 2) if slope_30d is not None else None,
            "ratio_history_90d": history_90,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("Mansfield RS computation failed: %s", e)
        return None


# ---------- summary ----------

def _print_summary(
    symbols: list[str],
    snaps: dict[str, dict],
    prior_price: dict[str, Optional[float]],
) -> None:
    table = Table(title=f"Refresh summary — {_utc_now_iso()}")
    table.add_column("Ticker", style="bold")
    table.add_column("Price", justify="right")
    table.add_column("Δ vs prior", justify="right")
    table.add_column("Missing fields")

    for sym in symbols:
        snap = snaps.get(sym)
        if snap is None:
            table.add_row(sym, "—", "—", "[red]FETCH FAILED[/red]")
            continue

        price = snap.get("price")
        price_s = f"${price:,.2f}" if price is not None else "—"

        prev = prior_price.get(sym)
        if prev is None or price is None or prev == 0:
            delta_s = "—"
        else:
            pct = (price - prev) / prev
            color = "green" if pct >= 0 else "red"
            delta_s = f"[{color}]{pct:+.2%}[/]"

        missing = [k for k in SNAPSHOT_FIELDS if snap.get(k) is None]
        if not missing:
            miss_s = "[dim]—[/dim]"
        else:
            miss_s = "[yellow]" + ", ".join(missing) + "[/yellow]"

        table.add_row(sym, price_s, delta_s, miss_s)

    console.print()
    console.print(table)


# ---------- helpers ----------

def _safe(func: Callable[[], Any]) -> Any:
    try:
        v = func()
    except Exception:
        return None
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def _info_float(info: dict, key: str) -> Optional[float]:
    v = info.get(key)
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _with_retry(func: Callable[[], Any], label: str = "") -> Any:
    last_err: Optional[Exception] = None
    for attempt in range(RETRIES + 1):
        try:
            return func()
        except Exception as e:
            last_err = e
            if attempt < RETRIES:
                wait = BACKOFF_BASE * (2 ** attempt)
                log.warning(
                    "%s failed (%s); retry after %.1fs",
                    label or "call", e, wait,
                )
                time.sleep(wait)
    raise RuntimeError(f"{label or 'call'}: {last_err}") from last_err


def _find_row(df, candidates: list[str]):
    if df is None or getattr(df, "empty", True):
        return None
    for c in candidates:
        if c in df.index:
            return df.loc[c]
    lower_map = {str(i).lower().replace(" ", ""): i for i in df.index}
    for c in candidates:
        key = c.lower().replace(" ", "")
        if key in lower_map:
            return df.loc[lower_map[key]]
    return None


def _yoy_growth(q_df, candidates: list[str]) -> Optional[float]:
    """YoY growth from quarterly statement: col 0 (latest Q) vs col 4 (same Q a year ago)."""
    row = _find_row(q_df, candidates)
    if row is None or len(row) < 5:
        return None
    try:
        latest = float(row.iloc[0])
        yago = float(row.iloc[4])
    except (TypeError, ValueError):
        return None
    if math.isnan(latest) or math.isnan(yago) or yago == 0:
        return None
    return (latest - yago) / abs(yago)


def _latest_margin(q_df, num_rows: list[str], den_rows: list[str]) -> Optional[float]:
    num = _find_row(q_df, num_rows)
    den = _find_row(q_df, den_rows)
    if num is None or den is None:
        return None
    try:
        n = float(num.iloc[0])
        d = float(den.iloc[0])
    except (TypeError, ValueError, IndexError):
        return None
    if math.isnan(n) or math.isnan(d) or d == 0:
        return None
    return n / d


def _ttm_fcf(q_cash) -> Optional[float]:
    """TTM free cash flow: sum last 4 quarters. Try direct FCF row first,
    fall back to OperatingCashFlow + CapEx (capex is reported negative)."""
    if q_cash is None or getattr(q_cash, "empty", True):
        return None
    fcf_row = _find_row(q_cash, ["Free Cash Flow", "FreeCashFlow"])
    if fcf_row is not None and len(fcf_row) >= 4:
        try:
            total = float(fcf_row.iloc[:4].sum())
            if not math.isnan(total):
                return total
        except (TypeError, ValueError):
            pass
    ocf = _find_row(
        q_cash,
        [
            "Operating Cash Flow",
            "OperatingCashFlow",
            "Total Cash From Operating Activities",
        ],
    )
    capex = _find_row(q_cash, ["Capital Expenditure", "CapitalExpenditure"])
    if ocf is None or capex is None or len(ocf) < 4 or len(capex) < 4:
        return None
    try:
        ocf_sum = float(ocf.iloc[:4].sum())
        capex_sum = float(capex.iloc[:4].sum())
    except (TypeError, ValueError):
        return None
    if math.isnan(ocf_sum) or math.isnan(capex_sum):
        return None
    return ocf_sum + capex_sum


def _period_return(hist) -> Optional[float]:
    if hist is None or getattr(hist, "empty", True) or len(hist) < 2:
        return None
    try:
        first = float(hist["Close"].iloc[0])
        last = float(hist["Close"].iloc[-1])
    except (KeyError, ValueError, IndexError):
        return None
    if first == 0 or math.isnan(first) or math.isnan(last):
        return None
    return (last - first) / first


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
