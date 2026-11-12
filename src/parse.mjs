// Parse only visible-page evidence. No requests, inference about dates, or account access.
const LIMITS = { text: 5000, tables: 8, rows: 100, columns: 24, cell: 500, tableChars: 14000 };
const EMPTY = /暂无(?:数据|记录|相关|结果)|无(?:查询|检索)结果|未(?:查询|检索)到|没有找到|没有符合|共\s*0\s*条|(?:结果|记录)\s*[:：]?\s*0\s*条|0\s*(?:条记录|个结果)|no\s+(?:results|records|data)\b/i;
const LOADING = /正在加载|加载中|正在检索|loading\s*\.{0,3}/i;
const clean = (value) => String(value ?? '').replace(/\u0000/g, '').trim();
const norm = (value) => clean(value).replace(/[\s:：()（）【】\[\]*＊]/g, '').toLowerCase();

function safeUrl(value) {
  try {
    const url = new URL(clean(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    // Login redirects can contain credentials even when the page snapshot is harmless.
    for (const key of [...url.searchParams.keys()]) {
      if (/token|ticket|password|passwd|secret|authorization|session|credential|jwt|^auth$|^code$|^state$|^samlresponse$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = url.hash.replace(/(^#|[?&])(?:access_token|id_token|refresh_token|token|ticket|code|state)=[^&]*/gi, '$1').replace(/[?#&]+$/, '');
    return url.href.slice(0, 2048);
  } catch {
    return '';
  }
}

function loginPage(snapshot) {
  const title = clean(snapshot?.title);
  const text = clean(snapshot?.text).slice(0, 1800);
  let url;
  try { url = new URL(snapshot?.url); } catch { /* The caller may supply an empty snapshot. */ }
  const loginRoute = url && /(?:^|\/)(?:login|signin|sign-in|authnengine)(?:\/|$)|\/protocol\/openid-connect\/auth(?:\/|$)|\/idp\/profile\/(?:SAML2|OAUTH2)\//i.test(url.pathname);
  if (loginRoute || /统一身份认证|身份认证平台|用户登录|账户登录|账号登录|同济.*登录|sign\s*in/i.test(title)) return true;
  return /(?:统一身份认证|忘记密码|忘记口令)/.test(text)
    && /(?:密码|口令|验证码)/.test(text)
    && /(?:登录|登\s*录)/.test(text)
    && /(?:用户名|学工号|学号|账号|账户)/.test(text);
}

function boundedSnapshot(snapshot) {
  let truncated = Boolean(snapshot?.truncated);
  let remaining = LIMITS.tableChars;
  const clip = (value, max) => {
    const text = clean(value);
    if (text.length > max) truncated = true;
    return text.slice(0, max);
  };
  const rawTables = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
  if (rawTables.length > LIMITS.tables || rawTables.some((table) => Boolean(table?.truncated))) truncated = true;
  const tables = rawTables.slice(0, LIMITS.tables).map((table) => {
    const rawHeaders = Array.isArray(table?.headers) ? table.headers : [];
    const rawRows = Array.isArray(table?.rows) ? table.rows : [];
    if (rawHeaders.length > LIMITS.columns || rawRows.length > LIMITS.rows) truncated = true;
    const headers = rawHeaders.slice(0, LIMITS.columns).map((cell) => clip(cell, 120));
    const rows = [];
    for (const row of rawRows.slice(0, LIMITS.rows)) {
      if (!Array.isArray(row)) continue;
      if (remaining <= 0) { truncated = true; break; }
      if (row.length > LIMITS.columns) truncated = true;
      const cells = row.slice(0, LIMITS.columns).map((cell) => {
        const value = clip(cell, Math.min(LIMITS.cell, Math.max(0, remaining)));
        remaining -= value.length;
        return value;
      });
      if (cells.some(Boolean)) rows.push(cells);
    }
    return { headers, rows };
  });
  return {
    source: { url: safeUrl(snapshot?.url), title: clip(snapshot?.title, 200) },
    text: clip(snapshot?.text, LIMITS.text), tables, truncated,
  };
}

function base(kind, snapshot) {
  if (loginPage(snapshot)) {
    return {
      kind, status: 'login_required',
      source: { url: safeUrl(snapshot?.url), title: clean(snapshot?.title).slice(0, 200) },
      records: [], evidence: { tables: [], text: '' },
      warnings: ['请在本机浏览器的同济官方页面完成登录，再重新查询。'], truncated: false,
    };
  }
  const bounded = boundedSnapshot(snapshot);
  return {
    kind, status: 'needs_page_selection', source: bounded.source, records: [],
    evidence: { tables: bounded.tables, text: bounded.text },
    warnings: bounded.truncated ? ['页面证据已截断；结果可能不完整。'] : [],
    truncated: bounded.truncated,
  };
}

function headerMap(headers, aliases) {
  const normalized = headers.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(aliases)) {
    const acceptable = new Set(names.map(norm));
    const matches = normalized.flatMap((header, index) => acceptable.has(header) ? [index] : []);
    // Duplicate matching columns are ambiguous, so preserve the table without guessing.
    if (matches.length === 1) map[field] = matches[0];
  }
  return map;
}

function rowsFrom(table, aliases, requiredField, warnings) {
  const fields = headerMap(table.headers, aliases);
  if (!(requiredField in fields)) return null;
  const records = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row.length !== table.headers.length) {
      warnings.push(`表格第 ${index + 1} 行与表头列数不同，已保留原文而未映射字段。`);
      continue;
    }
    // A one-cell empty-state row can appear underneath a full-width table heading.
    if (row.every((cell) => !cell || EMPTY.test(cell))) continue;
    if (!row[fields[requiredField]]) continue;
    const record = {};
    for (const [field, column] of Object.entries(fields)) {
      if (row[column]) record[field] = row[column];
    }
    records.push(record);
  }
  return records;
}

function finish(result, { relevant, matched, hasRows }) {
  const text = result.evidence.text;
  if (hasRows) result.status = 'ok';
  else if (relevant && EMPTY.test(text) && !LOADING.test(text)) result.status = 'empty';
  else if (matched || relevant) result.status = 'unstructured';
  else result.status = 'needs_page_selection';
  if (LOADING.test(text) && !hasRows) result.warnings.push('页面似乎仍在加载，请等待后重试。');
  if (result.status === 'unstructured') result.warnings.push('未能可靠提取结构化记录；请依据页面原文核对，必要时在浏览器中打开目标查询页。');
  if (result.status === 'needs_page_selection') result.warnings.push('请在本机浏览器中打开对应查询页面，再重新读取。');
  result.warnings = [...new Set(result.warnings)].slice(0, 8);
  return result;
}

const TIMETABLE = {
  course: ['课程名称', '课程名', '课程', '教学班名称'],
  courseCode: ['课程代码', '课程编号', '课程号', '新课程序号'],
  teacher: ['教师', '教师姓名', '任课教师', '授课教师', '上课教师'],
  location: ['上课地点', '授课地点', '上课教室', '地点', '教室'],
  week: ['周次', '上课周次', '教学周'],
  day: ['星期', '上课星期', '星期几', '周几'],
  period: ['节次', '上课节次', '课节'],
  time: ['上课时间', '授课时间', '时间', '教学安排'],
  semester: ['学期', '学年学期'],
  notes: ['备注'],
  campus: ['校区'],
};

export function parseTimetable(snapshot) {
  const result = base('timetable', snapshot);
  if (result.status === 'login_required') return result;
  // Portal navigation often includes “我的课表” on every page. Body text alone
  // therefore cannot establish that a course-name table is the user's schedule.
  let route = '';
  try {
    const url = new URL(result.source.url);
    route = decodeURIComponent(`${url.pathname}\n${url.hash}`);
  } catch { /* Missing or malformed URL is not evidence of a timetable page. */ }
  const unrelatedTitle = /选课目录|课程目录|培养计划|教学计划|课程设置|课程库/.test(result.source.title);
  const explicitPage = !unrelatedTitle && /课表|课程表|timetable/i.test(`${result.source.title}\n${route}`);
  let matched = false;
  for (const table of result.evidence.tables) {
    const fields = headerMap(table.headers, TIMETABLE);
    const hasScheduleColumns = ['location', 'week', 'day', 'period', 'time'].some((field) => field in fields);
    // Course titles, credits, teachers and semesters also occur in course
    // catalogs and study plans; they are not sufficient schedule evidence.
    if (!explicitPage && !hasScheduleColumns) continue;
    const records = rowsFrom(table, TIMETABLE, 'course', result.warnings);
    if (records !== null) { matched = true; result.records.push(...records); }
  }
  return finish(result, { relevant: explicitPage || matched, matched, hasRows: result.records.length > 0 });
}

const LECTURES = {
  title: ['讲座名称', '讲堂名称', '讲座题目', '报告题目', '讲座主题', '活动名称'],
  speaker: ['主讲人', '主讲嘉宾', '报告人', '讲者'],
  time: ['讲座时间', '报告时间', '活动时间', '开始时间', '时间'],
  location: ['讲座地点', '报告地点', '活动地点', '地点'],
  status: ['状态', '报名状态', '参与情况', '完成情况', '审核状态'],
  category: ['讲座类别', '讲堂类别', '讲座级别', '类别', '级别'],
  language: ['讲座语言'],
};
const PROGRESS = {
  label: ['项目', '类别', '讲堂类别', '讲座类别', '级别', '考核项目', '考核内容'],
  required: ['应修', '应修次数', '应修数量', '应修数', '要求次数', '要求数量'],
  completed: ['已修', '已修次数', '已修数量', '已修数', '完成次数', '完成数量'],
  status: ['完成情况', '是否完成', '评价完成情况', '心得录入情况', '状态', '成绩'],
};
const WIDE_PROGRESS = {
  schoolRequired: ['校级应修', '校级应修数', '校级应修次数', '校级应修数量'],
  schoolCompleted: ['校级已修', '校级已修数', '校级已修次数', '校级已修数量'],
  departmentRequired: ['院级应修', '院级应修数', '院级应修次数', '院级应修数量'],
  departmentCompleted: ['院级已修', '院级已修数', '院级已修次数', '院级已修数量'],
  status: ['完成情况', '是否完成', '成绩'],
};

function lectureTextProgress(text) {
  // The graduate /evaluate page renders counts as cards rather than table
  // rows: “required / completed”, followed immediately by an explicit label.
  // Require both adjacency and matching category names to avoid assigning
  // unrelated numbers (or reversed labels) to lecture requirements.
  const pattern = /(?:^|\n)[ \t]*(?<required>\d+)[ \t]*\/[ \t]*(?:\r?\n[ \t]*)?(?<completed>\d+)[ \t]*\r?\n[ \t]*(?<label>本院院级|校级|院级|慕课)应通过次数[ \t]*\/[ \t]*\k<label>通过次数(?:[ \t]*(?=\r?\n|$))/gu;
  return [...text.matchAll(pattern)].map((match) => ({
    label: match.groups.label,
    required: match.groups.required,
    completed: match.groups.completed,
    sourceText: match[0].trim(),
  }));
}

export function parseLectures(snapshot) {
  const result = base('lectures', snapshot);
  result.progress = [];
  if (result.status === 'login_required') return result;
  const relevant = /高等讲堂|讲堂|讲座|心得录入与评价|lecture/i.test(`${result.source.title}\n${result.evidence.text}`);
  let matched = false;
  for (const table of result.evidence.tables) {
    const aliases = relevant ? { ...LECTURES, title: [...LECTURES.title, '题目', '主题', '名称'] } : LECTURES;
    const records = rowsFrom(table, aliases, 'title', result.warnings);
    if (records !== null) { matched = true; result.records.push(...records); }
    if (!relevant) continue;
    const fields = headerMap(table.headers, PROGRESS);
    if ('label' in fields && ('required' in fields || 'completed' in fields || 'status' in fields)) {
      const progress = rowsFrom(table, PROGRESS, 'label', result.warnings);
      matched = true;
      result.progress.push(...progress);
    }
    const wideFields = headerMap(table.headers, WIDE_PROGRESS);
    const required = ['schoolRequired', 'schoolCompleted', 'departmentRequired', 'departmentCompleted'].find((key) => key in wideFields);
    if (required) {
      const progress = rowsFrom(table, WIDE_PROGRESS, required, result.warnings);
      matched = true;
      result.progress.push(...progress);
    }
  }
  if (relevant) {
    for (const progress of lectureTextProgress(result.evidence.text)) {
      const duplicate = result.progress.some((item) => item.label === progress.label && item.required === progress.required && item.completed === progress.completed);
      if (!duplicate) result.progress.push(progress);
    }
    const overall = result.evidence.text.match(/(?:^|\n)[ \t]*最终成绩[ \t]*[：:][ \t]*([^\r\n]{1,80})/u);
    if (overall) result.overallStatus = overall[1].trim();
  }
  const hasProgress = result.progress.length > 0 || Boolean(result.overallStatus);
  result.dataType = result.records.length ? (hasProgress ? 'mixed' : 'lectures') : (hasProgress ? 'progress' : 'unknown');
  return finish(result, { relevant: relevant || matched, matched, hasRows: result.records.length > 0 || hasProgress });
}

const LIBRARY = {
  title: ['书名', '题名', '图书名称', '题名/责任者', '题名／责任者', '题名信息', 'title'],
  author: ['作者', '责任者', 'author'],
  isbn: ['ISBN', 'ISBN号', 'ISBN/ISSN', 'ISBN／ISSN'],
  location: ['馆藏地', '馆藏地点', '馆藏位置', '所属馆', '所在馆', '馆别', '馆藏馆'],
  callNumber: ['索书号', '排架号'],
  status: ['状态', '馆藏状态', '借阅状态', '流通状态', '在馆状态', '可借状态'],
  dueDate: ['应还日期', '应还时间', '到期日期', '归还期限'],
  borrowedAt: ['借出日期', '借出时间', '借阅日期'],
  returnedAt: ['实际归还时间', '实际归还日期', '归还日期'],
  publisher: ['出版社', '出版者'],
};

function isCatalogSearchPage(source) {
  let hash = '';
  try { hash = decodeURIComponent(new URL(source.url).hash); } catch { /* No usable route. */ }
  if (/bookDetails/i.test(hash)) return false;
  return /^#\/searchList(?:[/?]|$)/i.test(hash) || /检索结果/.test(source.title);
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function libraryCards(text, truncated) {
  const header = /(?:^|\n)[^\S\r\n]*(\d+)[.．、][^\S\r\n]*\[(图书|学位论文|期刊|会议论文|电子图书|电子书|报纸|标准|专利|音像资料|视听资料|古籍|特种文献|论文)\][^\S\r\n]*(?=\r?\n|$)/gu;
  const starts = [...text.matchAll(header)];
  const records = [];
  const warnings = [];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const end = starts[index + 1]?.index ?? text.length;
    const segment = text.slice(match.index, end).trim();
    const content = text.slice(match.index + match[0].length, end).trim();
    const record = { recordNumber: safeCount(match[1]), resourceType: match[2] };
    const aiMarker = content.match(/(?:^|\n)[ \t]*AI解读[ \t]*(?=\r?\n|$)/u);
    if (aiMarker) {
      const title = content.slice(0, aiMarker.index).trim().split(/\r?\n/u).map(clean).filter(Boolean).join(' ');
      if (title) record.title = title.slice(0, 500);
    }
    const callNumbers = [...new Set(content.split(/\r?\n/u).map(clean).filter((line) => /^[A-Z]{1,3}\d[A-Z\d.\-]*\/[A-Z\d][A-Z\d.\-]*(?:[（(]\d+[）)])?$/iu.test(line)))];
    if (callNumbers.length === 1) record.callNumber = callNumbers[0];
    const paper = content.match(/纸本\s*[（(]\s*(\d+)\s*[）)]/u);
    const available = content.match(/可借\s*[（(]\s*(\d+)\s*[）)]/u);
    if (paper && safeCount(paper[1]) !== undefined) record.paperCopies = safeCount(paper[1]);
    if (available && safeCount(available[1]) !== undefined) record.availableCopies = safeCount(available[1]);
    const countEvidence = [paper?.[0], available?.[0]].filter(Boolean).join(' / ');
    record.summaryText = segment.slice(0, 700);
    if (segment.length > 700 && countEvidence) record.summaryText += `\n…\n${countEvidence}`;
    if (!record.title || (/纸本\s*[（(]/u.test(content) && !paper) || (/可借\s*[（(]/u.test(content) && !available) || (truncated && index === starts.length - 1)) {
      record.incomplete = true;
      warnings.push(`第 ${match[1]} 条书目卡片可能不完整，已保留可见字段；缺失数量不代表零。`);
    }
    records.push(record);
  }
  // This helper only runs for a verified search-result title/route. A single
  // explicit “共 N 条” before the numbered list can identify its total even
  // when “检索结果” appears only in document.title. Ambiguous totals are omitted.
  const prefix = text.slice(0, starts[0]?.index ?? text.length);
  const totals = [...prefix.matchAll(/(?:^|\n)[^\S\r\n]*共\s*(\d+)\s*条(?=\s|$)/gu)];
  return { records, warnings, totalResults: totals.length === 1 ? safeCount(totals[0][1]) : undefined };
}

export function parseLibrary(snapshot) {
  const result = base('library', snapshot);
  if (result.status === 'login_required') return result;
  const relevant = /图书|馆藏|借阅|书目|检索结果|library|catalog|opac/i.test(`${result.source.title}\n${result.evidence.text}\n${result.source.url}`);
  let matched = false;
  for (const table of result.evidence.tables) {
    const records = rowsFrom(table, LIBRARY, 'title', result.warnings);
    if (records !== null) { matched = true; result.records.push(...records); }
  }
  const catalogSearch = isCatalogSearchPage(result.source);
  if (catalogSearch) {
    const cards = libraryCards(result.evidence.text, result.truncated);
    result.records.push(...cards.records);
    result.warnings.push(...cards.warnings);
    if (cards.records.length) matched = true;
    if (cards.totalResults !== undefined) result.totalResults = cards.totalResults;
  }
  const context = `${result.source.title}\n${result.evidence.text}\n${result.source.url}`;
  const borrowingContext = /我的借阅|当前借阅|借阅记录|个人借阅|在借图书|当前外借/.test(context);
  const catalogContext = catalogSearch || /馆藏检索|书目检索|检索结果|图书检索|catalog|opac|webpac/i.test(context);
  result.dataType = result.records.length && (borrowingContext || result.records.some((row) => row.dueDate || row.borrowedAt || row.returnedAt))
    ? 'borrowing' : (result.records.length && catalogContext ? 'catalog' : 'unknown');
  return finish(result, { relevant: relevant || matched, matched, hasRows: result.records.length > 0 });
}
