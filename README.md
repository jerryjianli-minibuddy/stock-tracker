# stock-tracker

A watchlist tracker designed to live on GitHub. Daily price + fundamentals
data is fetched by a GitHub Actions cron job and committed back as JSON; a
static dashboard in `docs/` reads those JSON files and renders the
watchlist — hosted via GitHub Pages, no server required.

## How it fits together

```
  edit by hand / via CLI                committed by Actions
        ↓                                        ↓
  data/tickers.json    ←─── refresh.py ───→  data/snapshots.json
  (watchlist + notes)         ↑               data/history.json
                              │                       │
                              └── GitHub Actions      ↓
                                  (daily-refresh)   docs/index.html
                                                     reads JSON
                                                     (GitHub Pages)
```

- **You own `data/tickers.json`** — your watchlist and your notes. Edit
  it directly or via `scripts/add_ticker.py`, then push.
- **Actions owns `data/snapshots.json` + `data/history.json`** — daily
  cron job at 21:15 UTC fetches via yfinance and commits the refreshed
  JSON back to the repo.
- **`docs/` is the dashboard** — pure static HTML/JS that reads the JSON
  files. GitHub Pages serves it.

## Layout

```
stock-tracker/
├── pyproject.toml              # uv-managed deps (yfinance, typer, anthropic, ...)
├── scripts/
│   ├── refresh.py              # fetches + writes snapshots.json + history.json
│   ├── add_ticker.py           # CLI to edit tickers.json
│   └── ingest_report.py        # Anthropic-API parser that merges tickers
├── data/
│   ├── tickers.json            # [] — committed by you
│   ├── snapshots.json          # {} — committed by Actions
│   └── history.json            # {} — committed by Actions (last 90/ticker)
├── docs/
│   ├── index.html              # GitHub Pages dashboard
│   ├── app.js
│   └── style.css
└── .github/workflows/
    └── daily-refresh.yml       # cron + commit back
```

## Local setup

```bash
uv sync
uv run scripts/add_ticker.py add NVDA --sector "AI Inference" --thesis "..."
uv run scripts/refresh.py          # fetches today's data into data/
```

## Enable the daily refresh

1. Push the repo to GitHub.
2. **Settings → Actions → General → Workflow permissions** → enable
   *"Read and write permissions"* (so the workflow can push commits).
3. The cron in `.github/workflows/daily-refresh.yml` (21:15 UTC, weekdays)
   will fire automatically. To trigger it on demand: **Actions →
   daily-refresh → Run workflow**.

## Enable the dashboard

1. **Settings → Pages → Source: Deploy from a branch**
2. Branch `main`, folder `/docs`.
3. Visit `https://<your-user>.github.io/stock-tracker/`.

## Schemas

`data/tickers.json` — your watchlist:

```json
[
  {
    "ticker": "NVDA",
    "company": "NVIDIA",
    "sector": "AI Inference",
    "thesis": "Accelerator near-monopoly; CUDA moat.",
    "catalyst": "Blackwell ramp through 2026.",
    "risks": "Inference shifting to custom ASICs.",
    "rating": "Strong",
    "notes": "Core long.",
    "date_added": "2026-05-25"
  }
]
```

`data/snapshots.json` — latest fetched data:

```json
{
  "last_updated": "2026-05-26T22:00:00Z",
  "data": {
    "NVDA": {
      "price": 950.20,
      "market_cap": 2300000000000,
      "pe_forward": 35.2,
      "rev_growth_yoy": 0.94,
      "eps_growth_yoy": 1.12,
      "gross_margin": 0.75,
      "op_margin": 0.62,
      "dma_50": 920.10,
      "dma_200": 780.40,
      "high_52w": 974.00,
      "low_52w": 410.20,
      "rs_proxy": 0.45,
      "fetched_at": "2026-05-26T22:00:00Z"
    }
  }
}
```

`data/history.json` — last 90 snapshots per ticker, for sparklines:

```json
{
  "NVDA": [ {"date": "2026-05-26", "price": 950.20, ...}, ... ]
}
```

## Status

Scaffolding only — the three `scripts/*.py` files raise `NotImplementedError`
and `docs/index.html` shows a placeholder. Implementation lands in the next
passes.
