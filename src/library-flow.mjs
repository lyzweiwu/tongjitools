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
    let callNumbers = [];
    for (let p = a.parentElement, n = 0; p && p !== document.body && n < 7; p = p.parentElement, n++) {
      // Stop before leaving this card. A collected edition can list multiple
      // call numbers in one line, one for each selectable volume.
      const hasOtherCard = [...p.querySelectorAll('a[href*="/bookDetails/"]')].some(link =>
        link !== a && visible(link) && /^\s*\d+[.．、]\s*\[/.test(link.innerText));
      if (hasOtherCard) break;
      const groups = p.innerText.split(/\r?\n/).map(line => line.trim().split(/[;；]/).map(s => s.trim()).filter(Boolean));
      const numbers = [...new Set(groups.filter(group => group.length && group.every(s =>
        /^[A-Z]{1,3}\d[A-Z\d.\-]*\/[A-Z\d][A-Z\d.,=\-/]*(?:[（(]\d+[）)])?$/i.test(s))).flat())];
      if (numbers.length) { callNumbers = numbers; break; }
    }
    for (const callNumber of callNumbers) records.push({
      title: a.innerText.replace(/^\s*\d+[.．、]\s*\[[^\]]+\]\s*/, '').trim(),
      callNumber, url: a.href,
    });
  }
  return records;
}

async function findRequestAction(page, callNumber, location) {
  const rows = page.getByRole('row')
    .filter({ has: page.getByRole('cell', { name: callNumber, exact: true }) })
    .filter({ has: page.getByRole('cell', { name: location, exact: true }) })
    .filter({ has: page.getByText('请求', { exact: true }) });
  if (await rows.count() !== 1) return null;
  let action = rows.locator('a:visible').filter({ hasText: /^请求$/ });
  if (await action.count() === 0) {
    // Ant tables may put the visible action in a fixed copy of the same row.
    const key = await rows.getAttribute('data-row-key');
    const root = page.locator('.ant-table').filter({ has: rows });
    if (key === null || await root.count() !== 1) return null;
    action = root.locator(`tr[data-row-key=${JSON.stringify(key)}] a:visible`).filter({ hasText: /^请求$/ });
  }
  return await action.count() === 1 ? action : null;
}

async function applyPickupPreference(page, dialog, preferences, timeout) {
  const { pickupLocation, preferredCampus } = preferences;
  if (!pickupLocation && !preferredCampus) return {};
  const combobox = dialog.getByRole('combobox').filter({ visible: true });
  if (await combobox.count() !== 1) return { preferredPickup: pickupLocation };
  await combobox.click({ timeout });
  const options = page.getByRole('option').filter({ visible: true });
  const desired = pickupLocation && page.getByRole('option', { name: pickupLocation, exact: true }).filter({ visible: true });
  if (desired) {
    await desired.first().waitFor({ state: 'visible', timeout }).catch(() => {});
    if (await desired.count() === 1) {
      await desired.click({ timeout });
      const selected = dialog.getByText(pickupLocation, { exact: true }).filter({ visible: true });
      await selected.waitFor({ state: 'visible', timeout: Math.min(timeout, 1000) }).catch(() => {});
      if (await selected.count() === 1) return { pickupLocation, pickupPreselected: true };
    }
  }
  await options.first().waitFor({ state: 'visible', timeout }).catch(() => {});
  const preferredPickupOptions = (await options.allInnerTexts()).map(text => text.trim())
    .filter(text => preferredCampus && text.includes(preferredCampus));
  return { preferredPickup: pickupLocation, preferredPickupOptions, pickupPreselected: false };
}

// Both modes open the official request form. The handoff lets the reader
// complete it directly while the preview locks submission.
export async function prepareBookRequest(browser, { query, callNumber } = {}, { handoff = false } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120 ||
      (callNumber !== undefined && (typeof callNumber !== 'string' || !callNumber.trim() || callNumber.length > 100))) {
    throw new Error('请提供书名或 ISBN，以及可选的索书号。');
  }
  if (handoff && !callNumber) throw new Error('须提供已选版本的索书号。');
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
    kind: handoff ? 'book_request_handoff' : 'book_request_preview', status, submitted: false,
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
    const preferences = await browser.preferences();
    const { preferredCampus, allowCrossCampus } = preferences;
    const stock = (table?.rows || []).filter(row => row[at('索书号')] === selected.callNumber)
      .map(row => ({ location: row[at('馆藏地')], availableCopies: Number(row[at('可借复本')]) }))
      .filter(row => row.location && Number.isFinite(row.availableCopies));
    const inPreferredCampus = row => Boolean(preferredCampus && row.location.includes(preferredCampus));
    const available = stock.filter(row => row.availableCopies > 0);
    const local = available.filter(inPreferredCampus);
    const other = available.filter(row => !inPreferredCampus(row));
    const targets = preferredCampus && !allowCrossCampus ? local : [...local, ...other];
    if (!targets.length) {
      return preferredCampus && !allowCrossCampus && other.length
        ? result('cross_campus_options', { preferredCampus, stock, message: '常用校区当前无可借复本，其他馆舍有可借复本。' })
        : result('not_available', { preferredCampus, stock, message: '当前没有识别到可委托的在架复本。' });
    }
    step = 'details.find_request';
    let action;
    let selectedStock;
    for (const row of targets) {
      action = await findRequestAction(page, selected.callNumber, row.location);
      if (action) { selectedStock = row; break; }
    }
    if (!action) {
      if (preferredCampus && !allowCrossCampus && other.length) {
        return result('cross_campus_options', { preferredCampus, stock, message: '未找到常用校区可操作的委托入口，其他馆舍显示有可借复本。' });
      }
      return result('needs_page_selection', { preferredCampus, stock, message: '未唯一识别可借馆藏的请求入口。' });
    }
    const sourceLocation = selectedStock.location;
    const sourceSelection = { preferredCampus, matchesPreferredCampus: preferredCampus ? inPreferredCampus(selectedStock) : null,
      preferredCampusStock: stock.filter(inPreferredCampus) };
    mark('details');
    stage = 'form';
    step = 'form.open';
    await action.click({ timeout: timeout() });
    const dialog = page.locator('[role="dialog"]:visible');
    step = 'form.wait_dialog';
    await dialog.waitFor({ state: 'visible', timeout: timeout() });
    // Local preview safeguard: prevent both button clicks and Enter submission.
    step = 'form.protect_submission';
    if (!handoff) await dialog.evaluate(el => {
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
    if (handoff) {
      step = 'form.pickup_preference';
      const pickup = await applyPickupPreference(page, dialog, preferences, timeout(3000))
        .catch(() => ({ preferredPickup: preferences.pickupLocation, pickupPreselected: false }));
      await page.bringToFront();
      mark('form');
      step = 'form.ready';
      return result('ready_for_user_submission', {
        book: { title: selected.title, callNumber: selected.callNumber, sourceLocation },
        source: { url: displayUrl(page.url()), title: detail.title },
        sourceSelection, pickup,
        message: '请在官方表单确认取书地和联系方式，再提交委托申请。',
      });
    }
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
      sourceSelection,
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
