import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readLoanPage } from './loan-page.mjs';
import { defaultLoanDueSoonDays, loanFromEvidence, loanQueryDate, loanTimezone } from './loan-status.mjs';

const origin = 'https://webpac.tongji.edu.cn';
const appPath = '/opac/openlink.php';
const entry = `${origin}${appPath}#/personalCenter`;
const title = z.string().trim().min(1).max(450);
export const renewalCheckOptions = z.strictObject({
  titles: z.array(title).min(1).max(20).optional(),
  loanId: z.uuid().optional(),
}).refine(value => !(value.titles && value.loanId), '请指定书名列表或本次借阅记录 ID。');
export const renewalPageOptions = z.strictObject({ title: title.optional(), loanId: z.uuid().optional() })
  .refine(value => Boolean(value.title) !== Boolean(value.loanId), '请指定一本图书的书名或本次借阅记录 ID。');

const messages = {
  login_required: '请在插件专用浏览器的同济 OPAC 完成登录，再查询当前借阅。已有馆藏标签页可见不代表已登录个人中心。',
  needs_page_selection: '请在插件专用浏览器的同济 OPAC 打开「我的图书馆 → 我的借阅 → 当前借阅」，然后重新查询。',
  page_pending: '当前借阅还在加载，尚未确认记录。请在浏览器确认页面就绪后重试。',
  page_structure_changed: '未能确认「当前借阅」列表或有效的空结果。请在官方页面核对。',
  no_active_loans: '官方页面确认本机构当前没有未归还的纸质图书。',
  network_error: '访问同济 OPAC 或加载当前借阅失败。请在专用浏览器检查网络和页面。',
  timeout: '等待同济 OPAC 或当前借阅查询超时。请在专用浏览器核对。',
  browser_error: '专用浏览器或本机偏好暂不可用。请检查 campus_status 和本机偏好。',
  renewal_unknown: '本次页面没有明确的续借资格，请在官方页面核对。',
  needs_loan_selection: '请从本次借阅候选中选择一条记录。',
  selection_expired: '该借阅记录选择已失效，请重新选择本次返回的记录。',
  no_matching_loans: '在已完整读取的纸质图书列表中没有匹配的当前借阅记录。',
  browser_not_visible: '当前浏览器为无界面模式。请使用有界面模式打开官方续借操作页面。',
  ready_for_user_action: '已定位官方「当前借阅」列表中的记录。请在浏览器核对书名和应还日期，再自行处理续借。',
  invalid_input: '请提供有效的书名或本次借阅记录 ID。',
};

function isPersonalCenter(value) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.origin === origin && url.pathname === appPath && url.hash.split('?')[0] === '#/personalCenter' &&
    !url.username && !url.password;
}

function isAuth(value) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && /^(?:iam|idp|sso|ids)\.tongji\.edu\.cn$/i.test(url.hostname);
}

// Follow the existing web UI. Only observe transport completion for the
// official read triggered by that UI. Never inspect its payload or headers.
function observeLoanRequest(page) {
  let latest = null;
  let requests = new WeakMap();
  const start = request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/find/loanInfo/loanList' && request.method() === 'POST') {
      latest = { pending: true };
      requests.set(request, latest);
    }
  };
  const response = res => {
    const state = requests.get(res.request());
    if (state) state.code = res.status();
  };
  const finish = request => {
    const state = requests.get(request);
    if (state) state.pending = false;
  };
  const failure = request => {
    const state = requests.get(request);
    if (state) Object.assign(state, { pending: false, failed: true });
  };
  const handlers = [['request', start], ['response', response], ['requestfinished', finish], ['requestfailed', failure]];
  for (const [name, handler] of handlers) page.on(name, handler);
  return {
    get latest() { return latest; },
    reset() { latest = null; requests = new WeakMap(); },
    close() { for (const [name, handler] of handlers) page.off(name, handler); },
  };
}

async function loadLoanView(page, waitMs, allowManualSelection) {
  const network = observeLoanRequest(page);
  let navigated = false;
  try {
    const options = { waitUntil: 'domcontentloaded', timeout: waitMs };
    // After a page-selection error the reader may already have opened the
    // current tab manually. Preserve that view for the next read.
    const manual = allowManualSelection && isPersonalCenter(page.url()) &&
      (await page.evaluate(readLoanPage).catch(() => null))?.current;
    let navigation;
    if (!manual) {
      navigation = page.url() === entry ? await page.reload(options) : await page.goto(entry, options);
      if (!navigation && isPersonalCenter(page.url())) navigation = await page.reload(options);
    }
    navigated = true;
    if (isAuth(page.url()) || [401, 403].includes(navigation?.status())) return { status: 'login_required' };
    if (navigation?.status() >= 400 || !isPersonalCenter(page.url())) return { status: 'network_error' };
    const deadline = Date.now() + waitMs;
    let selectedMenu = false;
    let last;
    let signature;
    let loginSince;
    while (Date.now() < deadline) {
      if (isAuth(page.url())) return { status: 'login_required' };
      if (!isPersonalCenter(page.url())) return { status: 'needs_page_selection' };
      last = await page.evaluate(readLoanPage).catch(() => null);
      if (last?.authRequired) return { status: 'login_required' };
      if (last?.outOfScope) return { status: 'needs_page_selection' };
      const request = network.latest;
      if ([401, 403].includes(request?.code)) return { status: 'login_required' };
      if (request?.failed || request?.code >= 400) return { status: 'network_error' };
      if (last?.current) {
        const empty = last.explicitEmpty || (last.genericEmpty && last.renderedQuota && request?.code === 200);
        if (!last.loading && !last.ambiguous && !request?.pending && (last.records?.length || empty)) {
          const nextSignature = JSON.stringify(last);
          if (signature === nextSignature) return { view: last, empty: empty && !last.records?.length };
          signature = nextSignature;
        } else signature = undefined;
      } else if (last && !last.ambiguous) {
        if (last.login) {
          loginSince ??= Date.now();
          if (Date.now() - loginSince >= 500) return { status: 'login_required' };
        } else loginSince = undefined;
        if (!last.login && !selectedMenu) {
          // Verified OPAC personal-center menu. No action, row, or renewal
          // control is ever clicked, even if its text contains "我的借阅".
          const menu = page.locator('li.ant-menu-item:visible').filter({ hasText: /^\s*(?:我的借阅|我的借閱|Borrow)\s*$/u });
          if (await menu.count() === 1) {
            network.reset();
            selectedMenu = true;
            await menu.click({ timeout: Math.max(1, deadline - Date.now()) });
          }
        }
      }
      await delay(150);
    }
    if (network.latest?.pending) return { status: 'timeout' };
    if (last?.login && !last.current) return { status: 'login_required' };
    if (last?.loading || !last) return { status: 'page_pending' };
    return { status: last.current || last.ambiguous || selectedMenu ? 'page_structure_changed' : 'needs_page_selection' };
  } catch (error) {
    if (isAuth(page.url())) return { status: 'login_required' };
    if (error.name === 'TimeoutError') return { status: 'timeout' };
    if (!navigated) return { status: 'network_error' };
    return { status: 'page_structure_changed' };
  } finally { network.close(); }
}

const choiceKey = row => createHash('sha256').update(JSON.stringify([
  row.title, row.author, row.borrowDate, row.dueDate, row.displayedRow,
])).digest('hex');
const normalizedTitle = value => value.normalize('NFKC').toLowerCase().replace(/[《》「」\s]/gu, '');

function matchingRows(loans, titles) {
  const matched = new Set();
  let unmatchedTitleCount = 0;
  for (const title of titles) {
    const key = normalizedTitle(title);
    const exact = loans.filter(loan => normalizedTitle(loan.title) === key);
    const candidates = exact.length || !key ? exact : loans.filter(loan => normalizedTitle(loan.title).includes(key));
    if (!candidates.length) unmatchedTitleCount++;
    for (const loan of candidates) matched.add(loan);
  }
  return { matches: [...matched], unmatchedTitleCount };
}

export async function runLoanFlow(browser, mode, input = {}, { now, waitMs = 12000 } = {}) {
  const timestamp = now ?? new Date();
  const queryDate = loanQueryDate(timestamp);
  const respond = (status, fields = {}) => ({
    status, queryDate, timezone: loanTimezone, fetchedAt: timestamp.toISOString(), source: entry,
    scope: 'institution_print_books', contentTrust: 'untrusted_page_data',
    ...(mode === 'open' ? { submitted: false } : {}),
    ...(messages[status] ? { message: messages[status] } : {}), ...fields,
  });
  const schema = mode === 'open' ? renewalPageOptions : renewalCheckOptions;
  if (mode !== 'query' && !schema.safeParse(input).success) return respond('invalid_input');
  const previous = input.loanId && browser.loanChoices.get(input.loanId);
  let page;
  let dueSoonDays;
  try {
    const context = await browser.ensureContext();
    ({ loanDueSoonDays: dueSoonDays = defaultLoanDueSoonDays } = await browser.preferences());
    page = browser.loanPage;
    if (!page || page.isClosed()) {
      page = context.pages().findLast(tab => !tab.isClosed() && isPersonalCenter(tab.url())) || await context.newPage();
      browser.loanPage = page;
      browser.loanNeedsPageSelection = false;
    }
  } catch { return respond('browser_error'); }

  const oldPage = previous?.page;
  browser.loanChoices.clear();
  const data = await loadLoanView(page, waitMs, browser.loanNeedsPageSelection);
  browser.loanNeedsPageSelection = data.status === 'needs_page_selection';
  if (!data.view) {
    if (data.status === 'login_required') await page.bringToFront().catch(() => {});
    return respond(data.status);
  }
  const { view, empty } = data;
  const rows = view.records || [];
  const loans = rows.map(row => ({ loanId: randomUUID(), ...loanFromEvidence(row, queryDate, dueSoonDays) }));
  const storedKeys = rows.map(choiceKey);
  const expiresAt = Date.now() + 5 * 60_000;
  for (const [index, loan] of loans.entries()) browser.loanChoices.set(loan.loanId, { key: storedKeys[index], page, expiresAt });
  const allPagesRead = view.allPagesRead && !view.omittedRows && !view.ambiguous;
  const reasons = [];
  if (!view.allPagesRead) reasons.push('分页未读全，仅返回当前可见页。');
  if (view.omittedRows || view.ambiguous) reasons.push('部分借阅行缺少可识别的书名或结构。');
  const summary = {
    dueSoonDays, allPagesRead, displayedPage: view.displayedPage ?? null,
    totalLoans: allPagesRead ? loans.length
      : view.pageReportedTotal >= loans.length ? view.pageReportedTotal : null,
    readLoans: loans.length, overdueCount: loans.filter(loan => loan.status === 'overdue').length,
    dueSoonCount: loans.filter(loan => loan.status === 'due_soon').length,
    dueTodayCount: loans.filter(loan => loan.status === 'due_today').length,
    unknownDueDateCount: loans.filter(loan => loan.status === 'unknown').length,
    unreadSections: view.unreadSections,
    ...(reasons.length ? { partialReasons: reasons } : {}),
  };
  const status = !allPagesRead ? 'partial' : empty ? 'no_active_loans' : 'success';
  if (mode === 'query') return respond(status, { ...summary, loans });

  const selected = oldPage === page && previous.expiresAt > Date.now() ? storedKeys.indexOf(previous.key) : -1;
  if (input.loanId && selected < 0) return respond('selection_expired', { ...summary, loans });
  if (status === 'no_active_loans') return respond(status, { ...summary, loans });
  const titles = mode === 'open' && input.title ? [input.title] : input.titles;
  const { matches, unmatchedTitleCount } = input.loanId ? { matches: [loans[selected]], unmatchedTitleCount: 0 }
    : titles ? matchingRows(loans, titles) : { matches: loans, unmatchedTitleCount: 0 };
  if (!matches.length) return respond(allPagesRead ? 'no_matching_loans' : 'partial', { ...summary, loans: [], unmatchedTitleCount });
  if (mode === 'check') {
    const unconfirmedCount = matches.filter(loan => ['requires_official_confirmation', 'unknown'].includes(loan.renewalEligibility)).length;
    return respond(status === 'partial' ? status : unconfirmedCount === matches.length ? 'renewal_unknown' : 'success',
      { ...summary, loans: matches, unmatchedTitleCount, unconfirmedCount });
  }
  if (matches.length > 1 || (!allPagesRead && !input.loanId)) {
    return respond('needs_loan_selection', { ...summary, loans: matches });
  }
  if (browser.config.headless) return respond('browser_not_visible', { ...summary, loans: matches });
  const target = rows[loans.indexOf(matches[0])];
  try {
    if (!isPersonalCenter(page.url()) || !(await page.evaluate(readLoanPage, target)).positioned) {
      return respond('page_pending', { ...summary, loans: matches });
    }
    await page.bringToFront();
  } catch { return respond('page_structure_changed'); }
  return respond('ready_for_user_action', { ...summary, loans: matches });
}
