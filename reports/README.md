# reports/

Drop incoming research reports here (PDF or Markdown).

A Claude Code session will ingest them when you say **"ingest"** or **"process reports"**:
it parses each unprocessed file, extracts tickers, merges into `data/tickers.json`,
records completion in `.processed.json`, and moves the source file to `archive/`.

See `CLAUDE.md` at the repo root for the full contract.

## Files

- `*.pdf`, `*.md` at the top level — unprocessed reports awaiting ingestion.
- `.processed.json` — dict keyed by filename; records `processed_at`, `tickers_added`, `tickers_updated` per file.
- `archive/` — reports already processed (kept for audit).

## Privacy note

If you don't want research PDFs committed to a public repo, add a line to `.gitignore`:

```
reports/*.pdf
reports/archive/*.pdf
```

`.processed.json` and this README should still be tracked so future sessions know the workflow exists.
