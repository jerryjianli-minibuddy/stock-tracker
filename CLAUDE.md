# CLAUDE.md

Operational instructions for Claude Code sessions working in this repo.

## Ticker watchlist

**Source of truth:** `data/tickers.json` — hand-edited by the user (or via `scripts/add_ticker.py`).

**Per-entry schema:**

```json
{
  "ticker":                "VRT",
  "company":               "Vertiv",
  "sector":                "Data Center Power",
  "thesis":                "",
  "bottlenecks_addressed": ["power-density", "cooling-efficiency"],
  "report_refs":           ["ai-infra-2026-q1"],
  "catalyst":              "",
  "risks":                 "",
  "rating":                "",
  "notes":                 "",
  "date_added":            "2026-05-25"
}
```

Field rules:

- **String fields** (`ticker`, `company`, `sector`, `thesis`, `catalyst`, `risks`, `rating`, `notes`, `date_added`) — all strings. `rating` is one of `"Strong" | "Watch" | "Pass" | ""` (empty = unrated); the dashboard styles only those three values.
- **`bottlenecks_addressed`** — array of `id` strings from `data/bottlenecks.json`. **Every id must resolve** to an existing entry — same rule as `reports.json[].rankings[].bottlenecks_addressed`. Defaults to `[]` for tickers not yet tagged. Hand-edits are allowed when you know a ticker plays in a space independent of any single report.
- **`report_refs`** — array of `id` strings from `data/reports.json`. Back-reference: which reports include this ticker. Primarily maintained by the ingestion workflow (forward ref lives in `reports.json[].rankings[].ticker`); rarely hand-edited. Defaults to `[]`.

Existing entries created before these fields were added are allowed to omit them; treat omission as equivalent to `[]`.

## Existing sectors

As of last edit to this file (re-read `data/tickers.json` to confirm — this list goes stale as the user adds tickers):

- `AI Apps`
- `AI Infra`
- `Bitcoin Mining / AI HPC`
- `Semis - SiC`

The user is curating this taxonomy deliberately — don't auto-canonicalize names (`AI Infrastructure` ≠ `AI Infra`).

## When adding tickers from a research report

1. **Prefer an existing sector.** Match against the live contents of `data/tickers.json`, not just the cached list above.
2. **If a ticker doesn't fit any existing sector, ASK before inventing a new one.** Show the user the candidate name and let them approve or rename.
3. **Set `date_added` to today** in ISO format (`YYYY-MM-DD`). Use the current date, not the date on the research report.
4. **Leave `snapshots.json` and `history.json` alone.** Those are managed exclusively by `scripts/refresh.py`, which runs daily under `.github/workflows/daily-refresh.yml`. Hand-editing them creates churn that the next refresh overwrites.
5. **Leave `docs/data/*.json` alone too** — those are mirrors of `data/*.json` that `refresh.py` writes for GitHub Pages.

For multi-ticker ingestion from a longer report, `scripts/ingest_report.py` is the intended path (parses the report via Anthropic API, merges into `tickers.json` with a confirmation prompt). If it's still scaffolded (`NotImplementedError`), edit `tickers.json` manually and offer to implement the script as a follow-up.

## Research report metadata

**Source of truth:** `data/reports.json` — array of report entries, hand-curated (Claude-written during ingestion, never touched by `refresh.py`).

**Per-entry schema:**

```json
{
  "id": "ai-infra-2026-q1",
  "title": "AI Inference Infrastructure — Q1 2026",
  "source": "personal research / Morgan Stanley / etc.",
  "date_ingested": "2026-05-25",
  "summary": "One-paragraph thesis of the entire report.",
  "rankings": [
    {
      "rank": 1,
      "ticker": "NVDA",
      "reasoning": "Why this is #1 — the actual argument, not just 'good company'.",
      "bottlenecks_addressed": ["compute-density", "memory-bandwidth"]
    },
    {
      "rank": 2,
      "ticker": "AVGO",
      "reasoning": "...",
      "bottlenecks_addressed": ["interconnect-bandwidth"]
    }
  ],
  "pdf_path": "reports/archive/ai_infra_q1_2026.pdf"
}
```

Field rules:

- **`id`** — kebab-case slug derived from the title (e.g. `ai-infra-2026-q1`). Must be unique within `reports.json`. If a conflict occurs, append `-v2`, `-v3`, etc.
- **`date_ingested`** — today's date in `YYYY-MM-DD`, set when the report is processed (not the report's own publication date — that goes in `source` or `summary` if useful).
- **`summary`** — one paragraph capturing the report's overall thesis, in the author's framing (not yours). Aim for 2-4 sentences.
- **`rankings`** — ordered list. `rank` is 1-indexed and should match the report's own ranking; if the report doesn't rank, infer from emphasis or leave `rankings: []`.
- **`reasoning`** — the *actual argument* for each ranking, paraphrased in 1-3 sentences. Not generic ("great company") — the specific edge the report identifies.
- **`bottlenecks_addressed`** — list of `id` strings drawn **exclusively** from `data/bottlenecks.json`. Don't mint a tag inline. If the report describes a bottleneck that doesn't exist in the taxonomy yet, propose a new `data/bottlenecks.json` entry (using the schema in *"Bottleneck taxonomy"* above) and ask the user before writing — don't auto-add.
- **`pdf_path`** — repo-relative path to the archived file (`reports/archive/<filename>`).

## Bottleneck taxonomy

**Source of truth:** `data/bottlenecks.json` — controlled vocabulary of bottlenecks that reports reference via `rankings[].bottlenecks_addressed`.

**Per-entry schema:**

```json
{
  "id": "memory-bandwidth",
  "name": "HBM Memory Bandwidth",
  "theme": "AI Inference",
  "physics": "Inference is memory-bandwidth-bound, not compute-bound. Each token requires loading the full model from HBM to SRAM...",
  "key_metric": "GB/s per accelerator",
  "current_frontier": "HBM3e: 4.8 TB/s; HBM4 targeting 6.4+ TB/s by 2026",
  "winners": ["NVDA", "AVGO", "Micron", "SK Hynix"],
  "losers_or_at_risk": ["anyone relying on GDDR for inference at scale"],
  "references": ["Chips and Cheese HBM analysis", "SemiAnalysis dive"]
}
```

Field rules:

- **`id`** — kebab-case slug, unique within the file. The only string allowed in any `bottlenecks_addressed` array elsewhere.
- **`name`** — human-readable label for the dashboard/reports view.
- **`theme`** — higher-level grouping (`AI Inference`, `Data Center Power`, ...). Reuse existing themes; don't invent close synonyms.
- **`physics`** — **the most important field in this repo.** A substantive paragraph (3-6 sentences) explaining the actual mechanism with **real numbers and units**: bandwidth in GB/s, power in kW, thermal limits in W/cm², process node in nm, latency in ms, FLOPs, die area, $/wafer, etc. Reading this field cold should leave someone understanding **why the constraint exists in physics or engineering**, not just that it exists. This field is the project's core IP — it accumulates substance across reports.

  ❌ **Avoid:** *"Memory bandwidth is critical for AI workloads."* (generic, no information)
  ❌ **Avoid:** *"Performance is limited by memory access."* (true but vague)
  ✅ **Aim for:** *"Each token of a 70B-parameter FP16 model requires reading 140 GB from HBM. At H100's 3.35 TB/s, the ceiling is ~24 tokens/sec/GPU before any compute happens — which is why HBM3 → HBM3e → HBM4 stacking drives more gains than FLOPs improvements."*

  When a later report adds detail to an existing entry (better numbers, additional context), **enrich the existing field in place** — don't fork a near-duplicate entry.
- **`key_metric`** — the thing you'd actually measure to track progress.
- **`current_frontier`** — best-known state at entry time. **May go stale** — when a new report introduces newer numbers, *update this field in place* (don't fork into a new entry).
- **`winners` / `losers_or_at_risk`** — tickers (or company names for non-listed players) connected to this bottleneck. These create a cross-reference network: a report ranking NVDA #1 with `bottlenecks_addressed: ["memory-bandwidth"]` is implicitly saying NVDA is a winner of that bottleneck.
- **`references`** — citations to the analysis that grounds this entry. Free-form strings (paper titles, blog post names, URLs).

## Ingesting research reports

When the user says **"ingest"** or **"process reports"** with no other context, run this workflow:

1. **Scan `reports/`** for `.pdf` or `.md` files at the top level. Skip anything inside `reports/archive/`.
2. **Filter out files already processed.** `reports/.processed.json` is a dict keyed by filename:
   ```json
   {
     "moneyball_2026_q1.pdf": {
       "processed_at": "2026-05-25T20:00:00Z",
       "tickers_added": ["NVDA", "AVGO"],
       "tickers_updated": ["WOLF"]
     }
   }
   ```
   If `filename in processed`, skip it.
3. **If no unprocessed files exist, say so and stop.** Don't re-process the archive.
4. **Extract tickers from each unprocessed file** per the rules in *"When adding tickers from a research report"* above (prefer existing sectors, ask before inventing new ones, set `date_added` to today). For PDFs, read them with the `Read` tool (it handles PDFs natively).
5. **Build a `reports.json` entry per file** following the schema in *"Research report metadata"* above — capture `title`, `source`, `summary`, ranked `rankings` with `reasoning` and `bottlenecks_addressed`. This is where the *content* of the report lives; the ticker updates are just the side-effect.
6. **Validate every `bottlenecks_addressed` tag against `data/bottlenecks.json`.** Each tag must match an existing `id`. If the report describes a bottleneck not yet in the taxonomy, draft a new entry (full schema: `id`, `name`, `theme`, `physics`, `key_metric`, `current_frontier`, `winners`, `losers_or_at_risk`, `references`) and include it in the diff below — don't quietly invent a tag. If a tag *almost* matches an existing entry (synonym, slight rewording), use the existing one.
7. **If a report has newer numbers for an existing bottleneck's `current_frontier`, propose an in-place update** to that field — include it in the diff. Don't fork a new entry.
8. **Show the user the full diff** — new tickers + ticker field updates + the new `reports.json` entry + any new/updated `bottlenecks.json` entries — and **wait for explicit confirmation** before writing.
9. **Write all three files in lockstep**, maintaining cross-references:
   - **`data/reports.json`** — append the new report entry.
   - **`data/bottlenecks.json`** — write any new entries drafted in step 6 and any `current_frontier` updates from step 7.
   - **`data/tickers.json`** — for every ticker appearing in the report's `rankings`:
     - Append the new report's `id` to that ticker's `report_refs` (deduped).
     - Union the bottleneck tags from that ticker's `rankings` entry into `bottlenecks_addressed` (deduped).
     - If the ticker isn't in `tickers.json` yet, create the entry per the *"When adding tickers from a research report"* rules, with `bottlenecks_addressed` and `report_refs` populated from this report.

   Skipping any of the three leaves dangling references. Treat them as a single atomic write.
10. **Append a dedup entry to `reports/.processed.json`** for each file processed: `processed_at` (current UTC ISO 8601), `tickers_added`, `tickers_updated`, `report_id` (the `id` from the new `reports.json` entry, for cross-reference).
11. **Move processed files to `reports/archive/`** (preserve filename — don't rename). Verify the `pdf_path` in `reports.json` matches the final archive location.
12. **Remind the user to commit and push** (see the section below).

If the user says **"ingest &lt;filename&gt;"** with an explicit path, process just that file. Still archive it and record it in `.processed.json` afterwards.

If a file fails to parse (corrupt PDF, encrypted, no tickers found), surface the error to the user, leave the file in `reports/` (don't archive it), and don't add it to `.processed.json` — so a retry will pick it up.

## After editing tickers.json

Remind the user to commit and push so the next Actions run picks up the new tickers:

```bash
git add data/tickers.json
git commit -m "Add <TICKERS> to watchlist"
git push
```

The next refresh — daily cron at 22:00 UTC weekdays, or manual via **Actions tab → manual-refresh → Run workflow** — will fetch snapshots for the new tickers and commit them back to `data/snapshots.json` + `data/history.json` + the `docs/data/` mirror.

## File ownership at a glance

| Path                                 | Edited by                          |
|--------------------------------------|------------------------------------|
| `data/tickers.json`                  | **User** (or `add_ticker.py`)      |
| `data/reports.json`                  | Claude (append on ingest)          |
| `data/bottlenecks.json`              | Claude (append/update on ingest, user-approved) |
| `data/snapshots.json`                | `refresh.py` only                  |
| `data/history.json`                  | `refresh.py` only                  |
| `docs/data/*.json`                   | `refresh.py` only (Pages mirror)   |
| `docs/{index.html,app.js,style.css}` | Dashboard tasks                    |
| `scripts/*.py`                       | Code tasks                         |
| `.github/workflows/*.yml`            | Workflow tasks                     |
| `reports/*.{pdf,md}`                 | **User** drops in, Claude archives |
| `reports/.processed.json`            | Claude (append-only on ingest)     |
| `reports/archive/`                   | Claude (move target after ingest)  |
