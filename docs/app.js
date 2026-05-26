// stock-tracker dashboard — vanilla JS, no build step.
// Three views (Watchlist / Reports / Bottlenecks) sharing one fetched data set
// joined client-side. Cross-navigation: clicking a ticker pill anywhere jumps
// to the watchlist row; clicking a bottleneck pill anywhere jumps to its card.

const DATA_PATH = "./data";
const STORAGE_KEYS = {
  activeTab:        "stock-tracker.activeTab",
  tabSorts:         "stock-tracker.tabSorts",      // per-tab column sort: { tabKey: {col, dir} }
  ratingFilter:     "stock-tracker.ratingFilter",
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
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.tabSorts) || "{}");
    if (raw && typeof raw === "object") state.tabSorts = raw;
  } catch { /* ignore */ }
  document.getElementById("rating-filter").value = state.ratingFilter;
  document.getElementById("rating-filter").addEventListener("change", (e) => {
    state.ratingFilter = e.target.value;
    localStorage.setItem(STORAGE_KEYS.ratingFilter, state.ratingFilter);
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
  }

  requestAnimationFrame(() => applyScrollTarget());
}

function restoreActiveTab() {
  const saved = localStorage.getItem(STORAGE_KEYS.activeTab);
  if (!saved) return "all";
  if (["all", "reports", "bottlenecks", "glossary", "macro"].includes(saved)) return saved;
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

  // Filter: active tab restricts to one sector, rating filter applies, search hides.
  let rows = state.rows;
  if (!showSector) rows = rows.filter((r) => r.sector === state.sector);
  rows = rows.filter((r) => passesRatingFilter(r.rating));
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
      const t = tr.dataset.ticker;
      if (state.expanded.has(t)) state.expanded.delete(t);
      else state.expanded.add(t);
      renderWatchlist();
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
  const colspan = showSector ? 20 : 19;
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
    const src = ind.fear_greed.source?.includes("CRYPTO") ? " ⚠️" : "";
    chips.push(chip(classify("F&G"), "fear-greed-index",
      `F&amp;G${src}`,
      `${ind.fear_greed.value.toFixed(0)} (${escapeText(ind.fear_greed.regime || "?")})`,
      ind.fear_greed.value));
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

  detail.innerHTML = regimeCard + `<div id="macro-indicators-grid">${cards}</div>`;

  // Sector rotation
  rot.innerHTML = renderSectorRotationTable();
  wireRotationHeaders();
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
    const cnnFallback = ind.fear_greed.source?.includes("CRYPTO") ? " ⚠️ fallback" : "";
    const deltaTxt = ind.fear_greed.prev_week != null ? `vs ${ind.fear_greed.prev_week.toFixed(0)} prev week` : "";
    cards.push(card(`Fear & Greed${cnnFallback}`, "fear-greed-index", fmtN(v, 0), ind.fear_greed.regime, sig, deltaTxt, ind.fear_greed.description));
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
