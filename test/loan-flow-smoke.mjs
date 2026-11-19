// Chrome integration check with the official URL intercepted and fictional data.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CampusBrowser } from '../src/browser.mjs';
import { makeConfig } from '../src/config.mjs';
import { runLoanFlow } from '../src/loan-flow.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'tongji-loans-test-'));
const browser = new CampusBrowser({ ...makeConfig(), headless: true, dataDir });
const settings = { now: new Date('2026-11-19T16:00:00Z'), waitMs: 1700 };
const entry = 'https://webpac.tongji.edu.cn/opac/openlink.php#/personalCenter';
const endpoint = '/find/loanInfo/loanList';
let fixture = 'normal';
let readRequests = 0;
let renewRequests = 0;
const check = (mode = 'query', input) => browser.run(() => runLoanFlow(browser, mode, input, settings));

function row(title, due, count, eligibility, action = true) {
  return `<tr data-row-key="PRIVATE_LOAN_KEY"><td>${title}<span hidden>PRIVATE_HIDDEN</span></td><td>虚构著者</td>` +
    `<td>2026-10-21</td><td>${due}</td><td>PRIVATE_BARCODE</td><td>${count}</td><td>${eligibility}</td><td>在借</td>` +
    `<td>${action ? '<button type="submit">续借</button>' : ''}</td></tr>`;
}
function table(rows) {
  return '<div class="ant-table"><div class="ant-table-header"><table><thead><tr><th>题名</th><th>责任者</th><th>借阅日期</th>' +
    '<th>应还日期</th><th>条码号</th><th>续借次数</th><th>续借资格</th><th>借阅状态</th><th>操作</th></tr></thead></table></div>' +
    `<div class="ant-table-body"><table><tbody>${rows.join('')}</tbody></table></div></div>`;
}
function paginator(more) {
  return '<ul class="ant-pagination"><li class="ant-pagination-item-active">1</li>' +
    `<li class="ant-pagination-total-text">共 ${more ? 12 : 4} 条</li><li class="ant-pagination-next ${more ? '' : 'ant-pagination-disabled'}" onclick="window.nextClicked=true"><button>下一页</button></li></ul>`;
}
function mockPage(mode) {
  if (mode === 'login') return '<main id="app"><button>登录</button><input type="password" value="PRIVATE_PASSWORD"></main>';
  if (mode === 'missing') return '<main id="app"><h1>馆藏检索</h1><p>当前库藏列表</p></main>';
  const rows = [
    row('测试书 A', '2026-11-20距离还书还有0天', '0', ''), row('测试书 A', '2026/11/21', '2', '不可续借：已被其他读者预约'),
    row('测试书 B', '2026-11-19', '1', '可续借'), row('测试书 C', '11/22/26', '-', '', false),
  ];
  if (mode === 'updated') rows[0] = row('测试书 D', '2026-12-01', '0', '');
  if (mode === 'broken_row') rows[3] = row('', '2026-11-30', '0', '');
  const content = mode === 'empty' ? '<p>暂无当前借阅记录</p>'
    : mode === 'official_empty' ? '<label>当前剩余可借阅数：<a>20</a>本</label><div>暂无数据</div>'
    : mode === 'ambiguous_empty' ? '<div>暂无数据</div>'
    : mode === 'changed' ? '<table><tr><th>栏目已更改</th></tr><tr><td>未知内容</td></tr></table>'
    : table(rows) + paginator(mode === 'paged');
  return `<!doctype html><main id="app"><p>姓名 PRIVATE_NAME 证号 PRIVATE_READER_ID 手机 PRIVATE_PHONE 邮箱 PRIVATE_EMAIL</p>
    <input type="hidden" value="PRIVATE_INPUT"><a href="?ticket=PRIVATE_TICKET">我的资料</a>
    <ul><li class="ant-menu-item" onclick="openLoans()">我的借阅</li></ul>
    <div id="root"></div></main><script>
    async function openLoans() {
      const root = document.querySelector('#root');
      root.innerHTML = '<div class="ant-tabs"><div class="ant-tabs-tab-active">当前借阅</div><div class="ant-tabs-tab">借阅历史</div><div class="ant-tabs-tabpane-active"><div>暂无数据</div></div></div>';
      const panel = root.querySelector('.ant-tabs-tabpane-active');
      if (${JSON.stringify(mode)} === 'busy') { panel.innerHTML = '<div aria-busy="true">加载中</div>'; return; }
      const res = await fetch(${JSON.stringify(endpoint)}, {method:'POST', body: 'PRIVATE_REQUEST_PAYLOAD'});
      if (!res.ok) return;
      sessionStorage.setItem('loan-cache', 'PRIVATE_LOAN_CACHE');
      panel.innerHTML = '<form>' + ${JSON.stringify(content)} + '</form>';
      panel.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        fetch('/mock-submit', {method:'POST'});
      });
      root.insertAdjacentHTML('beforeend', '<div hidden><table><tr><td>PRIVATE_HISTORY</td></tr></table></div>');
      if (${JSON.stringify(mode)} === 'history') {
        root.querySelector('.ant-tabs-tab-active').textContent = '借阅历史';
        root.querySelector('.ant-tabs-tab:not(.ant-tabs-tab-active)').textContent = '当前借阅';
      }
    }
    </script>`;
}

try {
  const context = await browser.ensureContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, 'webpac.tongji.edu.cn');
    if (url.pathname === '/mock-submit') {
      renewRequests++;
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === endpoint) {
      readRequests++;
      if (fixture === 'network') return route.fulfill({ status: 503 });
      if (fixture === 'expired') return route.fulfill({ status: 401 });
      if (fixture === 'timeout') return;
      if (fixture === 'async') await new Promise(resolve => setTimeout(resolve, 650));
      return route.fulfill({ json: { safeTestResponse: true } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: mockPage(fixture) });
  });
  await browser.configurePreferences({ loanDueSoonDays: 1 });
  const catalog = await browser.pageFor('library');
  const normal = await browser.queryMyLoans();
  assert.equal(normal.status, 'success', JSON.stringify(normal));
  assert.equal(await browser.pageFor('library'), catalog);
  assert.equal(normal.totalLoans, 4);
  assert.equal(normal.readLoans, 4);
  assert.equal(normal.dueSoonDays, 1);
  assert.equal(normal.dueTodayCount, normal.dueSoonCount);
  assert.equal(normal.dueSoonCount, 1);
  assert.equal(normal.overdueCount, 1);
  assert.equal(normal.unknownDueDateCount, 1);
  assert.equal(normal.allPagesRead, true);
  assert.equal(normal.loans[3].dueDate, null);
  assert.equal(normal.loans[1].renewalCount, 2);
  assert.equal(normal.loans[0].pageStatus, '在借');
  assert.equal(new Set(normal.loans.map(loan => loan.loanId)).size, 4);
  assert.doesNotMatch(JSON.stringify(normal), /PRIVATE_/);

  const available = await browser.checkRenewal({ titles: ['《测试书 B》', '测试书 A', '未匹配的书'] });
  assert.equal(available.status, 'success');
  assert.equal(available.unmatchedTitleCount, 1);
  assert.deepEqual(available.loans.map(loan => loan.renewalEligibility), ['eligible', 'requires_official_confirmation', 'ineligible']);
  assert.equal((await check('check', { titles: ['测试书 C'] })).status, 'renewal_unknown');
  assert.equal((await check('check', { titles: ['其他测试书名'] })).status, 'no_matching_loans');
  const ambiguous = await browser.openRenewalPage({ title: '测试书 A' });
  assert.equal(ambiguous.status, 'needs_loan_selection');
  assert.equal(ambiguous.loans.length, 2);
  const selectedId = ambiguous.loans[1].loanId;
  // Launch headless for CI. Exercise the same handoff code used by a visible window.
  browser.config.headless = false;
  const handoff = await browser.openRenewalPage({ loanId: selectedId });
  assert.equal(handoff.status, 'ready_for_user_action', JSON.stringify(handoff));
  assert.equal(handoff.submitted, false);
  assert.equal(handoff.loans[0].displayedRow, 2);
  assert.equal(browser.loanPage.url(), entry);
  assert.equal(await browser.loanPage.locator('dialog, .ant-modal').count(), 0);
  assert.equal(renewRequests, 0);
  assert.equal((await check('open', { loanId: selectedId })).status, 'selection_expired');
  const beforeChange = await check('open', { title: '测试书 A' });
  fixture = 'updated';
  assert.equal((await check('open', { loanId: beforeChange.loans[0].loanId })).status, 'selection_expired');
  assert.equal((await check()).loans[0].title, '测试书 D');

  fixture = 'async';
  const started = Date.now();
  assert.equal((await check()).status, 'success');
  assert.ok(Date.now() - started >= 650);
  fixture = 'empty';
  const empty = await check();
  assert.equal(empty.status, 'no_active_loans');
  assert.equal(empty.totalLoans, 0);
  fixture = 'official_empty';
  assert.equal((await check()).status, 'no_active_loans');
  fixture = 'paged';
  const partial = await check();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.totalLoans, 12);
  assert.equal(partial.readLoans, 4);
  assert.equal(partial.allPagesRead, false);
  assert.equal(await browser.loanPage.evaluate(() => window.nextClicked || false), false);
  assert.equal((await check('open', { title: '测试书 B' })).status, 'needs_loan_selection');
  assert.equal((await check('check', { titles: ['仅后续页可能有'] })).status, 'partial');
  fixture = 'broken_row';
  assert.equal((await check()).status, 'partial');
  const outcomes = {
    login: 'login_required', expired: 'login_required', busy: 'page_pending', changed: 'page_structure_changed',
    ambiguous_empty: 'page_structure_changed', missing: 'needs_page_selection', history: 'page_structure_changed',
    network: 'network_error', timeout: 'timeout',
  };
  for (const [name, status] of Object.entries(outcomes)) {
    fixture = name;
    const result = await check();
    assert.equal(result.status, status, JSON.stringify({ fixture, result }));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    assert.equal('totalLoans' in result, false);
  }
  fixture = 'missing';
  assert.equal((await check()).status, 'needs_page_selection');
  await browser.loanPage.evaluate(html => {
    document.querySelector('main').innerHTML = '<section><h2>当前借阅</h2>' + html + '</section>';
  }, table([row('手动定位测试书', '2026-12-02', '', '', false)]));
  const manuallySelected = await check();
  assert.equal(manuallySelected.status, 'success');
  assert.equal(manuallySelected.loans[0].title, '手动定位测试书');
  assert.ok(readRequests >= 20, 'each read must refresh the current view');
  assert.equal(renewRequests, 0);
  await browser.close();
  assert.doesNotMatch(await readFile(browser.browserProfile.sessionFile, 'utf8'), /PRIVATE_|测试书/);
  console.log(JSON.stringify({ status: 'ok', readRequests, renewRequests, checks: [
    'live_current_rows', 'no_catalog_tab_interference', 'multititle_qualification', 'same_title_selection', 'visible_handoff',
    'stale_selection', 'fresh_results', 'delayed_read', 'confirmed_empty', 'pagination', 'malformed_rows', 'expired_login',
    'pending_view', 'unrecognized_structure', 'ambiguous_empty', 'missing_menu', 'manual_page_selection', 'history_excluded',
    'read_failure_and_timeout', 'no_sensitive_output_or_persistence', 'zero_renewal_submissions',
  ] }));
} finally {
  await browser.close();
  await rm(dataDir, { recursive: true, force: true });
}
