"""Compute the 5-Pillar Theme-to-Pick scores for every ticker.

Run modes:
  python scripts/synthesize_pillars.py --preview          # show 3 sample tickers, write nothing
  python scripts/synthesize_pillars.py --preview NVDA AVGO PLTR  # specific tickers
  python scripts/synthesize_pillars.py                    # bulk-apply to data/ + docs/data/

Pillars (Theme_to_Pick_Pipeline.md):
  1. moat                — gross margin trend + bottleneck-winner role
  2. tam                 — 3yr revenue CAGR (using YoY as proxy until forward CAGRs are ingested)
  3. founder_led         — founder-CEO / insider ownership / explicit report mention
  4. capital_efficiency  — Rule of 40 = rev_growth_% + fcf_margin_%
  5. valuation_discipline — EV/S ÷ 3yr CAGR (PEG-equivalent); hard gate < 2.5

Counts:
  pillars_passed = number of pillars with pass=True
  pillar_eligibility = "CORE-eligible" (5/5) | "SWING-eligible" (4/5) | "PASS" (<4/5)

Conservative defaults per CLAUDE.md:
  - Quantitative pillars where input data is missing → pass=False
  - founder_led pillar where evidence is unclear → pass=None (unknown, NOT failed)
  - binding_constraint_thesis is NEVER auto-populated — that's the manual judgment
    field required for CORE tagging.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DOCS = ROOT / "docs" / "data"

# Sector → margin threshold bucket. Software-ish sectors have high gross-margin
# economics; hardware-ish are BOM-bound. See CLAUDE.md sector taxonomy.
SOFTWARE_SECTORS = {"AI Infra", "Software", "Healthcare AI", "Thematic ETFs"}
HARDWARE_SECTORS = {
    "Semis - Packaging", "Semis - SiC", "Semis - Process", "Semis - Analog/Sensors",
    "Power Conversion", "Physical AI / Robotics", "Space & Defense",
    "Critical Materials", "Bitcoin Mining / AI HPC",
}

# Thresholds — see Theme_to_Pick_Pipeline.md / CLAUDE.md
MOAT_PCT_SOFTWARE = 60.0   # gross margin %
MOAT_PCT_HARDWARE = 35.0
TAM_CAGR_PCT = 20.0        # 3yr CAGR % (use rev_growth_yoy as proxy)
RULE40_SOFTWARE = 40.0
RULE40_HARDWARE = 25.0     # hardware-cyclical threshold
VAL_DISC_GATE = 2.5        # EV/S ÷ growth — STRICTLY less than to pass

FOUNDER_RE = re.compile(r"\bfounder", re.I)


# ---------- helpers ----------

def sector_type(sector: str) -> str:
    if sector in SOFTWARE_SECTORS:
        return "software"
    if sector in HARDWARE_SECTORS:
        return "hardware"
    return "hardware"  # conservative default for unknown sectors


def fcf_margin(snap: dict) -> float | None:
    """Derive FCF margin from snapshot fields. Snapshots don't carry revenue
    directly, but market_cap / ps_ratio is the same number."""
    fcf = snap.get("fcf_ttm")
    mc = snap.get("market_cap")
    ps = snap.get("ps_ratio")
    if fcf is None or mc is None or ps is None or ps <= 0:
        return None
    revenue = mc / ps
    if revenue <= 0:
        return None
    return fcf / revenue


def pct(v: float | None, digits: int = 1) -> str:
    return "—" if v is None else f"{v * 100:.{digits}f}%"


def fmt_signed_pct(v: float | None, digits: int = 1) -> str:
    if v is None:
        return "—"
    p = v * 100
    return f"{'+' if p >= 0 else ''}{p:.{digits}f}%"


# ---------- pillar computation ----------

def compute_moat(t: dict, snap: dict, bottlenecks: list[dict]) -> dict:
    bucket = sector_type(t["sector"])
    threshold = MOAT_PCT_SOFTWARE if bucket == "software" else MOAT_PCT_HARDWARE
    gm = snap.get("gross_margin") if snap else None
    margin_pass = gm is not None and gm * 100 >= threshold

    sym = t["ticker"].upper()
    bn_winner_in = [
        bn for bn in bottlenecks
        if sym in [w.upper() for w in (bn.get("winners") or [])]
    ]

    # Pass if EITHER the margin clears OR the ticker is a structural bottleneck
    # winner — structural moat trumps quarterly margin compression.
    passed = margin_pass or bool(bn_winner_in)

    evidence_parts: list[str] = []
    if gm is not None:
        verdict = "passes" if margin_pass else "below threshold"
        evidence_parts.append(f"Gross margin {pct(gm)} {verdict} ≥{threshold:.0f}% {bucket}")
    if bn_winner_in:
        names = ", ".join(bn.get("name", bn["id"]) for bn in bn_winner_in[:3])
        evidence_parts.append(f"Bottleneck winner: {names}")
    if not evidence_parts:
        evidence_parts.append("Data missing — verify manually")

    return {
        "pass": passed,
        "evidence": "; ".join(evidence_parts),
        "metric_value": gm,
        "metric_label": "Gross Margin",
        "metric_threshold": f"≥{threshold:.0f}% {bucket}",
    }


def compute_tam(t: dict, snap: dict) -> dict:
    rev_g = snap.get("rev_growth_yoy") if snap else None
    passed = rev_g is not None and rev_g * 100 >= TAM_CAGR_PCT
    if rev_g is not None:
        verdict = "passes" if passed else "below threshold"
        evidence = (
            f"Revenue growth YoY {fmt_signed_pct(rev_g)} {verdict} ≥{TAM_CAGR_PCT:.0f}% "
            "(proxy for 3yr forward CAGR — replace with consensus CAGR when ingested)"
        )
    else:
        evidence = "Revenue growth missing — verify manually"
    return {
        "pass": passed,
        "evidence": evidence,
        "metric_value": rev_g,
        "metric_label": "3yr Revenue CAGR (proxy: YoY)",
        "metric_threshold": f"≥{TAM_CAGR_PCT:.0f}%",
    }


def compute_founder_led(t: dict, reports: list[dict]) -> dict:
    """Qualitative pillar — scan ingested report reasoning for the word
    'founder'. If the reports don't mention it, return pass=None (unknown).
    Per CLAUDE.md, unknown is NOT a fail — it's a flag to verify manually."""
    sym = t["ticker"].upper()
    refs = t.get("report_refs") or []
    matched: list[tuple[str, str]] = []
    for rid in refs:
        rep = next((r for r in reports if r["id"] == rid), None)
        if not rep:
            continue
        for rk in rep.get("rankings", []) or []:
            if (rk.get("ticker") or "").upper() != sym:
                continue
            reasoning = rk.get("reasoning") or ""
            if FOUNDER_RE.search(reasoning):
                # Surface a short snippet (≤200 chars) around the keyword
                m = FOUNDER_RE.search(reasoning)
                start = max(0, m.start() - 60)
                end = min(len(reasoning), m.end() + 120)
                snippet = reasoning[start:end].strip()
                matched.append((rep["id"], snippet))

    if matched:
        rep_id, snippet = matched[0]
        return {
            "pass": True,
            "evidence": f"Report '{rep_id}': \"…{snippet}…\"",
            "metric_value": None,
            "metric_label": "Founder-led signal",
            "metric_threshold": "Founder CEO OR insider >5% OR explicit signal",
        }
    return {
        "pass": None,
        "evidence": "No founder-led mention in ingested reports — verify manually",
        "metric_value": None,
        "metric_label": "Founder-led signal",
        "metric_threshold": "Founder CEO OR insider >5% OR explicit signal",
    }


def compute_capital_efficiency(t: dict, snap: dict) -> dict:
    bucket = sector_type(t["sector"])
    threshold = RULE40_SOFTWARE if bucket == "software" else RULE40_HARDWARE
    rev_g = snap.get("rev_growth_yoy") if snap else None
    fm = fcf_margin(snap) if snap else None
    if rev_g is None or fm is None:
        return {
            "pass": False,
            "evidence": "Rule of 40 inputs missing (rev growth or FCF margin) — verify manually",
            "metric_value": None,
            "metric_label": "Rule of 40",
            "metric_threshold": f"≥{threshold:.0f} {bucket}",
        }
    rule40 = rev_g * 100 + fm * 100
    passed = rule40 >= threshold
    return {
        "pass": passed,
        "evidence": (
            f"Rule of 40 = {rule40:.1f} (rev growth {fmt_signed_pct(rev_g)} + "
            f"FCF margin {pct(fm)}); {'passes' if passed else 'below threshold'} ≥{threshold:.0f} {bucket}"
        ),
        "metric_value": rule40,
        "metric_label": "Rule of 40",
        "metric_threshold": f"≥{threshold:.0f} {bucket}",
    }


def compute_valuation_discipline(t: dict, snap: dict) -> dict:
    ev_s = snap.get("ev_to_sales") if snap else None
    rev_g = snap.get("rev_growth_yoy") if snap else None
    if ev_s is None or rev_g is None or rev_g <= 0:
        return {
            "pass": False,
            "evidence": "EV/S or positive growth missing — cannot compute PEG-equivalent; verify manually",
            "metric_value": None,
            "metric_label": "EV/S NTM ÷ 3yr CAGR (PEG-equivalent)",
            "metric_threshold": f"<{VAL_DISC_GATE} hard gate",
        }
    score = ev_s / (rev_g * 100)
    passed = score < VAL_DISC_GATE
    return {
        "pass": passed,
        "evidence": (
            f"EV/S {ev_s:.1f}x ÷ growth {rev_g * 100:.0f}% = {score:.2f} — "
            f"{'passes' if passed else 'fails'} hard gate <{VAL_DISC_GATE}"
        ),
        "metric_value": score,
        "metric_label": "EV/S NTM ÷ 3yr CAGR (PEG-equivalent)",
        "metric_threshold": f"<{VAL_DISC_GATE} hard gate",
    }


def compute_pillars(t: dict, snap: dict | None, reports: list[dict], bottlenecks: list[dict]) -> dict:
    snap = snap or {}
    return {
        "moat":                  compute_moat(t, snap, bottlenecks),
        "tam":                   compute_tam(t, snap),
        "founder_led":           compute_founder_led(t, reports),
        "capital_efficiency":    compute_capital_efficiency(t, snap),
        "valuation_discipline":  compute_valuation_discipline(t, snap),
    }


def eligibility(passed: int) -> str:
    if passed >= 5:
        return "CORE-eligible"
    if passed == 4:
        return "SWING-eligible"
    return "PASS"


# ---------- main ----------

def main() -> int:
    args = sys.argv[1:]
    preview = "--preview" in args
    preview_tickers = [a for a in args if a != "--preview" and not a.startswith("--")]

    tickers = json.load(open(DATA / "tickers.json"))
    snapshots = json.load(open(DATA / "snapshots.json"))["data"]
    reports = json.load(open(DATA / "reports.json"))
    bottlenecks = json.load(open(DATA / "bottlenecks.json"))

    # Build the pillar dict for every ticker
    computed: dict[str, dict] = {}
    for t in tickers:
        sym = t["ticker"]
        snap = snapshots.get(sym.upper()) or snapshots.get(sym)
        pillars = compute_pillars(t, snap, reports, bottlenecks)
        passed = sum(1 for p in pillars.values() if p["pass"] is True)
        computed[sym] = {
            "pillars": pillars,
            "passed": passed,
            "eligibility": eligibility(passed),
        }

    # --- PREVIEW MODE ---
    if preview:
        sample = preview_tickers
        if not sample:
            # Auto-pick: one likely 5/5, one 4/5, one <4/5
            by_score: dict[int, str] = {}
            for sym, c in computed.items():
                by_score.setdefault(c["passed"], sym)
            ordered = sorted(by_score.items(), reverse=True)
            sample = [s for _, s in ordered[:3]]
        for sym in sample:
            if sym not in computed:
                print(f"!! {sym} not found")
                continue
            c = computed[sym]
            t = next(t for t in tickers if t["ticker"] == sym)
            print(f"=== {sym} — {t['company']} ({t['sector']}) ===")
            print(f"  Pillars: {c['passed']}/5  →  {c['eligibility']}")
            for pname, p in c["pillars"].items():
                pass_str = {True: "PASS", False: "FAIL", None: "UNKN"}[p["pass"]]
                print(f"  [{pass_str}] {pname.upper().replace('_',' ')}")
                print(f"          metric: {p['metric_label']} = {p['metric_value']}")
                print(f"          threshold: {p['metric_threshold']}")
                print(f"          {p['evidence']}")
            print()
        return 0

    # --- BULK APPLY ---
    applied = 0
    for t in tickers:
        sym = t["ticker"]
        c = computed[sym]
        # Migrate legacy `thesis` → `one_line_thesis` if needed (don't overwrite)
        if t.get("thesis") and not t.get("one_line_thesis"):
            t["one_line_thesis"] = t["thesis"]
        # Ensure the field exists (empty if no thesis)
        t.setdefault("one_line_thesis", "")
        t["five_pillars"] = c["pillars"]
        t["pillars_passed"] = c["passed"]
        t["pillars_total"] = 5
        t["pillar_eligibility"] = c["eligibility"]
        # Risks: keep existing if present; ensure list shape
        if isinstance(t.get("risks"), str):
            t["risks"] = [t["risks"]] if t["risks"].strip() else []
        else:
            t.setdefault("risks", [])
        # binding_constraint_thesis: NEVER auto-fill; create as null if absent
        t.setdefault("binding_constraint_thesis", None)
        applied += 1

    # Write to both data/ and docs/data/ mirrors
    for path in [DATA / "tickers.json", DOCS / "tickers.json"]:
        with open(path, "w") as f:
            json.dump(tickers, f, indent=2)
            f.write("\n")

    # Print summary
    from collections import Counter
    elig = Counter(c["eligibility"] for c in computed.values())
    print(f"Applied pillar synthesis to {applied} tickers")
    for e, n in elig.most_common():
        print(f"  {e}: {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
