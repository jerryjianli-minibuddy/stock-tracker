// stock-tracker dashboard — vanilla JS, no build step.
// Three views (Watchlist / Reports / Bottlenecks) sharing one fetched data set
// joined client-side. Cross-navigation: clicking a ticker pill anywhere jumps
// to the watchlist row; clicking a bottleneck pill anywhere jumps to its card.

const DATA_PATH = "./data";
const STORAGE_KEYS = {
  activeTab:        "stock-tracker.activeTab",
  tabSorts:         "stock-tracker.tabSorts",      // per-tab column sort: { tabKey: {col, dir} }
  ratingFilter:     "stock-tracker.ratingFilter",
  eligibilityFilter:"stock-tracker.eligibilityFilter",
};

// Columns that are click-to-sort. The key matches a row property; the type
// drives the comparator (numeric vs string vs special).
const SORTABLE_COLS = {
  price:           "num",
  market_cap:      "num",
  pe_forward:      "num",
  ps_ratio:        "num",
  ev_to_sales:     "num",
  ev_to_ebitda:    "num",
  rev_growth_yoy:  "num",
  eps_growth_yoy:  "num",
  gross_margin:    "num",
  pct_from_high:   "num",
  mansfield_rs:    "num",
  rs_proxy:        "num",
  above_200dma:    "bool",
  rating:          "rating",
  pillars_passed:  "num",
  net_debt_to_ebitda: "num",
};

const state = {
  // raw
  tickers: [], snapshots: {}, history: {}, reports: [], bottlenecks: [],
  macro: null, sectorRotation: [],
  glossary: [],
  glossaryById: new Map(),
  // joined rows (watchlist)
  rows: [],
  // lookups
  bottleneckById: new Map(),
  reportById: new Map(),
  tickerByT: new Map(),
  // ui state — top-level view
  view: "watchlist",
  sector: "All",               // "All" or a sector name (drives the per-sector tab filter)
  search: "",
  // watchlist controls
  tabSorts: {},                // { [tabKey]: {col, dir} } — column sort per tab; missing = default rank
  ratingFilter: "all",         // all | strong | strong_watch | hide_pass
  eligibilityFilter: "all",    // all | core | swing_plus | has_binding
  expanded: new Set(),         // ticker symbols whose detail rows are expanded
  // navigation
  scrollTarget: null,          // {kind: "ticker"|"bottleneck"|"report", id: string}
  // rotation table (Macro tab)
  rotationSortKey: "mansfield_rs", rotationSortDir: "desc",
};

document.addEventListener("DOMContentLoaded", init);

// ============ init + data loading ============

async function init() {
  initTheme();
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("search").addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderWatchlist();
  });
  // Restore persisted watchlist control state (must run before renderWatchlist)
  state.ratingFilter = localStorage.getItem(STORAGE_KEYS.ratingFilter) || "all";
  state.eligibilityFilter = localStorage.getItem(STORAGE_KEYS.eligibilityFilter) || "all";
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.tabSorts) || "{}");
    if (raw && typeof raw === "object") state.tabSorts = raw;
  } catch { /* ignore */ }
  document.getElementById("rating-filter").value = state.ratingFilter;
  document.getElementById("eligibility-filter").value = state.eligibilityFilter;
  document.getElementById("rating-filter").addEventListener("change", (e) => {
    state.ratingFilter = e.target.value;
    localStorage.setItem(STORAGE_KEYS.ratingFilter, state.ratingFilter);
    renderWatchlist();
  });
  document.getElementById("eligibility-filter").addEventListener("change", (e) => {
    state.eligibilityFilter = e.target.value;
    localStorage.setItem(STORAGE_KEYS.eligibilityFilter, state.eligibilityFilter);
    renderWatchlist();
  });
  document.getElementById("glossary-search").addEventListener("input", (e) => {
    state.glossarySearch = e.target.value.trim().toLowerCase();
    renderGlossary();
  });

  try {
    const [tickers, snapshots, history, reports, bottlenecks, macro, rotation, glossary] = await Promise.all([
      fetchJSON(`${DATA_PATH}/tickers.json`, []),
      fetchJSON(`${DATA_PATH}/snapshots.json`, { last_updated: null, data: {} }),
      fetchJSON(`${DATA_PATH}/history.json`, {}),
      fetchJSON(`${DATA_PATH}/reports.json`, []),
      fetchJSON(`${DATA_PATH}/bottlenecks.json`, []),
      fetchJSON(`${DATA_PATH}/macro.json`, null),
      fetchJSON(`${DATA_PATH}/sector_rotation.json`, { sectors: [] }),
      fetchJSON(`${DATA_PATH}/glossary.json`, { terms: [] }),
    ]);
    state.tickers = Array.isArray(tickers) ? tickers : [];
    state.snapshots = snapshots.data || {};
    state.history = history || {};
    state.reports = Array.isArray(reports) ? reports : [];
    state.bottlenecks = Array.isArray(bottlenecks) ? bottlenecks : [];
    state.macro = macro;
    state.sectorRotation = (rotation && Array.isArray(rotation.sectors)) ? rotation.sectors : [];
    state.glossary = (glossary && Array.isArray(glossary.terms)) ? glossary.terms : [];
    state.glossaryById = new Map(state.glossary.map((t) => [t.id, t]));
    document.getElementById("last-updated").textContent = snapshots.last_updated
      ? `Updated ${formatTimestamp(snapshots.last_updated)}`
      : "No data yet";
  } catch (err) {
    document.getElementById("last-updated").textContent = `Load failed: ${err.message}`;
    return;
  }

  // Build lookup tables once
  state.bottleneckById = new Map(state.bottlenecks.map((b) => [b.id, b]));
  state.reportById = new Map(state.reports.map((r) => [r.id, r]));
  state.tickerByT = new Map(state.tickers.map((t) => [t.ticker.toUpperCase(), t]));

  // Build watchlist rows
  state.rows = state.tickers.map((t) => buildRow(t, state.snapshots[t.ticker.toUpperCase()]));

  renderMacroBanner();
  renderTabs();
  renderReports();
  renderBottlenecks();
  renderMacroView();
  renderGlossary();
  wireGlossaryModalOnce();
  wirePillarModalOnce();
  wireLeverageModalOnce();
  activateTab(restoreActiveTab());
}

// ============ helpers reused across views ============

function fetchJSON_orNull(p) { return fetchJSON(p, null).catch(() => null); }


function buildRow(ticker, snap) {
  const s = snap || {};
  const price = s.price ?? null;
  const high = s.high_52w ?? null;
  const dma200 = s.dma_200 ?? null;
  const pct_from_high = (high && price != null) ? (high - price) / high : null;
  const above_200dma = (price != null && dma200 != null) ? (price >= dma200) : null;
  return { ...ticker, ...s, pct_from_high, above_200dma };
}

// ============ tab system + cross-nav ============
//
// Tab identifiers stored in localStorage and used in data-tab attributes:
//   'all'              → state.view='watchlist', state.sector='All'
//   'sector:<name>'    → state.view='watchlist', state.sector=<name>
//   'reports'
//   'bottlenecks'
//   'glossary'
//   'macro'

function getSectorsInOrder(tickers) {
  const seen = new Set();
  const order = [];
  for (const t of tickers) {
    const s = t.sector;
    if (s && !seen.has(s)) { seen.add(s); order.push(s); }
  }
  return order;
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  const sectors = getSectorsInOrder(state.tickers);
  const sectorButtons = sectors.map((s) => {
    const count = state.tickers.filter((t) => t.sector === s).length;
    return `<button class="tab" data-tab="sector:${escapeAttr(s)}">${escapeText(s)} <span class="count">(${count})</span></button>`;
  }).join("");
  const macroTab = state.macro
    ? `<button class="tab" data-tab="macro">Macro <span class="count">(${state.macro.regime || "?"})</span></button>`
    : `<button class="tab" data-tab="macro">Macro</button>`;
  nav.innerHTML = [
    `<button class="tab" data-tab="all">All <span class="count">(${state.tickers.length})</span></button>`,
    sectorButtons,
    `<span class="tab-divider" aria-hidden="true"></span>`,
    `<button class="tab" data-tab="reports">Reports <span class="count">(${state.reports.length})</span></button>`,
    `<button class="tab" data-tab="bottlenecks">Bottlenecks <span class="count">(${state.bottlenecks.length})</span></button>`,
    `<button class="tab" data-tab="glossary">Glossary <span class="count">(${state.glossary.length})</span></button>`,
    `<button class="tab" data-tab="manage">Manage</button>`,
    macroTab,
  ].join("");
  nav.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab))
  );
}

function activeTabKey() {
  if (state.view === "reports")     return "reports";
  if (state.view === "bottlenecks") return "bottlenecks";
  if (state.view === "glossary")    return "glossary";
  if (state.view === "manage")      return "manage";
  if (state.view === "macro")       return "macro";
  if (state.sector === "All")       return "all";
  return `sector:${state.sector}`;
}

function highlightActiveTab() {
  const key = activeTabKey();
  document.querySelectorAll("#tabs .tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === key)
  );
}

function activateTab(tabId) {
  if (tabId === "reports")        state.view = "reports";
  else if (tabId === "bottlenecks") state.view = "bottlenecks";
  else if (tabId === "glossary")    state.view = "glossary";
  else if (tabId === "manage")      state.view = "manage";
  else if (tabId === "macro")       state.view = "macro";
  else if (tabId === "all") { state.view = "watchlist"; state.sector = "All"; }
  else if (typeof tabId === "string" && tabId.startsWith("sector:")) {
    state.view = "watchlist";
    state.sector = tabId.slice(7);
  } else return;

  localStorage.setItem(STORAGE_KEYS.activeTab, activeTabKey());

  document.querySelectorAll(".view").forEach((sec) => {
    const active = sec.id === `view-${state.view}`;
    sec.classList.toggle("active", active);
    sec.hidden = !active;
  });

  highlightActiveTab();

  if (state.view === "watchlist") {
    renderWatchlist();
  } else if (state.view === "manage") {
    renderManage();
  }

  requestAnimationFrame(() => applyScrollTarget());
}

function restoreActiveTab() {
  const saved = localStorage.getItem(STORAGE_KEYS.activeTab);
  if (!saved) return "all";
  if (["all", "reports", "bottlenecks", "glossary", "manage", "macro"].includes(saved)) return saved;
  if (saved.startsWith("sector:")) {
    const s = saved.slice(7);
    if (getSectorsInOrder(state.tickers).includes(s)) return saved;
  }
  // legacy 'watchlist' from the unified-layout era → All
  return "all";
}

function jumpToTicker(t) {
  state.expanded.add(t);
  const tk = state.tickerByT.get(String(t).toUpperCase());
  // Activate the sector tab the ticker lives in (or fall back to All).
  state.scrollTarget = { kind: "ticker", id: t };
  state.search = "";
  const searchEl = document.getElementById("search");
  if (searchEl) searchEl.value = "";
  if (tk?.sector && getSectorsInOrder(state.tickers).includes(tk.sector)) {
    activateTab(`sector:${tk.sector}`);
  } else {
    activateTab("all");
  }
}

function jumpToBottleneck(id) {
  state.scrollTarget = { kind: "bottleneck", id };
  activateTab("bottlenecks");
}

function applyScrollTarget() {
  if (!state.scrollTarget) return;
  const { kind, id } = state.scrollTarget;
  const sel = kind === "ticker"
    ? `tr.data-row[data-ticker="${cssEscape(id)}"]`
    : kind === "report"
    ? `[data-report-id="${cssEscape(id)}"]`
    : kind === "glossary"
    ? `[data-glossary-id="${cssEscape(id)}"]`
    : `[data-bottleneck-id="${cssEscape(id)}"]`;
  const el = document.querySelector(sel);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash-target");
    setTimeout(() => el.classList.remove("flash-target"), 1500);
  }
  state.scrollTarget = null;
}

// ============ watchlist view ============

// Composite ranking score — used as the default sort within each sector and
// surfaced in the rank cell's tooltip. See CLAUDE.md "Composite rank score".
function computeCompositeScore(r) {
  const ratingWeight = { Strong: 3, Watch: 1, Pass: -2 }[r.rating] ?? 0;
  const mrsClamped = r.mansfield_rs == null
    ? 0
    : Math.max(-5, Math.min(5, r.mansfield_rs / 10));
  const revGrowth = (r.rev_growth_yoy != null ? r.rev_growth_yoy : 0) * 2;
  const above200 = r.above_200dma === null ? 0 : (r.above_200dma ? 0.5 : -0.5);
  const nearHigh = (r.pct_from_high != null && r.pct_from_high <= 0.15) ? 0.3 : 0;
  return ratingWeight + mrsClamped + revGrowth + above200 + nearHigh;
}

// Rating ranks for the "rating" sort mode — lower is better.
const RATING_SORT_RANK = { Strong: 0, Watch: 1, Pass: 3 };
function ratingSortValue(r) {
  return RATING_SORT_RANK[r] ?? 2; // unrated falls between Watch and Pass
}

function passesRatingFilter(rating) {
  switch (state.ratingFilter) {
    case "strong":         return rating === "Strong";
    case "strong_watch":   return rating === "Strong" || rating === "Watch";
    case "hide_pass":      return rating !== "Pass";
    case "all":
    default:               return true;
  }
}

function passesEligibilityFilter(row) {
  const passed = row.pillars_passed ?? 0;
  switch (state.eligibilityFilter) {
    case "core":         return passed >= 5;
    case "swing_plus":   return passed >= 4;
    case "has_binding":  return !!row.binding_constraint_thesis;
    case "all":
    default:             return true;
  }
}

// Current sort for the active tab. Returns null when the tab is in default
// (composite rank) mode — renderWatchlist then sorts by computeCompositeScore.
function currentSort() {
  const key = activeTabKey();
  const s = state.tabSorts[key];
  if (!s || !s.col || !SORTABLE_COLS[s.col]) return null;
  if (s.dir !== "asc" && s.dir !== "desc") return null;
  return s;
}

function setCurrentSort(col, dir) {
  const key = activeTabKey();
  if (!col || !dir) {
    delete state.tabSorts[key];
  } else {
    state.tabSorts[key] = { col, dir };
  }
  localStorage.setItem(STORAGE_KEYS.tabSorts, JSON.stringify(state.tabSorts));
}

// 3-state cycle invoked by a column-header click: desc → asc → default(=null).
function cycleSort(col) {
  const cur = currentSort();
  if (!cur || cur.col !== col) {
    setCurrentSort(col, "desc");
  } else if (cur.dir === "desc") {
    setCurrentSort(col, "asc");
  } else {
    setCurrentSort(null, null);
  }
}

function sortRows(rows) {
  const cur = currentSort();
  const out = [...rows];
  if (!cur) {
    // Default: composite-rank descending.
    out.sort((a, b) => computeCompositeScore(b) - computeCompositeScore(a));
    return out;
  }
  const { col, dir } = cur;
  const mult = dir === "asc" ? 1 : -1;
  const type = SORTABLE_COLS[col];
  out.sort((a, b) => {
    let va, vb;
    if (type === "rating") {
      va = ratingSortValue(a.rating);
      vb = ratingSortValue(b.rating);
    } else if (type === "bool") {
      va = a[col] == null ? null : (a[col] ? 1 : 0);
      vb = b[col] == null ? null : (b[col] ? 1 : 0);
    } else {
      va = a[col]; vb = b[col];
    }
    // Nulls always at the bottom regardless of direction.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
    return String(va).localeCompare(String(vb)) * mult;
  });
  return out;
}


function renderWatchlist() {
  const wrap = document.getElementById("watchlist-table-wrap");
  const empty = document.getElementById("empty-watchlist");
  const q = state.search;
  const showSector = state.sector === "All";

  // Filter: active tab restricts to one sector, rating + eligibility filters apply, search hides.
  let rows = state.rows;
  if (!showSector) rows = rows.filter((r) => r.sector === state.sector);
  rows = rows.filter((r) => passesRatingFilter(r.rating));
  rows = rows.filter((r) => passesEligibilityFilter(r));
  if (q) {
    rows = rows.filter(
      (r) => r.ticker.toLowerCase().includes(q) || (r.company || "").toLowerCase().includes(q)
    );
  }

  // Composite rank is sector-local: every ticker's # column shows its rank
  // within its own sector when sorted by composite descending. This is
  // computed from the rating-filtered universe (not the search-filtered one)
  // so the rank label doesn't shuffle as you type. On the All tab you'll see
  // multiple "#1"s — one per sector — which is correct by design.
  const rankByTicker = new Map();
  const sectorSizes = new Map();
  const allSectors = getSectorsInOrder(state.tickers);
  for (const sec of allSectors) {
    const sectorRows = state.rows
      .filter((r) => r.sector === sec && passesRatingFilter(r.rating));
    const composite = [...sectorRows].sort((a, b) => computeCompositeScore(b) - computeCompositeScore(a));
    composite.forEach((r, i) => rankByTicker.set(r.ticker, { rank: i + 1, score: computeCompositeScore(r) }));
    sectorSizes.set(sec, sectorRows.length);
  }

  const sorted = sortRows(rows);

  if (sorted.length === 0) {
    wrap.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Active column sort drives the ▲/▼ arrow on the matching header. The
  // arrow indicators live in CSS via .sort-asc / .sort-desc::after.
  const cur = currentSort();
  const sortCls = (col) => cur && cur.col === col
    ? (cur.dir === "asc" ? "sort-asc" : "sort-desc")
    : "";
  // Build a th with data-sort + an active-direction class for the arrow.
  const th = (col, label, extraCls = "") => {
    const cls = [extraCls, sortCls(col)].filter(Boolean).join(" ");
    return `<th class="${cls}" data-sort="${col}">${label}</th>`;
  };
  // Mansfield is the only header with both sorting AND a glossary definition
  // (per CLAUDE.md: plain stock metrics are self-explanatory). The ⓘ button
  // is a separate click target inside the header — clicking the label sorts,
  // clicking the icon opens the glossary popover.
  const mansfieldTh = `
    <th class="num ${sortCls("mansfield_rs")}" data-sort="mansfield_rs">
      <span class="th-label">Mansfield</span><button type="button" class="header-info" data-glossary="mansfield-rs" aria-label="Mansfield RS definition" title="Definition">ⓘ</button>
    </th>`;
  const sectorCol = showSector
    ? `<th class="sector-col">Sector</th>`
    : "";

  wrap.innerHTML = `
    <table class="watchlist${showSector ? " with-sector" : ""}" id="watchlist">
      <thead>
        <tr>
          <th class="rank-col" title="Composite rank within sector">#</th>
          <th>Ticker</th>
          <th>Company</th>
          ${sectorCol}
          ${th("price",          "Price",         "num")}
          ${th("market_cap",     "Mkt Cap",       "num")}
          ${th("pe_forward",     "Fwd P/E",       "num")}
          ${th("rev_growth_yoy", "Rev YoY",       "num")}
          ${th("eps_growth_yoy", "EPS YoY",       "num")}
          ${th("gross_margin",   "Gross",         "num")}
          ${th("pct_from_high",  "% From High",   "num")}
          ${th("above_200dma",   "Above 200DMA",  "")}
          ${th("rs_proxy",       "RS",            "num")}
          ${th("ps_ratio",       "P/S",           "num")}
          ${th("ev_to_sales",    "EV/S",          "num")}
          ${th("ev_to_ebitda",   "EV/EBITDA",     "num")}
          ${mansfieldTh}
          <th>vs SPY 52w</th>
          <th>Ratio Trend</th>
          ${th("pillars_passed", "Pillars",       "")}
          ${th("net_debt_to_ebitda", "Leverage", "")}
          ${th("rating",         "Rating",        "")}
        </tr>
      </thead>
      <tbody>
        ${sorted.map((r) => renderTickerRow(r, rankByTicker.get(r.ticker), sectorSizes.get(r.sector) || 0, showSector)).join("")}
      </tbody>
    </table>
  `;

  // Column-header click → 3-state sort cycle. The Mansfield ⓘ child sits
  // inside the th — defer to the global glossary delegator for that click.
  wrap.querySelectorAll("th[data-sort]").forEach((thEl) => {
    thEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-glossary]")) return; // ⓘ → glossary
      cycleSort(thEl.dataset.sort);
      renderWatchlist();
    });
  });

  wrap.querySelectorAll(".data-row").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".pill.clickable")) return;
      if (e.target.closest(".rating-clickable")) return;
      if (e.target.closest("[data-glossary]")) return;
      if (e.target.closest("[data-pillars-ticker]")) return;
      if (e.target.closest("[data-leverage-ticker]")) return;
      const t = tr.dataset.ticker;
      if (state.expanded.has(t)) state.expanded.delete(t);
      else state.expanded.add(t);
      renderWatchlist();
    });
  });
  wrap.querySelectorAll("[data-pillars-ticker]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      openPillarModal(cell.dataset.pillarsTicker);
    });
  });
  wrap.querySelectorAll("[data-leverage-ticker]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      openLeverageModal(cell.dataset.leverageTicker);
    });
  });
  wirePillClicks(wrap);
  wireRatingClicks(wrap);
}

function renderTickerRow(r, rankInfo, sectorSize, showSector) {
  const exp = state.expanded.has(r.ticker);
  const rank = rankInfo?.rank ?? "—";
  const score = rankInfo?.score;
  const rankClass = rankCellClass(rank, sectorSize);
  const tooltip = score != null
    ? `Composite ${score.toFixed(2)} = rating ${ratingWeightOf(r.rating).toFixed(1)} + mansfield ${mansfieldComponent(r.mansfield_rs).toFixed(2)} + rev ${revGrowthComponent(r.rev_growth_yoy).toFixed(2)} + 200DMA ${above200Component(r.above_200dma).toFixed(1)} + nearHigh ${nearHighComponent(r.pct_from_high).toFixed(1)}`
    : "";
  const sectorCell = showSector
    ? `<td class="sector-col">${escapeText(r.sector || "")}</td>`
    : "";
  const colspan = showSector ? 22 : 21;
  return `
    <tr class="data-row ${exp ? "expanded" : ""}" data-ticker="${escapeAttr(r.ticker)}">
      <td class="rank-cell ${rankClass}" title="${escapeAttr(tooltip)}">${rank}</td>
      <td class="ticker">${escapeText(r.ticker)}<span class="caret">${exp ? "▾" : "▸"}</span></td>
      <td class="company-col">${escapeText(r.company || "")}</td>
      ${sectorCell}
      <td class="num price-col">${fmtPrice(r.price)}</td>
      <td class="num">${fmtCap(r.market_cap)}</td>
      <td class="num">${fmtPE(r.pe_forward)}</td>
      <td class="num rev-col ${revGrowthClass(r.rev_growth_yoy)}">${fmtPct(r.rev_growth_yoy, true)}</td>
      <td class="num">${fmtPct(r.eps_growth_yoy, true)}</td>
      <td class="num">${fmtPct(r.gross_margin)}</td>
      <td class="num ${pctFromHighClass(r.pct_from_high)}">${fmtPct(r.pct_from_high)}</td>
      <td class="dma-col ${above200Class(r.above_200dma)}">${above200Text(r.above_200dma)}</td>
      <td class="num">${fmtPct(r.rs_proxy, true)}</td>
      <td class="num">${fmtX(r.ps_ratio)}</td>
      <td class="num">${fmtX(r.ev_to_sales)}</td>
      <td class="num">${fmtEvEbitda(r.ev_to_ebitda)}</td>
      <td class="num mansfield-cell ${mansfieldClass(r.mansfield_rs)}">${fmtMansfield(r.mansfield_rs)}</td>
      <td class="${above200Class(r.ratio_above_sma)}">${ratioAboveSmaText(r.ratio_above_sma)}</td>
      <td class="ratio-trend-cell">${miniSparkline(r.ratio_history_90d || [])}</td>
      <td class="pillars-cell" data-pillars-ticker="${escapeAttr(r.ticker)}" title="Open pillar breakdown">${pillarDots(r)}</td>
      <td class="leverage-cell ${leverageCellClass(r)}" data-leverage-ticker="${escapeAttr(r.ticker)}" title="Open leverage breakdown">${leverageCellText(r)}</td>
      <td class="rating-col">${ratingPill(r.rating, r.ticker)}</td>
    </tr>
    ${exp ? `<tr class="detail-row"><td colspan="${colspan}">${renderTickerDetail(r)}</td></tr>` : ""}
  `;
}

// Small info icon HTML appended to glossary-clickable elements. Single source
// of truth so styling and accessibility attributes stay consistent.
function glossaryIcon() {
  return ` <span class="glossary-info" aria-hidden="true">ⓘ</span>`;
}

function rankCellClass(rank, sectorSize) {
  if (sectorSize <= 1) return "rank-solo";
  if (rank === 1) return "rank-gold";
  if (rank === 2 || rank === 3) return "rank-silver";
  return "rank-normal";
}

// Score-component helpers used for the rank tooltip.
function ratingWeightOf(r)         { return { Strong: 3, Watch: 1, Pass: -2 }[r] ?? 0; }
function mansfieldComponent(v)     { return v == null ? 0 : Math.max(-5, Math.min(5, v / 10)); }
function revGrowthComponent(v)     { return (v != null ? v : 0) * 2; }
function above200Component(v)      { return v === null ? 0 : (v ? 0.5 : -0.5); }
function nearHighComponent(v)      { return (v != null && v <= 0.15) ? 0.3 : 0; }

function renderTickerDetail(r) {
  const hist = state.history[r.ticker] || [];
  const prices = hist.map((h) => h.price).filter((p) => p != null);
  const fields = [
    ["Thesis", r.thesis],
    ["Catalyst", r.catalyst],
    ["Risks", r.risks],
    ["Notes", r.notes],
  ].filter(([, v]) => v && String(v).trim());

  const bnIds = Array.isArray(r.bottlenecks_addressed) ? r.bottlenecks_addressed : [];
  const reportIds = Array.isArray(r.report_refs) ? r.report_refs : [];

  const bnSection = bnIds.length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">Bottlenecks addressed</div>
        ${bnIds.map((id) => {
          const b = state.bottleneckById.get(id);
          const name = b ? b.name : id;
          const blurb = b ? `${escapeText(b.theme)} · ${escapeText(b.key_metric || "")}` : "(not in bottlenecks.json)";
          return `<div class="bottleneck-line">
            <span class="pill pill-bottleneck clickable" data-jump-bottleneck="${escapeAttr(id)}">${escapeText(name)}</span>
            <span class="blurb">${blurb}</span>
          </div>`;
        }).join("")}
      </div>` : "";

  const reportSection = reportIds.length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">Referenced in reports</div>
        ${reportIds.map((rid) => {
          const rep = state.reportById.get(rid);
          if (!rep) return `<div class="report-ref"><span class="muted small">(${escapeText(rid)} not found)</span></div>`;
          const ranking = (rep.rankings || []).find((rk) => (rk.ticker || "").toUpperCase() === r.ticker);
          const rankStr = ranking ? ` #${ranking.rank}` : "";
          const reasoning = ranking ? ranking.reasoning : "";
          return `
            <div class="report-ref">
              <span class="report-ref-title">${escapeText(rep.title)}</span><span class="report-ref-rank">${escapeText(rankStr)}</span>
              ${reasoning ? `<div class="report-ref-reasoning">${escapeText(reasoning)}</div>` : ""}
            </div>`;
        }).join("")}
      </div>` : "";

  const spark = sparkline(prices, 260, 60);
  const trail = prices.length >= 2
    ? `${((prices[prices.length - 1] - prices[0]) / prices[0] * 100).toFixed(1)}% over ${prices.length}d`
    : "";

  const rsSection = renderRsSection(r);

  return `
    <div class="detail">
      <div class="detail-text">
        ${fields.length === 0
          ? `<div class="muted small">No notes yet — edit data/tickers.json or run /ingest on a research report.</div>`
          : fields.map(([k, v]) => `<div class="field"><span class="field-label">${escapeText(k)}:</span>${escapeText(v)}</div>`).join("")}
        ${bnSection}
        ${reportSection}
        ${rsSection}
      </div>
      <div class="detail-spark">
        <div class="muted small" style="margin-bottom:0.25rem;">
          ${prices.length} day${prices.length === 1 ? "" : "s"}${trail ? " · " + trail : ""}
        </div>
        ${spark || `<div class="muted small">no history yet</div>`}
      </div>
    </div>
  `;
}

function renderRsSection(r) {
  const mrs = r.mansfield_rs;
  const slope = r.ratio_slope_30d;
  const above = r.ratio_above_sma;
  const hist = Array.isArray(r.ratio_history_90d) ? r.ratio_history_90d : [];
  if (mrs == null && hist.length === 0) return "";

  const headline = (() => {
    if (mrs == null) return "Relative Strength data not yet available.";
    const verb = above ? "outperforming" : "underperforming";
    const accel = slope == null
      ? ""
      : (slope >= 0
          ? `, with the ratio accelerating over the last 30 days (${slope >= 0 ? "+" : ""}${slope.toFixed(1)}%)`
          : `, but the 30-day slope is rolling over (${slope.toFixed(1)}%)`);
    const flag = mrs > 30 ? " ⚠️ <strong>Extended</strong> — far above its 52w trend." :
                  mrs < -30 ? " ⚠️ <strong>Deep underperformance</strong> vs SPY." : "";
    return `<strong>${escapeText(r.ticker)}</strong> has been ${verb} SPY on a 52-week basis (Mansfield RS ${mrs >= 0 ? "+" : ""}${mrs.toFixed(1)})${accel}.${flag}`;
  })();

  const chart = largeSparklineWithSMA(hist, r.ratio_sma_52w, 320, 72);

  return `
    <div class="detail-section rs-section">
      <div class="detail-section-label">Relative Strength vs SPY</div>
      <div class="rs-headline">${headline}</div>
      <div class="rs-chart">
        ${chart || '<div class="muted small">no ratio history yet</div>'}
        ${chart ? `<div class="rs-legend">
          <span><span class="swatch" style="background:${mrs >= 0 ? "var(--green)" : "var(--red)"};"></span>Ratio</span>
          <span><span class="swatch" style="background:var(--text-muted);"></span>52w SMA</span>
        </div>` : ""}
      </div>
    </div>
  `;
}

// ============ reports view ============

function renderReports() {
  const list = document.getElementById("reports-list");
  const empty = document.getElementById("empty-reports");
  if (state.reports.length === 0) {
    list.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;

  // newest first by date_ingested
  const sorted = [...state.reports].sort((a, b) =>
    String(b.date_ingested || "").localeCompare(String(a.date_ingested || ""))
  );

  list.innerHTML = sorted.map((rep) => {
    const rankings = (rep.rankings || []).slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    return `
      <article class="report-card" data-report-id="${escapeAttr(rep.id)}">
        <header class="report-card-header">
          <h2 class="report-title">${escapeText(rep.title || rep.id)}</h2>
          <div class="report-meta">
            ${escapeText(rep.source || "")}
            ${rep.date_ingested ? ` · ingested ${escapeText(rep.date_ingested)}` : ""}
          </div>
        </header>
        ${rep.summary ? `<div class="report-summary">${escapeText(rep.summary)}</div>` : ""}
        ${rankings.length ? `
          <table class="rankings-table" aria-label="Rankings">
            <thead>
              <tr>
                <th>#</th><th>Ticker</th><th>Reasoning</th><th>Bottlenecks</th>
              </tr>
            </thead>
            <tbody>
              ${rankings.map((rk) => `
                <tr>
                  <td class="rank">${escapeText(String(rk.rank ?? ""))}</td>
                  <td class="ticker-cell">
                    <span class="pill pill-ticker clickable" data-jump-ticker="${escapeAttr((rk.ticker || "").toUpperCase())}">${escapeText(rk.ticker || "")}</span>
                  </td>
                  <td class="reasoning">${escapeText(rk.reasoning || "")}</td>
                  <td class="bottlenecks-cell">
                    ${(rk.bottlenecks_addressed || []).map((bid) => {
                      const b = state.bottleneckById.get(bid);
                      const lbl = b ? b.name : bid;
                      return `<span class="pill pill-bottleneck clickable" data-jump-bottleneck="${escapeAttr(bid)}">${escapeText(lbl)}</span>`;
                    }).join("")}
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : `<div class="muted small">No rankings recorded.</div>`}
      </article>
    `;
  }).join("");

  wirePillClicks(list);
}

// ============ bottlenecks view ============

function renderBottlenecks() {
  const grid = document.getElementById("bottlenecks-grid");
  const empty = document.getElementById("empty-bottlenecks");
  if (state.bottlenecks.length === 0) {
    grid.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;

  const sorted = [...state.bottlenecks].sort((a, b) =>
    (a.theme || "").localeCompare(b.theme || "") || (a.name || "").localeCompare(b.name || "")
  );

  grid.innerHTML = sorted.map((b) => `
    <article class="bottleneck-card" data-bottleneck-id="${escapeAttr(b.id)}">
      <h3 class="bottleneck-name">${escapeText(b.name || b.id)}</h3>
      <div class="bottleneck-tagline">
        ${escapeText(b.theme || "")}${b.key_metric ? ` · ${escapeText(b.key_metric)}` : ""}
      </div>
      <p class="bottleneck-physics">${escapeText(b.physics || "")}</p>
      ${b.current_frontier ? `
        <div class="bottleneck-row">
          <span class="row-label">Frontier</span>
          <span class="row-value">${escapeText(b.current_frontier)}</span>
        </div>` : ""}
      ${(b.winners || []).length ? `
        <div class="bottleneck-row">
          <span class="row-label">Winners</span>
          <span class="row-value bottleneck-tickers">
            ${b.winners.map((t) => tickerOrTextPill(t)).join("")}
          </span>
        </div>` : ""}
      ${(b.losers_or_at_risk || []).length ? `
        <div class="bottleneck-row">
          <span class="row-label">At risk</span>
          <span class="row-value bottleneck-tickers">
            ${b.losers_or_at_risk.map((t) => tickerOrTextPill(t)).join("")}
          </span>
        </div>` : ""}
      ${(b.references || []).length ? `
        <div class="bottleneck-refs">
          <span class="row-label">References</span>
          <ul>${b.references.map((r) => `<li>${escapeText(r)}</li>`).join("")}</ul>
        </div>` : ""}
    </article>
  `).join("");

  wirePillClicks(grid);
}

// Render a ticker pill if the string matches a known ticker symbol;
// otherwise a plain gray pill (handles "Micron", "SK Hynix" etc. as text).
function tickerOrTextPill(s) {
  const up = String(s || "").toUpperCase();
  if (state.tickerByT.has(up)) {
    return `<span class="pill pill-ticker clickable" data-jump-ticker="${escapeAttr(up)}">${escapeText(up)}</span>`;
  }
  return `<span class="pill pill-gray">${escapeText(s)}</span>`;
}

// ============ pill-click wiring ============

function wirePillClicks(scope) {
  scope.querySelectorAll("[data-jump-ticker]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = el.dataset.jumpTicker;
      // Reverse link: if the ticker has reasoning, open the rating modal.
      // (Modal includes a "view in watchlist" affordance for jumping the row.)
      if (state.tickerByT.get(t)?.rating_reasoning) {
        openRatingModal(t);
      } else {
        jumpToTicker(t);
      }
    })
  );
  scope.querySelectorAll("[data-jump-bottleneck]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToBottleneck(el.dataset.jumpBottleneck);
    })
  );
}

function wireRatingClicks(scope) {
  scope.querySelectorAll("[data-rating-ticker]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openRatingModal(el.dataset.ratingTicker);
    })
  );
}

// ============ rating reasoning modal ============

let _modalWired = false;
function wireModalOnce() {
  if (_modalWired) return;
  _modalWired = true;
  document.querySelectorAll("#rating-modal [data-close-modal]").forEach((el) =>
    el.addEventListener("click", closeRatingModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRatingModal();
  });
}

function openRatingModal(ticker) {
  wireModalOnce();
  const t = state.tickerByT.get(String(ticker).toUpperCase());
  if (!t) return;
  const rr = t.rating_reasoning;
  const modal = document.getElementById("rating-modal");
  document.getElementById("rating-modal-title").textContent =
    `${t.ticker} — ${t.company || ""}`.trim().replace(/—\s*$/, "").trim();
  document.getElementById("rating-modal-pill").innerHTML = (() => {
    const r = t.rating;
    if (!r) return `<span class="muted">—</span>`;
    const cls = { Strong: "pill-green", Watch: "pill-yellow", Pass: "pill-gray" }[r] || "pill-gray";
    return `<span class="pill ${cls}">${escapeText(r)}</span>`;
  })();

  const body = document.getElementById("rating-modal-body");
  if (!rr) {
    body.innerHTML = `<div class="muted">No rating reasoning recorded for ${escapeText(t.ticker)}. Edit data/tickers.json or run /ingest.</div>`;
  } else {
    const drivers = (rr.primary_drivers || []).map((d) => `<li>${escapeText(d)}</li>`).join("");
    const risks = (rr.key_risks || []).map((d) => `<li>${escapeText(d)}</li>`).join("");
    const evidence = (rr.evidence || []).map((ev) => renderEvidenceItem(ev)).join("");
    const meta = `${escapeText(rr.rated_by || "auto")} · rated ${escapeText(rr.rated_date || "")}`;
    body.innerHTML = `
      ${rr.summary ? `<div class="modal-section">
        <div class="modal-section-label">Summary</div>
        <div class="modal-summary">${escapeText(rr.summary)}</div>
      </div>` : ""}
      ${drivers ? `<div class="modal-section">
        <div class="modal-section-label">Primary drivers</div>
        <ul>${drivers}</ul>
      </div>` : ""}
      ${risks ? `<div class="modal-section">
        <div class="modal-section-label">Key risks</div>
        <ul>${risks}</ul>
      </div>` : ""}
      ${evidence ? `<div class="modal-section">
        <div class="modal-section-label">Evidence (${(rr.evidence || []).length})</div>
        ${evidence}
      </div>` : `<div class="modal-section"><div class="modal-section-label">Evidence</div><div class="muted small">No linked reports or bottlenecks.</div></div>`}
      <div class="modal-section modal-meta">${meta} · <a href="#" data-jump-row="${escapeAttr(t.ticker)}">view in watchlist →</a></div>
    `;
    body.querySelectorAll("[data-jump-row]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.preventDefault();
        closeRatingModal();
        jumpToTicker(el.dataset.jumpRow);
      })
    );
    body.querySelectorAll("[data-evidence-report]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.preventDefault();
        closeRatingModal();
        state.scrollTarget = { kind: "report", id: el.dataset.evidenceReport };
        activateTab("reports");
      })
    );
    body.querySelectorAll("[data-evidence-bottleneck]").forEach((el) =>
      el.addEventListener("click", (e) => {
        e.preventDefault();
        closeRatingModal();
        jumpToBottleneck(el.dataset.evidenceBottleneck);
      })
    );
  }

  const copyBtn = document.getElementById("rating-modal-copy");
  copyBtn.classList.remove("copied");
  copyBtn.textContent = "Copy override snippet";
  copyBtn.onclick = () => copyOverrideSnippet(t, copyBtn);

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function renderEvidenceItem(ev) {
  if (ev.type === "report") {
    const rep = state.reportById.get(ev.ref_id);
    const title = rep ? rep.title : (ev.ref_name || ev.ref_id);
    const rank = ev.rank != null ? `#${ev.rank}` : "";
    const reasoning = ev.reasoning ? `<div class="modal-evidence-detail">${escapeText(ev.reasoning)}</div>` : "";
    return `
      <div class="modal-evidence-item kind-report">
        <div class="modal-evidence-header">
          <span class="modal-evidence-kind">Report${rank ? " · " + rank : ""}</span>
          <a href="#" data-evidence-report="${escapeAttr(ev.ref_id)}">${escapeText(title)}</a>
        </div>
        ${reasoning}
      </div>`;
  }
  if (ev.type === "bottleneck") {
    const b = state.bottleneckById.get(ev.ref_id);
    const name = b ? b.name : (ev.ref_name || ev.ref_id);
    const role = ev.role ? `<span class="muted small"> · ${escapeText(ev.role)}</span>` : "";
    const physics = ev.physics_summary ? `<div class="modal-evidence-detail">${escapeText(ev.physics_summary)}</div>` : "";
    return `
      <div class="modal-evidence-item kind-bottleneck">
        <div class="modal-evidence-header">
          <span class="modal-evidence-kind">Bottleneck</span>
          <a href="#" data-evidence-bottleneck="${escapeAttr(ev.ref_id)}">${escapeText(name)}</a>${role}
        </div>
        ${physics}
      </div>`;
  }
  return `<div class="modal-evidence-item"><div class="modal-evidence-detail">${escapeText(JSON.stringify(ev))}</div></div>`;
}

function closeRatingModal() {
  const modal = document.getElementById("rating-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

function copyOverrideSnippet(t, btn) {
  // Paste-ready JSON fragment for tickers.json — flips rated_by to "manual" so
  // future /ingest runs preserve it.
  const today = new Date().toISOString().slice(0, 10);
  const rr = t.rating_reasoning || {};
  const snippet = {
    ticker: t.ticker,
    rating: t.rating || "",
    rating_reasoning: {
      summary: rr.summary || "",
      primary_drivers: rr.primary_drivers || [],
      key_risks: rr.key_risks || [],
      evidence: rr.evidence || [],
      rated_date: today,
      rated_by: "manual",
    },
  };
  const text = JSON.stringify(snippet, null, 2);
  const onOk = () => {
    btn.classList.add("copied");
    btn.textContent = "Copied — edit then paste into tickers.json";
  };
  const onFail = () => {
    btn.textContent = "Copy failed (use right-click)";
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onOk, onFail);
  } else {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      onOk();
    } catch { onFail(); }
  }
}

// ============ glossary system ============
//
// Two surfaces:
// - Modal popover (#glossary-modal): opened by clicking any term/header/cell
//   with a data-glossary or data-glossary-cell attribute. Optionally shows a
//   context-aware lead line ("AMKR's Mansfield RS is +8.6 → Outperforming")
//   plus highlights the matching row in the interpretation scale.
// - Full Glossary tab: scrollable reference of every term, grouped by
//   category, with a search filter.

let _glossaryModalWired = false;
function wireGlossaryModalOnce() {
  if (_glossaryModalWired) return;
  _glossaryModalWired = true;
  document.querySelectorAll("#glossary-modal [data-close-glossary]").forEach((el) =>
    el.addEventListener("click", closeGlossaryModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeGlossaryModal();
  });
  document.getElementById("glossary-modal-fullview").addEventListener("click", (e) => {
    e.preventDefault();
    const id = document.getElementById("glossary-modal").dataset.currentTerm || "";
    closeGlossaryModal();
    state.scrollTarget = id ? { kind: "glossary", id } : null;
    activateTab("glossary");
  });
  // Delegate clicks anywhere in the document to open the modal whenever a
  // glossary-tagged element is clicked. This keeps individual render sites
  // free from having to re-wire after every re-render.
  //
  // Conflict rule: when the same header drives BOTH sorting and glossary
  // (rotation-table th has data-rsort + data-glossary), the ⓘ icon opens
  // glossary; the rest of the header sorts. Watchlist sector-table headers
  // don't sort on click (sort is via dropdown), so the whole header opens
  // the glossary.
  document.addEventListener("click", (e) => {
    const cellEl = e.target.closest("[data-glossary-cell]");
    if (cellEl) {
      const id = cellEl.dataset.glossaryCell;
      const value = cellEl.dataset.glossaryValue;
      const ticker = cellEl.dataset.glossaryTicker;
      openGlossaryModal(id, { value, ticker });
      return;
    }
    const termEl = e.target.closest("[data-glossary]");
    if (!termEl) return;
    const isSortHeader = termEl.matches("[data-rsort]");
    const clickedIcon  = e.target.closest(".glossary-info");
    if (isSortHeader && !clickedIcon) return; // let the sort handler win
    openGlossaryModal(termEl.dataset.glossary, null);
  });
}

function openGlossaryModal(id, context) {
  const term = state.glossaryById.get(id);
  const modal = document.getElementById("glossary-modal");
  modal.dataset.currentTerm = id || "";
  if (!term) {
    document.getElementById("glossary-modal-title").textContent = `(${id || "unknown"})`;
    document.getElementById("glossary-modal-category").textContent = "";
    document.getElementById("glossary-modal-body").innerHTML =
      `<div class="muted">No glossary entry for <code>${escapeText(id || "")}</code>. Add one to <code>data/glossary.json</code>.</div>`;
  } else {
    document.getElementById("glossary-modal-title").textContent = term.term;
    document.getElementById("glossary-modal-category").textContent = term.category || "";
    document.getElementById("glossary-modal-body").innerHTML = renderGlossaryBody(term, context);
  }
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function closeGlossaryModal() {
  const modal = document.getElementById("glossary-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.currentTerm;
}

function renderGlossaryBody(term, context) {
  const matchIdx = context && context.value != null
    ? scaleMatchIndex(term.id, context.value)
    : -1;
  // Context-aware lead line: "<TICKER>'s <metric> is <value> → <label>"
  let contextHtml = "";
  if (context && context.value != null && matchIdx >= 0 && term.interpretation_scale?.[matchIdx]) {
    const row = term.interpretation_scale[matchIdx];
    const ticker = context.ticker ? `<strong>${escapeText(context.ticker)}'s</strong> ` : "";
    contextHtml = `<div class="glossary-context glossary-color-${escapeAttr(row.color || "gray")}">
      ${ticker}${escapeText(term.term)} is <strong>${escapeText(formatContextValue(term.id, context.value))}</strong>
       → ${escapeText(row.label)} <span class="muted small">(${escapeText(row.color || "")} zone)</span>
    </div>`;
  } else if (context && context.value != null) {
    contextHtml = `<div class="glossary-context">
      ${context.ticker ? `<strong>${escapeText(context.ticker)}'s</strong> ` : ""}
      ${escapeText(term.term)} is <strong>${escapeText(formatContextValue(term.id, context.value))}</strong>
    </div>`;
  }

  const sections = [];
  if (term.short_definition) sections.push(`<div class="glossary-section glossary-short">${escapeText(term.short_definition)}</div>`);
  // Term-specific live data injection — F&G shows the 7-component breakdown +
  // prev_close/1w/1m/1y; put-call-cnn shows the current zone (the standard
  // scale highlight already handles the rest).
  if (term.id === "fear-greed-index") {
    const fg = state.macro?.indicators?.fear_greed;
    if (fg) sections.push(renderFearGreedLiveSection(fg));
  }
  if (term.id === "put-call-cnn") {
    const pc = state.macro?.indicators?.put_call;
    if (pc) sections.push(renderPutCallLiveSection(pc));
  }
  if (term.formula)         sections.push(`<div class="glossary-section"><div class="glossary-label">Formula</div><div class="glossary-formula">${escapeText(term.formula)}</div></div>`);
  if (term.what_it_measures) sections.push(`<div class="glossary-section"><div class="glossary-label">What it measures</div><div>${escapeText(term.what_it_measures)}</div></div>`);
  if (Array.isArray(term.interpretation_scale) && term.interpretation_scale.length) {
    sections.push(`<div class="glossary-section">
      <div class="glossary-label">How to read</div>
      <ul class="glossary-scale">
        ${term.interpretation_scale.map((row, i) => `
          <li class="glossary-scale-row ${i === matchIdx ? "match" : ""}">
            <span class="glossary-dot glossary-color-${escapeAttr(row.color || "gray")}" aria-hidden="true"></span>
            <span class="glossary-range">${escapeText(row.range || "")}</span>
            <span class="glossary-rlabel">${escapeText(row.label || "")}</span>
            ${row.meaning ? `<div class="glossary-meaning muted small">${escapeText(row.meaning)}</div>` : ""}
          </li>`).join("")}
      </ul>
    </div>`);
  }
  if (term.how_to_use)      sections.push(`<div class="glossary-section"><div class="glossary-label">How to use</div><div>${escapeText(term.how_to_use)}</div></div>`);
  if (term.origin)          sections.push(`<div class="glossary-section"><div class="glossary-label">Origin</div><div class="muted small">${escapeText(term.origin)}</div></div>`);
  if (term.ken_quote)       sections.push(`<div class="glossary-section glossary-quote">${escapeText(term.ken_quote)}</div>`);
  if (term.common_pitfalls) sections.push(`<div class="glossary-section"><div class="glossary-label">Common pitfalls</div><div>${escapeText(term.common_pitfalls)}</div></div>`);

  return contextHtml + sections.join("");
}

// Friendly labels for the F&G sub-components (matches CNN's UI).
const FNG_COMPONENT_LABELS = {
  market_momentum:    "Market Momentum",
  price_strength:     "Stock Price Strength",
  price_breadth:      "Stock Price Breadth",
  put_call_options:   "Put/Call Options",
  volatility_vix:     "Market Volatility (VIX)",
  safe_haven_demand:  "Safe Haven Demand",
  junk_bond_demand:   "Junk Bond Demand",
};
const FNG_COMPONENT_ORDER = [
  "market_momentum", "price_strength", "price_breadth", "put_call_options",
  "volatility_vix", "safe_haven_demand", "junk_bond_demand",
];

function fngColor(score) {
  if (score == null) return "gray";
  if (score < 25) return "red";
  if (score < 45) return "orange";
  if (score < 55) return "gray";
  if (score < 75) return "lime";
  return "yellow";
}

function renderFearGreedLiveSection(fg) {
  const ratingLower = (rt) => rt ? rt.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ") : "—";
  const prevRow = (label, v) => v == null ? "" :
    `<div class="fng-prev-row"><span>${label}</span><span class="fng-prev-val">${v.toFixed(1)}</span></div>`;
  const componentsRows = FNG_COMPONENT_ORDER.map((k) => {
    const c = fg.components?.[k] || {};
    const score = c.score;
    const color = fngColor(score);
    return `
      <tr class="fng-comp-row fng-comp-${color}">
        <td class="fng-comp-name">${escapeText(FNG_COMPONENT_LABELS[k] || k)}</td>
        <td class="fng-comp-score num">${score == null ? "—" : score.toFixed(1)}</td>
        <td class="fng-comp-rating">${escapeText(ratingLower(c.rating || ""))}</td>
        <td class="fng-comp-bar"><div class="fng-bar-bg"><div class="fng-bar-fill fng-color-${color}" style="width:${Math.max(0, Math.min(100, score || 0))}%"></div></div></td>
      </tr>
    `;
  }).join("");
  // Divergence detection: callout when the 7 components span a wide range,
  // since the headline composite is just an average and can hide sub-signal
  // disagreement. >50 point spread is a meaningful divergence in practice
  // (today: 25.4 breadth ↔ 97.8 momentum — same composite as a uniformly-
  // greedy market but a fundamentally different setup).
  const scores = FNG_COMPONENT_ORDER.map(k => fg.components?.[k]?.score).filter(v => v != null);
  const min = scores.length ? Math.min(...scores) : null;
  const max = scores.length ? Math.max(...scores) : null;
  const divergence = (min != null && (max - min) > 50)
    ? `<div class="fng-divergence">⚠ <strong>Divergence Watch:</strong> components span ${min.toFixed(0)} … ${max.toFixed(0)} (range ${(max - min).toFixed(0)}). Headline ${fg.value?.toFixed(0)} hides meaningful sub-signal disagreement — internals (breadth, junk bonds, price strength) are far weaker than the surface signals (momentum, options, safe-haven).</div>`
    : "";
  return `
    <div class="glossary-section fng-live">
      <div class="glossary-label">Current reading · ${escapeText(fg.source || "")}</div>
      <div class="fng-headline">
        <span class="fng-headline-score fng-color-${fngColor(fg.value)}">${fg.value == null ? "—" : fg.value.toFixed(1)}</span>
        <span class="fng-headline-label">${escapeText(fg.regime || "?")}</span>
      </div>
      ${divergence}
      <div class="fng-prev">
        ${prevRow("Previous close", fg.prev_close)}
        ${prevRow("1 week ago",   fg.prev_week)}
        ${prevRow("1 month ago",  fg.prev_month)}
        ${prevRow("1 year ago",   fg.prev_year)}
      </div>
      <div class="fng-comp-label">Components</div>
      <table class="fng-comp-table"><tbody>${componentsRows}</tbody></table>
      <div class="muted small fng-foot">Data ${escapeText(fg.data_timestamp || "—")} · Fetched ${escapeText(fg.last_updated || "—")}</div>
    </div>
  `;
}

function renderPutCallLiveSection(pc) {
  if (pc.cnn_score == null) {
    return `<div class="glossary-section"><div class="muted">Put/Call score unavailable. ${escapeText(pc.error || "")}</div></div>`;
  }
  const color = fngColor(pc.cnn_score);
  return `
    <div class="glossary-section fng-live">
      <div class="glossary-label">Current reading · ${escapeText(pc.source || "")}</div>
      <div class="fng-headline">
        <span class="fng-headline-score fng-color-${color}">${pc.cnn_score.toFixed(1)}</span>
        <span class="fng-headline-label">${escapeText(pc.zone || "?")}</span>
      </div>
      <div class="muted small">${escapeText(pc.interpretation || "")}</div>
      <div class="muted small fng-foot">Data ${escapeText(pc.data_timestamp || "—")} · Fetched ${escapeText(pc.last_updated || "—")}</div>
    </div>
  `;
}

// Numeric-threshold matchers for context-aware highlighting. Each function
// takes the raw cell value (string, since it came from a data-attribute) and
// returns the matching index in the term's interpretation_scale array.
function scaleMatchIndex(id, rawValue) {
  if (rawValue == null || rawValue === "") return -1;
  // booleans encoded as "yes"/"no" / "true"/"false"
  if (id === "above-200dma" || id === "spy-200dma") {
    if (rawValue === "true" || rawValue === "yes")  return 0;
    if (rawValue === "false" || rawValue === "no") return 1;
  }
  const v = parseFloat(rawValue);
  if (Number.isNaN(v)) return -1;
  switch (id) {
    case "mansfield-rs":
      if (v >= 10) return 0;
      if (v >= 3)  return 1;
      if (v >= -3) return 2;
      if (v >= -10) return 3;
      return 4;
    case "rev-growth-yoy":  // expects percentage (e.g. 0.30 = 30%)
      if (v < 0)     return 0;
      if (v < 0.10)  return 1;
      if (v < 0.25)  return 2;
      if (v < 0.50)  return 3;
      return 4;
    case "eps-growth-yoy":
      if (v < 0)     return 0;
      if (v < 0.10)  return 1;
      if (v < 0.25)  return 2;
      if (v < 0.50)  return 3;
      return 4;
    case "pct-from-52w-high":
      if (v < 0.15)  return 0;
      if (v < 0.25)  return 1;
      if (v < 0.40)  return 2;
      return 3;
    case "ps-ratio":
      if (v < 2)   return 0;
      if (v < 6)   return 1;
      if (v < 15)  return 2;
      if (v < 25)  return 3;
      return 4;
    case "ev-sales":
      if (v < 2)   return 0;
      if (v < 6)   return 1;
      if (v < 15)  return 2;
      return 3;
    case "ev-ebitda":
      if (v <= 0)  return 4;  // n/m
      if (v < 10)  return 0;
      if (v < 15)  return 1;
      if (v < 25)  return 2;
      return 3;
    case "vix":
      if (v < 15)  return 0;
      if (v < 20)  return 1;
      if (v < 25)  return 2;
      if (v < 30)  return 3;
      if (v < 40)  return 4;
      return 5;
    case "fear-greed-index":
    case "put-call-cnn":
      if (v < 25)  return 0;
      if (v < 45)  return 1;
      if (v < 55)  return 2;
      if (v < 75)  return 3;
      return 4;
    case "dxy":
      if (v < 95)   return 0;
      if (v < 100)  return 1;
      if (v < 105)  return 2;
      if (v < 110)  return 3;
      return 4;
    case "credit-spread":
      if (v < 300)  return 0;
      if (v < 500)  return 1;
      if (v < 700)  return 2;
      return 3;
    case "composite-score":
      if (v > 5)   return 0;
      if (v > 2)   return 1;
      if (v > -2)  return 2;
      return 3;
    default:
      return -1;
  }
}

// Format a context value for display in the lead line — matches the column's
// in-row format (percentages, multiples, basis points, etc.).
function formatContextValue(id, rawValue) {
  const v = parseFloat(rawValue);
  if (Number.isNaN(v)) return rawValue;
  switch (id) {
    case "rev-growth-yoy":
    case "eps-growth-yoy":
    case "pct-from-52w-high":
    case "gross-margin":
    case "op-margin":
    case "fcf-margin":
      return `${(v * 100).toFixed(1)}%`;
    case "ps-ratio":
    case "ev-sales":
    case "ev-ebitda":
    case "pe-forward":
    case "pe-trailing":
      return `${v.toFixed(1)}x`;
    case "mansfield-rs":
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
    case "credit-spread":
      return `${Math.round(v)} bps`;
    case "dxy":
    case "vix":
      return v.toFixed(1);
    case "fear-greed-index":
    case "put-call-cnn":
      return v.toFixed(0);
    case "above-200dma":
    case "spy-200dma":
      return rawValue === "true" || rawValue === "yes" ? "Yes" : "No";
    case "composite-score":
      return v.toFixed(2);
    default:
      return rawValue;
  }
}

// ============ glossary view (full reference tab) ============

function renderGlossary() {
  const container = document.getElementById("glossary-sections");
  const empty = document.getElementById("empty-glossary");
  if (state.glossary.length === 0) {
    container.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "No glossary terms loaded (data/glossary.json missing or empty).";
    return;
  }
  const q = state.glossarySearch || "";
  const matches = (t) => {
    if (!q) return true;
    const hay = `${t.term} ${t.short_definition || ""} ${t.what_it_measures || ""} ${t.id}`.toLowerCase();
    return hay.includes(q);
  };
  // Preserve insertion order of categories as they first appear in the data,
  // not alphabetical — gives the user authored control over category order.
  const order = [];
  const seen = new Set();
  for (const t of state.glossary) {
    if (!seen.has(t.category)) { seen.add(t.category); order.push(t.category); }
  }
  let totalMatching = 0;
  const html = order.map((cat) => {
    const terms = state.glossary.filter((t) => t.category === cat && matches(t));
    if (terms.length === 0) return "";
    totalMatching += terms.length;
    return `
      <section class="glossary-category" data-category="${escapeAttr(cat)}">
        <h2 class="glossary-cat-name">${escapeText(cat)} <span class="muted small">(${terms.length})</span></h2>
        <div class="glossary-cat-grid">
          ${terms.map((t) => `
            <article class="glossary-card" data-glossary-id="${escapeAttr(t.id)}">
              <header class="glossary-card-header">
                <h3>${escapeText(t.term)}</h3>
                <code class="muted small">${escapeText(t.id)}</code>
              </header>
              ${renderGlossaryBody(t, null)}
            </article>
          `).join("")}
        </div>
      </section>
    `;
  }).join("");
  container.innerHTML = html;
  empty.hidden = totalMatching > 0;
  if (totalMatching === 0) empty.textContent = `No terms match "${q}".`;
}

// ============ Manage tab (read-only planner, emits CLI commands + JSON diff) ============
//
// The dashboard is static — it can't write tickers.json. The Manage tab lets
// the user accumulate planned changes (add/remove/move/rate tickers; add/
// rename/remove sectors) and then click "Generate edits" to get:
//   (a) a copy-pasteable block of CLI commands for scripts/manage.py, OR
//   (b) a JSON diff blob the user can paste into Claude Code.
//
// Pending changes live in-memory only — refresh wipes them. That's
// intentional: nothing leaves this browser tab until the user explicitly
// copies the output and runs the commands.

const _manageState = {
  pending: [],        // [{type, ...}] — see _pendingChange shapes below
};

function renderManage() {
  // Sector dropdown contents (current sectors + "+ new" option)
  const sectors = getSectorsInOrder(state.tickers);
  const addSectorSel = document.getElementById("manage-add-sector");
  addSectorSel.innerHTML = sectors.map(s =>
    `<option value="${escapeAttr(s)}">${escapeText(s)}</option>`
  ).join("") + `<option value="__new__">— New sector —</option>`;

  // Ticker table — every row has a sector dropdown (planned reassign) + remove btn
  const tbody = document.querySelector("#manage-tickers-table tbody");
  tbody.innerHTML = state.tickers.map(t => `
    <tr data-ticker="${escapeAttr(t.ticker)}">
      <td><strong>${escapeText(t.ticker)}</strong></td>
      <td>${escapeText(t.company || "")}</td>
      <td>
        <select class="manage-sector-select" data-sym="${escapeAttr(t.ticker)}" data-orig="${escapeAttr(t.sector || "")}">
          ${sectors.map(s => `<option value="${escapeAttr(s)}"${s === t.sector ? " selected" : ""}>${escapeText(s)}</option>`).join("")}
        </select>
      </td>
      <td><span class="muted">${escapeText(t.rating || "—")}</span></td>
      <td><button class="ghost-btn manage-remove-btn" data-sym="${escapeAttr(t.ticker)}">× Remove</button></td>
    </tr>
  `).join("");

  // Sector table — count + rename input + remove btn
  const counts = state.tickers.reduce((acc, t) => ((acc[t.sector] = (acc[t.sector] || 0) + 1), acc), {});
  const stbody = document.querySelector("#manage-sectors-table tbody");
  stbody.innerHTML = sectors.map(s => `
    <tr data-sector="${escapeAttr(s)}">
      <td><strong>${escapeText(s)}</strong></td>
      <td class="num">${counts[s] || 0}</td>
      <td><input type="text" class="manage-sector-rename" data-orig="${escapeAttr(s)}" placeholder="rename to…"></td>
      <td>
        <button class="ghost-btn manage-sector-rename-btn" data-orig="${escapeAttr(s)}">Rename</button>
        <button class="ghost-btn manage-sector-remove-btn" data-name="${escapeAttr(s)}">× Remove</button>
      </td>
    </tr>
  `).join("");

  _wireManageHandlers();
  _renderPending();
}

function _wireManageHandlers() {
  // Per-row sector dropdown change → queue a 'move' pending change
  document.querySelectorAll(".manage-sector-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const sym = sel.dataset.sym;
      const orig = sel.dataset.orig;
      const target = sel.value;
      if (target === "__new__") {
        const name = prompt("New sector name:");
        if (!name) { sel.value = orig; return; }
        _pushPending({ type: "move", ticker: sym, from: orig, to: name });
      } else if (target !== orig) {
        _pushPending({ type: "move", ticker: sym, from: orig, to: target });
      }
    });
  });
  // Remove button
  document.querySelectorAll(".manage-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.dataset.sym;
      const reason = prompt(`Reason for removing ${sym}? (optional, for institutional memory)`, "") || "";
      _pushPending({ type: "remove", ticker: sym, reason });
    });
  });
  // Add ticker form
  document.getElementById("manage-add-btn").onclick = () => {
    const symEl = document.getElementById("manage-add-symbol");
    const sectorEl = document.getElementById("manage-add-sector");
    const ratingEl = document.getElementById("manage-add-rating");
    const sym = (symEl.value || "").trim().toUpperCase();
    if (!sym) { symEl.focus(); return; }
    let sector = sectorEl.value;
    if (sector === "__new__") {
      sector = prompt("New sector name:") || "";
      if (!sector) return;
    }
    const rating = ratingEl.value;
    _pushPending({ type: "add", ticker: sym, sector, rating });
    symEl.value = "";
  };
  // Sector add
  document.getElementById("manage-sector-add-btn").onclick = () => {
    const input = document.getElementById("manage-sector-new");
    const name = (input.value || "").trim();
    if (!name) { input.focus(); return; }
    _pushPending({ type: "sector-add", name });
    input.value = "";
  };
  // Sector rename buttons (per row)
  document.querySelectorAll(".manage-sector-rename-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const orig = btn.dataset.orig;
      const inp = document.querySelector(`.manage-sector-rename[data-orig="${cssEscape(orig)}"]`);
      const to = (inp?.value || "").trim();
      if (!to || to === orig) return;
      _pushPending({ type: "sector-rename", from: orig, to });
      inp.value = "";
    });
  });
  // Sector remove
  document.querySelectorAll(".manage-sector-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      _pushPending({ type: "sector-remove", name });
    });
  });
  // Clear / emit buttons
  document.getElementById("manage-clear-btn").onclick = () => {
    _manageState.pending = [];
    _renderPending();
    document.getElementById("manage-output").hidden = true;
  };
  document.getElementById("manage-emit-cli").onclick  = () => _emitOutput("cli");
  document.getElementById("manage-emit-diff").onclick = () => _emitOutput("diff");
  document.getElementById("manage-gh-connect").onclick = () => _ghConnect();
  document.getElementById("manage-apply-btn").onclick  = () => _applyViaGitHub();
  _updateGhStatus();
}

function _pushPending(change) {
  _manageState.pending.push(change);
  _renderPending();
}

function _renderPending() {
  const ul = document.getElementById("pending-list");
  const countEl = document.getElementById("pending-count");
  if (!ul) return;
  countEl.textContent = `(${_manageState.pending.length})`;
  if (_manageState.pending.length === 0) {
    ul.innerHTML = `<li class="muted small">No pending changes. Use the controls above to plan adds / moves / removes.</li>`;
    return;
  }
  ul.innerHTML = _manageState.pending.map((c, i) => {
    const txt = _describePending(c);
    return `<li><span class="pending-idx">${i + 1}.</span> ${escapeText(txt)} <button class="pending-x" data-idx="${i}">×</button></li>`;
  }).join("");
  ul.querySelectorAll(".pending-x").forEach((btn) => {
    btn.addEventListener("click", () => {
      _manageState.pending.splice(Number(btn.dataset.idx), 1);
      _renderPending();
    });
  });
}

function _describePending(c) {
  switch (c.type) {
    case "add":            return `Add ${c.ticker} → ${c.sector} (${c.rating || "—"})`;
    case "remove":         return `Remove ${c.ticker}${c.reason ? ` — "${c.reason}"` : ""}`;
    case "move":           return `Move ${c.ticker}: ${c.from || "(unset)"} → ${c.to}`;
    case "rate":           return `Rate ${c.ticker} ${c.rating}`;
    case "sector-add":     return `Add sector "${c.name}"`;
    case "sector-remove":  return `Remove sector "${c.name}"`;
    case "sector-rename":  return `Rename sector "${c.from}" → "${c.to}"`;
    default:               return JSON.stringify(c);
  }
}

function _emitOutput(kind) {
  const pre = document.getElementById("manage-output");
  if (_manageState.pending.length === 0) {
    pre.textContent = "(No pending changes — make some above first.)";
    pre.hidden = false;
    return;
  }
  let text;
  if (kind === "cli") {
    const cmds = _manageState.pending.map(_toCLI).join("\n");
    text = `# Run from the repo root:\n${cmds}\n\n# Then commit + push:\ngit add -A data/ docs/data/ && git commit -m "Apply ${_manageState.pending.length} change(s) from Manage tab" && git push`;
  } else {
    const diff = _manageState.pending.map(c => ({ ...c }));
    text = `Apply these changes to data/tickers.json (and reports.json/bottlenecks.json for sector renames):\n\n${JSON.stringify(diff, null, 2)}\n\nUse scripts/manage.py for each — see CLAUDE.md → "Local management CLI".`;
  }
  pre.textContent = text;
  pre.hidden = false;
  // Copy to clipboard
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const c = document.getElementById("manage-copied");
      c.hidden = false;
      setTimeout(() => { c.hidden = true; }, 2500);
    }).catch(() => {});
  }
}

function _toCLI(c) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  switch (c.type) {
    case "add":           return `uv run python scripts/manage.py add ${c.ticker} --sector ${q(c.sector)} --rating ${c.rating || "Watch"}`;
    case "remove":        return `uv run python scripts/manage.py remove ${c.ticker}` + (c.reason ? ` --reason ${q(c.reason)}` : "");
    case "move":          return `uv run python scripts/manage.py move ${c.ticker} --to ${q(c.to)}`;
    case "rate":          return `uv run python scripts/manage.py rate ${c.ticker} --rating ${c.rating}`;
    case "sector-add":    return `uv run python scripts/manage.py sector-add ${q(c.name)}`;
    case "sector-remove": return `uv run python scripts/manage.py sector-remove ${q(c.name)}`;
    case "sector-rename": return `uv run python scripts/manage.py sector-rename ${q(c.from)} --to ${q(c.to)}`;
    default:              return `# unknown: ${JSON.stringify(c)}`;
  }
}

// ============ Manage tab: direct apply via GitHub API ============
//
// No backend required. The user pastes a fine-grained personal access token
// (this repo only; permissions: Contents RW + Actions RW) which lives in
// sessionStorage — cleared when the tab closes, never persisted to disk.
//
// "Apply via GitHub" then:
//   1. Reads the current data/tickers.json + data/removed_tickers.json
//      straight from the GitHub Contents API (NOT the possibly-stale Pages
//      copy — avoids clobbering a daily-refresh commit).
//   2. Applies the pending queue to those arrays client-side.
//   3. Commits data/tickers.json + docs/data/tickers.json (mirror) +
//      data/removed_tickers.json in ONE atomic commit via the Git trees API.
//   4. Triggers the manual-refresh workflow (workflow_dispatch) so new
//      tickers get snapshots + pillars within a few minutes.
//
// Pages redeploys from the commit, so the change is visible on next reload.

const GH_OWNER  = "jerryjianli-minibuddy";
const GH_REPO   = "stock-tracker";
const GH_BRANCH = "main";
const GH_TOKEN_KEY = "stock-tracker.ghToken"; // sessionStorage

function _ghToken() { return sessionStorage.getItem(GH_TOKEN_KEY) || ""; }

function _ghConnect() {
  let tok = null;
  try {
    tok = prompt(
      "Paste a GitHub fine-grained personal access token.\n\n" +
      "Create one at github.com → Settings → Developer settings →\n" +
      "Fine-grained tokens → Generate new token:\n" +
      "  • Repository access: Only select repositories → stock-tracker\n" +
      "  • Permissions: Contents (Read and write), Actions (Read and write)\n\n" +
      "Stored in sessionStorage only — cleared when this tab closes."
    );
  } catch {
    // Some embedded contexts disable prompt(); surface guidance instead.
    const status = document.getElementById("manage-apply-status");
    if (status) status.textContent =
      "This browser blocks prompt dialogs — run sessionStorage.setItem('stock-tracker.ghToken', '<token>') in the console instead.";
  }
  if (tok && tok.trim()) sessionStorage.setItem(GH_TOKEN_KEY, tok.trim());
  _updateGhStatus();
}

function _updateGhStatus() {
  const btn = document.getElementById("manage-gh-connect");
  if (!btn) return;
  btn.textContent = _ghToken() ? "🔑 GitHub: connected (click to replace)" : "🔑 Connect GitHub";
}

async function _gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${_ghToken()}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${opts.method || "GET"} ${path} → ${res.status} ${text.slice(0, 180)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function _ghReadJson(path) {
  try {
    const data = await _gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${GH_BRANCH}`);
    const bytes = Uint8Array.from(atob((data.content || "").replace(/\n/g, "")), (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    if (String(e).includes("404")) return null; // file doesn't exist yet
    throw e;
  }
}

// One atomic commit containing several files (Git data API: tree → commit → ref).
async function _ghCommitFiles(files, message) {
  const base = `/repos/${GH_OWNER}/${GH_REPO}`;
  const ref = await _gh(`${base}/git/ref/heads/${GH_BRANCH}`);
  const headSha = ref.object.sha;
  const headCommit = await _gh(`${base}/git/commits/${headSha}`);
  const tree = await _gh(`${base}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    }),
  });
  const commit = await _gh(`${base}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
  });
  await _gh(`${base}/git/refs/heads/${GH_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}

async function _ghTriggerRefresh(reason) {
  await _gh(`/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/manual-refresh.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: GH_BRANCH, inputs: { reason } }),
  });
}

// Apply the pending queue to in-memory copies of tickers + removed arrays.
// Mutates both arrays; returns human-readable summary lines for the commit msg.
function _applyPendingToData(tickers, removed) {
  const today = new Date().toISOString().slice(0, 10);
  const summary = [];
  const findT = (sym) => tickers.find((t) => t.ticker.toUpperCase() === String(sym).toUpperCase());
  const archive = (t, reason) => removed.push({ ...t, removed_at: today, removal_reason: reason || "(via Manage tab)" });

  for (const c of _manageState.pending) {
    switch (c.type) {
      case "add": {
        if (findT(c.ticker)) { summary.push(`skip add ${c.ticker} (already exists)`); break; }
        tickers.push({
          ticker: c.ticker.toUpperCase(),
          // Browser can't reach yfinance (CORS) — company name backfills are
          // a CLI affair; symbol placeholder is fine until then.
          company: c.ticker.toUpperCase(),
          sector: c.sector,
          thesis: "", one_line_thesis: "",
          bottlenecks_addressed: [], report_refs: [],
          catalyst: "", risks: [],
          rating: c.rating ?? "Watch",
          notes: "", date_added: today,
          binding_constraint_thesis: null,
        });
        summary.push(`add ${c.ticker} → ${c.sector}`);
        break;
      }
      case "remove": {
        const t = findT(c.ticker);
        if (!t) { summary.push(`skip remove ${c.ticker} (not found)`); break; }
        archive(t, c.reason);
        tickers.splice(tickers.indexOf(t), 1);
        summary.push(`remove ${c.ticker}`);
        break;
      }
      case "move": {
        const t = findT(c.ticker);
        if (!t) { summary.push(`skip move ${c.ticker} (not found)`); break; }
        t.sector = c.to;
        summary.push(`move ${c.ticker} → ${c.to}`);
        break;
      }
      case "rate": {
        const t = findT(c.ticker);
        if (!t) { summary.push(`skip rate ${c.ticker} (not found)`); break; }
        t.rating = c.rating;
        summary.push(`rate ${c.ticker} ${c.rating || "unrated"}`);
        break;
      }
      case "sector-add":
        // Sectors derive from tickers — nothing to write until a ticker uses it.
        summary.push(`sector "${c.name}" noted (appears once a ticker uses it)`);
        break;
      case "sector-rename": {
        let n = 0;
        for (const t of tickers) if (t.sector === c.from) { t.sector = c.to; n++; }
        summary.push(`rename sector "${c.from}" → "${c.to}" (${n})`);
        break;
      }
      case "sector-remove": {
        const inSector = tickers.filter((t) => t.sector === c.name);
        if (inSector.length === 0) { summary.push(`sector "${c.name}" already empty`); break; }
        let dest = null;
        try {
          dest = prompt(
            `Sector "${c.name}" still has ${inSector.length} ticker(s): ` +
            `${inSector.map((t) => t.ticker).join(", ")}.\n\n` +
            `Type a destination sector to MOVE them, or type DELETE to remove them all:`
          );
        } catch { /* prompt blocked → treated as cancel */ }
        if (!dest || !dest.trim()) { summary.push(`skip sector-remove "${c.name}" (cancelled)`); break; }
        if (dest.trim().toUpperCase() === "DELETE") {
          for (const t of inSector) {
            archive(t, `sector "${c.name}" deleted via Manage tab`);
            tickers.splice(tickers.indexOf(t), 1);
          }
          summary.push(`delete sector "${c.name}" + ${inSector.length} ticker(s)`);
        } else {
          for (const t of inSector) t.sector = dest.trim();
          summary.push(`remove sector "${c.name}" (moved ${inSector.length} → ${dest.trim()})`);
        }
        break;
      }
      default:
        summary.push(`skip unknown change: ${JSON.stringify(c)}`);
    }
  }
  return summary;
}

async function _applyViaGitHub() {
  const status = document.getElementById("manage-apply-status");
  const btn = document.getElementById("manage-apply-btn");
  if (_manageState.pending.length === 0) {
    status.textContent = "No pending changes — queue some adds/moves/removes above first.";
    return;
  }
  if (!_ghToken()) {
    _ghConnect();
    if (!_ghToken()) { status.textContent = "Not connected — token required to apply."; return; }
  }
  btn.disabled = true;
  try {
    status.textContent = "Reading current data from GitHub…";
    const [tickers, removed] = await Promise.all([
      _ghReadJson("data/tickers.json"),
      _ghReadJson("data/removed_tickers.json").then((r) => r || []),
    ]);
    if (!Array.isArray(tickers)) throw new Error("could not read data/tickers.json from GitHub");

    const summary = _applyPendingToData(tickers, removed);

    status.textContent = "Committing…";
    const body = JSON.stringify(tickers, null, 2) + "\n";
    const sha = await _ghCommitFiles(
      [
        { path: "data/tickers.json",        content: body },
        { path: "docs/data/tickers.json",   content: body },
        { path: "data/removed_tickers.json", content: JSON.stringify(removed, null, 2) + "\n" },
      ],
      `Manage tab: ${summary.join("; ")}`.slice(0, 300),
    );

    status.textContent = "Triggering data-refresh workflow…";
    let workflowNote = "Refresh workflow started — new tickers get full data in ~3-5 min.";
    try { await _ghTriggerRefresh("Manage tab apply"); }
    catch { workflowNote = "⚠ Could not trigger the refresh workflow (token may lack Actions permission) — new tickers will backfill on the next daily run."; }

    _manageState.pending = [];
    _renderPending();
    status.innerHTML =
      `✓ Committed <code>${escapeText(sha.slice(0, 7))}</code>. ${escapeText(workflowNote)} ` +
      `<a href="https://github.com/${GH_OWNER}/${GH_REPO}/commit/${escapeAttr(sha)}" target="_blank" rel="noopener">view commit ↗</a> · ` +
      `reload this page in ~1 min to see the change.`;
  } catch (e) {
    status.textContent = `✗ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ============ macro banner + macro view ============

function renderMacroBanner() {
  const banner = document.getElementById("macro-banner");
  if (!state.macro) { banner.hidden = true; return; }
  banner.hidden = false;
  const m = state.macro;
  const regimeClass = (m.regime || "MIXED").toLowerCase().replace("-", "-");
  const ind = m.indicators || {};

  // bull/bear classification helper
  const classify = (key) => {
    if (m.signals_bullish?.some(s => s.toLowerCase().includes(key.toLowerCase()))) return "bull";
    if (m.signals_bearish?.some(s => s.toLowerCase().includes(key.toLowerCase()))) return "bear";
    return "neut";
  };

  // Each chip carries data-glossary (term) and data-glossary-cell+value (for
  // context-aware popover that highlights the current zone in the scale).
  const chip = (cls, glossaryId, lblHtml, valHtml, contextValue) => {
    const ctx = contextValue != null
      ? ` data-glossary-cell="${glossaryId}" data-glossary-value="${contextValue}"`
      : "";
    return `<span class="indicator-chip glossary-clickable ${cls}" data-glossary="${glossaryId}"${ctx}><span class="lbl">${lblHtml}</span><span class="val">${valHtml}</span></span>`;
  };
  const chips = [];
  if (ind.vix?.current != null)
    chips.push(chip(classify("VIX"), "vix", "VIX", ind.vix.current.toFixed(1), ind.vix.current));
  if (ind.fear_greed?.value != null) {
    chips.push(chip(classify("F&G"), "fear-greed-index",
      "F&amp;G",
      `${ind.fear_greed.value.toFixed(0)} (${escapeText(ind.fear_greed.regime || "?")})`,
      ind.fear_greed.value));
  } else if (ind.fear_greed) {
    // Visible-broken state: source unavailable / endpoint error
    chips.push(`<span class="indicator-chip glossary-clickable bear" data-glossary="fear-greed-index" title="${escapeAttr(ind.fear_greed.error || 'unavailable')}"><span class="lbl">F&amp;G</span><span class="val">— unavailable</span></span>`);
  }
  if (ind.put_call?.cnn_score != null) {
    const pcZone = ind.put_call.zone || "?";
    chips.push(chip(classify("Put/Call"), "put-call-cnn",
      "P/C",
      `${ind.put_call.cnn_score.toFixed(0)} (${escapeText(pcZone)})`,
      ind.put_call.cnn_score));
  } else if (ind.put_call) {
    chips.push(`<span class="indicator-chip glossary-clickable bear" data-glossary="put-call-cnn" title="${escapeAttr(ind.put_call.error || 'unavailable')}"><span class="lbl">P/C</span><span class="val">— unavailable</span></span>`);
  }
  if (ind.net_liquidity?.delta_4w != null) {
    const sign = ind.net_liquidity.delta_4w >= 0 ? "+" : "";
    chips.push(chip(classify("Net Liq"), "net-liquidity",
      "Net Liq Δ4w",
      `${sign}$${Math.round(ind.net_liquidity.delta_4w)}B`,
      ind.net_liquidity.delta_4w));
  }
  if (ind.dxy?.current != null)
    chips.push(chip(classify("DXY"), "dxy", "DXY", ind.dxy.current.toFixed(1), ind.dxy.current));
  if (ind.credit_spread?.current_bps != null)
    chips.push(chip(classify("HY OAS"), "credit-spread", "HY OAS", `${Math.round(ind.credit_spread.current_bps)}bps`, ind.credit_spread.current_bps));
  if (ind.credit_cycle?.phase) {
    const cyclePhase = ind.credit_cycle.phase;
    const cycleClass = (
      cyclePhase === "EXPANSION"   ? "bull" :
      cyclePhase === "RECOVERY"    ? "bull" :
      cyclePhase === "LATE CYCLE"  ? "neut" :
      cyclePhase === "CONTRACTION" ? "bear" : "neut"
    );
    chips.push(`<span class="indicator-chip glossary-clickable credit-chip credit-${cyclePhase.toLowerCase().replace(' ', '-')} ${cycleClass}" data-glossary="credit-cycle"><span class="lbl">Credit</span><span class="val">${escapeText(cyclePhase)}</span></span>`);
  }
  if (ind.spy_200dma?.above_200dma != null) {
    const c = ind.spy_200dma.above_200dma ? "bull" : "bear";
    const sign = ind.spy_200dma.pct_from_200dma >= 0 ? "+" : "";
    chips.push(chip(c, "spy-200dma", "SPY vs 200DMA", `${sign}${ind.spy_200dma.pct_from_200dma.toFixed(1)}%`,
      ind.spy_200dma.above_200dma ? "true" : "false"));
  }

  banner.innerHTML = `
    <span class="regime-pill glossary-clickable ${regimeClass}" data-glossary="regime">REGIME: ${escapeText(m.regime || "?")}</span>
    ${chips.join("")}
    <span class="banner-jump muted small">click background → Macro tab</span>
  `;
  // The banner background opens the Macro tab, but clicking a chip/regime
  // pill should open the glossary popover — defer to the centralized
  // data-glossary delegator and skip the tab jump when that fires.
  banner.addEventListener("click", (e) => {
    if (e.target.closest("[data-glossary], [data-glossary-cell]")) return;
    activateTab("macro");
  });
}

function renderMacroView() {
  const detail = document.getElementById("macro-detail");
  const rot = document.getElementById("sector-rotation");
  if (!state.macro) {
    detail.innerHTML = '<div class="muted">macro.json not yet generated — run scripts/fetch_macro.py.</div>';
    rot.innerHTML = "";
    return;
  }
  const m = state.macro;
  const regimeClass = (m.regime || "MIXED").toLowerCase();

  // Regime card
  const bull = (m.signals_bullish || []).map(s => `<li>${escapeText(s)}</li>`).join("") || `<li class="muted">none</li>`;
  const bear = (m.signals_bearish || []).map(s => `<li>${escapeText(s)}</li>`).join("") || `<li class="muted">none</li>`;
  const regimeCard = `
    <article class="regime-card">
      <div class="headline">
        <span class="regime-pill glossary-clickable ${regimeClass}" data-glossary="regime">REGIME: ${escapeText(m.regime || "?")}</span>
        <span class="muted small">Last updated ${formatTimestamp(m.last_updated)}</span>
      </div>
      <p class="reasoning">${escapeText(m.regime_reasoning || "")}</p>
      <div class="signals-row">
        <div class="signals-col bull"><h4>Bullish (${(m.signals_bullish || []).length})</h4><ul>${bull}</ul></div>
        <div class="signals-col bear"><h4>Bearish (${(m.signals_bearish || []).length})</h4><ul>${bear}</ul></div>
      </div>
    </article>
  `;

  // Indicator cards
  const cards = renderIndicatorCards(m.indicators || {});

  // Credit Cycle card — synthesized phase + 6 underlying signals + cross-link
  // to the user's most-levered holdings
  const creditCard = renderCreditCycleCard(m.indicators?.credit_cycle);

  detail.innerHTML = regimeCard + creditCard + `<div id="macro-indicators-grid">${cards}</div>`;

  // Wire the cross-link clicks (ticker pills inside the credit-cycle card
  // jump to that ticker's row + open its leverage modal).
  detail.querySelectorAll("[data-credit-jump-ticker]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const sym = el.dataset.creditJumpTicker;
      jumpToTicker(sym);
      // Open leverage modal after the watchlist renders
      requestAnimationFrame(() => openLeverageModal(sym));
    })
  );

  // Sector rotation
  rot.innerHTML = renderSectorRotationTable();
  wireRotationHeaders();
}

function renderCreditCycleCard(cc) {
  if (!cc || !cc.phase) {
    return `<article class="credit-card">
      <div class="muted">Credit cycle data unavailable — run scripts/fetch_macro.py.</div>
    </article>`;
  }
  const phase = cc.phase;
  const phaseClass = phase.toLowerCase().replace(" ", "-");
  const phaseNote = ({
    "EXPANSION":   "Credit tailwind — levered growth names can work; risk-on for cyclicals.",
    "LATE CYCLE":  "Begin de-risking high-leverage names; favor net-cash balance sheets; watch refinancing calendars.",
    "CONTRACTION": "Avoid leverage entirely; net-cash companies only; distressed opportunities emerging but early.",
    "RECOVERY":    "Credit thawing — levered survivors re-rate hardest; early-cycle positioning."
  })[phase] || "";

  const ind = cc.indicators || {};
  const row = (label, value, gloss, sub) => `
    <tr>
      <td class="credit-sig-name${gloss ? " glossary-clickable" : ""}"${gloss ? ` data-glossary="${escapeAttr(gloss)}"` : ""}>
        ${escapeText(label)}${gloss ? glossaryIcon() : ""}
      </td>
      <td class="credit-sig-value num">${value}</td>
      <td class="credit-sig-sub muted small">${sub || ""}</td>
    </tr>`;

  const hy = ind.hy_oas || {};
  const igOas = ind.ig_oas || {};
  const diff = ind.hy_ig_diff || {};
  const sloos = ind.sloos || {};
  const cni = ind.cni_loans || {};
  const debt = ind.corp_debt_to_gdp || {};

  const signalsHtml = `
    <table class="credit-signals">
      <tbody>
        ${row("HY OAS",          hy.current_bps != null ? `${hy.current_bps}bps` : "—",          "credit-spread", hy.delta_4w_bps != null ? `Δ4w ${hy.delta_4w_bps >= 0 ? "+" : ""}${hy.delta_4w_bps}bps · ${escapeText(hy.regime || "")}` : "")}
        ${row("IG OAS",          igOas.current_bps != null ? `${igOas.current_bps}bps` : "—",    null,           igOas.delta_4w_bps != null ? `Δ4w ${igOas.delta_4w_bps >= 0 ? "+" : ""}${igOas.delta_4w_bps}bps · ${escapeText(igOas.regime || "")}` : "")}
        ${row("HY − IG diff",    diff.current_bps != null ? `${diff.current_bps}bps` : "—",       "hy-ig-differential", diff.delta_4w_bps != null ? `Δ4w ${diff.delta_4w_bps >= 0 ? "+" : ""}${diff.delta_4w_bps}bps · ${escapeText(diff.trend || "")}` : "")}
        ${row("Bank Lending (SLOOS)", sloos.current_pct != null ? `${sloos.current_pct >= 0 ? "+" : ""}${sloos.current_pct}%` : "—", "bank-lending-standards-sloos", sloos.delta_qoq != null ? `QoQ ${sloos.delta_qoq >= 0 ? "+" : ""}${sloos.delta_qoq} · ${escapeText(sloos.regime || "")}` : "")}
        ${row("C&I Loans",       cni.current_b != null ? `$${cni.current_b}B` : "—",             null,           cni.delta_13w_pct != null ? `13w ${cni.delta_13w_pct >= 0 ? "+" : ""}${cni.delta_13w_pct.toFixed(2)}% · ${escapeText(cni.trend || "")}` : "")}
        ${row("Corp Debt / GDP", debt.current_pct != null ? `${debt.current_pct}%` : "—",        null,           debt.delta_yoy_pct != null ? `YoY ${debt.delta_yoy_pct >= 0 ? "+" : ""}${debt.delta_yoy_pct} · ${escapeText(debt.trend || "")}` : "")}
      </tbody>
    </table>
  `;

  // Cross-link: top 5 most-levered tickers by net_debt_to_ebitda (so when the
  // cycle turns Late/Contraction, the user instantly sees which of THEIR names
  // are most exposed).
  const levered = state.rows
    .filter((r) => r.net_debt_to_ebitda != null && r.net_debt_to_ebitda > 0)
    .sort((a, b) => b.net_debt_to_ebitda - a.net_debt_to_ebitda)
    .slice(0, 5);
  const leveredHtml = levered.length === 0 ? "" : `
    <div class="credit-most-levered">
      <div class="credit-section-label">Your most levered holdings</div>
      <div class="credit-most-levered-list">
        ${levered.map(r => `
          <span class="credit-levered-chip leverage-${leverageBucket(r)}" data-credit-jump-ticker="${escapeAttr(r.ticker)}" title="${escapeAttr(`${r.sector} — click to view leverage breakdown`)}">
            <strong>${escapeText(r.ticker)}</strong> ${r.net_debt_to_ebitda.toFixed(1)}x
          </span>
        `).join("")}
      </div>
    </div>
  `;

  return `
    <article class="credit-card credit-card-${phaseClass}">
      <div class="credit-headline">
        <span class="credit-phase-pill credit-${phaseClass} glossary-clickable" data-glossary="credit-cycle">CREDIT: ${escapeText(phase)}${glossaryIcon()}</span>
        <span class="muted small">Last updated ${escapeText(formatTimestamp(cc.last_updated))}</span>
      </div>
      <p class="credit-reasoning">${escapeText(cc.reasoning || "")}</p>
      <p class="credit-positioning"><strong>Positioning:</strong> ${escapeText(phaseNote)}</p>
      <div class="credit-section-label">Underlying signals</div>
      ${signalsHtml}
      ${leveredHtml}
    </article>
  `;
}

function renderIndicatorCards(ind) {
  const cards = [];
  const tag = (sig, def="neut") => `<span class="ind-tag ${sig}">${def}</span>`;
  const tagFromRegime = (reg, bullThr, bearThr, val) => {
    if (val == null) return "neut";
    if (val < bullThr) return "bull";
    if (val > bearThr) return "bear";
    return "neut";
  };

  if (ind.vix) {
    const sig = ind.vix.current == null ? "neut" : (ind.vix.current < 20 ? "bull" : ind.vix.current > 25 ? "bear" : "neut");
    cards.push(card("VIX", "vix", fmtN(ind.vix.current, 2), ind.vix.regime, sig,
      ind.vix.sma_20d != null ? `20d SMA ${ind.vix.sma_20d.toFixed(1)}` : "",
      ind.vix.description));
  }
  if (ind.fear_greed) {
    const v = ind.fear_greed.value;
    const sig = v == null ? "neut" : (v > 50 ? "bull" : v < 30 ? "bear" : "neut");
    const broken = v == null ? " ⚠️ unavailable" : "";
    const deltaTxt = ind.fear_greed.prev_week != null ? `vs ${ind.fear_greed.prev_week.toFixed(0)} prev week` : "";
    cards.push(card(`Fear & Greed${broken}`, "fear-greed-index", fmtN(v, 0), ind.fear_greed.regime, sig, deltaTxt, ind.fear_greed.description));
  }
  if (ind.put_call) {
    const v = ind.put_call.cnn_score;
    const sig = v == null ? "neut" : (v > 75 ? "bear" : v < 25 ? "bear" : v > 55 ? "bull" : v < 45 ? "bull" : "neut");
    const broken = v == null ? " ⚠️ unavailable" : "";
    cards.push(card(`Put/Call${broken}`, "put-call-cnn", fmtN(v, 0), ind.put_call.zone, sig,
      "", ind.put_call.description));
  }
  if (ind.net_liquidity) {
    const d = ind.net_liquidity.direction;
    const sig = d === "expanding" ? "bull" : d === "contracting" ? "bear" : "neut";
    const valStr = ind.net_liquidity.current != null ? `$${(ind.net_liquidity.current / 1000).toFixed(2)}T` : "—";
    const deltas = `Δ4w ${fmtSigned(ind.net_liquidity.delta_4w, "B")} · Δ13w ${fmtSigned(ind.net_liquidity.delta_13w, "B")}`;
    cards.push(card("Net Liquidity", "net-liquidity", valStr, ind.net_liquidity.direction, sig, deltas, ind.net_liquidity.description));
  }
  if (ind.dxy) {
    const v = ind.dxy.current;
    const sig = v == null ? "neut" : (v < 100 ? "bull" : v > 105 ? "bear" : "neut");
    cards.push(card("DXY", "dxy", fmtN(v, 2), ind.dxy.regime, sig,
      ind.dxy.sma_50d != null ? `50d SMA ${ind.dxy.sma_50d.toFixed(1)}` : "",
      ind.dxy.description));
  }
  if (ind.credit_spread) {
    const bps = ind.credit_spread.current_bps;
    const sig = bps == null ? "neut" : (bps < 400 ? "bull" : bps > 500 ? "bear" : "neut");
    const deltaTxt = ind.credit_spread.delta_4w_bps != null
      ? `Δ4w ${fmtSigned(ind.credit_spread.delta_4w_bps, "bps")}` : "";
    cards.push(card("HY Credit Spread", "credit-spread", bps != null ? `${Math.round(bps)} bps` : "—",
      ind.credit_spread.regime, sig, deltaTxt, ind.credit_spread.description));
  }
  if (ind.spy_200dma) {
    const above = ind.spy_200dma.above_200dma;
    const sig = above === true ? "bull" : above === false ? "bear" : "neut";
    const pct = ind.spy_200dma.pct_from_200dma;
    const val = ind.spy_200dma.price != null ? `$${ind.spy_200dma.price.toFixed(2)}` : "—";
    const tag = above == null ? "?" : above ? "Above" : "Below";
    const deltaTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs 200DMA ($${(ind.spy_200dma.dma_200 || 0).toFixed(2)})` : "";
    cards.push(card("SPY vs 200DMA", "spy-200dma", val, tag, sig, deltaTxt, ind.spy_200dma.description));
  }
  return cards.join("");
}

function card(title, glossaryId, val, tag, sig, deltas, desc) {
  const titleAttr = glossaryId ? ` class="ind-title glossary-clickable" data-glossary="${escapeAttr(glossaryId)}"` : ` class="ind-title"`;
  const titleIcon = glossaryId ? glossaryIcon() : "";
  return `
    <article class="macro-card">
      <div${titleAttr}>${escapeText(title)}${titleIcon}</div>
      <div class="ind-val">${val}</div>
      ${tag ? `<span class="ind-tag ${sig}">${escapeText(tag)}</span>` : ""}
      ${deltas ? `<div class="ind-deltas">${escapeText(deltas)}</div>` : ""}
      ${desc ? `<div class="ind-desc">${escapeText(desc)}</div>` : ""}
    </article>
  `;
}

function renderSectorRotationTable() {
  if (!state.sectorRotation.length) {
    return '<div class="muted">No sector rotation data — fetch_macro.py needs to run.</div>';
  }
  const rows = [...state.sectorRotation];
  const key = state.rotationSortKey;
  const dir = state.rotationSortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
  const tagClass = (t) => `tag-${(t || "unknown").toLowerCase()}`;
  const sortInd = (k) => state.rotationSortKey === k ? (state.rotationSortDir === "asc" ? "sort-asc" : "sort-desc") : "";
  return `
    <h2>Sector Rotation</h2>
    <div class="muted small" style="margin-bottom:0.5rem;">Ratio vs SPY · 52-week trend. Leading = above SMA + slope up; Lagging = below + slope down.</div>
    <table class="rotation-table" id="rotation-table">
      <thead>
        <tr>
          <th data-rsort="etf" class="${sortInd('etf')}">ETF</th>
          <th data-rsort="name" class="${sortInd('name')}">Sector</th>
          <th data-rsort="mansfield_rs" class="num ${sortInd('mansfield_rs')} glossary-clickable" data-glossary="mansfield-rs">Mansfield RS${glossaryIcon()}</th>
          <th data-rsort="ratio_above_sma" class="${sortInd('ratio_above_sma')} glossary-clickable" data-glossary="ratio-vs-spy">Above 52w SMA?${glossaryIcon()}</th>
          <th data-rsort="ratio_slope_30d" class="num ${sortInd('ratio_slope_30d')} glossary-clickable" data-glossary="ratio-slope-30d">30d Slope${glossaryIcon()}</th>
          <th data-rsort="regime_tag" class="${sortInd('regime_tag')} glossary-clickable" data-glossary="sector-rotation">Tag${glossaryIcon()}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(s => `
          <tr>
            <td><strong>${escapeText(s.etf)}</strong></td>
            <td>${escapeText(s.name)}</td>
            <td class="num mansfield-cell ${mansfieldClass(s.mansfield_rs)}">${fmtMansfield(s.mansfield_rs)}</td>
            <td class="${above200Class(s.ratio_above_sma)}">${ratioAboveSmaText(s.ratio_above_sma)}</td>
            <td class="num">${fmtPct((s.ratio_slope_30d || 0) / 100, true)}</td>
            <td><span class="tag-pill ${tagClass(s.regime_tag)}">${escapeText(s.regime_tag || "—")}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function wireRotationHeaders() {
  document.querySelectorAll('#rotation-table thead th[data-rsort]').forEach(th => {
    th.addEventListener("click", (e) => {
      // ⓘ icon clicks go to the glossary delegator; everything else sorts.
      if (e.target.closest(".glossary-info")) return;
      const key = th.dataset.rsort;
      if (state.rotationSortKey === key) {
        state.rotationSortDir = state.rotationSortDir === "asc" ? "desc" : "asc";
      } else {
        state.rotationSortKey = key;
        state.rotationSortDir = ["mansfield_rs", "ratio_slope_30d"].includes(key) ? "desc" : "asc";
      }
      document.getElementById("sector-rotation").innerHTML = renderSectorRotationTable();
      wireRotationHeaders();
    });
  });
}

// ============ sparkline ============

function miniSparkline(values, w = 60, h = 18) {
  if (!values || values.length < 2) return `<span class="muted small">—</span>`;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = h - 1 - ((v - min) / range) * (h - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "var(--green)" : "var(--red)";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="ratio trend"><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function largeSparklineWithSMA(values, smaValue, w = 320, h = 72) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values, smaValue ?? Infinity);
  const max = Math.max(...values, smaValue ?? -Infinity);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pad = 4;
  const innerH = h - 2 * pad;
  const ratioPts = values.map((v, i) => {
    const x = i * step;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "var(--green)" : "var(--red)";

  let smaLine = "";
  if (smaValue != null && !isNaN(smaValue)) {
    const y = pad + innerH - ((smaValue - min) / range) * innerH;
    smaLine = `<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3"/>`;
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="ratio vs SPY">
    ${smaLine}
    <polyline points="${ratioPts}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function sparkline(prices, w = 240, h = 56) {
  if (!prices || prices.length < 2) return "";
  const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
  const step = w / (prices.length - 1);
  const pts = prices.map((p, i) => {
    const x = i * step;
    const y = (h - 4) - ((p - min) / range) * (h - 8) + 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = prices[prices.length - 1] >= prices[0];
  const stroke = up ? "var(--green)" : "var(--red)";
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="price sparkline">
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// ============ formatters ============

function fmtPrice(v) { return v == null ? "—" : `$${v.toFixed(2)}`; }
function fmtCap(v) {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}
function fmtPE(v) { return v == null ? "—" : `${v.toFixed(1)}x`; }
function fmtX(v) { return v == null ? "—" : `${v.toFixed(1)}x`; }
function fmtEvEbitda(v) {
  if (v == null) return "—";
  if (v < 0) return `<span class="muted" title="negative EBITDA">n/m</span>`;
  return `${v.toFixed(1)}x`;
}
function fmtN(v, d = 2) { return v == null ? "—" : Number(v).toFixed(d); }
function fmtMansfield(v) {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}`;
}
function fmtSigned(v, unit = "") {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${Math.round(v)}${unit}`;
}
function fmtPct(v, signed = false) {
  if (v == null) return "—";
  const p = v * 100;
  if (signed) return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  return `${p.toFixed(1)}%`;
}
function revGrowthClass(v) {
  if (v == null) return "";
  if (v > 0.25) return "cell-green";
  if (v < 0) return "cell-red";
  return "";
}
function pctFromHighClass(v) {
  if (v == null) return "";
  if (v <= 0.15) return "cell-green";
  if (v <= 0.25) return "cell-yellow";
  return "cell-red";
}
function above200Text(v) { return v == null ? "—" : v ? "Yes" : "No"; }
function above200Class(v) { return v == null ? "" : v ? "cell-green" : "cell-red"; }
function ratioAboveSmaText(v) { return v == null ? "—" : v ? "Yes" : "No"; }
function mansfieldClass(v) {
  if (v == null) return "";
  if (v >= 20) return "mansfield-3";
  if (v >= 5) return "mansfield-2";
  if (v >= 0) return "mansfield-1";
  if (v >= -5) return "mansfield-n1";
  if (v >= -20) return "mansfield-n2";
  return "mansfield-n3";
}
// ============ 5-Pillar framework UI ============
//
// Pillars data model (per ticker, populated by scripts/synthesize_pillars.py):
//   five_pillars: {moat, tam, founder_led, capital_efficiency, valuation_discipline}
//     where each pillar = {pass: true|false|null, evidence, metric_value,
//                          metric_label, metric_threshold}
//   pillars_passed: int (count of pass=true)
//   pillars_total:  5
//   pillar_eligibility: "CORE-eligible" | "SWING-eligible" | "PASS"
//   binding_constraint_thesis: null | string (manually supplied — never auto-filled)

const PILLAR_ORDER = ["moat", "tam", "founder_led", "capital_efficiency", "valuation_discipline"];
const PILLAR_LABEL = {
  moat: "Moat",
  tam: "TAM",
  founder_led: "Founder-led",
  capital_efficiency: "Capital Efficiency",
  valuation_discipline: "Valuation Discipline",
};
// Glossary id mapping for pillar headers (clickable from inside the modal)
const PILLAR_GLOSSARY = {
  moat: "pillar-moat",
  tam: "pillar-tam",
  founder_led: "pillar-founder-led",
  capital_efficiency: "pillar-capital-efficiency",
  valuation_discipline: "pillar-valuation-discipline",
};

function pillarDotsClass(passed) {
  if (passed >= 5) return "pillars-5";
  if (passed === 4) return "pillars-4";
  if (passed === 3) return "pillars-3";
  return "pillars-low";
}

function pillarDots(r) {
  const pillars = r.five_pillars;
  if (!pillars) return `<span class="muted">—</span>`;
  const passed = r.pillars_passed ?? 0;
  const cls = pillarDotsClass(passed);
  const dots = PILLAR_ORDER.map((id) => {
    const p = pillars[id];
    if (!p) return `<span class="pdot pdot-fail">○</span>`;
    if (p.pass === true)  return `<span class="pdot pdot-pass">●</span>`;
    if (p.pass === false) return `<span class="pdot pdot-fail">○</span>`;
    return `<span class="pdot pdot-unknown">◐</span>`; // null = unknown
  }).join("");
  const bindingMark = r.binding_constraint_thesis ? `<span class="pdot-binding" title="Binding constraint thesis supplied">★</span>` : "";
  return `<span class="pillars-strip ${cls}">${dots} <span class="pillars-count">${passed}/5</span>${bindingMark}</span>`;
}

let _pillarModalWired = false;
function wirePillarModalOnce() {
  if (_pillarModalWired) return;
  _pillarModalWired = true;
  document.querySelectorAll("#pillar-modal [data-close-pillar]").forEach((el) =>
    el.addEventListener("click", closePillarModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePillarModal();
  });
}

function openPillarModal(ticker) {
  wirePillarModalOnce();
  const t = state.tickerByT.get(String(ticker).toUpperCase());
  if (!t) return;
  const modal = document.getElementById("pillar-modal");
  modal.dataset.currentTicker = t.ticker;

  document.getElementById("pillar-modal-title").textContent = `${t.ticker} — ${t.company || ""}`;
  document.getElementById("pillar-modal-dots").innerHTML = pillarDots(t);
  const elig = t.pillar_eligibility || "—";
  const hasBinding = !!t.binding_constraint_thesis;
  const eligLabel = elig === "CORE-eligible" && hasBinding ? "CORE (binding thesis supplied)" : elig;
  document.getElementById("pillar-modal-elig").textContent = `Eligibility: ${eligLabel}`;

  const body = document.getElementById("pillar-modal-body");
  if (!t.five_pillars) {
    body.innerHTML = `<div class="muted">No pillar data for ${escapeText(t.ticker)} yet. Run <code>scripts/synthesize_pillars.py</code>.</div>`;
  } else {
    body.innerHTML = renderPillarModalBody(t);
  }

  // Show or hide the "+ add binding thesis" button per current state
  const addBtn = document.getElementById("pillar-modal-add-binding");
  addBtn.textContent = hasBinding
    ? "Copy override binding-thesis snippet"
    : "+ Add binding constraint thesis…";
  addBtn.classList.remove("copied");
  addBtn.onclick = () => copyBindingThesisSnippet(t, addBtn);

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function closePillarModal() {
  const modal = document.getElementById("pillar-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.currentTicker;
}

function renderPillarModalBody(t) {
  const thesis = t.one_line_thesis || t.thesis || "";
  const pillars = t.five_pillars;
  const cards = PILLAR_ORDER.map((id) => {
    const p = pillars[id];
    if (!p) return "";
    const pass = p.pass;
    const pillarCls = pass === true ? "pillar-pass" : pass === false ? "pillar-fail" : "pillar-unknown";
    const verdict = pass === true ? "PASS" : pass === false ? "FAIL" : "UNKNOWN";
    const dot = pass === true ? "●" : pass === false ? "○" : "◐";
    const metric = p.metric_value != null
      ? `<div class="pillar-metric"><strong>${escapeText(p.metric_label || "")}:</strong> ${escapeText(formatPillarMetric(id, p.metric_value))} <span class="muted small">(threshold ${escapeText(p.metric_threshold || "")})</span></div>`
      : `<div class="pillar-metric muted small">${escapeText(p.metric_label || "")} — no value (threshold ${escapeText(p.metric_threshold || "")})</div>`;
    const gid = PILLAR_GLOSSARY[id];
    return `
      <article class="pillar-card ${pillarCls}">
        <header class="pillar-card-header">
          <span class="pillar-dot">${dot}</span>
          <span class="pillar-name glossary-clickable" data-glossary="${escapeAttr(gid)}">${escapeText(PILLAR_LABEL[id])}<span class="glossary-info" aria-hidden="true">ⓘ</span></span>
          <span class="pillar-verdict">${verdict}</span>
        </header>
        ${metric}
        <div class="pillar-evidence">${escapeText(p.evidence || "")}</div>
      </article>
    `;
  }).join("");

  const risks = Array.isArray(t.risks) ? t.risks.filter((s) => s && s.trim()) : [];
  const risksHtml = risks.length
    ? `<ul class="pillar-risks">${risks.map((r) => `<li>${escapeText(r)}</li>`).join("")}</ul>`
    : `<div class="muted small">No risks recorded — add some to <code>tickers.json[ticker].risks</code>.</div>`;

  const bindingHtml = t.binding_constraint_thesis
    ? `<div class="binding-thesis-text">${escapeText(t.binding_constraint_thesis)}</div>`
    : `<div class="binding-thesis-missing">⚠ Required for CORE tagging — not yet supplied. Click the button below to copy a paste-ready snippet, edit it, then commit to <code>tickers.json</code>.</div>`;

  return `
    ${thesis ? `<div class="pillar-section pillar-thesis">
      <div class="pillar-section-label">One-line thesis</div>
      <div>${escapeText(thesis)}</div>
    </div>` : ""}
    <div class="pillar-section">
      <div class="pillar-section-label glossary-clickable" data-glossary="five-pillars">5 Pillars<span class="glossary-info" aria-hidden="true">ⓘ</span></div>
      <div class="pillar-grid">${cards}</div>
    </div>
    <div class="pillar-section">
      <div class="pillar-section-label">Risks</div>
      ${risksHtml}
    </div>
    <div class="pillar-section">
      <div class="pillar-section-label glossary-clickable" data-glossary="binding-constraint-thesis">Binding Constraint Thesis (Section 7)<span class="glossary-info" aria-hidden="true">ⓘ</span></div>
      ${bindingHtml}
    </div>
  `;
}

// Format a pillar metric value for display per its type.
function formatPillarMetric(pillarId, value) {
  if (value == null) return "—";
  switch (pillarId) {
    case "moat":
    case "tam":
      return `${(value * 100).toFixed(1)}%`;
    case "capital_efficiency":
      return value.toFixed(1);
    case "valuation_discipline":
      return value.toFixed(2);
    default:
      return String(value);
  }
}

function copyBindingThesisSnippet(t, btn) {
  // Paste-ready JSON fragment for tickers.json — sets the binding-constraint
  // thesis. The placeholder TEXT prompts the user to actually write a
  // sentence; the JSON shape itself is correct so paste-and-edit works.
  const snippet = {
    ticker: t.ticker,
    binding_constraint_thesis: t.binding_constraint_thesis ||
      `<edit me — one sentence answering: what's the binding constraint on this theme being delivered at scale in 18-36 months, and is ${t.ticker} the chokepoint or merely a beneficiary?>`,
  };
  const text = JSON.stringify(snippet, null, 2);
  const onOk = () => {
    btn.classList.add("copied");
    btn.textContent = "Copied — edit then paste into tickers.json";
  };
  const onFail = () => {
    btn.textContent = "Copy failed (use right-click)";
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onOk, onFail);
  } else {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      onOk();
    } catch { onFail(); }
  }
}

// ============ Leverage column + modal ============
//
// Headline metric is net_debt_to_ebitda; cash-burners show runway in
// quarters instead. The cell colour-codes by zone (blue net-cash, green
// low, lime moderate, yellow elevated, orange high, red danger/burning).
// Clicking opens a modal with the full debt breakdown.

function leverageBucket(r) {
  const nde = r.net_debt_to_ebitda;
  const runway = r.cash_runway_quarters;
  const ebitda = r.ebitda;
  if (nde == null) {
    if (runway != null) return "burning";    // unprofitable cash-burner
    if (ebitda != null && ebitda <= 0) return "burning";
    return "unknown";
  }
  if (nde < 0)    return "net_cash";
  if (nde < 1.5)  return "low";
  if (nde < 3)    return "moderate";
  if (nde < 4.5)  return "elevated";
  if (nde < 6)    return "high";
  return "danger";
}

function leverageCellClass(r) {
  return `leverage-${leverageBucket(r)}`;
}

function leverageCellText(r) {
  const bucket = leverageBucket(r);
  const nde = r.net_debt_to_ebitda;
  const runway = r.cash_runway_quarters;
  if (bucket === "net_cash") return `<span class="lev-label">Net Cash</span>`;
  if (bucket === "burning") {
    if (runway != null) return `<span class="lev-label">${runway.toFixed(1)}q runway</span>`;
    return `<span class="lev-label">N/A — burning</span>`;
  }
  if (bucket === "unknown") return `<span class="muted">—</span>`;
  return `<span class="lev-num">${nde.toFixed(1)}x</span>`;
}

function fmtMoney(v) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${v < 0 ? "−" : ""}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${v < 0 ? "−" : ""}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${v < 0 ? "−" : ""}$${(abs / 1e6).toFixed(0)}M`;
  return `${v < 0 ? "−" : ""}$${abs.toLocaleString()}`;
}

let _leverageModalWired = false;
function wireLeverageModalOnce() {
  if (_leverageModalWired) return;
  _leverageModalWired = true;
  document.querySelectorAll("#leverage-modal [data-close-leverage]").forEach((el) =>
    el.addEventListener("click", closeLeverageModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLeverageModal();
  });
}

function openLeverageModal(ticker) {
  wireLeverageModalOnce();
  const r = state.tickerByT.get(String(ticker).toUpperCase());
  if (!r) return;
  // Merge in snapshot fields if not already on the joined row (defensive)
  const snap = state.snapshots?.[r.ticker.toUpperCase()] || {};
  const data = { ...r, ...snap };

  const bucket = leverageBucket(data);
  const badgeText = ({
    net_cash: "Net Cash", low: "Low Leverage", moderate: "Moderate",
    elevated: "Elevated", high: "High", danger: "Dangerous",
    burning: "Burning Cash", unknown: "Insufficient Data"
  })[bucket];

  document.getElementById("leverage-modal-title").textContent = `${data.ticker} — ${data.company || ""}`;
  document.getElementById("leverage-modal-badge").innerHTML =
    `<span class="leverage-badge leverage-${bucket}">${escapeText(badgeText)}</span>`;
  document.getElementById("leverage-modal-body").innerHTML = renderLeverageModalBody(data);
  const modal = document.getElementById("leverage-modal");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function closeLeverageModal() {
  const modal = document.getElementById("leverage-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

function renderLeverageModalBody(d) {
  const row = (label, value, gloss) => `
    <tr>
      <td class="lev-row-label${gloss ? " glossary-clickable" : ""}"${gloss ? ` data-glossary="${escapeAttr(gloss)}"` : ""}>
        ${escapeText(label)}${gloss ? glossaryIcon() : ""}
      </td>
      <td class="lev-row-value num">${value}</td>
    </tr>`;

  const ndeText = d.net_debt_to_ebitda == null
    ? '<span class="muted">— (EBITDA missing or ≤ 0)</span>'
    : `${d.net_debt_to_ebitda.toFixed(2)}x`;
  const icText = d.interest_coverage == null
    ? '<span class="muted">—</span>'
    : (d.interest_coverage > 1000 ? '>1000x (net cash, immaterial)' : `${d.interest_coverage.toFixed(1)}x`);
  const runwayText = d.cash_runway_quarters == null
    ? '<span class="muted">— (positive FCF; not applicable)</span>'
    : `${d.cash_runway_quarters.toFixed(1)} quarters`;

  // Why-this-matters note keyed to credit cycle phase if available
  const phase = state.macro?.indicators?.credit_cycle?.phase;
  const phaseNote = ({
    "EXPANSION":   "Credit is flowing. Even elevated-leverage names can work — refinancing cost is low. Lean offensive.",
    "LATE CYCLE":  "Banks tightening. Begin de-risking names above 4× net-debt/EBITDA. Net-cash balance sheets get a premium.",
    "CONTRACTION": "Credit crunch. Avoid leverage entirely. Net-cash companies only — levered names compound their problems through refinancing windows.",
    "RECOVERY":    "Credit thawing. Levered survivors re-rate fastest. Highest beta is in the names that survived contraction with leverage intact."
  })[phase] || null;

  return `
    <div class="lev-section">
      <div class="lev-section-label">Headline leverage</div>
      <table class="lev-table">
        <tbody>
          ${row("Net Debt / EBITDA",      ndeText,                         "net-debt-to-ebitda")}
          ${row("Debt / Equity",          d.debt_to_equity == null ? "—" : `${d.debt_to_equity.toFixed(2)}x`)}
          ${row("Interest Coverage",      icText,                          "interest-coverage")}
          ${row("Current Ratio",          d.current_ratio == null ? "—" : d.current_ratio.toFixed(2))}
        </tbody>
      </table>
    </div>
    <div class="lev-section">
      <div class="lev-section-label">Balance-sheet detail</div>
      <table class="lev-table">
        <tbody>
          ${row("Total Debt",   fmtMoney(d.total_debt))}
          ${row("Total Cash",   fmtMoney(d.total_cash))}
          ${row("Net Debt",     fmtMoney(d.net_debt))}
          ${row("EBITDA (TTM)", fmtMoney(d.ebitda))}
          ${row("FCF (TTM)",    fmtMoney(d.fcf_ttm))}
          ${row("Cash Runway",  runwayText,                                "cash-runway")}
        </tbody>
      </table>
    </div>
    <div class="lev-section lev-why">
      <div class="lev-section-label glossary-clickable" data-glossary="leverage">Why this matters${glossaryIcon()}</div>
      <p>In a rising-rate or risk-off regime, highly levered companies face refinancing risk: when their debt matures, they must roll it at higher rates, compressing margins or forcing dilution. Net-debt/EBITDA above 4-5× with weak interest coverage is where companies break in a downturn. Net-cash companies can play offense while levered peers play defense.</p>
      ${phase ? `<p class="lev-phase-note"><strong>Current credit cycle: ${escapeText(phase)}.</strong> ${escapeText(phaseNote || "")}</p>` : ""}
    </div>
  `;
}

function ratingPill(r, ticker) {
  const hasReasoning = ticker && state.tickerByT.get(ticker)?.rating_reasoning;
  const dataAttr = hasReasoning
    ? ` data-rating-ticker="${escapeAttr(ticker)}" title="View reasoning"`
    : "";
  if (!r) {
    const cls = hasReasoning ? "muted rating-clickable" : "muted";
    return `<span class="${cls}"${dataAttr}>—</span>`;
  }
  const baseCls = { Strong: "pill-green", Watch: "pill-yellow", Pass: "pill-gray" }[r] || "pill-gray";
  const cls = hasReasoning ? `pill ${baseCls} rating-clickable` : `pill ${baseCls}`;
  return `<span class="${cls}"${dataAttr}>${escapeText(r)}</span>`;
}

// ============ helpers ============

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function escapeText(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeText(s); }
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, "\\$&");
}
async function fetchJSON(path, fallback) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  try { return await r.json(); } catch { return fallback; }
}

// ============ theme ============

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
  syncThemeToggle();
}
function toggleTheme() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("theme", "light");
  }
  syncThemeToggle();
}
function syncThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  btn.textContent = isLight ? "☾" : "☼";
}
