// =====================================================
// Kaon Group - GA4 Traffic Dashboard
// =====================================================

const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

let tokenClient = null;
let accessToken = null;
let siteCharts = {};  // { siteId: Chart instance }
let compareCharts = {};
let currentDays = 30;
let siteData = {};    // { siteId: { totals, rows } }

// ── 날짜 유틸 ──────────────────────────────────────

function getDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days + 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function formatDate(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

function fmtDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '-';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPercent(val) {
  if (val === null || isNaN(val)) return '-';
  return (val * 100).toFixed(1) + '%';
}

// ── GA4 API ────────────────────────────────────────

async function runReport(propertyId, days) {
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
  };

  const res = await fetch(`${GA4_API}/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    handleAuthExpired();
    throw new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (res.status === 403) {
    throw new Error('이 속성에 대한 접근 권한이 없습니다.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 오류 (${res.status})`);
  }

  return res.json();
}

function parseReport(reportData) {
  const rows = (reportData.rows || []).map(row => ({
    date: row.dimensionValues[0].value,
    sessions: Number(row.metricValues[0].value),
    users: Number(row.metricValues[1].value),
    pageviews: Number(row.metricValues[2].value),
    bounceRate: Number(row.metricValues[3].value),
    avgDuration: Number(row.metricValues[4].value),
    newUsers: Number(row.metricValues[5].value),
  }));

  const totalsRaw = reportData.totals?.[0]?.metricValues || [];
  const totals = {
    sessions: Number(totalsRaw[0]?.value || 0),
    users: Number(totalsRaw[1]?.value || 0),
    pageviews: Number(totalsRaw[2]?.value || 0),
    bounceRate: Number(totalsRaw[3]?.value || 0),
    avgDuration: Number(totalsRaw[4]?.value || 0),
    newUsers: Number(totalsRaw[5]?.value || 0),
  };

  return { rows, totals };
}

// ── Auth ──────────────────────────────────────────

function initAuth() {
  if (!window.google) {
    setTimeout(initAuth, 300);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: onAuthSuccess,
    error_callback: onAuthError,
  });
}

function onAuthSuccess(resp) {
  if (resp.error) {
    onAuthError(resp);
    return;
  }
  accessToken = resp.access_token;
  showDashboard();
  loadAllSites();
}

function onAuthError(err) {
  console.error('Auth error:', err);
  const msg = err.type === 'popup_closed' ? '로그인 창이 닫혔습니다.' : '로그인 중 오류가 발생했습니다.';
  alert(msg);
}

function handleAuthExpired() {
  accessToken = null;
  showLoginScreen();
}

function login() {
  if (!tokenClient) {
    alert('Google 라이브러리가 아직 로딩 중입니다. 잠시 후 다시 시도해 주세요.');
    return;
  }
  if (CONFIG.OAUTH_CLIENT_ID.includes('YOUR_')) {
    alert('config.js에서 OAUTH_CLIENT_ID를 설정해 주세요.');
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

function logout() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
  destroyAllCharts();
  showLoginScreen();
}

// ── UI 상태 ───────────────────────────────────────

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
  const now = new Date();
  const str = now.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('lastUpdated').textContent = `마지막 업데이트: ${str}`;
}

// ── 대시보드 렌더링 ──────────────────────────────

function buildDashboard() {
  const sitesGrid = document.getElementById('sitesGrid');
  const trendGrid = document.getElementById('trendGrid');
  sitesGrid.innerHTML = '';
  trendGrid.innerHTML = '';

  CONFIG.SITES.forEach(site => {
    sitesGrid.appendChild(createSiteCard(site));
    trendGrid.appendChild(createTrendCard(site));
  });

  buildCompareCharts();
}

function createSiteCard(site) {
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
        <div class="status-dot loading"></div>
        <span>로딩 중</span>
      </div>
    </div>
    <div class="metrics-grid" id="metrics-${site.id}">
      ${['세션', '사용자', '페이지뷰', '이탈률', '평균 체류시간', '신규 사용자'].map(() => `
        <div class="metric-item">
          <div class="skeleton skeleton-number" style="margin:0 auto 4px;"></div>
          <div class="skeleton skeleton-text" style="width:60%;margin:0 auto;"></div>
        </div>
      `).join('')}
    </div>
    <div class="mini-chart-wrap">
      <canvas id="mini-chart-${site.id}"></canvas>
    </div>
  `;

  return card;
}

function createTrendCard(site) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.innerHTML = `
    <h3 style="color:${site.color}">${site.name} — 일별 트래픽</h3>
    <div class="chart-wrap">
      <canvas id="trend-chart-${site.id}"></canvas>
    </div>
  `;
  return card;
}

function renderSiteCard(site, data) {
  const { totals, rows } = data;

  // 상태 업데이트
  const statusEl = document.getElementById(`status-${site.id}`);
  statusEl.innerHTML = `<div class="status-dot"></div><span>연결됨</span>`;

  // 메트릭 렌더링
  const metricsEl = document.getElementById(`metrics-${site.id}`);
  metricsEl.innerHTML = `
    <div class="metric-item">
      <div class="metric-value" style="color:${site.color}">${fmtNum(totals.sessions)}</div>
      <div class="metric-label">세션</div>
    </div>
    <div class="metric-item">
      <div class="metric-value">${fmtNum(totals.users)}</div>
      <div class="metric-label">사용자</div>
    </div>
    <div class="metric-item">
      <div class="metric-value">${fmtNum(totals.pageviews)}</div>
      <div class="metric-label">페이지뷰</div>
    </div>
    <div class="metric-item">
      <div class="metric-value">${fmtPercent(totals.bounceRate)}</div>
      <div class="metric-label">이탈률</div>
    </div>
    <div class="metric-item">
      <div class="metric-value">${fmtDuration(totals.avgDuration)}</div>
      <div class="metric-label">평균 체류시간</div>
    </div>
    <div class="metric-item">
      <div class="metric-value">${fmtNum(totals.newUsers)}</div>
      <div class="metric-label">신규 사용자</div>
    </div>
  `;

  // 미니 차트
  const miniCtx = document.getElementById(`mini-chart-${site.id}`);
  if (siteCharts[`mini-${site.id}`]) {
    siteCharts[`mini-${site.id}`].destroy();
  }
  siteCharts[`mini-${site.id}`] = new Chart(miniCtx, {
    type: 'line',
    data: {
      labels: rows.map(r => formatDate(r.date)),
      datasets: [{
        data: rows.map(r => r.sessions),
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
      scales: { x: { display: false }, y: { display: false } },
      animation: { duration: 400 },
    },
  });

  // 트렌드 차트
  const trendCtx = document.getElementById(`trend-chart-${site.id}`);
  if (siteCharts[`trend-${site.id}`]) {
    siteCharts[`trend-${site.id}`].destroy();
  }
  siteCharts[`trend-${site.id}`] = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: rows.map(r => formatDate(r.date)),
      datasets: [
        {
          label: '세션',
          data: rows.map(r => r.sessions),
          borderColor: site.color,
          backgroundColor: site.bgColor,
          borderWidth: 2,
          pointRadius: rows.length <= 14 ? 3 : 0,
          fill: true,
          tension: 0.4,
          yAxisID: 'y',
        },
        {
          label: '사용자',
          data: rows.map(r => r.users),
          borderColor: site.color + '99',
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.4,
          yAxisID: 'y',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { mode: 'index' },
      },
      scales: {
        x: {
          grid: { color: '#F0F4F8' },
          ticks: { font: { size: 11 }, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: '#F0F4F8' },
          ticks: { font: { size: 11 } },
          beginAtZero: true,
        },
      },
    },
  });
}

function setSiteError(site, message) {
  const statusEl = document.getElementById(`status-${site.id}`);
  statusEl.innerHTML = `<div class="status-dot error"></div><span style="color:#EF4444">오류</span>`;

  const metricsEl = document.getElementById(`metrics-${site.id}`);
  metricsEl.innerHTML = `<div class="error-msg" style="grid-column:1/-1">${message}</div>`;
}

function buildCompareCharts() {
  const labels = CONFIG.SITES.map(s => s.name);
  const sessionData = CONFIG.SITES.map(s => siteData[s.id]?.totals?.sessions || 0);
  const userColors = CONFIG.SITES.map(s => s.color);

  // Sessions compare
  const sessCtx = document.getElementById('sessionsCompareChart');
  if (compareCharts.sessions) compareCharts.sessions.destroy();
  compareCharts.sessions = new Chart(sessCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '세션',
        data: sessionData,
        backgroundColor: userColors.map(c => c + 'CC'),
        borderColor: userColors,
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F0F4F8' }, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });

  // Users compare
  const usersCtx = document.getElementById('usersCompareChart');
  if (compareCharts.users) compareCharts.users.destroy();
  compareCharts.users = new Chart(usersCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '사용자',
        data: CONFIG.SITES.map(s => siteData[s.id]?.totals?.users || 0),
        backgroundColor: userColors.map(c => c + 'CC'),
        borderColor: userColors,
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F0F4F8' }, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

function destroyAllCharts() {
  Object.values(siteCharts).forEach(c => c?.destroy());
  Object.values(compareCharts).forEach(c => c?.destroy());
  siteCharts = {};
  compareCharts = {};
}

// ── 데이터 로드 ───────────────────────────────────

async function loadAllSites() {
  const days = currentDays;
  buildDashboard();

  const promises = CONFIG.SITES.map(async site => {
    try {
      if (site.propertyId.includes('YOUR_')) {
        throw new Error('config.js에서 Property ID를 설정해 주세요.');
      }
      const report = await runReport(site.propertyId, days);
      const data = parseReport(report);
      siteData[site.id] = data;
      renderSiteCard(site, data);
    } catch (err) {
      console.error(`[${site.name}] 오류:`, err);
      setSiteError(site, err.message);
    }
  });

  await Promise.all(promises);
  buildCompareCharts();
  setLastUpdated();
}

// ── 이벤트 바인딩 ─────────────────────────────────

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('loginBtnMain').addEventListener('click', login);
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('refreshBtn').addEventListener('click', loadAllSites);

document.getElementById('dateRange').addEventListener('change', function () {
  currentDays = Number(this.value);
  if (accessToken) loadAllSites();
});

// ── 초기화 ───────────────────────────────────────

window.addEventListener('load', () => {
  initAuth();
  showLoginScreen();
});
