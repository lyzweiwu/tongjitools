import { performance } from 'node:perf_hooks';
import { displayUrl, isSchoolUrl } from './config.mjs';

export const BOOK_PREVIEW_TIMEOUTS = Object.freeze({ stepMs: 12000, searchResultsMs: 25000, totalMs: 45000 });

// Return diagnostic categories only; raw errors may contain URLs or credentials.
export function diagnosePreparationFailure(error, { stage, step, elapsedMs = 0, searchRequests = [] }) {
  const errorType = ['TimeoutError', 'TypeError', 'ReferenceError', 'Error'].includes(error?.name) ? error.name : 'Error';
  if (elapsedMs >= BOOK_PREVIEW_TIMEOUTS.totalMs) return { status: 'flow_timeout', errorType };
  const failedRequest = searchRequests.find(r => r.failureCode || r.httpStatus >= 400);
  if (stage === 'search' && failedRequest) return { status: 'search_request_failed', errorType };
  if (errorType === 'TimeoutError') return { status: step === 'search.wait_results' ? 'search_timeout' : 'step_timeout', errorType };
  return { status: stage === 'browser' ? 'browser_error' : 'page_structure_changed', errorType };
}

// Scope extraction to one numbered result card; facet/recommendation text must
// not displace book records in the general page snapshot's text budget.
function readBookCards() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const records = [];
  for (const a of document.querySelectorAll('a[href*="/bookDetails/"]')) {
    if (!visible(a) || !/^\s*\d+[.．、]\s*\[/.test(a.innerText)) continue;
    let callNumber;
    for (let p = a.parentElement, n = 0; p && p !== document.body && n < 7; p = p.parentElement, n++) {
      const numbers = [...new Set(p.innerText.split(/\r?\n/).map(s => s.trim()).filter(s =>
        /^[A-Z]{1,3}\d[A-Z\d.\-]*\/[A-Z\d][A-Z\d.\-]*(?:[（(]\d+[）)])?$/i.test(s)))];
      if (numbers.length === 1) { callNumber = numbers[0]; break; }
      if (numbers.length > 1) break;
    }
    if (callNumber) records.push({
      title: a.innerText.replace(/^\s*\d+[.．、]\s*\[[^\]]+\]\s*/, '').trim(),
      callNumber, url: a.href,
    });
  }
  return records;
}

// Preparation only: there is deliberately no submit handler or submit option.
export async function prepareBookRequest(browser, { query, callNumber } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120 ||
      (callNumber !== undefined && (typeof callNumber !== 'string' || !callNumber.trim() || callNumber.length > 100))) {
    throw new Error('请提供书名或 ISBN，以及可选的索书号。');
  }
  query = query.trim();
  callNumber = callNumber?.trim();
  const started = performance.now();
  const timings = {};
  let previous = started;
  let stage = 'browser';
  let step = 'browser.start';
  let page;
  let context;
  let submittedAt;
  let failure;
  const searchRequests = [];
  const requestRecords = new WeakMap();
  const elapsed = () => Math.round(performance.now() - started);
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.hostname !== 'webpac.tongji.edu.cn' || url.pathname !== '/find/unify/search') return;
    const record = { startedMs: elapsed(), startedAfterSubmitMs: submittedAt === undefined ? null : Math.round(performance.now() - submittedAt), pending: true };
    requestRecords.set(request, record);
    searchRequests.push(record);
  };
  const onResponse = response => { const record = requestRecords.get(response.request()); if (record) record.httpStatus = response.status(); };
  const onFinished = request => {
    const record = requestRecords.get(request);
    if (record) { record.pending = false; record.durationMs = elapsed() - record.startedMs; }
  };
  const onFailed = request => {
    const record = requestRecords.get(request);
    if (record) { onFinished(request); record.failureCode = request.failure()?.errorText?.match(/ERR_[A-Z_]+/)?.[0] || 'request_failed'; }
  };
  const listeners = [['request', onRequest], ['response', onResponse], ['requestfinished', onFinished], ['requestfailed', onFailed]];
  const timeout = (max = BOOK_PREVIEW_TIMEOUTS.stepMs) => Math.max(1, Math.min(max, BOOK_PREVIEW_TIMEOUTS.totalMs - (performance.now() - started)));
  const mark = name => { const now = performance.now(); timings[name] = Math.round(now - previous); previous = now; };
  const result = (status, fields = {}) => ({
    kind: 'book_request_preview', status, submitted: false,
    stopAt: 'pickup_and_contact', query, ...fields,
    timingsMs: { ...timings, ...(!Object.hasOwn(timings, stage) ? { [stage]: Math.round(performance.now() - previous) } : {}), total: elapsed() },
    diagnostics: { stage, step, limits: BOOK_PREVIEW_TIMEOUTS, ...(failure ? { failure } : {}),
      searchRequests: searchRequests.map(r => ({ ...r, ...(r.pending ? { pendingForMs: elapsed() - r.startedMs } : {}) })) },
    fetchedAt: new Date().toISOString(),
  });
  try {
    context = await browser.ensureContext();
    for (const [event, handler] of listeners) context.on(event, handler);
    step = 'browser.open_entry';
    page = await browser.pageFor('library');
    mark('browser');
    const entry = new URL(browser.config.services.library);
    if (entry.hostname !== 'webpac.tongji.edu.cn') {
      return result('needs_page_selection', { message: '该准备流程仅适配同济新版馆藏页面。' });
    }
    stage = 'search';
    step = 'search.open_home';
    if (new URL(page.url()).hash !== '#/Home') {
      await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: timeout(20000) });
    }
    const inputs = page.locator('input[type="text"]:visible');
    step = 'search.wait_input';
    await inputs.first().waitFor({ state: 'visible', timeout: timeout() });
    if (await inputs.count() !== 1) return result('needs_page_selection', { message: '无法唯一识别馆藏检索框。' });
    step = 'search.fill_input';
    await inputs.fill(query);
    step = 'search.press_enter';
    submittedAt = performance.now();
    await inputs.press('Enter');
    // Wait for numbered results, rather than recommendations left in a page shell.
    step = 'search.wait_results';
    await page.waitForFunction(() => {
      const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      if (/^(iam|idp|sso|ids)\./i.test(location.hostname)) return true;
      if (!location.hash.startsWith('#/searchList')) return false;
      return [...document.querySelectorAll('a[href*="/bookDetails/"]')].some(a =>
        visible(a) && /^\s*\d+[.．、]\s*\[/.test(a.innerText)) ||
        /无检索结果|没有检索到|未检索到/.test(document.body.innerText);
    }, null, { timeout: timeout(BOOK_PREVIEW_TIMEOUTS.searchResultsMs) });
    step = 'search.read_page';
    const search = await browser.snapshot(page, 'library');
    if (search.status !== 'ok') return result(search.status, { message: search.message });
    step = 'search.read_cards';
    const records = await page.evaluate(readBookCards);
    const candidates = records.filter(b => !callNumber || b.callNumber === callNumber);
    mark('search');
    if (!records.length) return result(/共\s*0\s*条|无检索结果/.test(search.text) ? 'no_matching_book' : 'page_pending', {
      stage: 'search', message: '当前尚未识别到完整的纸本书目卡片；没有打开申请表。',
    });
    if (candidates.length !== 1) return result('needs_book_selection', {
      message: '请从本次检索结果中确定一个版本；流程没有打开申请表。',
      candidates: records.map(({ title, callNumber }) => ({ title, callNumber })),
    });
    const selected = candidates[0];
    const target = new URL(selected.url);
    if (!isSchoolUrl(selected.url) || target.hostname !== entry.hostname || !/^#\/searchList\/bookDetails\/\d+$/.test(target.hash)) {
      return result('needs_page_selection', { message: '未识别到受支持的同济书目详情链接。' });
    }
    stage = 'details';
    step = 'details.open';
    await page.goto(selected.url, { waitUntil: 'domcontentloaded', timeout: timeout(20000) });
    step = 'details.wait_stock_rows';
    await page.waitForFunction(expectedCallNumber => {
      const text = document.body?.innerText || '';
      const readyTable = [...document.querySelectorAll('table')].some(t =>
        /当前请求数/.test(t.innerText) && /可借复本/.test(t.innerText) &&
        t.innerText.includes(expectedCallNumber));
      return /账号\s*登录\s*后即可发起请求/.test(text) ||
        (readyTable && /可发起委托次数/.test(text)) ||
        /^(iam|idp|sso|ids)\./i.test(location.hostname);
    }, selected.callNumber, { timeout: timeout() });
    step = 'details.read_page';
    const detail = await browser.snapshot(page, 'library');
    if (detail.status !== 'ok' || /账号\s*登录\s*后即可发起请求/.test(detail.text)) {
      return result('login_required', { message: '请在官方浏览器中自行登录后重新运行准备流程。', source: { url: detail.url } });
    }
    const table = detail.tables.find(t => t.headers.includes('当前请求数') && t.headers.includes('馆藏地'));
    const at = name => table?.headers.indexOf(name) ?? -1;
    const eligible = table?.rows.find(row => row[at('索书号')] === selected.callNumber && Number(row[at('可借复本')]) > 0);
    if (!eligible) return result('not_available', { message: '当前没有识别到可委托的在架复本；未打开申请表。' });
    const sourceLocation = eligible[at('馆藏地')];
    step = 'details.find_request';
    const rows = page.getByRole('row').filter({ hasText: selected.callNumber }).filter({ hasText: sourceLocation })
      .filter({ has: page.getByText('请求', { exact: true }) });
    if (await rows.count() !== 1) return result('needs_page_selection', { message: '未唯一识别目标馆藏的请求入口。' });
    let action = rows.locator('a:visible').filter({ hasText: /^请求$/ });
    // Ant tables may duplicate action cells in a fixed column. Use the visible
    // copy with the same row key, never an unrelated row's action.
    if (await action.count() === 0) {
      const key = await rows.getAttribute('data-row-key');
      const root = page.locator('.ant-table').filter({ has: rows });
      if (key === null || await root.count() !== 1) return result('needs_page_selection');
      action = root.locator(`tr[data-row-key=${JSON.stringify(key)}] a:visible`).filter({ hasText: /^请求$/ });
    }
    if (await action.count() !== 1) return result('needs_page_selection', { message: '请求按钮不可唯一识别。' });
    mark('details');
    stage = 'form';
    step = 'form.open';
    await action.click({ timeout: timeout() });
    const dialog = page.locator('[role="dialog"]:visible');
    step = 'form.wait_dialog';
    await dialog.waitFor({ state: 'visible', timeout: timeout() });
    // Local preview safeguard: prevent both button clicks and Enter submission.
    step = 'form.protect_submission';
    await dialog.evaluate(el => {
      el.dataset.campusPreviewOnly = 'true';
      const isSubmit = b => /^(?:确\s*定|提\s*交|确认申请)$/.test(b?.textContent?.trim() || '');
      for (const b of el.querySelectorAll('button')) if (isSubmit(b)) b.disabled = true;
      el.addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
      el.addEventListener('click', e => {
        if (isSubmit(e.target.closest('button'))) { e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
    });
    const phone = dialog.locator('input[placeholder="请输入手机号码"]');
    const email = dialog.locator('input[placeholder="请输入邮箱"]');
    step = 'form.wait_phone';
    await phone.waitFor({ state: 'visible', timeout: timeout() });
    step = 'form.wait_email';
    await email.waitFor({ state: 'visible', timeout: timeout() });
    step = 'form.open_pickups';
    await dialog.getByRole('combobox').click({ timeout: timeout() });
    const options = page.locator('[role="option"]:visible');
    step = 'form.wait_pickups';
    await options.first().waitFor({ state: 'visible', timeout: timeout() });
    step = 'form.read_fields';
    const pickupOptions = (await options.allTextContents()).map(s => s.trim()).filter(Boolean);
    const hasPhone = await phone.evaluate(e => !!e.value.trim());
    const hasEmail = await email.evaluate(e => !!e.value.trim());
    // React can replace buttons while loading the form; disable the final nodes.
    await dialog.locator('button').evaluateAll(buttons => {
      for (const b of buttons) if (/^(?:确\s*定|提\s*交|确认申请)$/.test(b.textContent.trim())) b.disabled = true;
    });
    const enabledSubmitButtons = await dialog.locator('button:enabled').filter({ hasText: /^(?:确\s*定|提\s*交|确认申请)$/ }).count();
    mark('form');
    step = 'form.ready';
    return result('ready_for_user_input', {
      book: { title: selected.title, callNumber: selected.callNumber, sourceLocation },
      source: { url: displayUrl(page.url()), title: detail.title },
      form: { pickupOptions, phoneRequired: true, emailRequired: true, hasPhone, hasEmail },
      submissionDisabled: enabledSubmitButtons === 0,
      message: '已停在取书地和手机号表单；未选择取书地、未填写联系方式、未提交申请。',
    });
  } catch (error) {
    // Never serialize raw browser errors, URLs with query credentials, or forms.
    failure = diagnosePreparationFailure(error, { stage, step, elapsedMs: elapsed(), searchRequests });
    const messages = {
      search_timeout: '等待检索结果超时，已停止；没有重新发送检索或提交申请。',
      search_request_failed: '检索请求返回错误或连接失败，已停止；没有提交申请。',
      page_structure_changed: '页面结构或页面执行出现异常，已停止；没有提交申请。',
      flow_timeout: '准备流程总等待预算已耗尽，已停止；没有提交申请。',
      step_timeout: '当前步骤等待超时，已停止；没有提交申请。',
      browser_error: '专用浏览器未能正常打开，已停止；没有提交申请。',
    };
    return result(failure.status, { stage, source: { url: page ? displayUrl(page.url()) : '' }, message: messages[failure.status] });
  } finally {
    if (context) for (const [event, handler] of listeners) context.off(event, handler);
  }
}
