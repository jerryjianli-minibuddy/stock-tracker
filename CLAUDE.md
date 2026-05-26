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

- `AI Infra`
- `Software`
- `Semis - Packaging`
- `Semis - SiC`
- `Semis - Process`
- `Semis - Analog/Sensors`
- `Bitcoin Mining / AI HPC`
- `Power Conversion`
- `Critical Materials`
- `Healthcare AI`
- `Physical AI / Robotics`
- `Space & Defense`
- `Thematic ETFs`

The user is curating this taxonomy deliberately — don't auto-canonicalize names (`AI Infrastructure` ≠ `AI Infra`).

**Software is the canonical sector** for application software, SaaS, AI-native apps, dev tools, and platform software. **Do NOT create a separate "AI Apps" sector** — AI-native applications belong in `Software`. If a report uses the phrase "AI Apps" or "AI applications", map those names into `Software` during ingest, not into a new sector.

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

## 5-Pillar framework (Theme-to-Pick scoring)

Every ticker in `data/tickers.json` carries a structured pillar block alongside the rating. The pillars are the **Theme_to_Pick_Pipeline.md** rubric encoded as data — 5 binary gates that determine whether a ticker is even eligible for serious consideration. The dashboard surfaces the pillar score as a clickable "Pillars" column showing ●●●◐● 4/5 dots; clicking opens the **Pillar Breakdown Modal** with per-pillar evidence + the binding-constraint section.

### Schema (per-ticker fields)

```json
{
  "ticker": "PLTR",
  "one_line_thesis": "AIP is the operating layer for enterprise AI…",
  "five_pillars": {
    "moat":                 {"pass": true,  "evidence": "...", "metric_value": 0.87, "metric_label": "Gross Margin", "metric_threshold": "≥60% software"},
    "tam":                  {"pass": true,  "evidence": "...", "metric_value": 0.85, "metric_label": "3yr Revenue CAGR (proxy: YoY)", "metric_threshold": "≥20%"},
    "founder_led":          {"pass": null,  "evidence": "No founder-led mention in ingested reports — verify manually", "metric_value": null, "metric_label": "Founder-led signal", "metric_threshold": "Founder CEO OR insider >5% OR explicit signal"},
    "capital_efficiency":   {"pass": true,  "evidence": "...", "metric_value": 136.2, "metric_label": "Rule of 40", "metric_threshold": "≥40 software"},
    "valuation_discipline": {"pass": true,  "evidence": "...", "metric_value": 0.72, "metric_label": "EV/S NTM ÷ 3yr CAGR (PEG-equivalent)", "metric_threshold": "<2.5 hard gate"}
  },
  "pillars_passed": 4,
  "pillars_total":  5,
  "pillar_eligibility": "SWING-eligible",
  "risks": ["Parabolic 90-day move (+85%) — Phase 5 risk", "..."],
  "binding_constraint_thesis": null
}
```

`pass` is tri-state: `true` (clears the gate), `false` (fails it), `null` (genuinely unknown — counts as not-passing for the 5/5 count but flagged differently in the UI). `pillar_eligibility` is derived from `pillars_passed`: `5/5 → "CORE-eligible"`, `4/5 → "SWING-eligible"`, `<4/5 → "PASS"`.

### Auto-population thresholds (in `scripts/synthesize_pillars.py`)

| Pillar | Pass rule |
|---|---|
| `moat` | gross margin ≥ 60% (software-bucket sectors) **OR** ≥ 35% (hardware-bucket) **OR** ticker named winner of any bottleneck in `bottlenecks.json` |
| `tam` | `rev_growth_yoy` ≥ 20% (currently used as proxy for forward 3yr CAGR — replace when forward consensus is ingested) |
| `founder_led` | the literal word "founder" appears in any ingested report's ranking-reasoning for this ticker. Otherwise `pass: null` (unknown). **Never `pass: false` automatically.** |
| `capital_efficiency` | Rule of 40 (`rev_growth_yoy_% + fcf_margin_%`) ≥ 40 (software) or ≥ 25 (hardware-cyclical). FCF margin derived as `fcf_ttm / (market_cap / ps_ratio)`. |
| `valuation_discipline` | `ev_to_sales / (rev_growth_yoy * 100)` < 2.5 (hard gate). Fails if growth ≤ 0. |

**Sector buckets** for the software-vs-hardware threshold split:
- **Software bucket**: `AI Infra`, `Software`, `Healthcare AI`, `Thematic ETFs`
- **Hardware bucket**: `Semis - *`, `Power Conversion`, `Physical AI / Robotics`, `Space & Defense`, `Critical Materials`, `Bitcoin Mining / AI HPC`

If you add a new sector, classify it in `synthesize_pillars.py` (constants `SOFTWARE_SECTORS` / `HARDWARE_SECTORS`).

### binding_constraint_thesis — NEVER auto-fill

This is the **Section 7** field from Theme_to_Pick_Pipeline: one sentence answering *what's the binding constraint on this theme being delivered at scale in 18-36 months, and is this ticker the chokepoint or merely a beneficiary?*

**Rules:**

1. `scripts/synthesize_pillars.py` initializes this field to `null` and never modifies it on subsequent runs.
2. The ingestion workflow (`/ingest`) **must not auto-fill it** either — even when the source report's reasoning sounds like a binding-constraint thesis, transcribe it into the report's `reasoning` field, not into the ticker's `binding_constraint_thesis`.
3. **Only the user supplies this field**, either by direct JSON edit or by clicking the **+ Add binding constraint thesis…** button in the Pillar Breakdown Modal (which copies a paste-ready JSON snippet to clipboard).
4. The dashboard shows a CORE-eligible ticker as just "CORE-eligible" until the thesis is supplied; once supplied, the eligibility label upgrades to "CORE".
5. The `Eligibility: Has binding thesis` filter in the watchlist shows only tickers where the user has done this work — i.e., names the user would actually consider CORE.

### Glossary cross-reference

Every pillar has a glossary entry under category `5-Pillar Framework` in `data/glossary.json`:

- `five-pillars` — overview of the rubric and CORE/SWING/PASS gates
- `pillar-moat` / `pillar-tam` / `pillar-founder-led` / `pillar-capital-efficiency` / `pillar-valuation-discipline` — per-pillar definitions with thresholds
- `binding-constraint-thesis` — Section 7 explainer
- `pillar-eligibility` — CORE vs SWING vs PASS labels

The Pillar Breakdown Modal renders the pillar names as glossary-clickable (each opens its definition popover). When adding a new pillar or changing thresholds, **update both `scripts/synthesize_pillars.py` AND the glossary entry** — they're the public contract.

### Ingestion integration

When `/ingest` processes a new report, the same workflow expands per ticker:

1. Extract `one_line_thesis` from the report's framing of the ticker (one sentence; if not obvious, leave empty).
2. Auto-compute the 5 pillars per the rules above (`synthesize_pillars.py` is the reference implementation).
3. Append risks from the report's stated risks section into `risks: []` (deduped against existing entries).
4. **Leave `binding_constraint_thesis` as `null`.** Never auto-fill it. Print a clear flag in the ingestion summary:

   ```
   PLTR: pillars ●●◐●● 4/5 (SWING-eligible)
          binding constraint thesis: [REQUIRED for CORE — supply manually]
   ```

5. Show the user a per-ticker pillar diff in the ingest preview (before any writes), so the user can spot-check threshold logic and override `founder_led` from `null` to `true` for known founder-CEOs.

### Re-running pillar synthesis

```bash
uv run scripts/synthesize_pillars.py            # bulk-apply to all 50 tickers
uv run scripts/synthesize_pillars.py --preview  # dry run, shows top 3 by score
uv run scripts/synthesize_pillars.py --preview PLTR NVDA WOLF   # specific tickers
```

The script writes both `data/tickers.json` and `docs/data/tickers.json` (Pages mirror). It preserves:

- **`binding_constraint_thesis`** — never overwritten (see "binding_constraint_thesis — NEVER auto-fill" above).
- **Manual founder-led flips** — if a pillar's evidence starts with `"Manual flip — …"`, the script keeps `pass: true` and the evidence verbatim. Use this when a founder-CEO isn't named in the ingested reports' ranking text (Jensen Huang at NVDA, Alex Karp at PLTR, etc. — the keyword scan misses them but a one-shot hand-edit captures them durably).

Manual override pattern (for `founder_led`):

```json
"founder_led": {
  "pass": true,
  "evidence": "Manual flip — Jensen Huang co-founder & CEO since founding (1993)",
  "metric_value": null,
  "metric_label": "Founder-led signal",
  "metric_threshold": "Founder CEO OR insider >5% OR explicit signal"
}
```

### Forward 3yr revenue CAGR (TAM + valuation discipline pillars)

Two pillars depend on growth rate: `tam` (gate ≥ 20%) and `valuation_discipline` (`EV/S ÷ growth < 2.5`). The synthesis script uses two growth sources, preferring the explicit one when present:

1. **`forward_3yr_cagr_pct`** (optional top-level ticker field) — hand-supplied or report-extracted forward 3yr consensus, in percent. Preferred when present; the pillar evidence will say "(source: <note>)".
2. **`rev_growth_yoy`** from `snapshots.json` — TTM proxy. Used when forward CAGR is absent; the pillar evidence will say "(TTM proxy — set forward_3yr_cagr_pct on the ticker for an explicit consensus number)".

Field shape:

```json
{
  "ticker": "PLTR",
  "forward_3yr_cagr_pct": 30,
  "forward_3yr_cagr_source": "Conservative mid-cycle consensus; report cited 50% near-term guide"
}
```

When ingesting a report that quotes a forward CAGR explicitly (e.g., "~25% 3yr CAGR" in a Software Basket ranking), capture it into `forward_3yr_cagr_pct` so the val_disc pillar reflects the same number the analyst used.

## Dashboard layout (canonical: tab-based)

The dashboard uses **tab-based navigation**. The tab row sits below the macro regime banner and looks like:

```
[ All (N) ] [ AI Infra (4) ] [ Software (6) ] [ Semis - SiC (1) ] ... ⎮ [ Reports (9) ] [ Bottlenecks (11) ] [ Glossary (36) ] [ Macro (RISK-ON) ]
```

- The **All** tab shows every ticker in a single table; the **Sector** column is visible so each row is self-identifying.
- Each **sector tab** filters to that sector and **hides the Sector column** (it's redundant when every row is from one sector).
- **Reports / Bottlenecks / Glossary / Macro** tabs are the non-watchlist views, separated from the sector list by a small divider.
- Sector tabs appear in the order sectors first show up in `data/tickers.json` — don't auto-sort them.

There is **no single-page stacked-sectors view**, **no collapsible sector sections**, **no sticky section headers**, and **no cross-sector Top Movers strip**. These were experiments that have been intentionally reverted. Don't reintroduce them.

### State + persistence

Active tab is persisted to `localStorage` under `stock-tracker.activeTab`, with one of these values: `all`, `sector:<name>`, `reports`, `bottlenecks`, `glossary`, `macro`. On load, an unknown or legacy value falls back to `all`.

Sort and rating filter selections persist under `stock-tracker.sortMode` and `stock-tracker.ratingFilter`. (The older `collapsedSectors` and `sectorVisibility` keys are dead — `init()` no longer reads them.)

### Composite rank score

Every table has a `#` column showing the ticker's **rank within its own sector** by composite score (sorted descending). The formula is in `computeCompositeScore()` in `docs/app.js` and **must stay in sync with this doc**:

```
composite =
    rating_weight           // Strong=3, Watch=1, Pass=-2, ""=0
  + clamp(mansfield_rs / 10, -5, +5)
  + (rev_growth_yoy ?? 0) * 2
  + (above_200dma ? +0.5 : -0.5)   // 0 if null
  + (pct_from_high <= 0.15 ? +0.3 : 0)
```

Rank is sector-local even on the **All** tab — meaning you'll see multiple "#1"s on screen, one per sector. That's intentional: the rank tells you "best-in-sector", and the sector is right next to the rank in the All view. The hover tooltip on the `#` cell shows the per-component breakdown. Rank cell color: #1 gold, #2-3 silver, others muted gray; single-ticker sectors show "1" with no medal styling.

If you tweak the formula:

1. Update both `computeCompositeScore` and the tooltip-component helpers (`ratingWeightOf`, `mansfieldComponent`, `revGrowthComponent`, `above200Component`, `nearHighComponent`) in `docs/app.js`.
2. Update the formula above in this file.
3. Mention the change in the commit message — the rank order is user-visible.

### Sort + filter

**Column-header sort** is the canonical way to reorder rows. Clicking a sortable header cycles through three states:

1. First click → **descending** (▼ arrow appears)
2. Second click → **ascending** (▲ arrow appears)
3. Third click → **default** (back to composite rank within sector, no arrow)

Sort state is persisted **per tab** in `localStorage` under `stock-tracker.tabSorts` as `{ [tabKey]: {col, dir} }`. Switching tabs restores that tab's sort; the AI Infra tab can be sorted by Mansfield desc while the All tab stays on rank-default.

Sortable columns (the `SORTABLE_COLS` table in `docs/app.js`):
- **Numeric** (sort by value): `price`, `market_cap`, `pe_forward`, `ps_ratio`, `ev_to_sales`, `ev_to_ebitda`, `rev_growth_yoy`, `eps_growth_yoy`, `gross_margin`, `pct_from_high`, `mansfield_rs`, `rs_proxy`
- **Boolean** (yes/no): `above_200dma`
- **Categorical** (Strong < Watch < unrated < Pass): `rating`

Non-sortable: `#`, `Ticker`, `Company`, `Sector`, `vs SPY 52w`, `Ratio Trend`. Nulls always sort to the bottom regardless of direction.

**Rating filter** dropdown above the table: `all` | `strong` | `strong_watch` | `hide_pass`. The composite `#` rank is recomputed across the rating-filtered universe (so when "Strong only" is on, the visible #1 is the top Strong name in its sector, not a hidden Pass).

**Search** filters by ticker symbol or company name within the active tab; it does not affect the rank label (search hides, it doesn't reshape the ranking).

### Mobile (≤768px)

Tabs scroll horizontally. Each ticker row collapses to a CSS-grid card showing: rank | ticker + company | rating (row 1); price | rev growth | above-200DMA | Mansfield (row 2). The Sector column is force-hidden on mobile even on the All tab (the sector name would be redundant given the company name is visible). Expand the card by tapping it to see the full detail panel.

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

### Where the glossary is wired up (and where it isn't)

Plain stock metrics are self-explanatory; the watchlist table is for *sorting and scanning*, not for definitions. Headers like Price / Mkt Cap / Fwd P/E / Rev YoY have no ⓘ icon and no popover — clicking them just sorts. The glossary is reserved for things that genuinely benefit from threshold context or framework explanation:

| Surface | Glossary clickable? | Notes |
|---|---|---|
| Watchlist column headers (Price, Mkt Cap, P/E, P/S, EV/S, EV/EBITDA, Rev YoY, EPS YoY, Gross, % From High, RS, Above 200DMA, Rating) | **No** — sort only | These are standard metrics. Adding a ⓘ to each would clutter a 19-column header row. |
| Watchlist **Mansfield** column header | **Yes**, via a separate ⓘ icon next to the label | Mansfield is non-obvious enough to warrant an inline definition. Clicking the label sorts; clicking the ⓘ opens glossary. |
| Watchlist data cells | **No** — context-aware cell popovers are gone | The per-cell "AMKR's Mansfield is +8.6 → Outperforming" feature was removed when the table was reverted to sort-first. The threshold info is one ⓘ click away via the Mansfield column header. |
| Macro banner indicators (VIX, F&G, Net Liq, DXY, HY OAS, SPY vs 200DMA, Regime) | **Yes** | Threshold context is the whole point of the banner; chips carry both `data-glossary` and `data-glossary-cell` so the popover shows the matching zone. |
| Macro tab indicator cards | **Yes** | Same indicators, more detail; titles carry `data-glossary`. |
| Macro tab sector-rotation table headers (Mansfield, 30d slope, Tag, Above 52w SMA) | **Yes** via the ⓘ pattern | The th sorts on body click; ⓘ opens glossary. |
| Bottlenecks tab | Reserved for future use | Physics labels and tag-pills could become glossary-linked; not wired today. |
| Glossary tab | n/a — that's the reference itself | |

Rule of thumb: **plain stock metrics → sort only; framework concepts and macro indicators → glossary clickable.** When adding a new term, decide which side of that line it falls on.

### Macro indicators — CNN F&G + Put/Call

`scripts/fetch_macro.py` pulls Fear & Greed and Put/Call together from CNN's data endpoint:

```
GET https://production.dataviz.cnn.io/index/fearandgreed/graphdata/<YYYY-MM-DD>
```

The endpoint sits behind a Cloudflare-style bot check that rejects bare Python UAs (HTTP 418). The fetcher uses `_http_get_cnn()` which sends a full set of browser-like headers (User-Agent, Accept, Accept-Language, Accept-Encoding, Referer https://www.cnn.com/, Origin) and decompresses gzip/deflate transparently. Don't simplify those headers — CNN's gate is sensitive to header order and completeness.

**Failure mode is explicit:** if the endpoint fails (404, schema change, blocked), the fetcher returns visibly-broken structures (`value: null`, `regime: "unknown"`, `error: "<msg>"`) instead of silently falling back to a wrong value. The old `alternative.me` crypto-F&G fallback has been removed — a wrong number is worse than a missing one. The dashboard renders `— unavailable` in that state.

**Data shape (in `data/macro.json` → `indicators.fear_greed`):**

```json
{
  "value": 58.6,
  "regime": "Greed",
  "rating_raw": "greed",
  "prev_close": 58.2,
  "prev_week": 63.2,
  "prev_month": 68.5,
  "prev_year": 66.8,
  "components": {
    "market_momentum":   {"score": 97.8, "rating": "extreme greed"},
    "price_strength":    {"score": 40.0, "rating": "fear"},
    "price_breadth":     {"score": 25.4, "rating": "fear"},
    "put_call_options":  {"score": 80.0, "rating": "extreme greed"},
    "volatility_vix":    {"score": 50.0, "rating": "neutral"},
    "safe_haven_demand": {"score": 83.6, "rating": "extreme greed"},
    "junk_bond_demand":  {"score": 33.2, "rating": "fear"}
  },
  "history_30d": [{"date": "2026-05-25", "score": 58.6, "rating": "Greed"}, ...],
  "data_timestamp": "2026-05-22T23:59:54+00:00",
  "last_updated":   "2026-05-26T05:11:55Z",
  "source":         "CNN production.dataviz.cnn.io"
}
```

**Put/Call lives at `indicators.put_call`** — same shape minus the components map, with a `zone` field instead of `regime` and an `interpretation` sentence. It IS CNN's put/call sub-component surfaced as a top-level indicator so the banner can have its own chip.

**History accumulates file-side.** CNN's endpoint only ships today's value (each component's `data[]` array has one element). `fetch_macro.py` reads the previous `macro.json`, appends today's score to `history_30d`, dedups by date, keeps the last 30. The history grows from 1 point on day 1 to a rolling 30-day window after a month of daily refreshes.

**Component naming.** Endpoint uses `market_momentum_sp500`, `stock_price_strength`, etc. The friendly UI names (`market_momentum`, `price_strength`, …) are the canonical labels used in `macro.json`, the glossary, and the dashboard. The `CNN_COMPONENTS` dict in `fetch_macro.py` is the source of truth for the mapping.

**Divergence detection.** The F&G popover surfaces a "Divergence Watch" callout when component scores span a range > 50 — the headline composite is an average, and a 50-point spread (e.g., breadth at 25 and momentum at 98) usually means the market regime is internally inconsistent and the headline is a less reliable timing signal.

### Rating chip is special

Clicking a rating chip in the watchlist (Strong / Watch / Pass) opens the **per-ticker reasoning modal** (`rating_reasoning` content), not the glossary. The Rating column header is sortable but does *not* open the glossary (the rating system is documented in this file and in the `rating-system` glossary entry, but reaching it from a sort-first header would conflict with the sort cycle). To read the rating-system definition, use the Glossary tab.

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
