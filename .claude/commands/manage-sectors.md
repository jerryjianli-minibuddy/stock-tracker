---
description: Add, remove, rename, or merge sectors — applied across tickers/reports/bottlenecks consistently.
---

# Manage sectors

Start by showing the current sector list with counts:

```bash
uv run python scripts/manage.py sectors
```

Then read `$ARGUMENTS` (or ask in chat if empty) for what to do. Recognized operations:

| Op | CLI |
|---|---|
| Reserve a new sector name | `uv run python scripts/manage.py sector-add "<NAME>"` |
| Remove an empty sector (or with prompt to move/delete tickers) | `uv run python scripts/manage.py sector-remove "<NAME>"` |
| Rename a sector everywhere | `uv run python scripts/manage.py sector-rename "<OLD>" --to "<NEW>"` |
| Merge sector A into B (de-dups by ticker) | `uv run python scripts/manage.py sector-merge "<A>" --into "<B>"` |

Behavior rules:

1. **For removals or merges** with existing tickers, the CLI will prompt where to move them. Read the prompt out loud to the user before answering — they should decide, not you.
2. **For renames**, the CLI walks `tickers.json` AND `reports.json` AND `bottlenecks.json` (in case any of those reference the sector string). Surface the count of touched records for transparency.
3. **For merges**, conflicts (same ticker in both source and dest sector) are resolved by KEEPING the destination entry. Surface any conflicts so the user knows what was discarded.
4. **After the change**, read out the new sector list with counts so the user can confirm the result matches expectation.
5. **Remind the user to commit + push.** Mention that the per-sector tab in the dashboard updates automatically on the next page load — no rebuild needed.

If the user asks to manage sectors implicitly (e.g., "merge AI Apps into Software"), parse intent directly and proceed without going through the menu. The menu is for when intent isn't clear.

The sector taxonomy is the user's deliberate framework — never auto-canonicalize names ("AI Infrastructure" ≠ "AI Infra"). Always confirm exact spelling before writing.
