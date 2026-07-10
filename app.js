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
let currentView = 'dashboard'; // 'dashboard' | 'insights'

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

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// (2026, 5) → "May 2026"
function fmtMonthLabelEn(y, m) {
  return `${EN_MONTHS[m - 1]} ${y}`;
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

// Channel breakdown (session default channel group) for current + previous month.
// Multi-property sites: fetch each language property and sum per channel.
async function fetchChannels(site) {
  const { startDate: cs, endDate: ce } = getMonthRange(selectedYear, selectedMonth);
  const prev = getPrevMonth(selectedYear, selectedMonth);
  const { startDate: ps, endDate: pe } = getMonthRange(prev.y, prev.m);
  const dateRanges = [{ startDate: cs, endDate: ce }, { startDate: ps, endDate: pe }];
  const propIds = getSitePropertyList(site);

  const reports = await Promise.all(propIds.map(pid =>
    runReport(pid, {
      dateRanges,
      metrics: ['sessions', 'totalUsers', 'engagedSessions'],
      dimensions: ['sessionDefaultChannelGroup'],
    }).catch(e => { console.warn(`[${site.name}] channels(${pid}):`, e.message); return null; })
  ));

  // merged[channel] = { cs, cu, ces, ps, pu, pes } (c=current, p=previous)
  const merged = {};
  for (const r of reports) {
    if (!r) continue;
    const dimHeaders = r.dimensionHeaders || [];
    const drIdx = dimHeaders.findIndex(h => h.name === 'dateRange');
    const chIdx = dimHeaders.findIndex(h => h.name === 'sessionDefaultChannelGroup');
    for (const row of (r.rows || [])) {
      const ch = row.dimensionValues[chIdx >= 0 ? chIdx : 0].value;
      const range = drIdx >= 0 ? row.dimensionValues[drIdx].value : 'date_range_0';
      if (!merged[ch]) merged[ch] = { cs: 0, cu: 0, ces: 0, ps: 0, pu: 0, pes: 0 };
      const m = merged[ch];
      const s = Number(row.metricValues[0]?.value || 0);
      const u = Number(row.metricValues[1]?.value || 0);
      const es = Number(row.metricValues[2]?.value || 0);
      if (range === 'date_range_1') { m.ps += s; m.pu += u; m.pes += es; }
      else { m.cs += s; m.cu += u; m.ces += es; }
    }
  }
  return merged;
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

// Top countries: current month + previous month (English property)
async function fetchTopCountries(site) {
  const { startDate: cs, endDate: ce } = getMonthRange(selectedYear, selectedMonth);
  const prev = getPrevMonth(selectedYear, selectedMonth);
  const { startDate: ps, endDate: pe } = getMonthRange(prev.y, prev.m);
  const enLang = site.languages.find(l => l.code === 'en');
  const { propId, filter } = enLang
    ? getLangQuery(site, enLang)
    : { propId: getSitePropertyList(site)[0], filter: undefined };

  return runReport(propId, {
    dateRanges: [
      { startDate: cs, endDate: ce },
      { startDate: ps, endDate: pe },
    ],
    metrics: ['totalUsers'],
    dimensions: ['country'],
    dimensionFilter: filter,
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    // 행이 (국가 × 기간) 단위로 반환되므로 충분히 크게 요청 후 파싱 시 Top 10 선별
    limit: 200,
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
  // 2개 dateRange 요청 시 dateRange 차원이 자동 추가됨 (국가 × 기간 행)
  const dimHeaders = report?.dimensionHeaders || [];
  const drIdx = dimHeaders.findIndex(h => h.name === 'dateRange');
  const cIdx = dimHeaders.findIndex(h => h.name === 'country');

  const currMap = {};
  const prevMap = {};
  rows.forEach(r => {
    const country = r.dimensionValues[cIdx >= 0 ? cIdx : 0].value;
    const users = Number(r.metricValues[0].value || 0);
    const range = drIdx >= 0 ? r.dimensionValues[drIdx].value : 'date_range_0';
    if (range === 'date_range_1') prevMap[country] = (prevMap[country] || 0) + users;
    else currMap[country] = (currMap[country] || 0) + users;
  });

  const total = Object.values(currMap).reduce((s, v) => s + v, 0);
  return Object.keys(currMap)
    .sort((a, b) => currMap[b] - currMap[a])
    .slice(0, 10)
    .map((country, i) => ({
      rank: i + 1,
      country,
      users: currMap[country],
      prevUsers: prevMap[country] ?? null,
      share: total > 0 ? (currMap[country] / total * 100) : 0,
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

// ── Rendering: Channel Analysis ───────────────────

const CHANNEL_COLORS = {
  'Organic Search': '#2563EB',
  'Direct': '#E87722',
  'Referral': '#16A34A',
  'Organic Social': '#9333EA',
  'Paid Search': '#DC2626',
  'Paid Social': '#DB2777',
  'Email': '#D97706',
  'Organic Video': '#0D9488',
  'AI Assistant': '#0891B2',
  'Display': '#7C3AED',
  'Unassigned': '#9CA3AF',
};
const CHANNEL_FALLBACK_COLOR = '#6B7280';

function channelColor(ch) {
  return CHANNEL_COLORS[ch] || CHANNEL_FALLBACK_COLOR;
}

// Sorted channel list for a site (by current sessions desc)
function sortedChannels(channels) {
  return Object.keys(channels).sort((a, b) => channels[b].cs - channels[a].cs);
}

function renderChannelSection() {
  const title = document.getElementById('channelTitle');
  if (title && selectedYear) {
    title.textContent = `채널별 유입 분석 (세션 기준): ${fmtMonthLabel(selectedYear, selectedMonth)}`;
  }
  renderChannelTables();
  renderChannelMixChart();
}

function renderChannelTables() {
  const grid = document.getElementById('channelGrid');
  if (!grid) return;
  grid.innerHTML = '';

  CONFIG.SITES.forEach(site => {
    const d = cache[site.id];
    const card = document.createElement('div');
    card.className = 'channel-table-card';

    if (!d || !d.channels) {
      card.innerHTML = `
        <div class="channel-card-header" style="background:${site.color}">${site.name}</div>
        <div class="loading-state" style="padding:20px 0">
          <div class="loading-spinner"></div><br>로딩 중...
        </div>`;
      grid.appendChild(card);
      return;
    }

    const chs = sortedChannels(d.channels);
    const totalCurr = chs.reduce((s, c) => s + d.channels[c].cs, 0);
    const totalPrev = chs.reduce((s, c) => s + d.channels[c].ps, 0);
    const totalChg = fmtPct(totalCurr, totalPrev);

    // Top 5 channels + merge the rest into "기타"
    const top = chs.slice(0, 5);
    const rest = chs.slice(5);
    const restAgg = rest.reduce((acc, c) => {
      const m = d.channels[c];
      acc.cs += m.cs; acc.ces += m.ces; acc.ps += m.ps;
      return acc;
    }, { cs: 0, ces: 0, ps: 0 });

    const rowHTML = (label, cs, ps, ces, idx, dotColor) => {
      const chg = fmtPct(cs, ps);
      const share = totalCurr > 0 ? (cs / totalCurr * 100).toFixed(1) : '0.0';
      const er = cs > 0 ? (ces / cs * 100).toFixed(1) + '%' : '–';
      return `<tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
        <td><span class="channel-dot" style="background:${dotColor}"></span>${label}</td>
        <td>${fmtNum(ps)}</td>
        <td>${fmtNum(cs)}</td>
        <td class="chg-${chg.dir}">${chg.text}</td>
        <td>${share}%</td>
        <td>${er}</td>
      </tr>`;
    };

    const bodyRows = top.map((c, i) => {
      const m = d.channels[c];
      return rowHTML(c, m.cs, m.ps, m.ces, i, channelColor(c));
    }).join('') + (rest.length > 0
      ? rowHTML('기타', restAgg.cs, restAgg.ps, restAgg.ces, top.length, CHANNEL_FALLBACK_COLOR)
      : '');

    card.innerHTML = `
      <div class="channel-card-header" style="background:${site.color}">
        ${site.name}
        <span class="channel-card-total">총 ${fmtNum(totalCurr)} 세션
          <span class="chg-${totalChg.dir}" style="margin-left:4px">${totalChg.text}</span>
        </span>
      </div>
      <table class="report-table">
        <thead style="background:${site.tableColor}">
          <tr><th>채널</th><th>전월</th><th>당월</th><th>증감률</th><th>비중</th><th>참여율</th></tr>
        </thead>
        <tbody>${bodyRows || '<tr><td colspan="6" style="color:#9CA3AF;text-align:center">데이터 없음</td></tr>'}</tbody>
      </table>`;
    grid.appendChild(card);
  });
}

function renderChannelMixChart() {
  const canvas = document.getElementById('channelMixChart');
  if (!canvas) return;
  charts['channelMixChart']?.destroy();

  const loaded = CONFIG.SITES.filter(s => cache[s.id] && cache[s.id].channels);
  if (loaded.length === 0) return;

  // Union of channels across sites, ordered by total current sessions
  const chTotals = {};
  loaded.forEach(site => {
    const chans = cache[site.id].channels;
    Object.keys(chans).forEach(c => { chTotals[c] = (chTotals[c] || 0) + chans[c].cs; });
  });
  const chOrder = Object.keys(chTotals).sort((a, b) => chTotals[b] - chTotals[a]);

  const labels = CONFIG.SITES.map(s => s.name.replace('KAON ', ''));
  const datasets = chOrder.map(ch => ({
    label: ch,
    data: CONFIG.SITES.map(site => {
      const d = cache[site.id];
      if (!d || !d.channels) return 0;
      const total = Object.values(d.channels).reduce((s, m) => s + m.cs, 0);
      const v = d.channels[ch] ? d.channels[ch].cs : 0;
      return total > 0 ? +(v / total * 100).toFixed(1) : 0;
    }),
    backgroundColor: channelColor(ch) + 'CC',
    borderColor: '#fff',
    borderWidth: 1,
  }));

  charts['channelMixChart'] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, padding: 6 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` } },
      },
      scales: {
        x: {
          stacked: true, max: 100,
          grid: { color: '#F3F4F6' },
          ticks: { font: { size: 10 }, callback: v => v + '%' },
        },
        y: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

// ── Insights View ─────────────────────────────────
// Rule-based insight drafts, one card per site per section.
// Each builder returns: null (still loading) or an array of {warn, html} bullets.

// Section 1: per-site overview insights (summary + YoY + language + trend)
function buildOverviewInsightBullets(site) {
  const d = cache[site.id];
  if (!d || !d.summary) return null;
  const bullets = [];

  const curr = parseTotals(d.summary, 0);
  const prev = parseTotals(d.summary, 1);
  const pvChg = fmtPct(curr.pageviews, prev.pageviews);
  const uvChg = fmtPct(curr.users, prev.users);
  bullets.push({
    html: `${selectedMonth}월 PV <b>${fmtNum(curr.pageviews)}</b> (<span class="chg-${pvChg.dir}">${pvChg.text}</span>) · UV <b>${fmtNum(curr.users)}</b> (<span class="chg-${uvChg.dir}">${uvChg.text}</span>) vs 전월`,
  });

  if (d.yoy) {
    const yc = parseTotals(d.yoy, 0);
    const yp = parseTotals(d.yoy, 1);
    const ypv = fmtPct(yc.pageviews, yp.pageviews);
    const yuv = fmtPct(yc.users, yp.users);
    bullets.push({
      html: `전년 동월 대비 PV <span class="chg-${ypv.dir}">${ypv.text}</span> · UV <span class="chg-${yuv.dir}">${yuv.text}</span>`,
    });
  }

  // PV/UV divergence
  if (prev.pageviews > 0 && prev.users > 0) {
    const pvD = (curr.pageviews - prev.pageviews) / prev.pageviews;
    const uvD = (curr.users - prev.users) / prev.users;
    if (pvD < -0.05 && uvD > 0.05) {
      bullets.push({ warn: true, html: `방문자는 늘었지만 PV는 감소 — 방문 깊이 축소(얕은 신규 유입 가능성), 유입 성격 점검 권장` });
    } else if (pvD > 0.05 && uvD < -0.05) {
      bullets.push({ html: `방문자 감소에도 PV 증가 — 방문자당 열람 페이지 수 증가` });
    }
  }

  // Biggest language mover
  if (d.langs) {
    let best = null;
    site.languages.filter(l => l.code !== 'all').forEach(l => {
      const r = d.langs[l.code];
      if (!r) return;
      const c = parseTotals(r, 0);
      const p = parseTotals(r, 1);
      const delta = c.pageviews - p.pageviews;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { label: l.label, delta, c, p };
    });
    if (best && Math.abs(best.delta) >= 50 && best.p.pageviews > 0) {
      const chg = fmtPct(best.c.pageviews, best.p.pageviews);
      bullets.push({
        html: `언어별 증감 주도: <b>${best.label}</b> PV ${fmtNum(best.p.pageviews)} → ${fmtNum(best.c.pageviews)} (<span class="chg-${chg.dir}">${chg.text}</span>)`,
      });
    }
  }

  // Current month vs YTD monthly average
  if (d.trend) {
    const t = parseTrend(d.trend);
    const currKey = `${selectedYear}${String(selectedMonth).padStart(2, '0')}`;
    const cur = t.find(x => x.month === currKey);
    const others = t.filter(x => x.month !== currKey);
    if (cur && others.length > 0) {
      const avg = others.reduce((s, x) => s + x.pageviews, 0) / others.length;
      if (avg > 0) {
        const diff = (cur.pageviews - avg) / avg;
        if (Math.abs(diff) >= 0.15) {
          bullets.push({
            html: `${selectedYear}년 월평균 PV(${fmtNum(avg)}) 대비 <span class="chg-${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${(Math.abs(diff) * 100).toFixed(1)}%</span> ${diff > 0 ? '상회' : '하회'}`,
          });
        }
      }
    }
  }

  return bullets;
}

// Section 2: top pages & countries insights
function buildPagesInsightBullets(site) {
  const d = cache[site.id];
  if (!d || (!d.topPages && !d.topCountries)) return null;
  const bullets = [];

  if (d.topPages) {
    const pages = parseTopPages(d.topPages);
    const prevMap = buildPrevPagesMap(d.prevTopPages);
    const langLabel = getLangLabel(site, site.topPagesLang);

    if (pages.length > 0) {
      const p1 = pages[0];
      bullets.push({
        html: `최다 방문(${langLabel}): <b>${p1.path}</b> — ${fmtNum(p1.views)} PV, 상위 페이지의 ${p1.share.toFixed(1)}%`,
      });
      if (p1.share >= 40) {
        bullets.push({ html: `상위 트래픽이 한 페이지에 집중(${p1.share.toFixed(1)}%) — 해당 페이지 최적화 효과가 큼` });
      }

      let riser = null, faller = null;
      pages.forEach(p => {
        const pv = prevMap[p.path];
        if (!pv || pv < 30) return;
        const r = (p.views - pv) / pv;
        if (r >= 0.3 && (!riser || r > riser.r)) riser = { p, pv, r };
        if (r <= -0.3 && (!faller || r < faller.r)) faller = { p, pv, r };
      });
      if (riser) bullets.push({ html: `급상승: <b>${riser.p.path}</b> ${fmtNum(riser.pv)} → ${fmtNum(riser.p.views)} (<span class="chg-up">▲ ${(riser.r * 100).toFixed(1)}%</span>)` });
      if (faller) bullets.push({ html: `하락: <b>${faller.p.path}</b> ${fmtNum(faller.pv)} → ${fmtNum(faller.p.views)} (<span class="chg-down">▼ ${(Math.abs(faller.r) * 100).toFixed(1)}%</span>)` });
    }
  }

  if (site.showCountries && d.topCountries) {
    const cs = parseTopCountries(d.topCountries);
    if (cs.length > 0) {
      bullets.push({ html: `방문 1위 국가(English): <b>${cs[0].country}</b> — UV ${fmtNum(cs[0].users)} (${cs[0].share.toFixed(1)}%)` });

      let surge = null;
      cs.forEach(c => {
        if (c.prevUsers === null || c.prevUsers < 20 || c.users < 30) return;
        const r = (c.users - c.prevUsers) / c.prevUsers;
        if (r >= 0.5 && (!surge || r > surge.r)) surge = { c, r };
      });
      if (surge) {
        bullets.push({
          warn: surge.r >= 1,
          html: `<b>${surge.c.country}</b> UV ${fmtNum(surge.c.prevUsers)} → ${fmtNum(surge.c.users)} (<span class="chg-up">▲ ${(surge.r * 100).toFixed(0)}%</span>) 급증${surge.r >= 1 ? ' — 유입 성격(실수요/봇) 확인 권장' : ''}`,
        });
      }

      const newc = cs.find(c => !c.prevUsers);
      if (newc) bullets.push({ html: `Top 10 신규 진입 국가: <b>${newc.country}</b> (UV ${fmtNum(newc.users)})` });
    }
  }

  return bullets;
}

// Section 3: channel insights
function buildChannelInsightBullets(site) {
  const d = cache[site.id];
  if (!d || !d.channels) return null;
  const chans = d.channels;
  const bullets = [];

  // 1) Biggest MoM mover (only if meaningful volume)
  let mover = null;
  sortedChannels(chans).forEach(c => {
    const m = chans[c];
    if (Math.max(m.cs, m.ps) < 50 || m.ps === 0) return;
    const delta = Math.abs(m.cs - m.ps);
    if (!mover || delta > mover.delta) mover = { ch: c, delta, m };
  });
  if (mover && mover.delta / mover.m.ps >= 0.15) {
    const chg = fmtPct(mover.m.cs, mover.m.ps);
    bullets.push({
      html: `당월 증감 주도 채널: <b>${mover.ch}</b> <span class="chg-${chg.dir}">${chg.text}</span> (${fmtNum(mover.m.ps)} → ${fmtNum(mover.m.cs)})`,
    });
  }

  // 2) Low-quality Direct warning (volume + low/dropping engagement)
  const dir = chans['Direct'];
  if (dir && dir.cs >= 100) {
    const erC = dir.cs > 0 ? dir.ces / dir.cs : 0;
    const erP = dir.ps > 0 ? dir.pes / dir.ps : null;
    const dropped = erP !== null && (erP - erC) >= 0.08;
    if (erC < 0.15 || (erC < 0.4 && dropped && dir.cs > dir.ps)) {
      bullets.push({
        warn: true,
        html: `Direct 참여율 ${(erC * 100).toFixed(1)}%${erP !== null ? ` (전월 ${(erP * 100).toFixed(1)}%)` : ''} — 세션 증가 대비 참여율이 낮아 봇/스캐너성 유입 의심`,
      });
    }
  }

  // 3) Newly appearing channels
  sortedChannels(chans).forEach(c => {
    const m = chans[c];
    if (m.ps === 0 && m.cs >= 5) {
      bullets.push({ html: `<b>${c}</b> 채널 신규 유입 (${fmtNum(m.cs)} 세션) — 월간 추적 권장` });
    }
  });

  return bullets;
}

function renderInsightGrid(elId, builder) {
  const grid = document.getElementById(elId);
  if (!grid) return;
  grid.innerHTML = '';

  CONFIG.SITES.forEach(site => {
    const bullets = builder(site);
    const card = document.createElement('div');
    card.className = 'insight-card';
    const header = `<div class="insight-card-header" style="background:${site.color}">${site.name}</div>`;
    if (bullets === null) {
      card.innerHTML = `${header}
        <div class="loading-state" style="padding:16px 0"><div class="loading-spinner"></div><br>로딩 중...</div>`;
    } else {
      card.innerHTML = `${header}
        <ul class="insight-list">${bullets.length > 0
          ? bullets.map(b => `<li class="${b.warn ? 'warn' : ''}">${b.warn ? '⚠️ ' : ''}${b.html}</li>`).join('')
          : '<li style="color:#9CA3AF">특이 사항 없음</li>'}</ul>`;
    }
    grid.appendChild(card);
  });
}

function renderInsightsView() {
  if (selectedYear) {
    const mLabel = fmtMonthLabel(selectedYear, selectedMonth);
    const t1 = document.getElementById('insightOverviewTitle');
    const t2 = document.getElementById('insightPagesTitle');
    const t3 = document.getElementById('insightChannelTitle');
    if (t1) t1.textContent = `법인별 Overview 인사이트: ${mLabel}`;
    if (t2) t2.textContent = `방문 페이지 · 방문 국가 분석: ${mLabel}`;
    if (t3) t3.textContent = `채널별 유입 분석: ${mLabel}`;
  }
  renderInsightGrid('insightOverviewGrid', buildOverviewInsightBullets);
  renderInsightGrid('insightPagesGrid', buildPagesInsightBullets);
  renderInsightGrid('insightChannelGrid', buildChannelInsightBullets);
}

// ── View Switching ────────────────────────────────

function switchView(view) {
  currentView = view;
  const dv = document.getElementById('dashboardView');
  const iv = document.getElementById('insightsView');
  if (dv) dv.style.display = view === 'dashboard' ? 'block' : 'none';
  if (iv) iv.style.display = view === 'insights' ? 'block' : 'none';
  document.querySelectorAll('.view-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo({ top: 0 });
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
      ? `<tr><td colspan="5" style="color:#9CA3AF;text-align:center">데이터 없음</td></tr>`
      : topCountries.map((c, idx) => `
          <tr style="background:${idx % 2 === 1 ? site.altRowColor : ''}">
            <td style="color:#6B7280">${c.rank}</td>
            <td>${c.country}</td>
            <td>${c.prevUsers !== null ? fmtNum(c.prevUsers) : '–'}</td>
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
            <tr><th>순위</th><th>국가</th><th>전월 UV</th><th>당월 UV</th><th>비중</th></tr>
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

  // Reset channel section + insights view (loading placeholders since cache is empty)
  renderChannelSection();
  renderInsightsView();

  // Load all 4 sites in parallel
  await Promise.all(CONFIG.SITES.map(site => loadOneSite(site)));
}

async function loadOneSite(site) {
  cache[site.id] = {};

  try {
    // Kick off all fetches in parallel
    const [summaryRes, yoyRes, trendRes, langsRes, topPagesRes, channelsRes] = await Promise.all([
      fetchSummary(site).catch(e => { console.error(`[${site.name}] summary:`, e.message); return null; }),
      fetchYoY(site).catch(e => { console.error(`[${site.name}] yoy:`, e.message); return null; }),
      fetchTrend(site).catch(e => { console.error(`[${site.name}] trend:`, e.message); return null; }),
      fetchLangs(site).catch(e => { console.error(`[${site.name}] langs:`, e.message); return null; }),
      fetchTopPages(site).catch(e => { console.error(`[${site.name}] topPages:`, e.message); return null; }),
      fetchChannels(site).catch(e => { console.error(`[${site.name}] channels:`, e.message); return null; }),
    ]);

    cache[site.id].summary = summaryRes;
    cache[site.id].yoy = yoyRes;
    cache[site.id].trend = trendRes;
    cache[site.id].langs = langsRes || {};
    cache[site.id].channels = channelsRes;

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

    // Update overview + channel analysis + insights with latest data
    renderOverview();
    renderChannelSection();
    renderInsightsView();

  } catch (err) {
    console.error(`[${site.name}] fatal:`, err.message);
    cache[site.id].error = err.message;
    renderSiteSection(site);
  }
}

// ── PDF 보고서 생성 ───────────────────────────────

// 캡처용 슬라이드 픽셀 폭 (16:9 → 1280 x 720)
const PDF_SLIDE_W = 1280;
const PDF_SLIDE_H = 720;

function setReportProgress(text) {
  const el = document.getElementById('reportProgress');
  if (el) el.textContent = text;
}

// 공통 슬라이드 헤더 (제목 + 주황 밑줄)
function slideHeaderHTML(title) {
  return `
    <div style="padding:40px 56px 0 56px">
      <div style="font-size:30px;font-weight:700;color:#1F2937;letter-spacing:-0.01em">${title}</div>
      <div style="height:4px;background:#E87722;margin-top:14px;border-radius:2px"></div>
    </div>`;
}

// 공통 슬라이드 푸터
function slideFooterHTML() {
  const yr = selectedYear || new Date().getFullYear();
  return `
    <div style="position:absolute;left:56px;right:56px;bottom:22px;display:flex;
                justify-content:space-between;align-items:center;
                font-size:12px;color:#9CA3AF;border-top:1px solid #F0F0F0;padding-top:10px">
      <span><span style="color:#E87722">● ● ●</span>&nbsp; KAON Group Corp.</span>
      <span>Copyright &copy; ${yr} KAON Group Co., Ltd. All rights reserved &nbsp;|&nbsp; Confidential</span>
    </div>`;
}

const KAON_LOGO_IMG = `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABnwAAAG7CAYAAADpMTtFAAAACXBIWXMAAC4jAAAuIwF4pT92AAAGdGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDIgNzkuMTYwOTI0LCAyMDE3LzA3LzEzLTAxOjA2OjM5ICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAxNy0xMi0yMFQxNTo0NDo1MCswOTowMCIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAxNy0xMi0yMFQxNTo0NDo1MCswOTowMCIgeG1wOk1vZGlmeURhdGU9IjIwMTctMTItMjBUMTU6NDQ6NTArMDk6MDAiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MWU4NTA2MmItZDBkYy0yZTRlLThmZWYtYmFiMjJhY2VhYzg2IiB4bXBNTTpEb2N1bWVudElEPSJhZG9iZTpkb2NpZDpwaG90b3Nob3A6OWNhZTRkMzMtYzI0ZC1iOTQ5LTk2ZjgtMWE1MWQ4YzczNzI5IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6MjE5YjRkYmEtMTBlZi1iZTQyLWFmMDAtNjQ5ZmI2MWY1NmRhIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIj4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDoyMTliNGRiYS0xMGVmLWJlNDItYWYwMC02NDlmYjYxZjU2ZGEiIHN0RXZ0OndoZW49IjIwMTctMTItMjBUMTU6NDQ6NTArMDk6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAoV2luZG93cykiLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjFlODUwNjJiLWQwZGMtMmU0ZS04ZmVmLWJhYjIyYWNlYWM4NiIgc3RFdnQ6d2hlbj0iMjAxNy0xMi0yMFQxNTo0NDo1MCswOTowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8L3JkZjpTZXE+IDwveG1wTU06SGlzdG9yeT4gPHBob3Rvc2hvcDpEb2N1bWVudEFuY2VzdG9ycz4gPHJkZjpCYWc+IDxyZGY6bGk+dXVpZDo3Mjk4RUUxNjk1MEVFMjExQkUzMEE4ODBGODNDOUMxNDwvcmRmOmxpPiA8L3JkZjpCYWc+IDwvcGhvdG9zaG9wOkRvY3VtZW50QW5jZXN0b3JzPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PrHntPkAAGvpSURBVHic7d3NcSPLmfXxI8XssJgaCyo7ygAVLRBogUALBFpwQQdAEg6Q1wJCFpCygLgWNGQAogsWvJgF1vMuMvs2m81PoKqeysz/L6Lj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" alt="KAON" style="height:54px;display:block" />`;

// 오프스크린에 슬라이드 DOM을 만들어 html2canvas로 캡처 후 제거
async function captureSlideHTML(innerHTML, { height = PDF_SLIDE_H } = {}) {
  const slide = document.createElement('div');
  slide.style.cssText =
    `position:fixed;left:-99999px;top:0;width:${PDF_SLIDE_W}px;height:${height}px;` +
    `background:#fff;box-sizing:border-box;font-family:'Noto Sans KR',sans-serif;overflow:hidden`;
  slide.innerHTML = innerHTML;
  document.body.appendChild(slide);
  try {
    return await html2canvas(slide, { scale: 2, backgroundColor: '#fff', logging: false, useCORS: true });
  } finally {
    slide.remove();
  }
}

// 화면에 렌더된 실제 요소를 캡처
async function captureElement(el) {
  return html2canvas(el, { scale: 2, backgroundColor: '#fff', logging: false, useCORS: true });
}

// 캔버스를 PDF 한 페이지(가로 16:9)에 꽉 차게(여백 포함) 배치
function addCanvasPage(pdf, canvas, isFirst) {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  if (!isFirst) pdf.addPage();

  const margin = 0;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const ratio = Math.min(availW / canvas.width, availH / canvas.height);
  const w = canvas.width * ratio;
  const h = canvas.height * ratio;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, w, h);
}

// 여러 캔버스를 공통 폭으로 맞춰 한 페이지에 세로로 쌓아 배치 (가운데 정렬)
function addStackedPage(pdf, canvases, isFirst) {
  const list = canvases.filter(Boolean);
  if (list.length === 0) return;

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  if (!isFirst) pdf.addPage();

  const marginX = 30;
  const marginY = 26;
  const gap = 10;
  const availW = pageW - marginX * 2;
  const availH = pageH - marginY * 2;

  // 모든 캔버스를 동일한 표시 폭(availW)으로 맞췄을 때의 높이 합산
  const baseHeights = list.map(c => c.height * (availW / c.width));
  const totalH = baseHeights.reduce((s, h) => s + h, 0) + gap * (list.length - 1);

  // 페이지 높이를 넘으면 전체 축소
  const s = Math.min(1, availH / totalH);
  const finalW = availW * s;
  const x = (pageW - finalW) / 2;
  let y = (pageH - totalH * s) / 2;

  list.forEach((c, i) => {
    const h = baseHeights[i] * s;
    pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, finalW, h);
    y += h + gap * s;
  });
}

// PPT 형식 흰색 제목 띠 (제목 + 주황 밑줄)를 오프스크린으로 캡처
async function captureTitleStrip(title) {
  return captureSlideHTML(`
    <div style="padding:26px 56px 0 56px">
      <div style="font-size:30px;font-weight:700;color:#1F2937;letter-spacing:-0.01em">${title}</div>
      <div style="height:4px;background:#E87722;margin-top:12px;border-radius:2px"></div>
    </div>`, { height: 116 });
}

async function generateReport() {
  if (!accessToken) { alert('먼저 로그인해 주세요.'); return; }

  const btn = document.getElementById('reportBtn');
  const overlay = document.getElementById('reportOverlay');
  btn.disabled = true;
  overlay.style.display = 'flex';
  setReportProgress('데이터 준비 중…');

  try {
    // 캡처 대상은 대시보드 뷰의 요소이므로, 인사이트 탭이 열려 있으면 전환
    if (currentView !== 'dashboard') switchView('dashboard');
    // 데이터가 아직 없으면 로드
    const anyLoaded = CONFIG.SITES.some(s => cache[s.id] && cache[s.id].summary);
    if (!anyLoaded) {
      await loadAllSites();
    }
    // 차트 애니메이션이 끝나도록 잠시 대기
    await new Promise(r => setTimeout(r, 400));

    const { jsPDF } = window.jspdf;
    // PPT와 동일한 16:9 비율 (pt 단위 960 x 540)
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [960, 540] });

    const mEn = fmtMonthLabelEn(selectedYear, selectedMonth);
    let first = true;

    // ── 1) 표지 ──
    setReportProgress('표지 생성 중…');
    const coverCanvas = await captureSlideHTML(`
      <div style="position:relative;width:100%;height:100%;
                  background:linear-gradient(135deg,#fff 60%,#FDF4EC 100%)">
        <div style="position:absolute;top:70px;left:64px">${KAON_LOGO_IMG}</div>
        <div style="position:absolute;top:230px;left:64px">
          <div style="font-size:64px;font-weight:700;color:#1F2937;line-height:1.15">
            Website Monthly Traffic<br>Report &nbsp;- ${mEn}
          </div>
          <div style="margin-top:24px;font-size:24px;color:#9CA3AF">Marketing Team</div>
        </div>
        <div style="position:absolute;right:64px;bottom:60px;text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:0.15em;color:#E87722">CONNECTED +</div>
          <div style="margin-top:8px;font-size:11px;color:#9CA3AF">
            Copyright &copy; ${selectedYear} KAON Group Co., Ltd. All rights reserved &nbsp;|&nbsp; Confidential
          </div>
        </div>
      </div>`);
    addCanvasPage(pdf, coverCanvas, first); first = false;

    // ── 2) Web Analytics Overview ──
    setReportProgress('전체 개요 슬라이드 캡처 중…');
    const overviewEl = document.querySelector('.report-section');
    if (overviewEl) {
      const c = await captureElement(overviewEl);
      addCanvasPage(pdf, c, first); first = false;
    }
    // 참고: 채널별 유입 분석(#channelSection)은 화면 전용 — PDF 보고서에는 포함하지 않음

    // ── 3) 사이트별 상세 (사이트당 2페이지) ──
    const sites = CONFIG.SITES;
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      setReportProgress(`${site.name} 슬라이드 캡처 중… (${i + 1}/${sites.length})`);
      const el = document.getElementById(`detail-${site.id}`);
      if (!el) continue;

      const headerBar   = el.querySelector('.site-header-bar');
      const overviewRow = el.querySelector('.site-overview-row');
      const detailRow   = el.querySelector('.site-detail-row');
      const topRow      = el.querySelector('.site-top-row');

      // 페이지 A: Web Traffic Overview (KPI + 추이 + 언어 테이블 + 파이)
      const titleA = await captureTitleStrip(`[${site.name}] Web Traffic Overview: ${mEn}`);
      const capHeader   = headerBar   ? await captureElement(headerBar)   : null;
      const capOverview = overviewRow ? await captureElement(overviewRow) : null;
      const capDetail   = detailRow   ? await captureElement(detailRow)   : null;
      addStackedPage(pdf, [titleA, capHeader, capOverview, capDetail], first);
      first = false;

      // 페이지 B: Top Pages (& Countries)
      const titleBText = site.showCountries
        ? `[${site.name}] Web Top Pages & Countries: ${mEn}`
        : `[${site.name}] Web Top Pages: ${mEn}`;
      const titleB = await captureTitleStrip(titleBText);
      const capTop = topRow ? await captureElement(topRow) : null;
      addStackedPage(pdf, [titleB, capTop], first);
      first = false;
    }

    // ── 4) Thank You ──
    setReportProgress('마무리 슬라이드 생성 중…');
    const thanksCanvas = await captureSlideHTML(`
      <div style="position:relative;width:100%;height:100%;
                  background:linear-gradient(135deg,#fff 55%,#FDF4EC 100%);
                  display:flex;flex-direction:column;align-items:center;justify-content:center">
        <div style="margin-bottom:8px">${KAON_LOGO_IMG}</div>
        <div style="font-size:56px;font-weight:300;color:#9CA3AF;letter-spacing:0.04em">THANK YOU</div>
        <div style="position:absolute;right:64px;bottom:60px;text-align:right">
          <div style="font-size:18px;font-weight:700;letter-spacing:0.15em;color:#E87722">CONNECTED +</div>
          <div style="margin-top:8px;font-size:11px;color:#9CA3AF">
            Copyright &copy; ${selectedYear} KAON Group Co., Ltd. All rights reserved &nbsp;|&nbsp; Confidential
          </div>
        </div>
      </div>`);
    addCanvasPage(pdf, thanksCanvas, first);

    setReportProgress('PDF 저장 중…');
    const fname = `KAON_Website_Traffic_Report_${selectedYear}_${String(selectedMonth).padStart(2, '0')}.pdf`;
    pdf.save(fname);
  } catch (err) {
    console.error('[Report] 생성 실패:', err);
    alert('보고서 생성 중 오류가 발생했습니다.\n' + (err.message || err));
  } finally {
    overlay.style.display = 'none';
    btn.disabled = false;
  }
}

// ── Auth ──────────────────────────────────────────

const TOKEN_STORAGE_KEY = 'kaon_ga_token';
const TOKEN_EXPIRY_KEY  = 'kaon_ga_token_expiry';

function saveToken(token, expiresIn) {
  // expires_in은 초 단위; 5분 버퍼를 빼서 만료 직전 재사용을 방지
  const expiresAt = Date.now() + (Number(expiresIn || 3600) - 300) * 1000;
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(expiresAt));
}

function loadCachedToken() {
  const token  = localStorage.getItem(TOKEN_STORAGE_KEY);
  const expiry = Number(localStorage.getItem(TOKEN_EXPIRY_KEY) || 0);
  return (token && Date.now() < expiry) ? token : null;
}

function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

function initAuth() {
  if (!window.google) { setTimeout(initAuth, 300); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: onAuthSuccess,
    error_callback: onAuthError,
  });

  // 유효한 캐시 토큰이 있으면 로그인 화면 없이 바로 대시보드 로드
  const cached = loadCachedToken();
  if (cached) {
    accessToken = cached;
    showDashboard();
    loadAllSites();
  } else {
    document.getElementById('loginBtn').style.display = 'inline-flex';
  }
}

function onAuthSuccess(resp) {
  if (resp.error) { onAuthError(resp); return; }
  accessToken = resp.access_token;
  saveToken(resp.access_token, resp.expires_in);
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
  clearToken();
  accessToken = null;
  // 팝업 없이 자동 갱신 시도; 실패하면 로그인 화면으로 이동
  if (tokenClient) {
    tokenClient.requestAccessToken({ prompt: '' });
  } else {
    showLoginScreen();
  }
}

function login() {
  if (!tokenClient) { alert('Google 라이브러리 로딩 중입니다. 잠시 후 다시 시도해 주세요.'); return; }
  // prompt: '' → 이미 동의한 계정은 화면 없이 바로 토큰 발급
  tokenClient.requestAccessToken({ prompt: '' });
}

function logout() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  clearToken();
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

  document.getElementById('reportBtn').addEventListener('click', generateReport);

  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('monthPicker').addEventListener('change', () => {
    applyMonthPicker();
    if (accessToken) loadAllSites();
  });
});

// ── Init ──────────────────────────────────────────

window.addEventListener('load', () => {
  // 캐시 토큰 여부는 initAuth 내부에서 판단 → 여기선 로그인 화면만 기본 표시
  showLoginScreen();
  initAuth();
});
