"""Parse a research report (markdown or text) via the Anthropic API and
merge extracted tickers into data/tickers.json.

Requires ANTHROPIC_API_KEY in the environment.

Usage:
    uv run scripts/ingest_report.py path/to/report.md

SCAFFOLDING ONLY — parser + merge logic lands in the next pass.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TICKERS_PATH = ROOT / "data" / "tickers.json"


def main() -> int:
    raise NotImplementedError("ingest logic deferred to next pass")


if __name__ == "__main__":
    raise SystemExit(main())
