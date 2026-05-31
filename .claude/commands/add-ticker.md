---
description: Add ticker(s) to the watchlist with optional sector + rating + thesis.
---

# Add ticker(s) to the watchlist

Parse `$ARGUMENTS` for ticker symbols (comma- or space-separated) and an optional sector / rating / thesis. Common phrasings:

- `/add-ticker AAPL` — ask which sector
- `/add-ticker AAPL Software` — sector follows the symbol
- `/add-ticker AAPL --sector "Software" --rating Strong --thesis "..."` — full form
- `/add-ticker AAPL MSFT NOW --sector Software` — multiple tickers, same sector

For each ticker, run the existing CLI in non-interactive form. The CLI handles yfinance validation, duplicate detection, snapshot fetch, and pillar resynthesis automatically:

```bash
uv run python scripts/manage.py add <SYM> --sector "<SECTOR>" [--rating <R>] [--thesis "..."]
```

Behavior rules:

1. **If no sector is given**, first show the current sector list (`uv run python scripts/manage.py sectors`) and ask which one to use. Suggest the closest existing sector before offering to create a new one.
2. **If the sector doesn't exist**, ask the user to confirm creating it (the CLI also prompts, but ask in chat first so the user can see the existing list and decide).
3. **If the ticker already exists**, the CLI will surface its current sector and offer to move it — surface that prompt to the user too.
4. **If the user provided a research report context** (e.g., they just ingested a PDF or pasted report text), also populate `thesis`, `risks[]`, `report_refs[]`, and `bottlenecks_addressed[]` per the schema in CLAUDE.md → "Ticker watchlist".
5. **After every successful add**, remind the user to commit + push. If they prefer, run the CLI with `--push` to auto-commit.

Surface a clear diff per ticker showing: sector, rating, what got auto-populated (one-line thesis, pillar scores after snapshot + pillar resynthesis). Don't bulk-push silently — every add should be visible and reversible.

If yfinance can't validate the ticker (typo, delisted), surface the error and ask before retrying with `--skip-validate`. Never auto-flip `--skip-validate` without asking.
