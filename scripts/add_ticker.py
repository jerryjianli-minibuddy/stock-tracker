"""CLI to add, edit, remove, and list tickers in data/tickers.json.

Usage:
    uv run scripts/add_ticker.py add NVDA --sector "AI Inference" --thesis "..."
    uv run scripts/add_ticker.py edit NVDA --rating Watch
    uv run scripts/add_ticker.py remove NVDA
    uv run scripts/add_ticker.py list

SCAFFOLDING ONLY — command bodies land in the next pass.
"""
from __future__ import annotations

from pathlib import Path

import typer

ROOT = Path(__file__).resolve().parents[1]
TICKERS_PATH = ROOT / "data" / "tickers.json"

app = typer.Typer(help="Edit data/tickers.json locally before pushing to GitHub.")


@app.command()
def add(ticker: str) -> None:
    raise NotImplementedError


@app.command()
def edit(ticker: str) -> None:
    raise NotImplementedError


@app.command()
def remove(ticker: str) -> None:
    raise NotImplementedError


@app.command("list")
def list_cmd() -> None:
    raise NotImplementedError


if __name__ == "__main__":
    app()
