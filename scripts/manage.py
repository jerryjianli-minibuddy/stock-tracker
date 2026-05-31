"""Local CLI for managing tickers and sectors in the stock-tracker repo.

Run via:
    uv run tracker add NVDA --sector "AI Infra" --rating Watch
    uv run tracker remove WOLF --reason "0/5 pillars, no thesis"
    uv run tracker move PLTR --to "Software"
    uv run tracker rate NVDA --rating Strong
    uv run tracker sector-add "Quantum"
    uv run tracker sector-rename "AI Apps" --to "Software"
    uv run tracker sector-merge "AI Apps" --into "Software"
    uv run tracker sector-remove "Quantum"
    uv run tracker list [--sector "Software"]
    uv run tracker sectors
    uv run tracker validate

All commands mutate `data/tickers.json` (canonical) and mirror to
`docs/data/tickers.json`. Sector-rename / sector-merge also touch
`reports.json` and `bottlenecks.json` if those files reference the
sector string (they generally don't — sector lives only on tickers —
but the scan is cheap and the future-proofing is worth it).

Pass `--push` to any mutating command to auto-commit + push.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.prompt import Confirm, Prompt
from rich.table import Table

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"
TICKERS_PATH = DATA / "tickers.json"
REPORTS_PATH = DATA / "reports.json"
BOTTLENECKS_PATH = DATA / "bottlenecks.json"
REMOVED_PATH = DATA / "removed_tickers.json"

app = typer.Typer(
    help="Manage tickers + sectors in tickers.json.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


# ---------- IO ----------

def _load(path: Path, default):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save(path: Path, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _save_tickers(tickers: list[dict]) -> None:
    """Write to both canonical and docs/data mirror."""
    _save(TICKERS_PATH, tickers)
    _save(DOCS_DATA / "tickers.json", tickers)


def _today() -> str:
    return date.today().isoformat()


# ---------- helpers ----------

def _find(tickers: list[dict], sym: str) -> Optional[dict]:
    sym_u = sym.upper()
    return next((t for t in tickers if t["ticker"].upper() == sym_u), None)


def _sectors_in_use(tickers: list[dict]) -> dict[str, int]:
    """Sector name → ticker count, in tickers.json insertion order."""
    counts: dict[str, int] = {}
    for t in tickers:
        s = t.get("sector") or "(unset)"
        counts[s] = counts.get(s, 0) + 1
    return counts


def _validate_yfinance(sym: str) -> tuple[bool, str]:
    """Confirm the ticker exists on yfinance. Returns (ok, message).
    Catches typos like 'NVDIA' → False with a hint."""
    try:
        import yfinance as yf
        t = yf.Ticker(sym)
        info = t.info or {}
        if not info or not info.get("regularMarketPrice") and not info.get("currentPrice"):
            return False, f"yfinance returned no price for {sym!r} — possibly delisted or a typo"
        name = info.get("longName") or info.get("shortName") or sym
        price = info.get("regularMarketPrice") or info.get("currentPrice")
        return True, f"{name} (${price})"
    except Exception as e:
        return False, f"yfinance lookup failed: {e}"


def _fetch_snapshot_for(sym: str) -> None:
    """Pull a fresh snapshot for a single ticker and merge into snapshots.json.
    Imports refresh.py lazily so the CLI is fast for non-fetching commands."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import refresh  # type: ignore

    snaps_path = DATA / "snapshots.json"
    history_path = DATA / "history.json"
    snaps = _load(snaps_path, {"last_updated": None, "data": {}})
    history = _load(history_path, {})

    console.print(f"[dim]Fetching snapshot for {sym}...[/dim]")
    try:
        snap = refresh._fetch_one(sym.upper(), spy_6mo_return=None, spy_hist=None)
        snaps["data"][sym.upper()] = snap
        # Append today's price to history (small helper inline)
        price = snap.get("price")
        if price is not None:
            hist = history.setdefault(sym.upper(), [])
            today = _today()
            if not hist or hist[-1]["date"] != today:
                hist.append({"date": today, "price": price})
                history[sym.upper()] = hist[-365:]  # keep ~1y
        from datetime import datetime, timezone
        snaps["last_updated"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _save(snaps_path, snaps)
        _save(DOCS_DATA / "snapshots.json", snaps)
        _save(history_path, history)
        _save(DOCS_DATA / "history.json", history)
        n_ok = sum(1 for v in snap.values() if v is not None and v != [])
        console.print(f"  [green]✓[/green] {sym}: {n_ok} fields populated")
    except Exception as e:
        console.print(f"  [yellow]⚠[/yellow] snapshot fetch failed: {e}")
        console.print(f"  [dim]Next daily-refresh will backfill.[/dim]")


def _resynthesize_pillars(only_ticker: Optional[str] = None) -> None:
    """Re-run pillar synthesis (preserves manual flips + binding theses).
    Currently runs across all tickers — synthesize_pillars.py doesn't support
    a per-ticker mode. Cheap on 56 tickers."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import synthesize_pillars  # type: ignore
    # Run by invoking the script's main(); --preview mode would print only.
    console.print("[dim]Recomputing pillars...[/dim]")
    saved_argv = sys.argv
    try:
        sys.argv = ["synthesize_pillars.py"]
        synthesize_pillars.main()
    finally:
        sys.argv = saved_argv


def _git_commit_push(message: str) -> None:
    """Stage data/ + docs/data/, commit, push. Used by --push flag."""
    try:
        subprocess.run(["git", "add", "-A", "data/", "docs/data/"], check=True, cwd=ROOT)
        # Detect if there are staged changes
        result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
        if result.returncode == 0:
            console.print("[dim]No changes to commit.[/dim]")
            return
        subprocess.run(["git", "commit", "-m", message], check=True, cwd=ROOT)
        subprocess.run(["git", "push"], check=True, cwd=ROOT)
        console.print(f"[green]✓ Pushed:[/green] {message}")
    except subprocess.CalledProcessError as e:
        console.print(f"[red]Git operation failed:[/red] {e}")


def _remind_commit(summary: str, push: bool) -> None:
    if push:
        _git_commit_push(summary)
    else:
        console.print()
        console.print(f"[yellow]Next:[/yellow] commit and push to publish")
        console.print("[dim]  git add -A data/ docs/data/[/dim]")
        console.print(f'[dim]  git commit -m "{summary}"[/dim]')
        console.print("[dim]  git push[/dim]")
        console.print("[dim](or re-run with --push to do this automatically)[/dim]")


def _new_ticker_entry(ticker: str, company: str, sector: str,
                      rating: str = "Watch", thesis: str = "") -> dict:
    return {
        "ticker":   ticker.upper(),
        "company":  company,
        "sector":   sector,
        "thesis":   thesis,
        "one_line_thesis": thesis,
        "bottlenecks_addressed": [],
        "report_refs":  [],
        "catalyst": "",
        "risks":    [],
        "rating":   rating,
        "notes":    "",
        "date_added": _today(),
        "binding_constraint_thesis": None,
    }


# ============ TICKER COMMANDS ============

@app.command()
def add(
    ticker: str = typer.Argument(..., help="Ticker symbol (e.g. NVDA)"),
    sector: str = typer.Option(..., "--sector", "-s", help="Sector name"),
    rating: str = typer.Option("Watch", "--rating", "-r",
                               help="Strong | Watch | Pass | ''"),
    thesis: str = typer.Option("", "--thesis", "-t", help="One-line thesis"),
    skip_validate: bool = typer.Option(False, "--skip-validate",
                                       help="Skip yfinance lookup (use for tickers not on yfinance)"),
    skip_snapshot: bool = typer.Option(False, "--skip-snapshot",
                                       help="Skip fetching a fresh snapshot now"),
    push: bool = typer.Option(False, "--push", help="Auto commit + push after"),
) -> None:
    """Add a ticker. Validates yfinance, fetches snapshot, sets date_added to today."""
    tickers = _load(TICKERS_PATH, [])
    existing = _find(tickers, ticker)
    if existing:
        console.print(f"[yellow]{ticker.upper()}[/yellow] already exists in sector "
                      f"[cyan]{existing['sector']}[/cyan] (rating: {existing.get('rating') or '—'}).")
        if existing["sector"] != sector and Confirm.ask(f"Move it to [cyan]{sector}[/cyan] instead?"):
            existing["sector"] = sector
            _save_tickers(tickers)
            console.print(f"[green]✓[/green] Moved {ticker.upper()} → {sector}")
            _remind_commit(f"Move {ticker.upper()} to {sector}", push)
        return

    # Sector prompt
    sectors = _sectors_in_use(tickers)
    if sector not in sectors:
        console.print(f"[yellow]Sector '{sector}' doesn't exist.[/yellow]")
        console.print(f"Existing sectors: {', '.join(sorted(sectors.keys()))}")
        if not Confirm.ask(f"Create new sector [cyan]{sector}[/cyan]?"):
            console.print("[dim]Aborted.[/dim]")
            return

    # yfinance validation
    company = ""
    if skip_validate:
        company = ticker.upper()
    else:
        ok, msg = _validate_yfinance(ticker)
        if not ok:
            console.print(f"[red]✗ Validation failed:[/red] {msg}")
            if not Confirm.ask("Add anyway?"):
                return
            company = ticker.upper()
        else:
            console.print(f"[green]✓[/green] Validated: {msg}")
            company = msg.split(" ($")[0]  # strip price tail

    entry = _new_ticker_entry(ticker, company, sector, rating, thesis)
    tickers.append(entry)
    _save_tickers(tickers)
    console.print(f"[green]✓[/green] Added [bold]{ticker.upper()}[/bold] — {company} → "
                  f"sector [cyan]{sector}[/cyan], rating [yellow]{rating}[/yellow]")

    if not skip_snapshot:
        _fetch_snapshot_for(ticker)
        _resynthesize_pillars()

    _remind_commit(f"Add {ticker.upper()} to {sector}", push)


@app.command()
def remove(
    ticker: str = typer.Argument(...),
    reason: str = typer.Option("", "--reason", help="Why removed (archived for memory)"),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Remove a ticker. Archives the entry to data/removed_tickers.json."""
    tickers = _load(TICKERS_PATH, [])
    t = _find(tickers, ticker)
    if not t:
        console.print(f"[red]✗[/red] {ticker.upper()} not in tickers.json")
        return

    # Show what we're about to remove
    table = Table(title=f"Removing {t['ticker']}", show_header=False)
    table.add_column("Field"); table.add_column("Value")
    for field in ["company", "sector", "rating", "date_added"]:
        table.add_row(field, str(t.get(field, "")))
    if t.get("pillars_passed") is not None:
        table.add_row("pillars", f"{t['pillars_passed']}/5 → {t.get('pillar_eligibility')}")
    console.print(table)

    if not Confirm.ask(f"Remove [bold red]{ticker.upper()}[/bold red]?"):
        return
    if not reason:
        reason = Prompt.ask("Reason (archived for memory)", default="").strip()

    # Archive
    archive = _load(REMOVED_PATH, [])
    archive.append({**t, "removed_at": _today(), "removal_reason": reason or "(no reason)"})
    _save(REMOVED_PATH, archive)

    # Remove from tickers.json
    tickers = [x for x in tickers if x["ticker"].upper() != ticker.upper()]
    _save_tickers(tickers)

    # Drop from snapshots + history so the dashboard doesn't show stale data
    for path in [DATA / "snapshots.json", DOCS_DATA / "snapshots.json"]:
        s = _load(path, {"data": {}})
        s.get("data", {}).pop(ticker.upper(), None)
        _save(path, s)
    for path in [DATA / "history.json", DOCS_DATA / "history.json"]:
        h = _load(path, {})
        h.pop(ticker.upper(), None)
        _save(path, h)

    console.print(f"[green]✓ Removed[/green] {ticker.upper()} "
                  f"(archived to {REMOVED_PATH.relative_to(ROOT)})")
    _remind_commit(f"Remove {ticker.upper()} from watchlist", push)


@app.command()
def move(
    ticker: str = typer.Argument(...),
    to: str = typer.Option(..., "--to", help="Destination sector"),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Move a ticker to a different sector. Preserves all other fields."""
    tickers = _load(TICKERS_PATH, [])
    t = _find(tickers, ticker)
    if not t:
        console.print(f"[red]✗[/red] {ticker.upper()} not found"); return
    old = t["sector"]
    if old == to:
        console.print(f"[dim]{ticker.upper()} is already in {to}.[/dim]")
        return
    sectors = _sectors_in_use(tickers)
    if to not in sectors and not Confirm.ask(f"Sector '{to}' doesn't exist. Create it?"):
        return
    t["sector"] = to
    _save_tickers(tickers)
    console.print(f"[green]✓[/green] Moved {ticker.upper()}: [yellow]{old}[/yellow] → [cyan]{to}[/cyan]")
    _remind_commit(f"Move {ticker.upper()} to {to}", push)


@app.command()
def rate(
    ticker: str = typer.Argument(...),
    rating: str = typer.Option(..., "--rating", "-r"),
    note: str = typer.Option("", "--note"),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Update the rating on a ticker."""
    if rating not in ("Strong", "Watch", "Pass", ""):
        console.print(f"[red]Rating must be one of:[/red] Strong, Watch, Pass, '' (empty for unrated)")
        return
    tickers = _load(TICKERS_PATH, [])
    t = _find(tickers, ticker)
    if not t:
        console.print(f"[red]✗[/red] {ticker.upper()} not found"); return
    old = t.get("rating") or "—"
    t["rating"] = rating
    if note:
        t["notes"] = f"{t.get('notes', '')}\n{_today()}: {note}".strip()
    _save_tickers(tickers)
    console.print(f"[green]✓[/green] {ticker.upper()} rating: [yellow]{old}[/yellow] → [yellow]{rating or '—'}[/yellow]")
    _remind_commit(f"Rate {ticker.upper()} {rating or 'unrated'}", push)


# ============ SECTOR COMMANDS ============

@app.command("sector-add")
def sector_add(
    name: str = typer.Argument(...),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Register a sector (it'll show as a tab once you add tickers to it).
    Adds a placeholder ticker only? No — sectors are derived from tickers,
    so 'adding' a sector just acknowledges you'll be using the name. Stores
    the name in a sector registry file so the dashboard can pre-show it."""
    tickers = _load(TICKERS_PATH, [])
    if name in _sectors_in_use(tickers):
        console.print(f"[dim]Sector '{name}' already in use.[/dim]")
        return
    console.print(f"[green]✓[/green] Sector [cyan]{name}[/cyan] is reserved.")
    console.print(f"[dim]It'll appear as a tab once you add a ticker via:[/dim]")
    console.print(f"[dim]  tracker add <SYM> --sector \"{name}\"[/dim]")


@app.command("sector-remove")
def sector_remove(
    name: str = typer.Argument(...),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Delete a sector. If it has tickers, prompts to move them somewhere
    or delete all of them. Empty sectors disappear automatically."""
    tickers = _load(TICKERS_PATH, [])
    in_sector = [t for t in tickers if t.get("sector") == name]
    if not in_sector:
        console.print(f"[dim]Sector '{name}' has no tickers; it'll disappear automatically.[/dim]")
        return
    console.print(f"Sector [cyan]{name}[/cyan] has [yellow]{len(in_sector)}[/yellow] tickers: "
                  f"{', '.join(t['ticker'] for t in in_sector)}")
    choice = Prompt.ask("Move them or delete all?",
                        choices=["move", "delete", "cancel"], default="cancel")
    if choice == "cancel":
        return
    if choice == "move":
        sectors = _sectors_in_use(tickers)
        dest = Prompt.ask(f"Destination sector",
                          choices=[s for s in sectors if s != name] + ["__new__"])
        if dest == "__new__":
            dest = Prompt.ask("New sector name")
        for t in in_sector:
            t["sector"] = dest
        _save_tickers(tickers)
        console.print(f"[green]✓[/green] Moved {len(in_sector)} tickers to [cyan]{dest}[/cyan]")
        _remind_commit(f"Remove sector '{name}' (moved {len(in_sector)} tickers to {dest})", push)
    else:  # delete
        if not Confirm.ask(f"[red]Delete all {len(in_sector)} tickers?[/red]"):
            return
        for t in in_sector:
            archive = _load(REMOVED_PATH, [])
            archive.append({**t, "removed_at": _today(),
                            "removal_reason": f"sector '{name}' deleted"})
            _save(REMOVED_PATH, archive)
        tickers = [t for t in tickers if t.get("sector") != name]
        _save_tickers(tickers)
        console.print(f"[green]✓[/green] Deleted sector + {len(in_sector)} tickers (archived)")
        _remind_commit(f"Delete sector '{name}' and its {len(in_sector)} tickers", push)


@app.command("sector-rename")
def sector_rename(
    old: str = typer.Argument(...),
    to: str = typer.Option(..., "--to"),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Rename a sector across tickers.json + reports.json + bottlenecks.json."""
    n = _rename_sector_everywhere(old, to)
    if n == 0:
        console.print(f"[dim]Nothing referenced sector '{old}'.[/dim]")
        return
    console.print(f"[green]✓[/green] Renamed sector [yellow]{old}[/yellow] → [cyan]{to}[/cyan] "
                  f"({n} ticker(s) updated)")
    _remind_commit(f"Rename sector '{old}' to '{to}'", push)


@app.command("sector-merge")
def sector_merge(
    sector_a: str = typer.Argument(..., metavar="SECTOR_A"),
    into: str = typer.Option(..., "--into"),
    push: bool = typer.Option(False, "--push"),
) -> None:
    """Move all of SECTOR_A's tickers into INTO (then delete SECTOR_A)."""
    if sector_a == into:
        console.print(f"[red]Can't merge a sector into itself.[/red]")
        return
    tickers = _load(TICKERS_PATH, [])
    in_a = [t for t in tickers if t.get("sector") == sector_a]
    if not in_a:
        console.print(f"[dim]Sector '{sector_a}' has no tickers.[/dim]")
        return
    in_into = {t["ticker"].upper() for t in tickers if t.get("sector") == into}
    # Move + de-dup
    for t in in_a:
        if t["ticker"].upper() in in_into:
            # Already exists in destination — log the conflict; user manually resolves
            console.print(f"[yellow]⚠[/yellow] {t['ticker']} exists in both — keeping {into} entry")
            tickers = [x for x in tickers if x is not t]
            continue
        t["sector"] = into
    _save_tickers(tickers)
    console.print(f"[green]✓[/green] Merged sector [yellow]{sector_a}[/yellow] into [cyan]{into}[/cyan] "
                  f"({len(in_a)} ticker(s) moved)")
    _remind_commit(f"Merge sector '{sector_a}' into '{into}'", push)


def _rename_sector_everywhere(old: str, new: str) -> int:
    """Update sector string across tickers.json + (defensively) reports.json
    and bottlenecks.json. Returns ticker count touched."""
    n = 0
    tickers = _load(TICKERS_PATH, [])
    for t in tickers:
        if t.get("sector") == old:
            t["sector"] = new; n += 1
    if n > 0:
        _save_tickers(tickers)
    # Reports + bottlenecks rarely reference sector strings, but scan anyway.
    for path in [REPORTS_PATH, BOTTLENECKS_PATH]:
        if not path.exists(): continue
        data = _load(path, None)
        blob = json.dumps(data)
        if old not in blob:
            continue
        # Surgical string replace would be wrong (could hit unrelated text);
        # walk dicts and only swap fields that explicitly use sector.
        def _walk(d):
            if isinstance(d, dict):
                for k, v in d.items():
                    if k in ("sector", "sectors") and v == old:
                        d[k] = new
                    elif k == "sectors" and isinstance(v, list):
                        d[k] = [new if x == old else x for x in v]
                    else:
                        _walk(v)
            elif isinstance(d, list):
                for item in d:
                    _walk(item)
        _walk(data)
        _save(path, data)
        # Mirror
        _save(DOCS_DATA / path.name, data)
    return n


# ============ UTILITY COMMANDS ============

@app.command("list")
def list_cmd(
    sector: Optional[str] = typer.Option(None, "--sector", "-s"),
) -> None:
    """List tickers grouped by sector (or filter to one)."""
    tickers = _load(TICKERS_PATH, [])
    if sector:
        tickers = [t for t in tickers if t.get("sector") == sector]
    grouped: dict[str, list[dict]] = {}
    for t in tickers:
        grouped.setdefault(t.get("sector", "(unset)"), []).append(t)
    for sec, ts in grouped.items():
        table = Table(title=f"{sec} ({len(ts)})", show_lines=False)
        table.add_column("Ticker", style="bold")
        table.add_column("Company")
        table.add_column("Rating", style="yellow")
        table.add_column("Pillars")
        for t in ts:
            pillars = (f"{t.get('pillars_passed','-')}/5"
                       if t.get('pillars_passed') is not None else "-")
            table.add_row(t["ticker"], t.get("company") or "",
                          t.get("rating") or "—", pillars)
        console.print(table)


@app.command("sectors")
def sectors_cmd() -> None:
    """List all sectors with ticker counts."""
    tickers = _load(TICKERS_PATH, [])
    counts = _sectors_in_use(tickers)
    table = Table(title=f"{len(counts)} sectors, {len(tickers)} total tickers")
    table.add_column("Sector"); table.add_column("Count", justify="right")
    for s, n in counts.items():
        table.add_row(s, str(n))
    console.print(table)


@app.command()
def validate(
    online: bool = typer.Option(False, "--online",
                                help="Also hit yfinance to confirm each ticker still exists"),
) -> None:
    """Sanity-check tickers.json for problems."""
    tickers = _load(TICKERS_PATH, [])
    problems: list[str] = []
    # Duplicates
    seen: set[str] = set()
    for t in tickers:
        sym = t["ticker"].upper()
        if sym in seen:
            problems.append(f"  duplicate ticker: {sym}")
        seen.add(sym)
    # Missing sectors
    for t in tickers:
        if not t.get("sector"):
            problems.append(f"  {t['ticker']}: no sector assigned")
    # Cross-refs in reports/bottlenecks pointing at non-existent tickers
    reports = _load(REPORTS_PATH, [])
    for rep in reports:
        for rk in rep.get("rankings", []) or []:
            sym = (rk.get("ticker") or "").upper()
            if sym and sym not in seen:
                problems.append(f"  report '{rep['id']}' ranks {sym} but ticker not in tickers.json")
    bottlenecks = _load(BOTTLENECKS_PATH, [])
    for bn in bottlenecks:
        for kind in ("winners", "losers_or_at_risk"):
            for x in (bn.get(kind) or []):
                sym = str(x).upper()
                # Only flag uppercase-looking tickers (skip company names like "Micron")
                if sym.isalpha() and 1 < len(sym) <= 5 and sym not in seen:
                    problems.append(f"  bottleneck '{bn['id']}' lists {sym} as {kind} but not in tickers.json")
    # Online validation (slow)
    if online:
        console.print(f"[dim]Online validation (will take ~{len(tickers)}s)...[/dim]")
        for t in tickers:
            ok, msg = _validate_yfinance(t["ticker"])
            if not ok:
                problems.append(f"  {t['ticker']}: {msg}")

    if not problems:
        console.print(f"[green]✓ tickers.json is clean[/green] ({len(tickers)} tickers, "
                      f"{len(_sectors_in_use(tickers))} sectors)")
    else:
        console.print(f"[red]Found {len(problems)} issue(s):[/red]")
        for p in problems:
            console.print(p)


if __name__ == "__main__":
    app()
