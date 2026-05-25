---
description: Ingest unprocessed research reports from reports/ into tickers/reports/bottlenecks
---

Follow the **"Ingesting research reports"** workflow defined in `CLAUDE.md` at the repo root. The full contract is there — do not improvise.

Quick summary of what this command does:

1. Scan `reports/` for `.pdf` / `.md` files at the top level.
2. Filter out filenames already in `reports/.processed.json`.
3. If no unprocessed files, say so and stop.
4. For each unprocessed file: extract the report's thesis, ranked tickers with **specific** reasoning, and the bottlenecks the report identifies.
5. Validate every bottleneck tag against `data/bottlenecks.json`. If a tag doesn't exist, draft a full new entry (with substantive `physics` per the rules in CLAUDE.md) and include it in the proposed diff.
6. Show the full diff (new tickers, ticker field updates, new report entry, new/updated bottleneck entries, ticker cross-references) and **wait for explicit user confirmation** before writing.
7. Write `data/tickers.json`, `data/reports.json`, `data/bottlenecks.json` atomically — maintain all cross-references.
8. Append to `reports/.processed.json` and move source files to `reports/archive/`.
9. Remind the user to commit and push.

If the user invokes this as `/ingest <filename>`, process only that file (still archive it and record it on success).

**Quality bar for the `physics` field on any new or enriched bottleneck:** real numbers, real units, real constraints — see the bad/good examples in CLAUDE.md. This field is the project's core IP. Vague marketing-language entries should not ship.
