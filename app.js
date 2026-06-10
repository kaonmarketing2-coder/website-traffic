// =====================================================
// Kaon Group - GA4 Traffic Dashboard
// =====================================================

const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

let tokenClient = null;
let accessToken = null;
let currentDays = 30;

// 캐시: siteData[siteId][langCode] = { totals, rows }
const siteData = {};
// 현재 선택된 언어 탭: activeLang[siteId] = langCode
const activeLang = {};
// Chart 인스턴스
const charts = {};

// ── 날짜 / 포맷 유틸 ─────────────────────────────

function getDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('ko-KR');
}

function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPct(val) {
  if (val === null || isNaN(val)) return '–';
  return (val * 100).toFixed(1) + '%';
}

// ── GA4 API ──────────────────────────────────────

function buildDimensionFilter(filterField, filterValue) {
  if (!filterValue) return null;
  return {
    dimensionFilter: {
      filter: {
        fieldName: filterField,
        stringFilter: { matchType: 'CONTAINS', value: filterValue, caseSensitive: false },
      },
    },
  };
}

async function runReport(propertyId, days, filterField, filterValue) {
  const { startDate, endDate } = getDateRange(days);
  const body = {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' },
      { name: 'newUsers' },
    ],
    dimensions: [{ name: 'date' }],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    metricAggregations: ['TOTAL'],
    ...buildDimensionFilter(filterField, filterValue),
  };

  const res = await fetch(`${GA4_API}/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) { handleAuthExpired(); throw new Error('인증 만료'); }
  if (res.status === 403) throw new Error('접근 권한 없음 (GA4 속성에 뷰어 권한을 추가해 주세요)');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 오류 (${res.status})`);
  }
  return res.json();
}

function parseReport(data) {
  const rows = (data.rows || []).map(r => ({
    date: r.dimensionValues[0].value,
    sessions:     Number(r.metricValues[0].value),
    users:        Number(r.metricValues[1].value),
    pageviews:    Number(r.metricValues[2].value),
    bounceRate:   Number(r.metricValues[3].value),
    avgDuration:  Number(r.metricValues[4].value),
    newUsers:     Number(r.metricValues[5].value),
  }));
  const t = data.totals?.[0]?.metricValues || [];
  return {
    rows,
    totals: {
      sessions:    Number(t[0]?.value || 0),
      users:       Number(t[1]?.value || 0),
      pageviews:   Number(t[2]?.value || 0),
      bounceRate:  Number(t[3]?.value || 0),
      avgDuration: Number(t[4]?.value || 0),
      newUsers:    Number(t[5]?.value || 0),
    },
  };
}

// ── Auth ─────────────────────────────────────────

function initAuth() {
  if (!window.google) { setTimeout(initAuth, 300); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: onAuthSuccess,
    error_callback: onAuthError,
  });
}

function onAuthSuccess(resp) {
  if (resp.error) { onAuthError(resp); return; }
  accessToken = resp.access_token;
  showDashboard();
  loadAll();
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
  if (CONFIG.OAUTH_CLIENT_ID.includes('YOUR_')) { alert('config.js에서 OAUTH_CLIENT_ID를 설정해 주세요.'); return; }
  tokenClient.requestAccessToken({ prompt: '' });
}

function logout() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  accessToken = null;
  destroyAllCharts();
  showLoginScreen();
}

// ── UI 상태 ──────────────────────────────────────

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('headerControls').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('headerControls').style.display = 'flex';
}

function setLastUpdated() {
  const str = new Date().toLocaleString('ko-KR', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  document.getElementById('lastUpdated').textContent = `마지막 업데이트: ${str}`;
}

function destroyAllCharts() {
  Object.values(charts).forEach(c => c?.destroy?.());
  Object.keys(charts).forEach(k => delete charts[k]);
}

// ── 언어 탭 렌더링 ────────────────────────────────

function renderLangTabs(site) {
  return site.languages.map(lang => `
    <button
      class="lang-tab${lang.code === 'all' ? ' active' : ''}"
      data-site="${site.id}"
      data-lang="${lang.code}"
      style="--site-color:${site.color}"
    >${lang.label}</button>
  `).join('');
}

// ── 메트릭 HTML ──────────────────────────────────

function metricsHTML(totals, color) {
  const items = [
    { v: fmtNum(totals.sessions),        l: '세션' },
    { v: fmtNum(totals.users),           l: '사용자' },
    { v: fmtNum(totals.pageviews),       l: '페이지뷰' },
    { v: fmtPct(totals.bounceRate),      l: '이탈률' },
    { v: fmtDuration(totals.avgDuration),l: '평균 체류시간' },
    { v: fmtNum(totals.newUsers),        l: '신규 사용자' },
  ];
  return items.map((item, i) => `
    <div class="metric-item">
      <div class="metric-value${i === 0 ? '" style="color:' + color + '"' : '"'}>${item.v}</div>
      <div class="metric-label">${item.l}</div>
    </div>
  `).join('');
}

function skeletonMetrics() {
  return Array(6).fill(`
    <div class="metric-item">
      <div class="skeleton skeleton-number" style="margin:0 auto 6px"></div>
      <div class="skeleton skeleton-text" style="width:55%;margin:0 auto"></div>
    </div>
  `).join('');
}

// ── 사이트 카드 생성 ─────────────────────────────

function buildSiteCard(site) {
  const card = document.createElement('div');
  card.className = 'site-card';
  card.id = `card-${site.id}`;
  card.style.setProperty('--site-color', site.color);

  card.innerHTML = `
    <div class="site-card-header">
      <div class="site-card-title">
        <h3>${site.name}</h3>
        <div class="site-url">${site.url}</div>
      </div>
      <div class="site-status" id="status-${site.id}">
        <div class="status-dot loading"></div><span>로딩 중</span>
      </div>
    </div>

    <div class="lang-tabs" id="tabs-${site.id}">
      ${renderLangTabs(site)}
    </div>

    <div class="metrics-grid" id="metrics-${site.id}">
      ${skeletonMetrics()}
    </div>

    <div class="mini-chart-wrap">
      <canvas id="mini-${site.id}"></canvas>
    </div>
  `;
  return card;
}

// ── 트렌드 카드 생성 ─────────────────────────────

function buildTrendCard(site) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = `trend-card-${site.id}`;
  card.innerHTML = `
    <div class="trend-header">
      <h3 style="color:${site.color}">${site.name}</h3>
      <div class="lang-tabs lang-tabs-sm" id="trend-tabs-${site.id}">
        ${renderLangTabs(site)}
      </div>
    </div>
    <div class="chart-wrap">
      <canvas id="trend-${site.id}"></canvas>
    </div>
  `;
  return card;
}

// ── 언어별 비교 카드 생성 ────────────────────────

function buildLangCompareCard(site) {
  const card = document.createElement('div');
  card.className = 'chart-card lang-compare-card';
  card.id = `lang-compare-card-${site.id}`;
  card.innerHTML = `
    <h3 style="color:${site.color}">${site.name} — 언어별 비교</h3>
    <div class="chart-wrap chart-wrap-md">
      <canvas id="lang-compare-${site.id}"></canvas>
    </div>
  `;
  return card;
}

// ── 차트: 미니 라인 ──────────────────────────────

function renderMiniChart(site, langCode) {
  const data = siteData[site.id]?.[langCode];
  if (!data) return;
  const canvasId = `mini-${site.id}`;
  charts[canvasId]?.destroy();
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels: data.rows.map(r => fmtDate(r.date)),
      datasets: [{
        data: data.rows.map(r => r.sessions),
        borderColor: site.color,
        backgroundColor: site.bgColor,
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
      animation: { duration: 300 },
    },
  });
}

// ── 차트: 트렌드 라인 ────────────────────────────

function renderTrendChart(site, langCode) {
  const data = siteData[site.id]?.[langCode];
  if (!data) return;
  const canvasId = `trend-${site.id}`;
  charts[canvasId]?.destroy();
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels: data.rows.map(r => fmtDate(r.date)),
      datasets: [
        {
          label: '세션',
          data: data.rows.map(r => r.sessions),
          borderColor: site.color,
          backgroundColor: site.bgColor,
          borderWidth: 2,
          pointRadius: data.rows.length <= 14 ? 3 : 0,
          fill: true,
          tension: 0.4,
        },
        {
          label: '사용자',
          data: data.rows.map(r => r.users),
          borderColor: site.color + '88',
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
      },
      scales: {
        x: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 }, maxTicksLimit: 10 } },
        y: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } }, beginAtZero: true },
      },
    },
  });
}

// ── 차트: 언어별 바 차트 ─────────────────────────

function renderLangCompareChart(site) {
  const langs = site.languages.filter(l => l.code !== 'all');
  const canvasId = `lang-compare-${site.id}`;
  charts[canvasId]?.destroy();

  const sessions = langs.map(l => siteData[site.id]?.[l.code]?.totals?.sessions ?? 0);
  const users    = langs.map(l => siteData[site.id]?.[l.code]?.totals?.users ?? 0);

  // 알파값을 변경한 색상 팔레트 (같은 계열, 밝기 차이)
  const alpha = ['FF', 'CC', 'AA', '88', '66'];
  const colors = langs.map((_, i) => site.color + (alpha[i] || '88'));

  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: langs.map(l => l.label),
      datasets: [
        {
          label: '세션',
          data: sessions,
          backgroundColor: colors,
          borderColor: langs.map(() => site.color),
          borderWidth: 2,
          borderRadius: 5,
        },
        {
          label: '사용자',
          data: users,
          backgroundColor: langs.map(() => site.color + '44'),
          borderColor: langs.map(() => site.color + '99'),
          borderWidth: 1.5,
          borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } }, beginAtZero: true },
      },
    },
  });
}

// ── 전체 사이트 비교 차트 ────────────────────────

function renderOverviewCompareCharts() {
  const labels = CONFIG.SITES.map(s => s.name);
  const colors = CONFIG.SITES.map(s => s.color);

  ['sessions', 'users'].forEach(metric => {
    const canvasId = metric === 'sessions' ? 'overviewSessionsChart' : 'overviewUsersChart';
    charts[canvasId]?.destroy();
    charts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: metric === 'sessions' ? '세션' : '사용자',
          data: CONFIG.SITES.map(s => siteData[s.id]?.['all']?.totals?.[metric] ?? 0),
          backgroundColor: colors.map(c => c + 'CC'),
          borderColor: colors,
          borderWidth: 2,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { grid: { color: '#EEF2F7' }, ticks: { font: { size: 11 } }, beginAtZero: true },
        },
      },
    });
  });
}

// ── 사이트 카드 상태 업데이트 ────────────────────

function setSiteLoaded(site) {
  const statusEl = document.getElementById(`status-${site.id}`);
  if (statusEl) statusEl.innerHTML = `<div class="status-dot"></div><span>연결됨</span>`;
}

function setSiteError(site, message) {
  const statusEl = document.getElementById(`status-${site.id}`);
  if (statusEl) statusEl.innerHTML = `<div class="status-dot error"></div><span style="color:#EF4444">오류</span>`;
  const metricsEl = document.getElementById(`metrics-${site.id}`);
  if (metricsEl) metricsEl.innerHTML = `<div class="error-msg" style="grid-column:1/-1">${message}</div>`;
}

// ── 탭 클릭 → 메트릭 & 차트 갱신 ────────────────

function switchLang(siteId, langCode, isCard) {
  const site = CONFIG.SITES.find(s => s.id === siteId);
  if (!site) return;

  activeLang[siteId] = langCode;

  // 탭 active 클래스 업데이트 (카드탭 또는 트렌드탭)
  const tabsContainerId = isCard ? `tabs-${siteId}` : `trend-tabs-${siteId}`;
  document.querySelectorAll(`#${tabsContainerId} .lang-tab`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === langCode);
  });

  const data = siteData[siteId]?.[langCode];
  if (!data) return;

  if (isCard) {
    // 카드 메트릭 업데이트
    const metricsEl = document.getElementById(`metrics-${siteId}`);
    if (metricsEl) metricsEl.innerHTML = metricsHTML(data.totals, site.color);
    renderMiniChart(site, langCode);
  } else {
    // 트렌드 차트 업데이트
    renderTrendChart(site, langCode);
  }
}

// ── 대시보드 구조 생성 ────────────────────────────

function buildDashboard() {
  // Sites grid
  const sitesGrid = document.getElementById('sitesGrid');
  sitesGrid.innerHTML = '';
  CONFIG.SITES.forEach(site => {
    activeLang[site.id] = 'all';
    sitesGrid.appendChild(buildSiteCard(site));
  });

  // Trend grid
  const trendGrid = document.getElementById('trendGrid');
  trendGrid.innerHTML = '';
  CONFIG.SITES.forEach(site => trendGrid.appendChild(buildTrendCard(site)));

  // Language compare grid
  const langCompareGrid = document.getElementById('langCompareGrid');
  langCompareGrid.innerHTML = '';
  CONFIG.SITES.forEach(site => langCompareGrid.appendChild(buildLangCompareCard(site)));
}

// ── 데이터 로드 ──────────────────────────────────

async function loadSite(site) {
  if (site.propertyId.includes('YOUR_')) {
    setSiteError(site, 'config.js에서 Property ID를 설정해 주세요.');
    return;
  }

  siteData[site.id] = {};
  let allError = null;

  // 모든 언어 병렬 로드
  await Promise.all(site.languages.map(async lang => {
    try {
      const report = await runReport(site.propertyId, currentDays, site.filterField, lang.filterValue);
      siteData[site.id][lang.code] = parseReport(report);
    } catch (err) {
      console.error(`[${site.name}/${lang.label}]`, err);
      siteData[site.id][lang.code] = null;
      if (lang.code === 'all') allError = err.message;
    }
  }));

  // 로드 완료 후 UI 갱신 ('all' 탭 기준으로 초기 렌더)
  const allData = siteData[site.id]['all'];
  if (allData) {
    setSiteLoaded(site);
    const metricsEl = document.getElementById(`metrics-${site.id}`);
    if (metricsEl) metricsEl.innerHTML = metricsHTML(allData.totals, site.color);
    renderMiniChart(site, 'all');
    renderTrendChart(site, 'all');
  } else {
    setSiteError(site, allError || '데이터를 불러오지 못했습니다.');
  }
  renderLangCompareChart(site);
}

async function loadAll() {
  buildDashboard();
  destroyAllCharts();

  // 4개 사이트 병렬 로드
  await Promise.all(CONFIG.SITES.map(loadSite));

  renderOverviewCompareCharts();
  setLastUpdated();
}

// ── 이벤트 위임 (언어 탭 클릭) ──────────────────

document.addEventListener('click', e => {
  const btn = e.target.closest('.lang-tab');
  if (!btn) return;
  const { site, lang } = btn.dataset;
  // 카드 탭인지 트렌드 탭인지 구분
  const isCard = !!btn.closest(`#tabs-${site}`);
  switchLang(site, lang, isCard);
});

// ── 헤더 버튼 ────────────────────────────────────

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('loginBtnMain').addEventListener('click', login);
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('refreshBtn').addEventListener('click', () => {
  if (accessToken) loadAll();
});
document.getElementById('dateRange').addEventListener('change', function () {
  currentDays = Number(this.value);
  if (accessToken) loadAll();
});

// ── 초기화 ───────────────────────────────────────

window.addEventListener('load', () => {
  initAuth();
  showLoginScreen();
});
