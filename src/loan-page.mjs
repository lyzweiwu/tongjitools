// This function runs in the browser. Keep the snapshot limited to the current
// loans panel and never inspect identifiers, links, form values or storage.
export function readLoanPage(target) {
  const visible = el => !!el?.getClientRects().length && !el.closest('[hidden], [aria-hidden="true"]') &&
    !['hidden', 'collapse'].includes(getComputedStyle(el).visibility);
  const text = el => (el?.innerText || '').replace(/\s+/gu, ' ').trim();
  const label = /^(?:当前借阅|當前借閱|当前借阅情况|Current Borrowing|Current Loans)$/iu;
  const query = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  if (query(document, 'input[type="password"]').length) return { authRequired: true };
  const current = query(document, '[role="tab"][aria-selected="true"], .ant-tabs-tab-active, h1, h2, h3')
    .filter(el => label.test(text(el)));
  const login = !current.length && query(document, '#app a, #app button, #app span')
    .some(el => /^(?:登录|账户登录|账号登录|请先登录|Log in|Sign in)$/iu.test(text(el)));
  const loading = root => query(root, '[aria-busy="true"], .ant-spin-spinning, [role="status"], #app')
    .some(el => el.matches('[aria-busy="true"], .ant-spin-spinning') || /^(?:正在加载|加载中|loading)[…\.。]*$/iu.test(text(el)));
  if (current.length !== 1) return { login, loading: loading(document), ambiguous: current.length > 1 };

  const active = current[0];
  const tabs = active.closest('.ant-tabs') || active.closest('[role="tablist"]')?.parentElement;
  const panelId = active.getAttribute('aria-controls');
  const panels = panelId ? [document.getElementById(panelId)].filter(visible)
    : tabs ? query(tabs, '.ant-tabs-tabpane-active, [role="tabpanel"]')
    : [active.closest('section, main, [role="region"]')].filter(Boolean);
  if (panels.length !== 1) return { current: true, login, loading: loading(document), ambiguous: panels.length > 1 };
  const panel = panels[0];
  if (loading(panel)) return { current: true, loading: true, login };
  const typeControls = query(panel, 'button, a, label, [role="tab"]');
  const alternateScope = typeControls.some(el => text(el) === '联盟借阅');
  const outOfScope = query(panel, '.ant-radio-button-wrapper-checked, [role="radio"][aria-checked="true"]')
    .some(el => /^(?:现刊|电子图书)$/u.test(text(el))) ||
    (alternateScope && !typeControls.some(el => text(el) === '图书'));
  if (outOfScope) return { current: true, outOfScope };

  const aliases = {
    title: /^(?:书名|题名|正题名|書名|題名|图书名称|书刊名称|Title)$/iu,
    author: /^(?:作者|著者|责任者|責任者|Author)$/iu,
    borrowDate: /^(?:借阅日期|借书日期|借出日期|借阅时间|借閱日期|Borrowing date|Loan date)$/iu,
    dueDate: /^(?:应还日期|应还时间|应归还日期|應還日期|归还期限|Due date)$/iu,
    renewalCount: /^(?:已续借次数|续借次数|續借次數|Renewal count)$/iu,
    pageStatus: /^(?:借阅状态|当前状态|狀態|状态|Loan status|Status)$/iu,
    eligibility: /^(?:续借资格|续借状态|是否可续借|Renewal eligibility|Renewal status)$/iu,
    operation: /^(?:操作|续借|續借|Operation|Renew)$/iu,
  };
  const fixedCopy = el => el.closest('.ant-table-fixed-left, .ant-table-fixed-right');
  const tableRoot = el => el.closest('.ant-table') || el.closest('table, [role="table"], [role="grid"]');
  const candidates = query(panel, 'thead tr, [role="row"]').filter(row => !fixedCopy(row)).flatMap(row => {
    const headers = [...row.children].map(cell => text(cell).normalize('NFKC'));
    const columns = Object.fromEntries(Object.entries(aliases).map(([name, pattern]) => {
      const matching = headers.flatMap((header, index) => pattern.test(header) ? [index] : []);
      return [name, matching.length === 1 ? matching[0] : -1];
    }));
    const history = headers.some(header => /^(?:实还日期|實還日期|实际归还日期|Actual date|Date returned)$/iu.test(header));
    return !history && columns.title >= 0 &&
      [columns.dueDate, columns.borrowDate, columns.renewalCount, columns.eligibility, columns.pageStatus].some(i => i >= 0)
      ? [{ row, columns }] : [];
  });
  const number = value => /^\d{1,8}$/u.test(value || '') ? Number(value) : null;
  const pagers = query(panel, '.ant-pagination, nav[aria-label="分页"], nav[aria-label="Pagination"]');
  const pager = pagers.length === 1 ? pagers[0] : null;
  const selectedPage = pager && query(pager, '.ant-pagination-item-active, [aria-current="page"]');
  const displayedPage = selectedPage?.length === 1 ? number(text(selectedPage[0])) : null;
  const next = pager ? query(pager, '.ant-pagination-next, [aria-label="下一页"], [aria-label="Next page"]') : [];
  const disabled = el => el.matches(':disabled, [aria-disabled="true"], .ant-pagination-disabled') ||
    !!el.querySelector('button:disabled, [aria-disabled="true"]');
  const pageTotals = pager ? query(pager, '.ant-pagination-total-text, [role="status"]')
    .map(el => /^(?:共\s*|Total\s+)(\d{1,8})(?:\s*(?:条|册|本|items?))?$/iu.exec(text(el))?.[1]).filter(Boolean) : [];
  const pageReportedTotal = pageTotals.length === 1 ? number(pageTotals[0]) : null;
  const allPagesRead = pagers.length === 0 || (displayedPage === 1 && next.length === 1 && disabled(next[0]));

  const unreadSections = [];
  if (typeControls.some(el => text(el) === '电子图书')) unreadSections.push('电子图书');
  if (alternateScope) unreadSections.push('联盟借阅');

  const emptyElements = query(panel, 'td, p, span, div, [role="status"]')
    .filter(el => !el.children.length && !el.closest('tr:not(.ant-table-placeholder), [role="row"]')).map(text);
  const explicitEmpty = emptyElements.some(value => /^(?:暂无(?:当前)?借阅(?:记录|信息)?|无(?:当前|未归还)借阅(?:记录)?|当前无借阅|没有未归还(?:的)?图书|共\s*0\s*(?:册|本)|No (?:active|current) loans)[。.!]?$/iu.test(value));
  const genericEmpty = emptyElements.some(value => /^(?:暂无数据|暂时没有数据|无数据|No data)$/iu.test(value));
  // OPAC can render the same empty placeholder while the read is in flight.
  // A positive remaining quota in the current panel comes from loaded loan data.
  const renderedQuota = query(panel, 'label').some(el => /^当前剩余可借阅数\s*[:：]\s*[1-9]\d*\s*本$/u.test(text(el)));
  if (candidates.length !== 1) return {
    current: true, explicitEmpty, genericEmpty, renderedQuota, ambiguous: candidates.length > 1, unreadSections, allPagesRead,
  };
  const [{ row: headerRow, columns }] = candidates;
  const root = tableRoot(headerRow);
  const rows = query(root, 'tbody tr, [role="row"]').filter(row => row !== headerRow &&
    tableRoot(row) === root && !fixedCopy(row) && !row.matches('.ant-table-placeholder, .ant-table-expanded-row') &&
    !row.querySelector('th, [role="columnheader"], .ant-empty'));
  const fixedRows = query(root, '.ant-table-fixed-right tbody tr').filter(row =>
    !row.matches('.ant-table-placeholder, .ant-table-expanded-row'));
  const renewalControl = cell => !!cell && query(cell, 'button, a, [role="button"]')
    .some(el => /^(?:续借|續借|Renew)$/iu.test(text(el)));
  let omittedRows = Math.max(0, rows.length - 120);
  let positioned = false;
  const records = rows.slice(0, 120).flatMap((row, index) => {
    const cells = [...row.children];
    const value = (name, max = 120) => {
      const cell = cells[columns[name]];
      const value = visible(cell) ? text(cell) : '';
      return value.length <= max && !/^(?:[–—-]+|N\/A)$/iu.test(value) ? value : '';
    };
    const title = value('title', 450);
    const pageStatus = value('pageStatus');
    if (!title || row.querySelector('td[colspan]') || /^(?:已还|已归还|已還|Returned)$/iu.test(pageStatus)) {
      omittedRows++;
      return [];
    }
    const actionCell = cells[columns.operation];
    // Ant may draw the action in a fixed column over the main table.
    const fixedRow = columns.operation >= 0 && fixedRows.length === rows.length ? fixedRows[index] : null;
    const fixedAction = fixedRow && Math.abs(fixedRow.getBoundingClientRect().top - row.getBoundingClientRect().top) <= 2;
    const hasRenewalAction = renewalControl(actionCell) || Boolean(fixedAction && renewalControl(fixedRow));
    const item = {
      title, author: value('author', 250), borrowDate: value('borrowDate'), dueDate: value('dueDate'),
      pageStatus, renewalCount: value('renewalCount'), eligibility: value('eligibility'),
      renewalNote: value('operation'), hasRenewalAction, displayedRow: index + 1,
    };
    if (target && JSON.stringify(item) === JSON.stringify(target)) {
      row.scrollIntoView({ block: 'center' });
      positioned = true;
    }
    return [item];
  });
  return {
    current: true, records, omittedRows, explicitEmpty, genericEmpty, renderedQuota, positioned, unreadSections,
    displayedPage, pageReportedTotal, allPagesRead: allPagesRead && (pageReportedTotal === null || pageReportedTotal === records.length),
  };
}
