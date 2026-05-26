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
  "rating":                "Strong",
  "rating_reasoning": {
    "summary":          "One-paragraph explanation of why this rating.",
    "primary_drivers":  ["...", "..."],
    "key_risks":        ["...", "..."],
    "evidence": [
      {"type": "report", "ref_id": "ai-infra-2026-q1", "ref_name": "AI Infra Q1 2026", "rank": 1, "reasoning": "verbatim from report ranking"},
      {"type": "bottleneck", "ref_id": "power-density", "ref_name": "Power Density", "role": "winner", "physics_summary": "from bottleneck physics"}
    ],
    "rated_date":       "2026-05-25",
    "rated_by":         "auto"
  },
  "notes":                 "",
  "date_added":            "2026-05-25"
}
```

Field rules:

- **String fields** (`ticker`, `company`, `sector`, `thesis`, `catalyst`, `risks`, `rating`, `notes`, `date_added`) — all strings. `rating` is one of `"Strong" | "Watch" | "Pass" | ""` (empty = unrated); the dashboard styles only those three values.
- **`bottlenecks_addressed`** — array of `id` strings from `data/bottlenecks.json`. **Every id must resolve** to an existing entry — same rule as `reports.json[].rankings[].bottlenecks_addressed`. Defaults to `[]` for tickers not yet tagged. Hand-edits are allowed when you know a ticker plays in a space independent of any single report.
- **`report_refs`** — array of `id` strings from `data/reports.json`. Back-reference: which reports include this ticker. Primarily maintained by the ingestion workflow (forward ref lives in `reports.json[].rankings[].ticker`); rarely hand-edited. Defaults to `[]`.
- **`rating_reasoning`** — structured object the dashboard surfaces in the clickable rating modal. The user expects every rated ticker to have one; an unrated ticker may still carry a reasoning object explaining *why* it's unrated. Subfield rules:
  - `summary` — 2-4 sentences; the punch-line of the rating.
  - `primary_drivers` / `key_risks` — bullet arrays. Specific to this ticker — not boilerplate. Drivers should mirror the report `reasoning` and the bottleneck role; risks should be the things that would force a downgrade.
  - `evidence` — array of cross-references with `{type: "report"|"bottleneck", ref_id, ref_name, ...}` plus type-specific extras (`rank`/`reasoning` for reports, `role`/`physics_summary` for bottlenecks). The dashboard renders each as a clickable link that jumps to the Reports or Bottlenecks tab. Every `ref_id` must resolve in the corresponding file.
  - `rated_date` — ISO date the reasoning was synthesized.
  - `rated_by` — `"auto"` (synthesized by `scripts/synthesize_ratings.py` or `/ingest`) or `"manual"` (user-curated). **The ingest workflow MUST preserve `rated_by == "manual"` entries unchanged** when recomputing reasoning. See *"Recomputing rating reasoning"* below.

Existing entries created before these fields were added are allowed to omit them; treat omission as equivalent to `[]` (or `null` for `rating_reasoning`).

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
10. **Recompute `rating_reasoning`** for every ticker whose `bottlenecks_addressed` or `report_refs` changed in step 9 — per *"Recomputing rating reasoning"* below. Preserve `rated_by == "manual"` entries unchanged. Include the resulting reasoning diff in the confirmation in step 8 (you may need a second confirmation pass if reasoning changes are extensive).
11. **Append a dedup entry to `reports/.processed.json`** for each file processed: `processed_at` (current UTC ISO 8601), `tickers_added`, `tickers_updated`, `report_id` (the `id` from the new `reports.json` entry, for cross-reference).
12. **Move processed files to `reports/archive/`** (preserve filename — don't rename). Verify the `pdf_path` in `reports.json` matches the final archive location.
13. **Remind the user to commit and push** (see the section below).

If the user says **"ingest &lt;filename&gt;"** with an explicit path, process just that file. Still archive it and record it in `.processed.json` afterwards.

If a file fails to parse (corrupt PDF, encrypted, no tickers found), surface the error to the user, leave the file in `reports/` (don't archive it), and don't add it to `.processed.json` — so a retry will pick it up.

## Recomputing rating reasoning

`scripts/synthesize_ratings.py` is the one-shot bootstrap that authored the `rating_reasoning` block on every ticker. After any ingest that adds reports, bottleneck winners, or rating changes, **regenerate reasoning for affected tickers** so the dashboard modal stays in sync.

Rules:

1. **Skip tickers with `rated_by == "manual"`.** That's a user override — never overwrite.
2. **Mechanically rebuild `evidence`** from the freshly merged `reports.json` + `bottlenecks.json` for every auto-rated ticker (the `build_evidence` helper in `synthesize_ratings.py` is the reference implementation).
3. **Re-synthesize `summary` / `primary_drivers` / `key_risks`** when the evidence changes materially — e.g. a new report ranking, a new bottleneck winner role. If only the price snapshot changed, leave the prose alone.
4. **Stamp `rated_date` with today** and keep `rated_by == "auto"`.
5. **Show the user the diff** before writing (same as the main ingest diff) — and only the tickers whose reasoning actually changed.

When the user types **"resynthesize ratings"** or **"recompute reasoning"**, run the same loop but force a re-author of every auto-rated ticker (still preserving `manual`). This is the right answer when the user is changing the rating taxonomy itself, not just adding evidence.

A ticker can also be *manually* overridden from the dashboard: clicking a rating opens the modal, which has a **Copy override snippet** button. The snippet sets `rated_by: "manual"` and is meant to be pasted directly into `data/tickers.json`. After paste, the user commits and pushes — and from that point on, ingest workflows must leave that block alone.

## Dashboard layout (Watchlist view)

The dashboard has four top-level tabs: **Watchlist · Macro · Reports · Bottlenecks**. The Watchlist is the default and shows **all sectors stacked vertically on a single page** — there are no per-sector tabs. Don't reintroduce them.

Per-sector structure:

- One collapsible `<section class="sector-section">` per sector, in the order sectors first appear in `data/tickers.json` (don't re-sort the sector list).
- A sticky `<header class="sector-header">` shows the sector name + ticker count and toggles collapse on click.
- Inside each section a `<table class="sector-table">` renders the tickers. The first column is `#` (composite rank within sector).

Collapsed sectors are persisted to `localStorage` under `stock-tracker.collapsedSectors` (JSON array of sector names). Sort mode, rating filter, and sector-visibility selections are persisted under `stock-tracker.sortMode`, `stock-tracker.ratingFilter`, and `stock-tracker.sectorVisibility`.

### Composite rank score

The default sort within each sector is by a composite score combining quality, momentum, and rating. The formula is in `computeCompositeScore()` in `docs/app.js` and **must stay in sync with this doc**:

```
composite =
    rating_weight           // Strong=3, Watch=1, Pass=-2, ""=0
  + clamp(mansfield_rs / 10, -5, +5)
  + (rev_growth_yoy ?? 0) * 2
  + (above_200dma ? +0.5 : -0.5)   // 0 if null
  + (pct_from_high <= 0.15 ? +0.3 : 0)
```

Rank #1 in a sector is the best-positioned name *right now*. The score itself is surfaced as a hover tooltip on the `#` cell so the math is auditable. Rank cell color: #1 gold, #2-3 silver, others muted gray; a single-ticker sector shows "1" without medal styling.

If you tweak the formula:

1. Update both `computeCompositeScore` and the tooltip-component helpers (`ratingWeightOf`, `mansfieldComponent`, `revGrowthComponent`, `above200Component`, `nearHighComponent`) in `docs/app.js`.
2. Update the formula above in this file.
3. Mention the change in the commit message — the rank order is user-visible and surprising changes feel like a bug.

### Sort, filter, top movers

Above the sector sections, the control row offers:

- **Sort within sector**: `rank` (composite, default) | `mansfield_rs` | `rev_growth_yoy` | `rating` | `price` | `market_cap`. Sort changes only affect the order within each sector — sectors themselves never reorder.
- **Rating filter**: `all` | `strong` | `strong_watch` | `hide_pass`. The composite `#` rank is recomputed across the post-filter slice (so when "Strong only" is on, the visible #1 is the top Strong name, not a hidden Pass).
- **Sector visibility**: `all` | `hide_empty` (hides sections whose post-filter row count is 0).

The **TOP RS / WEAKEST** strip at the top of the watchlist surfaces the 3 highest and 3 lowest Mansfield RS tickers across all sectors. Clicking a chip uncollapses that ticker's sector, scrolls to its row, and flashes it. Top movers always reflect the full universe, regardless of filter/search state.

### Mobile (≤768px)

Tables collapse to a card layout via CSS grid (`grid-template-areas`). The visible cells become: rank, ticker, company, rating (top row); price, rev growth, above-200DMA, Mansfield (second row). Everything else is hidden in column mode but still present in the detail panel that expands on tap. Section headers and the controls bar become non-sticky on mobile to free up vertical space.

## Glossary

`data/glossary.json` is the single source of truth for every definition surfaced in the dashboard — column headers, macro indicators, regime labels, ratings, framework concepts. The dashboard reads it on load (mirrored to `docs/data/glossary.json` by `refresh.py` via the standard `*.json` glob) and turns every term into a clickable popover.

### Schema

```json
{
  "terms": [
    {
      "id":   "mansfield-rs",       // kebab-case unique key — referenced by data-glossary attrs in app.js
      "category": "Relative Strength & Trend",
      "term": "Mansfield Relative Strength",
      "short_definition": "1-2 sentence punchline",
      "formula":          "((current_ratio / 52w_SMA) - 1) × 100",
      "what_it_measures": "1-2 paragraph explanation",
      "interpretation_scale": [
        {"range": "+10 or more", "label": "Strong leadership", "color": "green",  "meaning": "..."},
        {"range": "+3 to +10",   "label": "Outperforming",     "color": "lime"},
        {"range": "-3 to +3",    "label": "Neutral",           "color": "gray",   "meaning": "..."},
        {"range": "-3 to -10",   "label": "Underperforming",   "color": "orange"},
        {"range": "-10 or worse","label": "Lagging badly",     "color": "red",    "meaning": "..."}
      ],
      "how_to_use":       "When to act, what to combine with.",
      "origin":           "Stan Weinstein (1988)",        // optional
      "ken_quote":        "Optional Ken Teng framing",    // optional
      "common_pitfalls":  "Where the metric breaks down"  // optional
    }
  ]
}
```

Categories are rendered in the order they first appear in the file — keep new entries within an existing category if possible. Valid colors are `green | lime | yellow | orange | red | gray` (these map to the dot+highlight CSS in `style.css`).

### Editing rules

1. **Single source of truth.** All definitions live in `data/glossary.json`. Edit the JSON directly or ask Claude Code to update it — never duplicate definitions in markdown or hardcode them in `app.js`.
2. **Every new dashboard metric ships with a glossary entry.** If `refresh.py` or `fetch_macro.py` adds a column, indicator, or chip, add a corresponding glossary entry in the same change. If you add a `data-glossary="foo-bar"` attribute to a DOM element, `foo-bar` must resolve in `glossary.json` (the JS prints a fallback message if it doesn't, but that's a defect, not a feature).
3. **Be substantive.** Include real numbers, real thresholds (e.g., "software 70-90%, semis 50-70%"), and a "why this matters" reasoning sentence. Avoid bland textbook definitions. The interpretation scale is the most important field — that's the part that turns the dashboard into a teaching tool.
4. **Refinements are welcome.** When the user learns something new and wants to refine a definition ("for biotech, gross margin <60% can still be fine because of pre-launch dynamics"), just edit the JSON. The dashboard picks it up on next load.

### Context-aware popover

Numeric cells in the watchlist (Mansfield, % From High, Rev YoY, P/S, EV/S, EV/EBITDA, EPS YoY, Above 200DMA) and macro banner chips (VIX, F&G, Net Liq, DXY, HY OAS, SPY vs 200DMA) carry `data-glossary-cell="<id>"` + `data-glossary-value="<value>"`. Clicking them opens the modal with a context lead line ("AMKR's Mansfield RS is +8.6 → Outperforming (lime zone)") and highlights the matching row in the interpretation scale.

The matching logic lives in `scaleMatchIndex(id, value)` in `docs/app.js`. **If you add a new term with a numeric scale and want context-aware highlighting, add the corresponding case to that function** — the scale itself is just labels; the thresholds for "which row matches value X" are hardcoded JS because the `range` strings in JSON are intentionally human-readable, not parseable.

### Rating chip is special

Clicking a rating chip in the watchlist (Strong / Watch / Pass) opens the **per-ticker reasoning modal** (`rating_reasoning` content), not the glossary. Clicking the **Rating column header** opens the glossary `rating-system` entry. These are intentionally different surfaces: reasoning is "why is THIS ticker rated this way", glossary is "what does the rating SYSTEM mean".

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
