"""One-shot bootstrap: synthesize rating_reasoning for every ticker in
data/tickers.json by reading reports.json and bottlenecks.json.

The summary / primary_drivers / key_risks per ticker were authored by hand
(below). The evidence list is mechanically assembled from reports and
bottlenecks so every cited fact is traceable to a JSON entry.

Future ingests (via the /ingest slash command) follow the same pattern:
when a new report lands, recompute reasoning for every affected ticker,
preserving manual overrides (rated_by == "manual").
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"

TODAY = "2026-05-25"

# ============ Per-ticker synthesis content ============

SYNTHESES: dict[str, dict] = {
    "NVDA": {
        "summary": "Owns the AI compute brains layer (GR00T, Cosmos, Jetson Thor). Watch (not Strong) because the data-center thesis is already in price; humanoid is real optionality but won't move the needle for years.",
        "primary_drivers": [
            "GPU near-monopoly with CUDA software moat — winner of memory-bandwidth and compute-density bottlenecks.",
            "Brains layer for Physical AI: GR00T N1.6 + Cosmos Reason 2 + Isaac Lab-Arena + Jetson Thor reference design.",
            "Tier 2 in humanoid report — humanoid is a free option, not the marginal driver of the stock today.",
        ],
        "key_risks": [
            "Forward P/E 21.6-25.8x cheap given growth — but the data-center thesis is fully attributable, not surprising.",
            "Humanoid contribution is <1% of revenue; rerating happens by attribution, not surprise.",
            "Inference shift toward custom ASICs (hyperscaler in-house silicon) over time.",
        ],
    },
    "AVGO": {
        "summary": "Not directly ranked in any ingested report, but tagged as a structural winner in two of the most important AI-infrastructure bottlenecks — HBM memory bandwidth and optical interconnect. Indirect evidence supports a Watch designation; would upgrade to Strong if a deep-dive ranks AVGO top-3 explicitly.",
        "primary_drivers": [
            "Winner of the HBM memory-bandwidth bottleneck — direct beneficiary of the HBM3e → HBM4 stacking arc alongside NVDA, Micron, SK Hynix.",
            "Winner of the optical interconnect-bandwidth bottleneck — #2 share at 800G/1.6T behind Marvell, with growing share at 1.6T.",
            "Hyperscaler ASIC anchor (Google TPU, Meta MTIA, OpenAI custom inference) — repeatedly cited across reports as a Tier-1 incumbent that other names re-rate against.",
        ],
        "key_risks": [
            "No direct report evidence — thesis rests entirely on bottleneck-level structural positioning. Upgrade requires a dedicated ingest.",
            "Mansfield RS moderately extended — discipline on entry timing matters.",
            "Customer concentration with hyperscalers — single large-customer insourcing event (e.g., Google reducing TPU partnership) materially impacts the franchise.",
        ],
        "rating_override": "Watch",  # currently "" — bottleneck winner evidence justifies Watch
    },
    "WOLF": {
        "summary": "In watchlist for SiC EV power-electronics exposure but no ingested research currently anchors a rating. Mansfield RS +166 reflects the post-blowup recovery from $8 lows; not a thesis-based signal.",
        "primary_drivers": [],
        "key_risks": [],
    },
    "PLTR": {
        "summary": "5/5 pillars and the only name the phase gate authorizes to enter in the Phase 4-in-correction software regime. SWING-only entry with hard stop — a CORE upgrade requires articulating the Stage-7 chokepoint thesis (governance/ontology layer vs. NVDA-dependent beneficiary).",
        "primary_drivers": [
            "Highest Composite score (68.5) in the Boloor software basket — only name clearing 5/5 pillars at the #1 rank.",
            "Q1 2026: revenue +85% YoY to $1.633B, 'largest ever' guide raise to $7.65-7.66B, Rule of 40 of 145%, adj FCF margin 57%.",
            "EV/NTM Sales 41x against ~50% forward 3-yr CAGR = 0.82 — passes the <2.5 PEG-equivalent gate; earns 20 asymmetry points for 'cheap vs own growth'.",
            "US commercial growth +133% YoY — the operating leverage story the chokepoint thesis depends on.",
        ],
        "key_risks": [
            "Phase 4-in-correction regime — multiple compression on the day after a beat-and-raise print is the live signal.",
            "Mansfield RS −23 — underperforming SPY despite being #1 in the basket; broad software downtrend is the headwind.",
            "Stage-7 chokepoint thesis required before any CORE designation; current rating capped at SWING.",
            "Hard stop $119.03 (52-week low) — entry must be sized against a real exit trigger.",
        ],
    },
    "IREN": {
        "summary": "In watchlist for the Bitcoin-mining → AI HPC hosting pivot; no ingested research to anchor a rating. Mentioned in passing in other reports' watchlists.",
        "primary_drivers": [],
        "key_risks": [],
    },
    "MRVL": {
        "summary": "Tier-2 AI-connectivity beneficiary, NOT a chokepoint. Phase 5 momentum (parabolic +140% in 70 days, mean sell-side PT below spot, insider cluster-selling under Murphy's 10b5-1) triggers automatic PASS regardless of pillar count.",
        "primary_drivers": [
            "Real franchise: AWS Trainium 2 in production (Marvell exclusive on T2), Microsoft Maia in design/preproduction, 800G/1.6T PAM4 DSPs at 60-80% share.",
            "Celestial AI Photonic Fabric acquisition repositions Marvell from Tier-2 to Tier-1.5 for the CPO era.",
            "Q1 FY27 guide $2.4B ±5% (+27% YoY) — fundamentals remain strong despite the verdict.",
        ],
        "key_risks": [
            "Phase 5 = automatic PASS in framework regardless of pillar count.",
            "Founder-led FAIL (Sutardja/Dai departed 2016) caps maximum designation at SWING, never CORE.",
            "Beta 2.0-2.25 means downside accelerates harder than upside; base case $145 (-18%) on FY28 revenue ~$13-14B.",
            "Disputed AWS T3/T4 socket (Benchmark Dec 8 2025: 'high conviction lost to Alchip').",
            "Re-entry framework: 25-30% drawdown + fresh catalyst + moat clarification — defined but not yet triggered.",
        ],
    },
    "AAOI": {
        "summary": "Picks-and-shovels play on 800G→1.6T optical ramp. Verdict is 'starter on weakness $100-130'. Mansfield RS +204 — the most extended name in the watchlist — confirms current $177 spot is full of expectation.",
        "primary_drivers": [
            "In-house indium phosphide (InP) laser-chip fab is the moat that protected AAOI during 2024-2025 industry-wide laser shortages.",
            "Amazon warrant for 7,945,399 shares at $23.6954 vesting against up to $4B in purchases through 2035 — converts customer to long-term equity-aligned partner.",
            ">$324M disclosed 800G/1.6T orders ($200M+ first 1.6T from one customer); $1.4B mid-2027 annualized run-rate from 1.6T alone per management.",
            "US manufacturing >55% by end-2027 aligns with hyperscaler supply-chain resilience preference.",
        ],
        "key_risks": [
            "Customer concentration recreates the 2017 dynamic that destroyed the stock (Amazon walked away, -70 to -90%).",
            "Chinese price pressure relentless — Innolight + Eoptolink ~60% of 800G with 20-25% lower pricing.",
            "$600M ATM equity program (May 14 2026) — dilution is a permanent tax; share count doubled in 15 months.",
            "CPO threat 2028-2030 from Broadcom/Marvell/NVIDIA could eliminate the pluggable transceiver market.",
            "Beta 3.76 (5Y) — when SPY falls 1%, AAOI falls ~3.76%; size accordingly.",
        ],
    },
    "BESIY": {
        "summary": "Hybrid-bonding near-monopoly on equipment for 3D stacking. Two reports both rank it #1 — 'best 3-year asymmetric play' that compounds across HBM4 and TSMC SoIC. Caveat: at €260+, the Besi deep-dive recommends Hold/Trim until a 25-35% pullback or HBM4 volume-order confirmation.",
        "primary_drivers": [
            "~67% D2W hybrid-bonding market share; 100nm placement in production, 50nm prototype shipping, sub-25nm in development.",
            "Applied Materials 9% equity stake + joint Kinex platform creates a flywheel of early customer roadmap visibility.",
            "150+ cumulative hybrid bonders shipped to 18 customers; six integrated production lines with 30 bonders at TSMC.",
            "HBM4 + TSMC SoIC ramp 2026-2028 is the structural demand driver — winner of both hybrid-bonding AND advanced-packaging bottlenecks.",
        ],
        "key_risks": [
            "SK Hynix reportedly sticking with MR-MUF for HBM4 16-high per TrendForce Jan 2026 — direct threat to one bull driver.",
            "Valuation 142x trailing / 70x forward prices flawless execution through 2027-2028.",
            "84% Asia concentration (China 45% + APAC 39% in Q4 2025) — geopolitical tail risk.",
            "Mansfield RS +57 — extended; entry timing matters even at Strong rating.",
        ],
    },
    "AMKR": {
        "summary": "Ranked #2 in AI's Next Physical Bottlenecks as the only credible CoWoS second source. The market mis-prices Amkor as a commodity OSAT, but its structural role in the AI advanced-packaging chokepoint is what justifies the Strong rating.",
        "primary_drivers": [
            "Ranked #2 in the AI Physical Bottlenecks framework — directly behind BESIY as the highest-conviction advanced-packaging name.",
            "TSMC Arizona partner; the only credible second source for CoWoS capacity outside Taiwan — a structural role the market is pricing as generic OSAT.",
            "Winner of the advanced-packaging bottleneck: CoWoS + ABF substrates are the actual AI supply gate (not HBM), oversubscribed through mid-2026.",
        ],
        "key_risks": [
            "OSAT-margin reversion if industry pricing power weakens through the cycle.",
            "US-fab strategic uncertainty — Arizona ramp execution unproven; capex commitments are large.",
            "Single-source dependency on TSMC's roadmap — if TSMC accelerates internal back-end capacity, AMKR's second-source value erodes.",
        ],
    },
    "TSM": {
        "summary": "Owns the CoWoS packaging bottleneck and the leading-edge process-node frontier. Watch (not Strong) because the AI-infra trade is crowded — real franchise, fully priced into expectations.",
        "primary_drivers": [
            "CoWoS ~75% share — winner of advanced-packaging and compute-density bottlenecks.",
            "N3 in HVM 2025; N2 ramp 2026; A16 (with Super Power Rail) targeting 2027 — process leadership intact.",
            "SoIC-X at 6μm pitch — TSMC's hybrid-bonding integration is the platform Besi's equipment ships into.",
        ],
        "key_risks": [
            "'Everyone knows it' — rank 5 in the asymmetry framework (least asymmetric of the 5).",
            "Geopolitical Taiwan tail risk — single-jurisdiction concentration.",
            "Multiple expansion limited — crowded long.",
        ],
    },
    "INTC": {
        "summary": "Highest-variance pick in the AI Physical Bottlenecks ranking. ~1.5 year lead on PowerVia (backside power delivery in 18A HVM); NVIDIA $5B co-development deal validates the technology. Strong because the upside if the foundry turnaround works is enormous.",
        "primary_drivers": [
            "Intel 18A in high-volume manufacturing January 2026 — ~1.5 year lead on TSMC A16 (Super Power Rail) which follows in 2027.",
            "PowerVia backside power delivery cuts IR drop from ~7% to <1% — structural for >1kW GPUs (Rubin 1,800W, Rubin Ultra 3,600W).",
            "NVIDIA finalized $5B co-development deal with Intel — endorsement from the marginal compute buyer.",
            "Microsoft adopted 18A for Maia 2 accelerator — second hyperscaler validation.",
        ],
        "key_risks": [
            "Highest-variance pick — technology lead is real but business turnaround is not yet proven.",
            "Foundry execution risk — yield, customer trust, capex discipline.",
            "Semi cyclicality on the broader business.",
        ],
    },
    "ADI": {
        "summary": "Smoking-gun mispricing in humanoid silicon. CEO Roche explicitly invoked humanoids on May 20 Q2 FY26 call; stock fell -7% on the beat — definition of expectation gap. Default supplier to ALL major humanoid programs given signal-chain/power/connectivity breadth.",
        "primary_drivers": [
            "Tier 1 Highest Conviction in humanoid robotics ranking (40% allocation of the sleeve).",
            "Winner of the humanoid-silicon bottleneck — sells into every major humanoid program (signal chain + power + connectivity at every joint and subsystem).",
            "CEO Vincent Roche on May 20 Q2 FY26 call: 'humanoids and other advanced robotics modalities are steadily increasing our opportunity pipeline value' — explicit smoking gun.",
            "Forward P/E ~33-35x is roughly in-line with semis industry median (34.29 per GuruFocus) — NOT a Physical AI premium. ZERO Physical AI revenue line item in any sell-side model.",
        ],
        "key_risks": [
            "Industrial cycle exposure (~50% of revenue) — if recovery stalls, multiple compresses.",
            "Stock fell -7% on a $110M beat — buy-side fatigue / expectation mismatch is real.",
            "Auto exposure is genuinely cyclical.",
        ],
    },
    "TXN": {
        "summary": "Named TI-NVIDIA Jetson Thor partnership (mmWave radar IWR6243 + motor control + sensing); Apptronik named as public customer. Market not yet rewarding humanoid headlines — stock fell -2.18% on announcement day.",
        "primary_drivers": [
            "Tier 1 in humanoid robotics ranking (35% allocation).",
            "Public design win at the NVIDIA Jetson Thor reference design level (announced March 5, 2026) — Apptronik named as a public customer.",
            "Winner of the humanoid-silicon bottleneck — mmWave radar (IWR6243), real-time motor control, sensing, and power integrated at the reference-platform level.",
            "Forward P/E ~30-35x is in-line with TXN's own 20-year average of 25.75 — capex anxiety is mispricing the upside, NOT Physical AI premium.",
        ],
        "key_risks": [
            "Mega-fab capex cycle depresses FCF — capex-anxiety is what defines the current multiple.",
            "Humanoid not yet in any sell-side model — narrative risk that the design wins don't translate to revenue line items.",
            "Stock fell -2.18% on the day of the NVIDIA announcement — market not yet rewarding humanoid headlines.",
        ],
    },
    "AMBA": {
        "summary": "Highest-variance Tier-1 in the humanoid basket. Only Western public pure-play edge-AI vision SoC at a swallowable market cap (~$2.7-3.1B). M&A optionality is the asymmetric catalyst — Bloomberg banker-hiring report from June 2025 has not been confirmed dead.",
        "primary_drivers": [
            "Tier 1 in humanoid robotics ranking (25% allocation — call-option sizing).",
            "CV7 8K vision SoC launched Jan 2026 with 2.5× the AI performance of CV5; Cooper Development Platform supports 200+ model architectures.",
            "45 million cumulative edge AI SoCs shipped per FY26 Annual Report — durable installed base.",
            "M&A backstop: Bloomberg June 2025 banker-hiring report not confirmed dead. NXP, Renesas, Infineon, PE roll-ups all logical acquirers; CEO Fermi Wang consistently declines to comment.",
        ],
        "key_risks": [
            "Customer concentration: 73.1% of Q4 revenue and 69.7% of annual revenue through WT Microelectronics (single distributor).",
            "52x forward P/E means execution must hit — no margin of safety on the multiple.",
            "NVIDIA GR00T+Jetson lock-in is real — AMBA must win the 'second source' decision, which is not guaranteed.",
            "Recent adverse patent ruling impacting U.S. exposure (Seeking Alpha Apr 2, 2026).",
        ],
    },
    "TER": {
        "summary": "Robotics segment +32% YoY (4th consecutive growth quarter); Amazon Vulcan via Universal Robots real but small. Rerate already partly happened in late 2025 — not as cheap as ADI/TXN.",
        "primary_drivers": [
            "Robotics segment Q1 2026 $91M (+32% YoY) — 4th consecutive growth quarter.",
            "Amazon Vulcan via Universal Robots: UBS confirmed as 'first tangible outcome of TER's strategy to engage more directly with large OEMs'.",
            "Insider selling halted in Q2 2026 — first time since 2018 per Hunterbrook/Citrini.",
        ],
        "key_risks": [
            "ATE (Automatic Test Equipment) is the dominant story — AI-related ATE is only ~15% of quarterly sales; robotics is ~7% of total.",
            "Rerate already partly happened in late 2025 — not as cheap as ADI/TXN at current multiple.",
            "ATE cyclicality on the AI cycle.",
        ],
    },
    "QCOM": {
        "summary": "Dragonwing IQ10 (700 TOPS) + NEURA Robotics partnership. Defensive humanoid silicon play — forward P/E ~19x cheap but Apple modem loss + handset exposure dominate.",
        "primary_drivers": [
            "Dragonwing IQ10 series (700 TOPS, 18-core Oryon CPU) launched at CES 2026.",
            "Strategic NEURA Robotics partnership announced March 9, 2026; Booster Robotics + VinMotion (Motion 2 humanoid) using prior-gen IQ9.",
            "Forward P/E ~19x — cheapest of the humanoid silicon names by AI-peer standards.",
        ],
        "key_risks": [
            "Apple modem loss looming — primary multiple-compression catalyst.",
            "Handset exposure (Snapdragon) dominates the narrative.",
            "Robotics is buried inside IoT segment ($1.7B/quarter) with no segment breakout.",
            "Less leveraged upside than AMBA on a humanoid M&A scenario.",
        ],
    },
    "TDY": {
        "summary": "Defense-tilted machine vision (Teledyne FLIR, DALSA) + loitering munitions. Humanoid optionality is incidental, not strategic. No direct SpaceX disclosure in the SpaceX IPO report either.",
        "primary_drivers": [
            "Teledyne FLIR runs UGVs (Black Hornet, SUGV) for defense — real revenue.",
            "DALSA machine vision for industrial automation — humanoid optionality is incidental, not strategic.",
            "Rogue 1 Block 2 loitering munition (Q3 2026 deliveries); LASSO program selection (May 13, 2026 — up to 130 Rogue 1 systems).",
        ],
        "key_risks": [
            "No 2026 humanoid robot design wins disclosed.",
            "Defense rotation risk if the cycle shifts.",
            "Low growth (fails T pillar in the SpaceX IPO ranking at rank 16).",
            "No direct SpaceX-named contract — sector beneficiary, not contracted revenue.",
        ],
    },
    "MPWR": {
        "summary": "Power conversion winner in next-gen GPU sockets, taking share from Vicor. Real share-gain story but well-followed — smaller asymmetry than ranks 1-3 in the same report.",
        "primary_drivers": [
            "Winning hyperscaler sockets from Vicor on next-gen GPU power conversion.",
            "Share-gain story validated by the AI Physical Bottlenecks report at rank 4.",
            "Direct beneficiary of rack-level power-density bottleneck (B200 1,200W, Rubin 1,800W, Rubin Ultra 3,600W).",
        ],
        "key_risks": [
            "Well-followed name — higher valuation, smaller asymmetry than ranks 1-3.",
            "Vicor competitive response — share gains are not guaranteed to compound.",
            "Cyclical exposure on the broader semi cycle.",
        ],
    },
    "MP": {
        "summary": "Only US fully-integrated mine-to-magnet rare-earth producer. DoD $110/kg NdPr floor + Apple $500M + Saudi JV. Watch (post-parabolic) because the +355% May-Oct 2025 ramp tripped Phase 5; buy only on a $50-54 flush or $61 reclaim per the deep-dive.",
        "primary_drivers": [
            "DoW $400M Series A Convertible Preferred at $30.03 + 10-year $110/kg NdPr price floor (DoD-guaranteed downside).",
            "Apple $500M definitive long-term agreement for 100%-recycled NdFeB magnets at Fort Worth; shipments begin 2027, $72M prepaid.",
            "Saudi/Maaden JV (Nov 2025) — capital-light optionality at zero MP capex.",
            "Only US ore body + only domestic HRE separation circuit being built — both chokepoint AND beneficiary of rare-earth-magnets bottleneck.",
            "Also tagged as space-supply-chain winner in the SpaceX IPO report (rank 2 Tier 1 CORE).",
        ],
        "key_risks": [
            "Phase 4 post-parabolic digestion (-43% from October 2025 ATH); the +355% in 5 months tripped Phase 5 smell test 6 months ago.",
            "Insider selling: Litinsky $19.6M May 12-13, Corbett $1.5M May 8; insiders net -$53M TTM.",
            "~38x P/S TTM full pricing — Rule-of-40 deeply negative on FCF -$328M.",
            "Trump-Xi truce tail risk would flood NdPr market and compress non-PPA revenue.",
            "Congressional appropriations risk on DoW Title III ($266M FY26 request vs ~$304M/yr floor cost).",
        ],
    },
    "TEM": {
        "summary": "Precision-medicine AI play. SWING (not CORE) — entry conditional on $46.28 close confirmation, hard stop $39.53. ARK has accumulated ~620K shares; 27% short interest = squeeze fuel.",
        "primary_drivers": [
            "Q1 2026: revenue $348.1M (+36.1% YoY); BMS strategic collaboration May 14 across 5 oncology + neuroscience clinical programs using Tempus Lens.",
            "ARK accumulated ~620K shares May 6-15 (~$30M) — TEM is ARK's third-largest holding (~5% of portfolio).",
            "Short interest 27.03% of 99.01M float (5.33 days-to-cover) — squeeze potential on positive Investor Day.",
            "IV30 in 12th percentile of 1-year range — cheap implied vol relative to the binary May 29 Investor Day catalyst.",
        ],
        "key_risks": [
            "Rule of 40 score 29.1-35.3% fails the ≥40 hurdle — confirms growth-momentum story, not compounder.",
            "High volatility (ATR 6.5%, beta 2.33-3.06); pending class actions from July 2025 remain unresolved.",
            "Binary May 29 Investor Day — ATM straddle prices ±13.7%; a single overnight event can take you to stop.",
            "CEO Lefkofsky sold 166,250 shares April 28 under 10b5-1 (mechanical but pattern is consistent net-selling).",
        ],
    },
    "TSLA": {
        "summary": "Tier 3 'already extended' in the humanoid robotics ranking — Optimus optionality is already capitalized into the bull-case sum-of-parts at $1T+ TAM. Pass on a humanoid-only thesis; own only if you also believe in robotaxi + auto recovery.",
        "primary_drivers": [
            "Real production scale-up underway: Fremont Gen-3 reveal targeted July-August 2026; Giga Texas Optimus factory permits for 5.2M sq ft, $5-10B construction investment, ultimate target 10M units/year.",
            "Tagged to humanoid-silicon bottleneck — exposure to the broader Physical AI capex cycle.",
        ],
        "key_risks": [
            "Optimus already capitalized in bull-case sum-of-parts at $1T+ TAM — no asymmetric entry left at current price.",
            "Production reality lagging promise: Musk on Q1 2026 call called production 'literally impossible to predict' this year; several hundred units deployed for learning, not productive work.",
            "Thesis dependence: must also believe in robotaxi + auto recovery, not just humanoid — single-driver entry is rejected by the framework.",
        ],
    },
    "SYM": {
        "summary": "$22.7B backlog, Walmart APD deal real, GAAP profitable Q2 — but the stock has ALREADY rerated post-IPO. High-quality story but not unknown early entry. AI-enabled robotics framing is already embedded.",
        "primary_drivers": [
            "$22.4-22.7B backlog at Q2 FY26 — real and growing.",
            "SoftBank Exotec JV ($11B contract); 87% revenue from Walmart pre-2025; new Walmart APD deal ($520M); diversification via Associated Wholesale Grocers (April 2026).",
            "Q2 FY26: revenue $676M (+23% YoY), GAAP profitable.",
        ],
        "key_risks": [
            "Already rerated post-IPO — KeyBanc PT $70, DA Davidson $70, Needham $75 already in consensus.",
            "P/S 2.6x with P/E -1047 (negative GAAP earnings) = full pricing.",
            "Insiders sold ~178,492 shares (~$10.3M) over 90 days to April 10.",
            "Stock down 21-28% YTD 2026 already shows mood shift.",
        ],
    },
    "ROK": {
        "summary": "Quality industrial automation play but the AI/data-center/warehouse automation narrative has already done the work. Forward P/E ~36.5x — not cheap. No CEO-level humanoid commentary.",
        "primary_drivers": [
            "Q2 FY26 (May 6 2026): Sales $2.239B (+12%), Adj EPS $3.30 vs $2.88 consensus; raised FY26 EPS to $12.50-$13.10.",
            "OTTO AMRs gaining adoption across Automotive, Food & Beverage, Data Center pilots.",
        ],
        "key_risks": [
            "Forward P/E ~36.5x — recently rerated, not cheap.",
            "No CEO-level humanoid commentary — narrative driver missing.",
            "AI/data-center/warehouse automation narrative has already done the work — no asymmetric setup remaining.",
        ],
    },
    "OUST": {
        "summary": "Branded 'sensing and perception platform for Physical AI' — but CEO Pacala himself warned of humanoid 'disillusionment' (TechCrunch Feb 9 2026). Already-narrative-priced at ~10-13x EV/sales. Hold if you own; trim into strength.",
        "primary_drivers": [
            "REV8 native color LiDAR launched Q1 2026; Stereolabs acquired Feb 9, 2026 for $35M cash + 1.8M shares (~$70M total).",
            "NVIDIA DRIVE Hyperion qualified; Gecko Robotics integration.",
            "Q1 2026 revenue $49M (+49% YoY) — real growth.",
        ],
        "key_risks": [
            "CEO Pacala's own TechCrunch warning (Feb 9 2026): 'There's going to be a little bit of disillusionment in physical AI as it turns out that it's much longer time to market for all these humanoids.'",
            "Already-narrative-priced at ~10-13x EV/sales — closer to fair value than cheap.",
            "Humanoid timeline longer than market thinks — the very CEO of the most 'Physical AI'-branded name flagging this.",
        ],
    },
    "ARM": {
        "summary": "Royalty model gets a sliver of every Jetson Thor + Dragonwing + edge AI SoC. Already aggressively rerated — up ~150-155% YTD 2026, trailing P/E ~265x. Humanoid contribution is rounding error vs the AGI CPU thesis already priced in.",
        "primary_drivers": [
            "Royalty model captures a sliver of every Jetson Thor, Dragonwing, and edge AI SoC.",
            "AGI CPU launched March 2026 with $15B/year revenue target by 2031 — the actual driver of the multiple.",
        ],
        "key_risks": [
            "Trailing P/E ~265x — extreme valuation; up ~150-155% YTD 2026 = no margin of safety.",
            "Humanoid contribution is rounding error vs the data-center CPU thesis already priced in.",
            "Already aggressively rerated — Tier 3 'not early' verdict applies.",
        ],
    },
    "ABB": {
        "summary": "Robotics being sold to SoftBank for $5.375B EV (closes mid-late 2026). The robotics optionality is GONE from public ABB — shareholders get cash gain but no ongoing humanoid exposure. Skip ABB itself; use the deal as confirmation of broader humanoid value.",
        "primary_drivers": [
            "SoftBank Robotics deal closes mid-to-late 2026: $5.375B EV, ~$2.4B pre-tax gain, ~$5.3B net cash to ABB.",
            "Masayoshi Son: 'SoftBank's next frontier is Physical AI' — a $5.375B vote that smart money sees toll-booth value public markets don't credit.",
        ],
        "key_risks": [
            "Robotics optionality is GONE from public ABB after deal closes — shareholders get cash gain but no ongoing exposure.",
            "Left with electrification segment (slow growth).",
            "ABB Robotics divestiture closing risk — SoftBank deal subject to regulatory approval.",
        ],
    },
    "SERV": {
        "summary": "Robot OPERATOR, not supply-chain toll booth. Speculative; not aligned with the 'toll booth' philosophy of the humanoid report. Q1 revenue $3M, market cap ~$677M — still venture-stage.",
        "primary_drivers": [
            "Q1 2026 revenue $3M (+578% YoY, low base); full-year 2026 guidance reaffirmed at ~$26M.",
            "Diligent Robotics acquired Jan 27 2026 for $25.7M (healthcare robots); ~2,000 robots deployed across 44 cities / 14 states.",
            "Cash $197M after $91M ATM raise — runway extended.",
        ],
        "key_risks": [
            "$3M Q1 revenue on $677M market cap = pure narrative pricing.",
            "Operator-model risk is high — execution-dependent, not a structural toll booth.",
            "Freedom Broker downgraded to Hold May 13 2026 citing dilution + execution risk.",
            "Not aligned with the toll-booth philosophy in the framework — speculative.",
        ],
    },
    "RBRK": {
        "summary": "5/5 pillars cyber-resilience leader. 66 Rule of 40. Phase gate blocks entry below #1 in the leader-only correction regime — watchlist for next regime shift, not entry now.",
        "primary_drivers": [
            "5/5 pillar pass — Moat, TAM, Founder-led, Capital Efficiency, Valuation.",
            "Cyber resilience category leader; 81% gross margin, ~28% rev CAGR, 20% FCF margin, 66 Rule of 40.",
            "Founder-led; $13B market cap, 8.1x EV/S — sensible scale.",
        ],
        "key_risks": [
            "Phase 4-in-correction regime blocks entry below #1 in the leader-only methodology.",
            "Q4 FY26 reported March 2026 — no fresh catalyst (outside 30-day window).",
            "Watchlist priority for next regime shift; second-best behind PLTR.",
        ],
    },
    "FIG": {
        "summary": "Figma post-IPO; design collaboration leader. Q1 +46% YoY accelerating — first post-IPO quarter showing growth re-acceleration. Phase gate blocks entry below #1.",
        "primary_drivers": [
            "5/5 pillar pass; founder-led (Dylan Field still CEO).",
            "Q1 2026 revenue +46% YoY to $333.4M, accelerating — first post-IPO quarter showing growth re-acceleration.",
            "80% gross margin, ~25% CAGR, 73 Rule of 40; $12B market cap, 7.4x EV/S.",
        ],
        "key_risks": [
            "Phase gate blocks entry below #1 in the leader-only correction regime.",
            "Post-IPO timeline — limited public history makes Phase classification harder.",
            "Lockup considerations as more shares unlock.",
        ],
    },
    "APP": {
        "summary": "AppLovin ad-tech AI leverage. Q1 $1,842M (+59% YoY); adj EBITDA $1.56B (+66% YoY); 129 Rule of 40 (highest in basket). Phase gate blocks below #1.",
        "primary_drivers": [
            "5/5 pillar pass; founder-led; $160B market cap, 21x EV/S.",
            "Q1 2026: revenue $1,842M (+59% YoY); adjusted EBITDA $1.56B up 66% YoY with 85% margin and 86% QoQ flow-through.",
            "89% gross margin, ~30% CAGR, 71% FCF margin, 129 Rule of 40 — highest in the basket.",
            "Axon platform launch announced for June 2026 as a fresh catalyst.",
        ],
        "key_risks": [
            "Phase gate blocks entry below #1.",
            "Ad-tech cyclicality on macro.",
            "Valuation rich at 21x EV/S — execution must continue at pace.",
        ],
    },
    "MNDY": {
        "summary": "Monday.com. Q1 +24% to $351.3M; record net adds of $500K+ ARR customers. 44 Rule of 40 — passes the hurdle but lowest of top 5. Phase gate blocks.",
        "primary_drivers": [
            "5/5 pillar pass; founder-led; $3.5B market cap, 2x EV/S.",
            "Q1 2026 revenue +24% YoY to $351.3M; record net adds of $500K+ ARR customers.",
            "Launched AI Work Platform with Native Agents.",
        ],
        "key_risks": [
            "44 Rule of 40 — passes hurdle but lowest of top 5 (vs PLTR 145, APP 129, RBRK 66, FIG 73).",
            "FY26 guide modest at 18-19% — deceleration vs Q1 +24%.",
            "Phase gate blocks entry below #1.",
        ],
    },
    "CRWD": {
        "summary": "5/5 pillars and fresh Q1 FY27 pipeline acceleration. De-facto leader if PLTR's chokepoint thesis fails. But rebound from $342.72 → $594.08 ATH (+73.5%) means asymmetry has compressed.",
        "primary_drivers": [
            "5/5 pillar pass; founder-led (Kurtz); $144B market cap, 24x EV/S.",
            "Fresh Q1 FY27 pipeline acceleration; 78% gross margin, ~22% CAGR, 26% FCF margin, 49 Rule of 40.",
            "De-facto leader if PLTR's chokepoint thesis fails — secondary watchlist priority.",
        ],
        "key_risks": [
            "Rebound +73.5% from $342.72 52-week low to $594.08 ATH May 15 2026 compressed asymmetry.",
            "Cheap score dropped to 12 from 20 — much less asymmetric than before the rebound.",
            "Phase gate blocks entry below #1; PLTR remains the only authorized name.",
        ],
    },
    "NOC": {
        "summary": "Named subcontractor on the $1.8B SpaceX Starshield/NRO program (Reuters May 2024). SDA Tranche 1/2 prime. 5/5 pillars. Best fundamental linkage to the SpaceX IPO trade — explicit Stage 1 initiate recommendation.",
        "primary_drivers": [
            "Tier 1 CORE rating in the SpaceX IPO ranking; 5/5 pillar pass.",
            "Named subcontractor on the $1.8B SpaceX Starshield/NRO program per Reuters (May 2024) and Spaceflight Now.",
            "SDA Tranche 1/2 prime per Wikipedia; Golden Dome architecture budget cycle late 2026.",
            "Winner of the space-supply-chain bottleneck — one of only three names with publicly verifiable named SpaceX/Starshield revenue.",
        ],
        "key_risks": [
            "Slow grower as a percentage of revenue from pure space.",
            "Defense rotation exposure.",
            "Share of SpaceX revenue not disclosed at line-item level.",
        ],
    },
    "HXL": {
        "summary": "ONLY publicly self-disclosed SpaceX composites supplier — Hexcel's own corporate page lists SpaceX alongside Airbus/Boeing/Lockheed. Starship hull/interstage exposure. Stage 1 initiate.",
        "primary_drivers": [
            "Tier 1 CORE rating in SpaceX IPO ranking; only publicly self-disclosed SpaceX composites supplier per Hexcel's own corporate composites page.",
            "Starship hull/interstage exposure — direct, contracted SpaceX revenue (not retail-narrative read-through).",
            "Winner of the space-supply-chain bottleneck.",
            "4/5 pillars (fails T at slow growth) — but the F&G of the linkage trumps the growth gap.",
        ],
        "key_risks": [
            "Aerospace cyclical exposure on the broader business.",
            "Fails T (slow growth) — share of SpaceX revenue not separately disclosed.",
            "Composites pricing pressure in a downturn.",
        ],
    },
    "MDA": {
        "summary": "$1.1B CAD Globalstar C-3 prime contract (launched on SpaceX rockets). Canadarm-3. TSX-listed Tier 2 — named verifiable Starshield-adjacent supplier.",
        "primary_drivers": [
            "Tier 2 CORE in SpaceX IPO ranking; $1.1B CAD Globalstar C-3 prime contract (per MDA's own PRNewswire release Feb 25, 2025) — launched on SpaceX rockets.",
            "Canadarm-3 NASA work; Telesat Lightspeed prime — diversified space-systems exposure.",
            "Winner of the space-supply-chain bottleneck — named verifiable Starshield-adjacent supplier.",
        ],
        "key_risks": [
            "TSX-listed — thinner US retail liquidity.",
            "Fails F (no founder signal).",
            "Slower growth profile vs space pure-plays.",
        ],
    },
    "LHX": {
        "summary": "L3Harris — payload/comms primes; 70%+ recurring DoD revenue; 8.64% of ARKX ETF. 5/5 pillar pass; Tier 2 CORE Stage 1 initiate.",
        "primary_drivers": [
            "5/5 pillar pass; payload/comms primes for classified space.",
            "70%+ recurring DoD revenue — durable franchise.",
            "8.64% of ARKX ETF — institutional flow tailwind.",
            "Winner of the space-supply-chain bottleneck.",
        ],
        "key_risks": [
            "Slow growth (typical defense prime).",
            "Already heavily ETF-owned (8.64% ARKX) — limited new flow upside.",
        ],
    },
    "IRDM": {
        "summary": "LEO satcom incumbent. ~17x FY27 P/E, 2.3% dividend yield, FCF positive. Explicit 'Stage 1 initiate' recommendation in the SpaceX IPO playbook.",
        "primary_drivers": [
            "Tier 2 CORE in SpaceX IPO ranking with explicit 'Stage 1 initiate' guidance.",
            "~17x FY27 P/E — cheapest CORE name in the space basket.",
            "2.3% dividend yield, FCF positive — durable cash returns.",
            "LEO satcom incumbent — durable subscriber franchise.",
        ],
        "key_risks": [
            "Long-term Starlink competition — D2C and IoT segments under structural threat.",
            "Fails T at ~7% growth — slower than pure-play space names.",
        ],
    },
    "KRMN": {
        "summary": "Karman payload fairings/interstages. CRITICAL CAVEAT: SpaceX is NOT a named Karman customer per FY24 release — filings name ULA/Blue Origin/SLS. Karman supplies SpaceX's competitors. Watch because the IPO read-through is sympathy, not contracted SpaceX revenue.",
        "primary_drivers": [
            "Q1 2026 revenue +51% YoY; raised 2026 guide $720-735M; backlog +60% to $1B+.",
            "Winner of the launch-capacity bottleneck — supplies major launch vehicles outside SpaceX.",
            "Stage 2 SWING add candidate per the SpaceX IPO playbook (build during May 22 - June 8 window).",
        ],
        "key_risks": [
            "CRITICAL: NOT a named SpaceX supplier per Karman's own FY24 release — filings name ULA / Blue Origin / NASA SLS. Read-through, not contracted SpaceX revenue.",
            "Retail mis-narrative risk if investors discover the supplier list publicly.",
            "Rich at ~20x sales (fails V); 1.5x D/E.",
        ],
    },
    "RKLB": {
        "summary": "Only public launch + space-systems pure-play. Q1 revenue $200.3M (+63.5% YoY); $2.2B backlog (+108% YoY); Neutron Q4 2026. Watch (SWING) — already extended; report says 'Do NOT add' in Stage 1.",
        "primary_drivers": [
            "$200.3M Q1 (+63.5% YoY); $2.2B backlog (+108% YoY); Neutron first launch Q4 2026 fills the medium-lift gap.",
            "Winner of the launch-capacity bottleneck — only public launch + space-systems pure-play.",
            "Golden Dome partnership with Raytheon.",
            "Already on user AutoTrade watchlist — flagged Tier 1 SWING.",
        ],
        "key_risks": [
            "Already parabolic — SpaceX IPO Stage 1 explicitly says 'Do NOT add to RKLB or MP' at current price.",
            "$450M ATM dilution Q1 — share count growth tax.",
            "Neutron delay risk — execution-dependent.",
            "Post-IPO comp pressure as more space names list and absorb sector flows.",
        ],
    },
    "KTOS": {
        "summary": "Hypersonic targets + Golden Dome SBI; founder-led. SWING — 3/5 pillars (fails M, V). Small-cap volatility.",
        "primary_drivers": [
            "Hypersonic targets — durable defense demand.",
            "Golden Dome SBI exposure — late-2026 budget cycle catalyst.",
            "Founder-led (DeMarco).",
        ],
        "key_risks": [
            "3/5 pillars — fails Moat and Valuation.",
            "Small-cap volatility — wider intraday ranges.",
            "Defense rotation exposure.",
        ],
    },
    "FLY": {
        "summary": "Firefly Aerospace. $1.4B backlog; 2026 guide $420-450M; Golden Dome SBI via SciTec. SWING — 3/5 pillars (fails M, V, R). Material weakness disclosed; Cantor cut PT $65→$35.",
        "primary_drivers": [
            "$1.4B backlog; 2026 guide $420-450M.",
            "Golden Dome SBI via SciTec partnership.",
            "Stage 2 SWING add candidate per the SpaceX IPO playbook.",
            "Winner of the launch-capacity bottleneck.",
        ],
        "key_risks": [
            "Net loss $298M 2025; FCF -$238M.",
            "Material weakness disclosed in financial reporting.",
            "Cantor cut PT $65→$35 — analyst capitulation.",
            "3/5 pillars (fails M, V, R).",
        ],
    },
    "VOYG": {
        "summary": "Voyager — Starlab ISS successor. $217.5M NASA grant; Palantir partner. SWING — 3/5 pillars (fails M, V, R). IPO'd June 2025 at $31, rallied to $69.75 then drifted; lockup risk.",
        "primary_drivers": [
            "Starlab ISS successor program; $217.5M NASA grant.",
            "Palantir partner — adds operational credibility.",
            "Stage 2 SWING add candidate per the playbook.",
        ],
        "key_risks": [
            "IPO June 2025 at $31; rallied to $69.75 then drifted — lockup risk active.",
            "3/5 pillars (fails M, V, R).",
            "Long-dated program risk (ISS successor commercialization is 2030+).",
        ],
    },
    "LUNR": {
        "summary": "Intuitive Machines. $943M backlog; 2026 guide $900M-$1B with positive adj. EBITDA; $4.8B NSN IDIQ. SWING — 3/5 pillars (fails M, R). Lumpy revenue.",
        "primary_drivers": [
            "$943M backlog; 2026 guide $900M-$1B with POSITIVE adjusted EBITDA (rare in lunar names).",
            "$4.8B NSN IDIQ contract vehicle.",
            "Lunar lander franchise — only public name.",
        ],
        "key_risks": [
            "Lumpy revenue — mission-based, not recurring.",
            "Dilution risk.",
            "3/5 pillars (fails M, R).",
        ],
    },
    "RDW": {
        "summary": "Redwire — ROSA contracts are with Boeing/Maxar per primary source PRNewswire, NOT SpaceX. Retail mis-narrative as SpaceX supplier. 3/5 pillars (fails M, V, R). Explicit avoid in the SpaceX IPO report.",
        "primary_drivers": [
            "ROSA solar arrays (genuine business) + Edge Autonomy defense drones.",
        ],
        "key_risks": [
            "NOT a named SpaceX supplier — ROSA contracts are with Boeing/Maxar per primary source PRNewswire.",
            "Retail mis-narrative as SpaceX supplier — sentiment-trap risk on IPO day.",
            "3/5 pillars (fails M, V, R); dilution.",
            "Explicit 'Avoid' in the SpaceX IPO playbook's Stage 1.",
        ],
    },
    "PL": {
        "summary": "Planet Labs — Earth-observation; defense ramp; founder-led. SWING — 3/5 pillars (fails M, R). Continuing losses.",
        "primary_drivers": [
            "Earth-observation incumbent with high-frequency imaging cadence.",
            "Defense ramp on Golden Dome / SDA architecture.",
            "Founder-led.",
        ],
        "key_risks": [
            "Continuing losses; fails Moat and Rule-of-40 pillars.",
            "Competitive Earth-obs market (BKSY, Maxar, etc.).",
            "Tier 3 in the SpaceX IPO ranking.",
        ],
    },
    "BKSY": {
        "summary": "BlackSky — Q1 2026 revenue -29.5% YoY (going backward per Simply Wall St). Analyst PTs cut $24→$20. 2/5 pillars (fails M, T, R, V). Explicit avoid in the report's Stage 1.",
        "primary_drivers": [
            "Gen-3 constellation deployment continues.",
            "$351M backlog; AFRL contracts.",
        ],
        "key_risks": [
            "Revenue going BACKWARD: Q1 2026 -29.5% YoY per Simply Wall St.",
            "2/5 pillars — fails 4 of 5 (Moat, TAM, Rule-of-40, Valuation).",
            "Analyst PTs cut $24 → $20.",
            "Explicitly listed in 'Stage 1 — Avoid initiating' in the SpaceX IPO playbook.",
        ],
    },
    "APH": {
        "summary": "Amphenol — oligopoly connectors across LEO sats (no SpaceX-named contract); AI data-center exposure. 5/5 pillars, but Tier 3 in the SpaceX IPO ranking because the SpaceX exposure is incidental, not the primary driver.",
        "primary_drivers": [
            "Oligopoly connectors across LEO sats per trade press (no SpaceX-named contract).",
            "Real exposure to AI data-center growth — the actual driver.",
            "5/5 pillar pass.",
        ],
        "key_risks": [
            "AI cyclicality — not pure space, AI-cap-spend dependent.",
            "No SpaceX-named contract — sector beneficiary, not contracted revenue.",
            "Rich valuation as a high-quality compounder.",
        ],
    },
    "HEI": {
        "summary": "Heico — aerospace aftermarket + electronic systems on classified space; family founder-led. 4/5 pillars (fails V at ~60x P/E). High-quality but rich.",
        "primary_drivers": [
            "Aerospace aftermarket franchise — durable cash flows.",
            "Electronic systems on classified space contracts.",
            "Family founder-led (Mendelson family).",
        ],
        "key_risks": [
            "~60x P/E — rich valuation; fails V pillar.",
            "Defensive growth profile — limited multi-bagger upside.",
            "Tier 3 in the SpaceX IPO ranking.",
        ],
    },
    "UFO": {
        "summary": "Procure Space ETF — basket exposure (0.94% ER). Top holdings Viasat/Garmin/RKLB/ASTS. The +31% YTD / +122% TTM is the WARNING, not the bullish signal.",
        "primary_drivers": [
            "Diversified basket exposure to the space theme; cleanest single-vehicle expression of 'space rerate'.",
            "Top holdings Viasat / Garmin / RKLB / ASTS.",
        ],
        "key_risks": [
            "0.94% expense ratio — high for an ETF.",
            "Already extended: +31% YTD / +122% TTM is the warning, not the bullish signal.",
            "Concentration in 4-5 holdings — not as diversified as the 'basket' framing implies.",
            "SpaceX IPO playbook: 'Avoid UFO/ROKT at these prices; if VIX spikes above 22 you can establish them on weakness.'",
        ],
    },
    "ROKT": {
        "summary": "SPDR Kensho Final Frontiers ETF. 54% A&D primes (LHX, NOC) + emerging space. 0.45% expense ratio. Less euphoric than UFO but indistinguishable from ITA/XAR.",
        "primary_drivers": [
            "0.45% expense ratio — lower than UFO; cheap A&D + emerging space exposure.",
            "54% A&D primes (LHX, NOC, etc.) — overlap with the SpaceX-supplier Tier 1 names.",
        ],
        "key_risks": [
            "Less euphoric than UFO but indistinguishable from ITA/XAR for most purposes.",
            "Same 'Avoid at these prices' guidance from the SpaceX IPO playbook.",
        ],
    },
}


# ============ Evidence assembly ============

def build_evidence(sym: str, reports: list[dict], bottlenecks: list[dict]) -> list[dict]:
    evidence: list[dict] = []
    for r in reports:
        for ranking in r["rankings"]:
            if ranking["ticker"].upper() == sym:
                evidence.append({
                    "type": "report",
                    "ref_id": r["id"],
                    "ref_title": r["title"],
                    "rank_in_report": ranking["rank"],
                    "report_reasoning": ranking["reasoning"],
                })
    for b in bottlenecks:
        winners_upper = [w.upper() for w in b.get("winners", [])]
        losers_upper  = [w.upper() for w in b.get("losers_or_at_risk", [])]
        if sym in winners_upper:
            evidence.append({
                "type": "bottleneck",
                "ref_id": b["id"],
                "ref_name": b["name"],
                "role": "winner",
                "physics_summary": _first_sentences(b["physics"], 2),
            })
        elif sym in losers_upper:
            evidence.append({
                "type": "bottleneck",
                "ref_id": b["id"],
                "ref_name": b["name"],
                "role": "loser_or_at_risk",
                "physics_summary": _first_sentences(b["physics"], 2),
            })
    return evidence


def _first_sentences(text: str, n: int = 2) -> str:
    parts = text.replace("…", ".").split(". ")
    return ". ".join(p.strip() for p in parts[:n]).rstrip(".") + "."


# ============ Main ============

def main() -> int:
    tickers = json.loads((DATA / "tickers.json").read_text())
    reports = json.loads((DATA / "reports.json").read_text())
    bottlenecks = json.loads((DATA / "bottlenecks.json").read_text())

    n_applied = 0
    n_skipped = 0
    rating_changes: list[tuple[str, str, str]] = []
    missing_synthesis: list[str] = []

    for t in tickers:
        sym = t["ticker"].upper()
        # Preserve manual overrides
        existing_rr = t.get("rating_reasoning")
        if existing_rr and existing_rr.get("rated_by") == "manual":
            n_skipped += 1
            continue

        syn = SYNTHESES.get(sym)
        if syn is None:
            missing_synthesis.append(sym)
            continue

        evidence = build_evidence(sym, reports, bottlenecks)

        rating_reasoning = {
            "summary": syn["summary"],
            "primary_drivers": syn["primary_drivers"],
            "key_risks": syn["key_risks"],
            "evidence": evidence,
            "rated_date": TODAY,
            "rated_by": "auto",
        }
        t["rating_reasoning"] = rating_reasoning

        # Rating override (only when synthesis explicitly proposes one)
        if "rating_override" in syn:
            old = t.get("rating") or ""
            if old != syn["rating_override"]:
                t["rating"] = syn["rating_override"]
                rating_changes.append((sym, old or "—", syn["rating_override"]))

        n_applied += 1

    out = json.dumps(tickers, indent=2) + "\n"
    (DATA / "tickers.json").write_text(out, encoding="utf-8")
    (DOCS_DATA / "tickers.json").write_text(out, encoding="utf-8")

    print(f"Applied rating_reasoning to {n_applied} tickers")
    print(f"Skipped (manual override): {n_skipped}")
    if missing_synthesis:
        print(f"Missing synthesis: {missing_synthesis}")
    if rating_changes:
        print(f"\nRating changes:")
        for sym, old, new in rating_changes:
            print(f"  {sym}: {old} → {new}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
