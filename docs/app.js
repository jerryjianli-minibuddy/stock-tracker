// stock-tracker dashboard — vanilla JS, no build step.
// Three views (Watchlist / Reports / Bottlenecks) sharing one fetched data set
// joined client-side. Cross-navigation: clicking a ticker pill anywhere jumps
// to the watchlist row; clicking a bottleneck pill anywhere jumps to its card.

const DATA_PATH = "./data";
const STORAGE_KEY = "stock-tracker.activeTab";
const NUMERIC_KEYS = new Set([
  "price", "market_cap", "pe_forward", "pe_trailing",
  "rev_growth_yoy", "eps_growth_yoy", "gross_margin", "op_margin",
  "fcf_ttm", "debt_to_equity",
  "dma_50", "dma_150", "dma_200",
  "high_52w", "low_52w", "volume_avg_30d",
  "rs_proxy", "pct_from_high",
]);

const state = {
  // raw
  tickers: [], snapshots: {}, history: {}, reports: [], bottlenecks: [],
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
    const [tickers, snapshots, history, reports, bottlenecks] = await Promise.all([
      fetchJSON(`${DATA_PATH}/tickers.json`, []),
      fetchJSON(`${DATA_PATH}/snapshots.json`, { last_updated: null, data: {} }),
      fetchJSON(`${DATA_PATH}/history.json`, {}),
      fetchJSON(`${DATA_PATH}/reports.json`, []),
      fetchJSON(`${DATA_PATH}/bottlenecks.json`, []),
    ]);
    state.tickers = Array.isArray(tickers) ? tickers : [];
    state.snapshots = snapshots.data || {};
    state.history = history || {};
    state.reports = Array.isArray(reports) ? reports : [];
    state.bottlenecks = Array.isArray(bottlenecks) ? bottlenecks : [];
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

  renderTabs();
  wireSortHeaders();
  renderReports();
  renderBottlenecks();
  activateTab(restoreActiveTab());
}

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

  nav.innerHTML = [
    `<button class="tab" data-tab="all">All <span class="count">(${state.tickers.length})</span></button>`,
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
  if (saved === "all" || saved === "reports" || saved === "bottlenecks") return saved;
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
        <td>${ratingPill(r.rating)}</td>
      </tr>
      ${exp ? `<tr class="detail-row"><td colspan="13">${renderTickerDetail(r)}</td></tr>` : ""}
    `;
  }).join("");

  tbody.querySelectorAll(".data-row").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      // ignore clicks on pills inside the row (only the row itself toggles)
      if (e.target.closest(".pill.clickable")) return;
      const t = tr.dataset.ticker;
      if (state.expanded.has(t)) state.expanded.delete(t);
      else state.expanded.add(t);
      renderWatchlist();
    });
  });
  wirePillClicks(tbody);
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

  return `
    <div class="detail">
      <div class="detail-text">
        ${fields.length === 0
          ? `<div class="muted small">No notes yet — edit data/tickers.json or run /ingest on a research report.</div>`
          : fields.map(([k, v]) => `<div class="field"><span class="field-label">${escapeText(k)}:</span>${escapeText(v)}</div>`).join("")}
        ${bnSection}
        ${reportSection}
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
      <article class="report-card">
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
      jumpToTicker(el.dataset.jumpTicker);
    })
  );
  scope.querySelectorAll("[data-jump-bottleneck]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToBottleneck(el.dataset.jumpBottleneck);
    })
  );
}

// ============ sparkline ============

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
function ratingPill(r) {
  if (!r) return `<span class="muted">—</span>`;
  const cls = { Strong: "pill-green", Watch: "pill-yellow", Pass: "pill-gray" }[r] || "pill-gray";
  return `<span class="pill ${cls}">${escapeText(r)}</span>`;
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
