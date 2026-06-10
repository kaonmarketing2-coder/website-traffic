// =====================================================
// KAON Group - GA4 Monthly Traffic Dashboard
// =====================================================

const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// ── State ─────────────────────────────────────────
let tokenClient = null;
let accessToken = null;
let selectedYear = null;
let selectedMonth = null;

// cache[siteId] = { summary, yoy, trend, langs, topPages, topCountries }
const cache = {};
// chart instances keyed by canvas id
const charts = {};

// ── Date Utilities ────────────────────────────────

function getMonthRange(y, m) {
  const pad = n => String(n).padStart(2, '0');
  const startDate = `${y}-${pad(m)}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${y}-${pad(m)}-${pad(lastDay)}`;
  return { startDate, endDate };
}

function getPrevMonth(y, m) {
  if (m === 1) return { y: y - 1, m: 12 };
  return { y, m: m - 1 };
}

function getYoYMonth(y, m) {
  return { y: y - 1, m };
}

function fmtMonthLabel(y, m) {
  return `${y}년 ${m}월`;
}

// "202601" → "1월"
function fmtYearMonth(yyyymm) {
  const s = String(yyyymm);
  return `${parseInt(s.slice(4, 6), 10)}월`;
}

// ── Format Utilities ──────────────────────────────

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  const num = Math.round(Number(n));
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 10_000) return num.toLocaleString('ko-KR');
  return num.toLocaleString('ko-KR');
}

// Returns { text: "▲ 13.8%", dir: "up"|"down"|"neutral" }
function fmtPct(curr, prev) {
  if (!prev || prev === 0) return { text: '–', dir: 'neutral' };
  const diff = ((curr - prev) / prev) * 100;
  if (Math.abs(diff) < 0.05) return { text: '±0.0%', dir: 'neutral' };
  if (diff > 0) return { text: `▲ ${diff.toFixed(1)}%`, dir: 'up' };
  return { text: `▼ ${Math.abs(diff).toFixed(1)}%`, dir: 'down' };
}

// ── Month Picker ──────────────────────────────────

function populateMonthPicker() {
  const sel = document.getElementById('monthPicker');
  sel.innerHTML = '';
  const now = new Date();
  // default to previous completed month
  let defY = now.getFullYear();
  let defM = now.getMonth(); // 0-based, so this IS the previous month (current month = getMonth()+1)
  if (defM === 0) { defY -= 1; defM = 12; }

  for (let i = 0; i < 12; i++) {
    let m = defM - i;
    let y = defY;
    while (m <= 0) { m += 12; y -= 1; }
    const opt = document.createElement('option');
    const val = `${y}-${String(m).padStart(2, '0')}`;
    opt.value = val;
    opt.textContent = fmtMonthLabel(y, m);
    sel.appendChild(opt);
  }

  sel.value = `${defY}-${String(defM).padStart(2, '0')}`;
  applyMonthPicker();
}

function applyMonthPicker() {
  const val = document.getElementById('monthPicker').value;
  const [y, m] = val.split('-').map(Number);
  selectedYear = y;
  selectedMonth = m;
  const title = document.getElementById('overviewTitle');
  if (title) title.textContent = `Monthly Web Analytics Overview: ${fmtMonthLabel(y, m)}`;
}

// ── Site Property Helpers ─────────────────────────

// Returns list of property IDs that together cover the whole site
function getSitePropertyList(site) {
  const perLang = site.languages.filter(l => l.code !== 'all' && l.propertyId);
  if (perLang.length > 0) return [...new Set(perLang.map(l => l.propertyId))];
  return site.propertyId ? [site.propertyId] : [];
}

// Returns {propId, filter} for a specific language entry
function getLangQuery(site, lang) {
  if (lang.propertyId) return { propId: lang.propertyId, filter: undefined };
  return {
    propId: site.propertyId,
    filter: lang.filterValue ? containsFilter(site.filterField, lang.filterValue) : undefined,
  };
}

// Build a virtual GA4 report compatible with parseTotals (uses totals[] path)
function buildVirtualReport(curr, prev) {
  return {
    totals: [
      { metricValues: [{ value: String(curr.pageviews) }, { value: String(curr.users) }] },
      { metricValues: [{ value: String(prev.pageviews) }, { value: String(prev.users) }] },
    ],
  };
}

// ── GA4 API ───────────────────────────────────────

async function runReport(propertyId, { dateRanges, metrics, dimensions, dimensionFilter, orderBys, limit }) {
  const body = {
    dateRanges,
    metrics: metrics.map(name => ({ name })),
    metricAggregations: ['TOTAL'],
  };
  if (dimensions && dimensions.length) body.dimensions = dimensions.map(name => ({ name }));
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  if (orderBys) body.orderBys = orderBys;
  if (limit) body.limit = limit;

  const res = await fetch(`${GA4_API}/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) { handleAuthExpired(); throw new Error('인증 만료'); }
  if (res.status === 403) { throw new Error('접근 권한 없음 (403)'); }
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      errMsg = errBody?.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }
  return res.json();
}

function containsFilter(fieldName, value, caseSensitive = false) {
  return {
    filter: {
      fieldName,
      stringFilter: { matchType: 'CONTAINS', value, caseSensitive },
    },
  };
}

// ── Data Fetching ─────────────────────────────────

// Current month + previous month totals (no dimension)
async function fetchSummary(site) {
  const { startDate: cs, endDate: ce } = getMonthRange(selectedYear, selectedMonth);
  const prev = getPrevMonth(selectedYear, selectedMonth);
  const { startDate: ps, endDate: pe } = getMonthRange(prev.y, prev.m);
  const dateRanges = [{ startDate: cs, endDate: ce }, { startDate: ps, endDate: pe }];
  const propIds = getSitePropertyList(site);
  if (propIds.length === 1) {
    return runReport(propIds[0], { dateRanges, metrics: ['screenPageViews', 'totalUsers'] });
  }
  // Multi-property: fetch each language property and sum totals
  const reports = await Promise.all(propIds.map(pid =>
    runReport(pid, { dateRanges, metrics: ['screenPageViews', 'totalUsers'] }).catch(() => null)
  ));
  let pv0 = 0, uv0 = 0, pv1 = 0, uv1 = 0;
  for (const r of reports) {
    if (!r) continue;
    const c = parseTotals(r, 0); const p = parseTotals(r, 1);
    pv0 += c.pageviews; uv0 += c.users; pv1 += p.pageviews; uv1 += p.users;
  }
  return buildVirtualReport({ pageviews: pv0, users: uv0 }, { pageviews: pv1, users: uv1 });
}

// Current month + same month last year
async function fetchYoY(site) {
  const { startDate: cs, endDate: ce } = getMonthRange(selectedYear, selectedMonth);
  const yoy = getYoYMonth(selectedYear, selectedMonth);
  const { startDate: ys, endDate: ye } = getMonthRange(yoy.y, yoy.m);
  const dateRanges = [{ startDate: cs, endDate: ce }, { startDate: ys, endDate: ye }];
  const propIds = getSitePropertyList(site);
  if (propIds.length === 1) {
    return runReport(propIds[0], { dateRanges, metrics: ['screenPageViews', 'totalUsers'] });
  }
  const reports = await Promise.all(propIds.map(pid =>
    runReport(pid, { dateRanges, metrics: ['screenPageViews', 'totalUsers'] }).catch(() => null)
  ));
  let pv0 = 0, uv0 = 0, pv1 = 0, uv1 = 0;
  for (const r of reports) {
    if (!r) continue;
    const c = parseTotals(r, 0); const p = parseTotals(r, 1);
    pv0 += c.pageviews; uv0 += c.users; pv1 += p.pageviews; uv1 += p.users;
  }
  return buildVirtualReport({ pageviews: pv0, users: uv0 }, { pageviews: pv1, users: uv1 });
}

// Jan 1 of selected year → end of selected month, grouped by yearMonth
async function fetchTrend(site) {
  const { endDate } = getMonthRange(selectedYear, selectedMonth);
  const dateRanges = [{ startDate: `${selectedYear}-01-01`, endDate }];
  const propIds = getSitePropertyList(site);
  const reports = await Promise.all(propIds.map(pid =>
    runReport(pid, {
      dateRanges,
      metrics: ['screenPageViews', 'totalUsers'],
      dimensions: ['yearMonth'],
      orderBys: [{ dimension: { dimensionName: 'yearMonth' }, desc: false }],
    }).catch(() => null)
  ));
  // Merge rows by yearMonth
  const merged = {};
  for (const r of reports) {
    if (!r) continue;
    for (const row of (r.rows || [])) {
      const m = row.dimensionValues[0].value;
      if (!merged[m]) merged[m] = { pageviews: 0, users: 0 };
      merged[m].pageviews += Number(row.metricValues[0].value || 0);
      merged[m].users    += Number(row.metricValues[1].value || 0);
    }
  }
  return {
    rows: Object.keys(merged).sort().map(m => ({
      dimensionValues: [{ value: m }],
      metricValues: [{ value: String(merged[m].pageviews) }, { value: String(merged[m].users) }],
    })),
  };
}

// Per-language totals for current month + previous month
async function fetchLangs(site) {
  const { startDate: cs, endDate: ce } = getMonthRange(selectedYear, selectedMonth);
  const prev = getPrevMonth(selectedYear, selectedMonth);
  const { startDate: ps, endDate: pe } = getMonthRange(prev.y, prev.m);

  const nonAll = site.languages.filter(l => l.code !== 'all');
  const results = {};

  await Promise.all(nonAll.map(async lang => {
    try {
      const { propId, filter } = getLangQuery(site, lang);
      const report = await runReport(propId, {
        dateRanges: [
          { startDate: cs, endDate: ce },
          { startDate: ps, endDate: pe },
        ],
        metrics: ['screenPageViews', 'totalUsers'],
        dimensionFilter: filter,
      });
      results[lang.code] = report;
    } catch (err) {
      console.warn(`[${site.name}/${lang.label}] lang fetch failed:`, err.message);
      results[lang.code] = null;
    }
  }));

  return results;
}

// Top pages for selected month, filtered by topPagesLang
async function fetchTopPages(site) {
  const { startDate, endDate } = getMonthRange(selectedYear, selectedMonth);
  const lang = site.languages.find(l => l.code === site.topPagesLang);
  const { propId, filter } = lang
    ? getLangQuery(site, lang)
    : { propId: getSitePropertyList(site)[0], filter: undefined };

  return runReport(propId, {
    dateRanges: [{ startDate, endDate }],
    metrics: ['screenPageViews'],
    dimensions: ['pagePath'],
    dimensionFilter: filter,
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 10,
  });
}

// Get prev month views for the same page paths
async function fetchPrevTopPages(site, paths) {
  if (!paths || paths.length === 0) return null;
  const prev = getPrevMonth(selectedYear, selectedMonth);
  const { startDate, endDate } = getMonthRange(prev.y, prev.m);
  const lang = site.languages.find(l => l.code === site.topPagesLang);
  const { propId, filter } = lang
    ? getLangQuery(site, lang)
    : { propId: getSitePropertyList(site)[0], filter: undefined };

  return runReport(propId, {
    dateRanges: [{ startDate, endDate }],
    metrics: ['screenPageViews'],
    dimensions: ['pagePath'],
    dimensionFilter: filter,
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 50,
  });
}

// Top countries for selected month (English property)
async function fetchTopCountries(site) {
  const { startDate, endDate } = getMonthRange(selectedYear, selectedMonth);
  const enLang = site.languages.find(l => l.code === 'en');
  const { propId, filter } = enLang
    ? getLangQuery(site, enLang)
    : { propId: getSitePropertyList(site)[0], filter: undefined };

  return runReport(propId, {
    dateRanges: [{ startDate, endDate }],
    metrics: ['totalUsers'],
    dimensions: ['country'],
    dimensionFilter: filter,
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit: 10,
  });
}

// ── Parsing ───────────────────────────────────────

function parseTotals(report, rangeIndex) {
  // 2개 dateRange + 무차원 요청 시 GA4가 dateRange 차원을 자동 추가하므로
  // totals 배열 순서에 의존하지 않고 rows에서 date_range_N 값으로 매칭한다
  const dimHeaders = report?.dimensionHeaders || [];
  const drIdx = dimHeaders.findIndex(h => h.name === 'dateRange');
  if (drIdx !== -1) {
    const row = (report.rows || []).find(
      r => r.dimensionValues?.[drIdx]?.value === `date_range_${rangeIndex}`
    );
    if (row) {
      return {
        pageviews: Number(row.metricValues?.[0]?.value || 0),
        users: Number(row.metricValues?.[1]?.value || 0),
      };
    }
    // 해당 기간 데이터 없음 (행 자체가 누락됨)
    return { pageviews: 0, users: 0 };
  }
  const totals = report?.totals?.[rangeIndex]?.metricValues || [];
  return {
    pageviews: Number(totals[0]?.value || 0),
    users: Number(totals[1]?.value || 0),
  };
}

function parseTrend(report) {
  return (report?.rows || []).map(r => ({
    month: r.dimensionValues[0].value, // "202601"
    pageviews: Number(r.metricValues[0].value || 0),
    users: Number(r.metricValues[1].value || 0),
  }));
}

function parseTopPages(report) {
  const rows = report?.rows || [];
  const total = rows.reduce((sum, r) => sum + Number(r.metricValues[0].value || 0), 0);
  return rows.slice(0, 5).map(r => ({
    path: r.dimensionValues[0].value,
    views: Number(r.metricValues[0].value || 0),
    share: total > 0 ? (Number(r.metricValues[0].value || 0) / total * 100) : 0,
  }));
}

function parseTopCountries(report) {
  const rows = report?.rows || [];
  const total = rows.reduce((sum, r) => sum + Number(r.metricValues[0].value || 0), 0);
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    country: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value || 0),
    share: total > 0 ? (Number(r.metricValues[0].value || 0) / total * 100) : 0,
  }));
}

// ── Rendering: Overview ───────────────────────────

function renderOverview() {
  renderOverviewCards();
  renderYoYTable();
  renderYoYChart();
}

function renderOverviewCards() {
  const container = document.getElementById('overviewCards');
  if (!container) return;
  container.innerHTML = '';

  CONFIG.SITES.forEach(site => {
    const d = cache[site.id];
    if (!d || !d.summary) {
      // placeholder card
      const card = document.createElement('div');
      card.className = 'kpi-card';
      card.innerHTML = `
        <div class="kpi-card-header" style="background:${site.color}">${site.name}</div>
        <div class="kpi-card-body">
          <div class="loading-state" style="padding:16px 0">
            <div class="loading-spinner"></div><br>로딩 중...
          </div>
        </div>`;
      container.appendChild(card);
      return;
    }

    const curr = parseTotals(d.summary, 0);
    const prev = parseTotals(d.summary, 1);
    const pvChg = fmtPct(curr.pageviews, prev.pageviews);
    const uvChg = fmtPct(curr.users, prev.users);

    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `
      <div class="kpi-card-header" style="background:${site.color}">${site.name}</div>
      <div class="kpi-card-body">
        <div class="kpi-values">
          <div class="kpi-col">
            <div class="kpi-label">Pageview</div>
            <div class="kpi-number">${fmtNum(curr.pageviews)}</div>
            <div class="kpi-change ${pvChg.dir}">${pvChg.text}</div>
            <div class="kpi-label" style="margin-top:2px;font-size:10px">vs 전월</div>
          </div>
          <div class="kpi-col">
            <div class="kpi-label">Visitors</div>
            <div class="kpi-number">${fmtNum(curr.users)}</div>
            <div class="kpi-change ${uvChg.dir}">${uvChg.text}</div>
            <div class="kpi-label" style="margin-top:2px;font-size:10px">vs 전월</div>
          </div>
        </div>
      </div>`;
    container.appendChild(card);
  });
}

function renderYoYTable() {
  const tbody = document.getElementById('yoyTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  CONFIG.SITES.forEach((site, i) => {
    const d = cache[site.id];
    const tr = document.createElement('tr');

    if (d && d.yoy) {
      const curr = parseTotals(d.yoy, 0);
      const yoy = parseTotals(d.yoy, 1);
      const pvChg = fmtPct(curr.pageviews, yoy.pageviews);
      const uvChg = fmtPct(curr.users, yoy.users);
      tr.style.background = i % 2 === 1 ? '#FFF8F3' : '';
      tr.innerHTML = `
        <td style="font-weight:600">${site.name}</td>
        <td>${fmtNum(yoy.pageviews)}</td>
        <td>${fmtNum(curr.pageviews)}</td>
        <td class="chg-${pvChg.dir}">${pvChg.text}</td>
        <td>${fmtNum(yoy.users)}</td>
        <td>${fmtNum(curr.users)}</td>
        <td class="chg-${uvChg.dir}">${uvChg.text}</td>`;
    } else {
      tr.innerHTML = `<td style="font-weight:600">${site.name}</td><td colspan="6" style="color:#9CA3AF">–</td>`;
    }
    tbody.appendChild(tr);
  });
}

function renderYoYChart() {
  const canvas = document.getElementById('yoyChart');
  if (!canvas) return;
  charts['yoyChart']?.destroy();

  const labels = CONFIG.SITES.map(s => s.name.replace('KAON ', ''));
  const prevData = CONFIG.SITES.map(site => {
    const d = cache[site.id];
    if (!d || !d.yoy) return 0;
    return parseTotals(d.yoy, 1).pageviews;
  });
  const currData = CONFIG.SITES.map(site => {
    const d = cache[site.id];
    if (!d || !d.yoy) return 0;
    return parseTotals(d.yoy, 0).pageviews;
  });

  const prevYear = getYoYMonth(selectedYear, selectedMonth).y;

  charts['yoyChart'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `${prevYear}년`,
          data: prevData,
          backgroundColor: ['#E87722', '#1E40AF', '#1E40AF', '#E87722'].map(c => c + '66'),
          borderColor: ['#E87722', '#1E40AF', '#1E40AF', '#E87722'],
          borderWidth: 1.5,
          borderRadius: 3,
        },
        {
          label: `${selectedYear}년`,
          data: currData,
          backgroundColor: ['#E87722', '#1E40AF', '#1E40AF', '#E87722'].map(c => c + 'CC'),
          borderColor: ['#E87722', '#1E40AF', '#1E40AF', '#E87722'],
          borderWidth: 1.5,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 11 } },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          grid: { color: '#EEF2F7' },
          ticks: { font: { size: 11 }, callback: v => fmtNum(v) },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── Rendering: Site Section ───────────────────────

function renderSiteSection(site) {
  const container = document.getElementById('siteDetailsContainer');
  if (!container) return;

  // Remove existing section for this site if re-rendering
  const existing = document.getElementById(`detail-${site.id}`);
  if (existing) existing.remove();

  const d = cache[site.id];
  if (!d) return;

  // Determine insert position (maintain config order)
  const siteIndex = CONFIG.SITES.findIndex(s => s.id === site.id);
  const wrap = document.createElement('div');
  wrap.className = 'site-section-wrap';
  wrap.id = `detail-${site.id}`;

  if (d.error) {
    wrap.innerHTML = `
      <div class="site-section">
        <div class="site-header-bar">${site.name}</div>
        <div class="error-state">${d.error}</div>
      </div>`;
    insertAtPosition(container, wrap, siteIndex);
    return;
  }

  const curr = parseTotals(d.summary, 0);
  const prev = parseTotals(d.summary, 1);
  const pvChg = fmtPct(curr.pageviews, prev.pageviews);
  const uvChg = fmtPct(curr.users, prev.users);
  const trendData = d.trend ? parseTrend(d.trend) : [];
  const langData = d.langs || {};
  const topPages = d.topPages ? parseTopPages(d.topPages) : [];
  const prevPagesMap = buildPrevPagesMap(d.prevTopPages);
  const topCountries = (site.showCountries && d.topCountries) ? parseTopCountries(d.topCountries) : [];

  // Build lang rows for language table
  const nonAllLangs = site.languages.filter(l => l.code !== 'all');

  // ── Build HTML ──
  const trendCanvasId = `trend-canvas-${site.id}`;
  const pieCanvasId = `pie-canvas-${site.id}`;

  // Trend chart cell height
  const overviewRow = `
    <div class="site-overview-row">
      <div class="kpi-box">
        <div class="kpi-box-label">${selectedMonth}월 Pageview</div>
        <div class="kpi-box-number">${fmtNum(curr.pageviews)}</div>
        <div class="kpi-box-change ${pvChg.dir}">${pvChg.text} vs 전월</div>
        <div class="kpi-box-sublabel">prev. ${fmtNum(prev.pageviews)}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-box-label">${selectedMonth}월 Visitors</div>
        <div class="kpi-box-number">${fmtNum(curr.users)}</div>
        <div class="kpi-box-change ${uvChg.dir}">${uvChg.text} vs 전월</div>
        <div class="kpi-box-sublabel">prev. ${fmtNum(prev.users)}</div>
      </div>
      <div class="kpi-box kpi-box-chart">
        <div class="kpi-box-chart-label">월별 트렌드 (${selectedYear}년 1월 ~ ${selectedMonth}월)</div>
        <div class="chart-wrap-trend">
          <canvas id="${trendCanvasId}"></canvas>
        </div>
      </div>
    </div>`;

  // Language table
  const langTableRows = nonAllLangs.map((lang, idx) => {
    const r = langData[lang.code];
    if (!r) return `<tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
      <td>${lang.label}</td><td colspan="6" style="color:#9CA3AF">–</td></tr>`;
    const lc = parseTotals(r, 0);
    const lp = parseTotals(r, 1);
    const lpvChg = fmtPct(lc.pageviews, lp.pageviews);
    const luvChg = fmtPct(lc.users, lp.users);
    return `<tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
      <td>${lang.label}</td>
      <td>${fmtNum(lp.pageviews)}</td>
      <td>${fmtNum(lc.pageviews)}</td>
      <td class="chg-${lpvChg.dir}">${lpvChg.text}</td>
      <td>${fmtNum(lp.users)}</td>
      <td>${fmtNum(lc.users)}</td>
      <td class="chg-${luvChg.dir}">${luvChg.text}</td>
    </tr>`;
  }).join('');

  const langSection = `
    <div class="site-detail-row">
      <div class="site-detail-cell">
        <div class="site-detail-cell-title">언어별 트래픽</div>
        <table class="report-table">
          <thead style="background:${site.tableColor}">
            <tr>
              <th>언어</th><th>전월PV</th><th>당월PV</th><th>증감률</th>
              <th>전월UV</th><th>당월UV</th><th>증감률</th>
            </tr>
          </thead>
          <tbody>${langTableRows}</tbody>
        </table>
      </div>
      <div class="site-detail-cell">
        <div class="site-detail-cell-title">언어별 PV 비중</div>
        <div class="pie-wrap">
          <canvas id="${pieCanvasId}"></canvas>
        </div>
      </div>
    </div>`;

  // Top pages table
  const topLangLabel = getLangLabel(site, site.topPagesLang);
  const topPagesRows = topPages.length === 0
    ? `<tr><td colspan="4" style="color:#9CA3AF;text-align:center">데이터 없음</td></tr>`
    : topPages.map((p, idx) => {
        const prevViews = prevPagesMap[p.path] || 0;
        return `<tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
          <td style="word-break:break-all;font-size:11px;max-width:200px">${p.path}</td>
          <td>${fmtNum(p.views)}</td>
          <td>${p.share.toFixed(1)}%</td>
          <td>${prevViews ? fmtNum(prevViews) : '–'}</td>
        </tr>`;
      }).join('');

  // Top countries table
  let topCountriesHTML = '';
  if (site.showCountries) {
    const countryRows = topCountries.length === 0
      ? `<tr><td colspan="4" style="color:#9CA3AF;text-align:center">데이터 없음</td></tr>`
      : topCountries.map((c, idx) => `
          <tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
            <td style="color:#6B7280">${c.rank}</td>
            <td>${c.country}</td>
            <td>${fmtNum(c.users)}</td>
            <td>${c.share.toFixed(1)}%</td>
          </tr>`).join('');

    topCountriesHTML = `
      <div class="site-top-cell">
        <div class="site-top-cell-title">
          방문국가 Top 10
          <span class="lang-badge" style="background:${site.tableColor}">English Only</span>
        </div>
        <table class="report-table">
          <thead style="background:${site.tableColor}">
            <tr><th>순위</th><th>국가</th><th>당월 UV</th><th>비중</th></tr>
          </thead>
          <tbody>${countryRows}</tbody>
        </table>
      </div>`;
  }

  const topSection = `
    <div class="site-top-row${site.showCountries ? '' : ' single-col'}">
      <div class="site-top-cell">
        <div class="site-top-cell-title">
          방문 페이지 Top 5
          <span class="lang-badge" style="background:${site.tableColor}">${topLangLabel} Only</span>
        </div>
        <table class="report-table">
          <thead style="background:${site.tableColor}">
            <tr><th>경로</th><th>당월</th><th>비중</th><th>전월</th></tr>
          </thead>
          <tbody>${topPagesRows}</tbody>
        </table>
      </div>
      ${topCountriesHTML}
    </div>`;

  wrap.innerHTML = `
    <div class="site-section">
      <div class="site-header-bar">
        ${site.name}
        <a href="${site.url}" target="_blank" rel="noopener">${site.url}</a>
      </div>
      ${overviewRow}
      ${langSection}
      ${topSection}
    </div>`;

  insertAtPosition(container, wrap, siteIndex);

  // Render charts after DOM insertion
  requestAnimationFrame(() => {
    renderTrendChart(site, trendData, trendCanvasId);
    renderLangPie(site, langData, pieCanvasId);
  });
}

function getLangLabel(site, code) {
  const lang = site.languages.find(l => l.code === code);
  return lang ? lang.label : code;
}

function buildPrevPagesMap(report) {
  const map = {};
  if (!report) return map;
  (report.rows || []).forEach(r => {
    map[r.dimensionValues[0].value] = Number(r.metricValues[0].value || 0);
  });
  return map;
}

function insertAtPosition(container, element, index) {
  const children = container.querySelectorAll(':scope > .site-section-wrap');
  if (children.length === 0 || index >= children.length) {
    container.appendChild(element);
  } else {
    container.insertBefore(element, children[index]);
  }
}

// ── Rendering: Trend Chart ────────────────────────

function renderTrendChart(site, trendData, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  charts[canvasId]?.destroy();

  if (!trendData || trendData.length === 0) {
    canvas.closest('.chart-wrap-trend').innerHTML = '<div style="color:#9CA3AF;font-size:12px;padding:16px">데이터 없음</div>';
    return;
  }

  charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: trendData.map(d => fmtYearMonth(d.month)),
      datasets: [
        {
          label: 'Pageview',
          data: trendData.map(d => d.pageviews),
          borderColor: '#2563EB',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#2563EB',
          fill: false,
          tension: 0.3,
        },
        {
          label: 'Visitors',
          data: trendData.map(d => d.users),
          borderColor: '#E87722',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#E87722',
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, font: { size: 11 }, padding: 8 },
        },
      },
      scales: {
        x: {
          grid: { color: '#F3F4F6' },
          ticks: { font: { size: 10 }, maxTicksLimit: 12 },
        },
        y: {
          grid: { color: '#F3F4F6' },
          ticks: { font: { size: 10 }, callback: v => fmtNum(v) },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── Rendering: Language Pie ───────────────────────

const PIE_COLORS = ['#2563EB', '#E87722', '#16A34A', '#9333EA', '#DC2626', '#0891B2'];

function renderLangPie(site, langData, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  charts[canvasId]?.destroy();

  const nonAll = site.languages.filter(l => l.code !== 'all');
  const labels = [];
  const values = [];

  nonAll.forEach(lang => {
    const r = langData[lang.code];
    if (!r) return;
    const v = parseTotals(r, 0).pageviews;
    if (v > 0) {
      labels.push(lang.label);
      values.push(v);
    }
  });

  if (values.length === 0) {
    canvas.closest('.pie-wrap').innerHTML = '<div style="color:#9CA3AF;font-size:12px;padding:16px">데이터 없음</div>';
    return;
  }

  const total = values.reduce((a, b) => a + b, 0);

  charts[canvasId] = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: PIE_COLORS.slice(0, values.length),
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            boxWidth: 12,
            font: { size: 11 },
            generateLabels(chart) {
              const data = chart.data;
              return data.labels.map((label, i) => {
                const val = data.datasets[0].data[i];
                const pct = total > 0 ? (val / total * 100).toFixed(1) : '0.0';
                return {
                  text: `${label} ${pct}%`,
                  fillStyle: PIE_COLORS[i] || '#ccc',
                  hidden: false,
                  index: i,
                };
              });
            },
          },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : '0.0';
              return ` ${fmtNum(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ── Load All Sites ────────────────────────────────

async function loadAllSites() {
  // Clear cache and remove existing site sections
  CONFIG.SITES.forEach(site => {
    delete cache[site.id];
    const el = document.getElementById(`detail-${site.id}`);
    if (el) el.remove();
  });

  // Destroy existing charts
  Object.keys(charts).forEach(k => {
    charts[k]?.destroy();
    delete charts[k];
  });

  // Reset overview
  document.getElementById('overviewCards').innerHTML = CONFIG.SITES.map(site => `
    <div class="kpi-card">
      <div class="kpi-card-header" style="background:${site.color}">${site.name}</div>
      <div class="kpi-card-body">
        <div class="loading-state" style="padding:16px 0">
          <div class="loading-spinner"></div><br>로딩 중...
        </div>
      </div>
    </div>`).join('');

  document.getElementById('yoyTableBody').innerHTML = CONFIG.SITES.map(s =>
    `<tr><td style="font-weight:600">${s.name}</td><td colspan="6" style="color:#9CA3AF">로딩 중...</td></tr>`
  ).join('');

  // Load all 4 sites in parallel
  await Promise.all(CONFIG.SITES.map(site => loadOneSite(site)));
}

async function loadOneSite(site) {
  cache[site.id] = {};

  try {
    // Kick off all fetches in parallel
    const [summaryRes, yoyRes, trendRes, langsRes, topPagesRes] = await Promise.all([
      fetchSummary(site).catch(e => { console.error(`[${site.name}] summary:`, e.message); return null; }),
      fetchYoY(site).catch(e => { console.error(`[${site.name}] yoy:`, e.message); return null; }),
      fetchTrend(site).catch(e => { console.error(`[${site.name}] trend:`, e.message); return null; }),
      fetchLangs(site).catch(e => { console.error(`[${site.name}] langs:`, e.message); return null; }),
      fetchTopPages(site).catch(e => { console.error(`[${site.name}] topPages:`, e.message); return null; }),
    ]);

    cache[site.id].summary = summaryRes;
    cache[site.id].yoy = yoyRes;
    cache[site.id].trend = trendRes;
    cache[site.id].langs = langsRes || {};

    // Now fetch prev top pages using paths from top pages result
    let prevTopPagesRes = null;
    if (topPagesRes) {
      const paths = (topPagesRes.rows || []).slice(0, 5).map(r => r.dimensionValues[0].value);
      prevTopPagesRes = await fetchPrevTopPages(site, paths).catch(e => {
        console.error(`[${site.name}] prevTopPages:`, e.message);
        return null;
      });
    }
    cache[site.id].topPages = topPagesRes;
    cache[site.id].prevTopPages = prevTopPagesRes;

    // Top countries (only if needed)
    if (site.showCountries) {
      cache[site.id].topCountries = await fetchTopCountries(site).catch(e => {
        console.error(`[${site.name}] topCountries:`, e.message);
        return null;
      });
    }

    // Render this site's section
    renderSiteSection(site);

    // Update overview with latest data
    renderOverview();

  } catch (err) {
    console.error(`[${site.name}] fatal:`, err.message);
    cache[site.id].error = err.message;
    renderSiteSection(site);
  }
}

// ── Auth ──────────────────────────────────────────

function initAuth() {
  if (!window.google) { setTimeout(initAuth, 300); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: onAuthSuccess,
    error_callback: onAuthError,
  });
  // Show login button once Google libs are ready
  document.getElementById('loginBtn').style.display = 'inline-flex';
}

function onAuthSuccess(resp) {
  if (resp.error) { onAuthError(resp); return; }
  accessToken = resp.access_token;
  console.log('[Auth] granted scope:', resp.scope);
  if (!resp.scope || !resp.scope.includes('analytics')) {
    alert('Google Analytics 권한이 포함되지 않았습니다.\n\nGoogle Cloud Console → OAuth 동의 화면에서\n"analytics.readonly" 범위를 추가한 후 다시 시도해 주세요.');
    return;
  }
  showDashboard();
  loadAllSites();
}

function onAuthError(err) {
  if (err.type !== 'popup_closed') alert('로그인 오류: ' + (err.message || err.type));
}

function handleAuthExpired() {
  accessToken = null;
  showLoginScreen();
}

function login() {
  if (!tokenClient) { alert('Google 라이브러리 로딩 중입니다. 잠시 후 다시 시도해 주세요.'); return; }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function logout() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  accessToken = null;
  showLoginScreen();
}

// ── UI State ──────────────────────────────────────

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('headerControls').style.display = 'none';
  document.getElementById('loginBtn').style.display = 'inline-flex';
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('headerControls').style.display = 'flex';
  document.getElementById('loginBtn').style.display = 'none';
}

// ── Event Listeners ───────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateMonthPicker();

  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('loginBtnMain').addEventListener('click', login);
  document.getElementById('logoutBtn').addEventListener('click', logout);

  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (accessToken) {
      applyMonthPicker();
      loadAllSites();
    }
  });

  document.getElementById('monthPicker').addEventListener('change', () => {
    applyMonthPicker();
    if (accessToken) loadAllSites();
  });
});

// ── Init ──────────────────────────────────────────

window.addEventListener('load', () => {
  initAuth();
  showLoginScreen();
});
