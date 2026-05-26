// stock-tracker dashboard — vanilla JS, no build step.
// Three views (Watchlist / Reports / Bottlenecks) sharing one fetched data set
// joined client-side. Cross-navigation: clicking a ticker pill anywhere jumps
// to the watchlist row; clicking a bottleneck pill anywhere jumps to its card.

const DATA_PATH = "./data";
const STORAGE_KEY = "stock-tracker.activeTab";
const NUMERIC_KEYS = new Set([
  "price", "market_cap", "pe_forward", "pe_trailing",
  "ps_ratio", "ev_to_sales", "ev_to_ebitda", "peg_ratio",
  "rev_growth_yoy", "eps_growth_yoy", "gross_margin", "op_margin",
  "fcf_ttm", "debt_to_equity",
  "dma_50", "dma_150", "dma_200",
  "high_52w", "low_52w", "volume_avg_30d",
  "rs_proxy", "pct_from_high",
  "mansfield_rs", "ratio_slope_30d", "ratio_vs_spy", "ratio_sma_52w",
]);

const state = {
  // raw
  tickers: [], snapshots: {}, history: {}, reports: [], bottlenecks: [],
  macro: null, sectorRotation: [],
  // joined rows (watchlist)
  rows: [],
  // lookups
  bottleneckById: new Map(),
  reportById: new Map(),
  tickerByT: new Map(),
  // ui state
  view: "watchlist",
  sector: "All", search: "",
  sortKey: "ticker", sortDir: "asc",
  expanded: new Set(),
  scrollTarget: null,    // {kind: "ticker"|"bottleneck", id: string}
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

  try {
    const [tickers, snapshots, history, reports, bottlenecks, macro, rotation] = await Promise.all([
      fetchJSON(`${DATA_PATH}/tickers.json`, []),
      fetchJSON(`${DATA_PATH}/snapshots.json`, { last_updated: null, data: {} }),
      fetchJSON(`${DATA_PATH}/history.json`, {}),
      fetchJSON(`${DATA_PATH}/reports.json`, []),
      fetchJSON(`${DATA_PATH}/bottlenecks.json`, []),
      fetchJSON(`${DATA_PATH}/macro.json`, null),
      fetchJSON(`${DATA_PATH}/sector_rotation.json`, { sectors: [] }),
    ]);
    state.tickers = Array.isArray(tickers) ? tickers : [];
    state.snapshots = snapshots.data || {};
    state.history = history || {};
    state.reports = Array.isArray(reports) ? reports : [];
    state.bottlenecks = Array.isArray(bottlenecks) ? bottlenecks : [];
    state.macro = macro;
    state.sectorRotation = (rotation && Array.isArray(rotation.sectors)) ? rotation.sectors : [];
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
  wireSortHeaders();
  renderReports();
  renderBottlenecks();
  renderMacroView();
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
// Tab identifiers are flat strings used in DOM data-tab attributes and as the
// localStorage value:
//   'all'                   → state.view='watchlist', state.sector='All'
//   'sector:<name>'         → state.view='watchlist', state.sector=<name>
//   'reports'               → state.view='reports'
//   'bottlenecks'           → state.view='bottlenecks'

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
    macroTab,
    sectorButtons,
    `<span class="tab-divider" aria-hidden="true"></span>`,
    `<button class="tab" data-tab="reports">Reports <span class="count">(${state.reports.length})</span></button>`,
    `<button class="tab" data-tab="bottlenecks">Bottlenecks <span class="count">(${state.bottlenecks.length})</span></button>`,
  ].join("");

  nav.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab))
  );
}

function activeTabKey() {
  if (state.view === "reports") return "reports";
  if (state.view === "bottlenecks") return "bottlenecks";
  if (state.view === "macro") return "macro";
  if (state.sector === "All") return "all";
  return `sector:${state.sector}`;
}

function highlightActiveTab() {
  const key = activeTabKey();
  document.querySelectorAll("#tabs .tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === key)
  );
}

function activateTab(tabId) {
  // Translate tab id → state
  if (tabId === "reports") {
    state.view = "reports";
  } else if (tabId === "bottlenecks") {
    state.view = "bottlenecks";
  } else if (tabId === "macro") {
    state.view = "macro";
  } else if (tabId === "all") {
    state.view = "watchlist";
    state.sector = "All";
  } else if (typeof tabId === "string" && tabId.startsWith("sector:")) {
    state.view = "watchlist";
    state.sector = tabId.slice(7);
  } else {
    return; // unknown tab id — ignore
  }

  // Persist
  localStorage.setItem(STORAGE_KEY, activeTabKey());

  // Show/hide view sections
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
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return "all";
  if (saved === "all" || saved === "reports" || saved === "bottlenecks" || saved === "macro") return saved;
  if (saved.startsWith("sector:")) {
    const s = saved.slice(7);
    if (getSectorsInOrder(state.tickers).includes(s)) return saved;
  }
  return "all"; // fallback when persisted sector no longer exists
}

function jumpToTicker(t) {
  state.expanded.add(t);
  state.scrollTarget = { kind: "ticker", id: t };
  state.search = "";
  const searchEl = document.getElementById("search");
  if (searchEl) searchEl.value = "";
  activateTab("all");
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

function wireSortHeaders() {
  document.querySelectorAll("#watchlist thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = NUMERIC_KEYS.has(key) ? "desc" : "asc";
      }
      renderWatchlist();
    });
  });
}

function renderWatchlist() {
  let rows = state.rows;
  if (state.sector !== "All") rows = rows.filter((r) => r.sector === state.sector);
  if (state.search) {
    const q = state.search;
    rows = rows.filter(
      (r) => r.ticker.toLowerCase().includes(q) || (r.company || "").toLowerCase().includes(q)
    );
  }
  const key = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === "above_200dma") { va = va === null ? null : (va ? 1 : 0); vb = vb === null ? null : (vb ? 1 : 0); }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  document.querySelectorAll("#watchlist thead th").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  // Show the Sector column only when viewing All
  document.getElementById("watchlist").classList.toggle("with-sector", state.sector === "All");

  const tbody = document.querySelector("#watchlist tbody");
  const empty = document.getElementById("empty-watchlist");
  if (rows.length === 0) { tbody.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;

  tbody.innerHTML = rows.map((r) => {
    const exp = state.expanded.has(r.ticker);
    return `
      <tr class="data-row ${exp ? "expanded" : ""}" data-ticker="${escapeAttr(r.ticker)}">
        <td class="ticker">${escapeText(r.ticker)}<span class="caret">${exp ? "▾" : "▸"}</span></td>
        <td>${escapeText(r.company || "")}</td>
        <td class="sector-col">${escapeText(r.sector || "")}</td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="num">${fmtCap(r.market_cap)}</td>
        <td class="num">${fmtPE(r.pe_forward)}</td>
        <td class="num ${revGrowthClass(r.rev_growth_yoy)}">${fmtPct(r.rev_growth_yoy, true)}</td>
        <td class="num">${fmtPct(r.eps_growth_yoy, true)}</td>
        <td class="num">${fmtPct(r.gross_margin)}</td>
        <td class="num ${pctFromHighClass(r.pct_from_high)}">${fmtPct(r.pct_from_high)}</td>
        <td class="${above200Class(r.above_200dma)}">${above200Text(r.above_200dma)}</td>
        <td class="num">${fmtPct(r.rs_proxy, true)}</td>
        <td class="num">${fmtX(r.ps_ratio)}</td>
        <td class="num">${fmtX(r.ev_to_sales)}</td>
        <td class="num">${fmtEvEbitda(r.ev_to_ebitda)}</td>
        <td class="num mansfield-cell ${mansfieldClass(r.mansfield_rs)}">${fmtMansfield(r.mansfield_rs)}</td>
        <td class="${above200Class(r.ratio_above_sma)}">${ratioAboveSmaText(r.ratio_above_sma)}</td>
        <td class="ratio-trend-cell">${miniSparkline(r.ratio_history_90d || [])}</td>
        <td>${ratingPill(r.rating, r.ticker)}</td>
      </tr>
      ${exp ? `<tr class="detail-row"><td colspan="19">${renderTickerDetail(r)}</td></tr>` : ""}
    `;
  }).join("");

  tbody.querySelectorAll(".data-row").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      // ignore clicks on pills / rating cells inside the row (only the row itself toggles)
      if (e.target.closest(".pill.clickable")) return;
      if (e.target.closest(".rating-clickable")) return;
      const t = tr.dataset.ticker;
      if (state.expanded.has(t)) state.expanded.delete(t);
      else state.expanded.add(t);
      renderWatchlist();
    });
  });
  wirePillClicks(tbody);
  wireRatingClicks(tbody);
}

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

  const chips = [];
  if (ind.vix?.current != null)
    chips.push(`<span class="indicator-chip ${classify("VIX")}"><span class="lbl">VIX</span><span class="val">${ind.vix.current.toFixed(1)}</span></span>`);
  if (ind.fear_greed?.value != null) {
    const src = ind.fear_greed.source?.includes("CRYPTO") ? " ⚠️" : "";
    chips.push(`<span class="indicator-chip ${classify("F&G")}"><span class="lbl">F&amp;G${src}</span><span class="val">${ind.fear_greed.value.toFixed(0)} (${escapeText(ind.fear_greed.regime || "?")})</span></span>`);
  }
  if (ind.net_liquidity?.delta_4w != null) {
    const sign = ind.net_liquidity.delta_4w >= 0 ? "+" : "";
    chips.push(`<span class="indicator-chip ${classify("Net Liq")}"><span class="lbl">Net Liq Δ4w</span><span class="val">${sign}$${Math.round(ind.net_liquidity.delta_4w)}B</span></span>`);
  }
  if (ind.dxy?.current != null)
    chips.push(`<span class="indicator-chip ${classify("DXY")}"><span class="lbl">DXY</span><span class="val">${ind.dxy.current.toFixed(1)}</span></span>`);
  if (ind.credit_spread?.current_bps != null)
    chips.push(`<span class="indicator-chip ${classify("HY OAS")}"><span class="lbl">HY OAS</span><span class="val">${Math.round(ind.credit_spread.current_bps)}bps</span></span>`);
  if (ind.spy_200dma?.above_200dma != null) {
    const c = ind.spy_200dma.above_200dma ? "bull" : "bear";
    const sign = ind.spy_200dma.pct_from_200dma >= 0 ? "+" : "";
    chips.push(`<span class="indicator-chip ${c}"><span class="lbl">SPY vs 200DMA</span><span class="val">${sign}${ind.spy_200dma.pct_from_200dma.toFixed(1)}%</span></span>`);
  }

  banner.innerHTML = `
    <span class="regime-pill ${regimeClass}">REGIME: ${escapeText(m.regime || "?")}</span>
    ${chips.join("")}
    <span class="muted small" style="margin-left:auto; flex-shrink:0;">click → Macro tab</span>
  `;
  banner.addEventListener("click", () => activateTab("macro"), { once: false });
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
        <span class="regime-pill ${regimeClass}">REGIME: ${escapeText(m.regime || "?")}</span>
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
    cards.push(card("VIX", fmtN(ind.vix.current, 2), ind.vix.regime, sig,
      ind.vix.sma_20d != null ? `20d SMA ${ind.vix.sma_20d.toFixed(1)}` : "",
      ind.vix.description));
  }
  if (ind.fear_greed) {
    const v = ind.fear_greed.value;
    const sig = v == null ? "neut" : (v > 50 ? "bull" : v < 30 ? "bear" : "neut");
    const cnnFallback = ind.fear_greed.source?.includes("CRYPTO") ? " ⚠️ fallback" : "";
    const deltaTxt = ind.fear_greed.prev_week != null ? `vs ${ind.fear_greed.prev_week.toFixed(0)} prev week` : "";
    cards.push(card(`Fear & Greed${cnnFallback}`, fmtN(v, 0), ind.fear_greed.regime, sig, deltaTxt, ind.fear_greed.description));
  }
  if (ind.net_liquidity) {
    const d = ind.net_liquidity.direction;
    const sig = d === "expanding" ? "bull" : d === "contracting" ? "bear" : "neut";
    const valStr = ind.net_liquidity.current != null ? `$${(ind.net_liquidity.current / 1000).toFixed(2)}T` : "—";
    const deltas = `Δ4w ${fmtSigned(ind.net_liquidity.delta_4w, "B")} · Δ13w ${fmtSigned(ind.net_liquidity.delta_13w, "B")}`;
    cards.push(card("Net Liquidity", valStr, ind.net_liquidity.direction, sig, deltas, ind.net_liquidity.description));
  }
  if (ind.dxy) {
    const v = ind.dxy.current;
    const sig = v == null ? "neut" : (v < 100 ? "bull" : v > 105 ? "bear" : "neut");
    cards.push(card("DXY", fmtN(v, 2), ind.dxy.regime, sig,
      ind.dxy.sma_50d != null ? `50d SMA ${ind.dxy.sma_50d.toFixed(1)}` : "",
      ind.dxy.description));
  }
  if (ind.credit_spread) {
    const bps = ind.credit_spread.current_bps;
    const sig = bps == null ? "neut" : (bps < 400 ? "bull" : bps > 500 ? "bear" : "neut");
    const deltaTxt = ind.credit_spread.delta_4w_bps != null
      ? `Δ4w ${fmtSigned(ind.credit_spread.delta_4w_bps, "bps")}` : "";
    cards.push(card("HY Credit Spread", bps != null ? `${Math.round(bps)} bps` : "—",
      ind.credit_spread.regime, sig, deltaTxt, ind.credit_spread.description));
  }
  if (ind.spy_200dma) {
    const above = ind.spy_200dma.above_200dma;
    const sig = above === true ? "bull" : above === false ? "bear" : "neut";
    const pct = ind.spy_200dma.pct_from_200dma;
    const val = ind.spy_200dma.price != null ? `$${ind.spy_200dma.price.toFixed(2)}` : "—";
    const tag = above == null ? "?" : above ? "Above" : "Below";
    const deltaTxt = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs 200DMA ($${(ind.spy_200dma.dma_200 || 0).toFixed(2)})` : "";
    cards.push(card("SPY vs 200DMA", val, tag, sig, deltaTxt, ind.spy_200dma.description));
  }
  return cards.join("");
}

function card(title, val, tag, sig, deltas, desc) {
  return `
    <article class="macro-card">
      <div class="ind-title">${escapeText(title)}</div>
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
          <th data-rsort="mansfield_rs" class="num ${sortInd('mansfield_rs')}">Mansfield RS</th>
          <th data-rsort="ratio_above_sma" class="${sortInd('ratio_above_sma')}">Above 52w SMA?</th>
          <th data-rsort="ratio_slope_30d" class="num ${sortInd('ratio_slope_30d')}">30d Slope</th>
          <th data-rsort="regime_tag" class="${sortInd('regime_tag')}">Tag</th>
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
    th.addEventListener("click", () => {
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
