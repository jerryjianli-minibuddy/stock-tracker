---
description: Remove ticker(s) from the watchlist, archiving the entries for institutional memory.
---

# Remove ticker(s) from the watchlist

Parse `$ARGUMENTS` for ticker symbols. For each:

1. **Show the user the current data** before deletion (sector, rating, pillar score, date_added, any rating_reasoning summary). Make sure they see what they're about to lose.
2. **Ask for a reason** (one-line note, optional but encouraged — this gets archived to `data/removed_tickers.json` so the institutional memory of "why we dropped this" survives).
3. **Run the CLI** in non-interactive form once the user confirms:

   ```bash
   uv run python scripts/manage.py remove <SYM> --reason "<note>"
   ```

The CLI handles: archive to `removed_tickers.json` with `removed_at` + `removal_reason`, drop the entry from `tickers.json`, drop the snapshot + history rows so the dashboard doesn't show stale data. All mirrored to `docs/data/` automatically.

After all removals:

- Show a summary list of what was removed
- Remind the user to commit + push (or run the CLI with `--push` for the last one if they prefer auto-commit)
- Note: any sector that becomes empty after the removal will disappear from the dashboard tabs automatically (no extra cleanup needed)

If the ticker is referenced in a report's rankings or as a bottleneck winner/loser, surface that BEFORE deleting — the user might want to keep it on the watchlist as a tracked-but-Pass name rather than fully removing the cross-reference.
