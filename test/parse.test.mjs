import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimetable, parseLectures, parseLibrary } from '../src/parse.mjs';

const page = (data = {}) => ({ url: 'https://1.tongji.edu.cn/', title: '同济大学', text: '', tables: [], links: [], ...data });

test('authentication pages do not expose page contents or redirect credentials', () => {
  const snapshot = page({
    url: 'https://iam.tongji.edu.cn/idp/AuthnEngine?ticket=SECRET&service=course',
    title: '统一身份认证', text: '学工号 密码 登录 忘记密码 USER-PRIVATE',
    tables: [{ headers: ['课程名称'], rows: [['SHOULD-NOT-RETURN']] }],
  });
  for (const parse of [parseTimetable, parseLectures, parseLibrary]) {
    const result = parse(snapshot);
    assert.equal(result.status, 'login_required');
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.evidence, { tables: [], text: '' });
    assert.doesNotMatch(JSON.stringify(result), /SECRET|USER-PRIVATE|SHOULD-NOT-RETURN/);
  }
});

test('timetable maps columns by headings and keeps ambiguous combined times verbatim', () => {
  const result = parseTimetable(page({
    title: '我的课表', text: '2026 秋季学期 我的课表',
    tables: [{ headers: ['上课地点', '课程名称', '任课教师', '上课时间'], rows: [['四平路某教室', '课程甲', '教师甲', '第 1-8 周，周二 3-4 节']] }],
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, [{ location: '四平路某教室', course: '课程甲', teacher: '教师甲', time: '第 1-8 周，周二 3-4 节' }]);
  assert.equal(result.records[0].day, undefined);
  assert.equal(result.records[0].week, undefined);
});

test('timetable grid is preserved without inventing courses or weekdays', () => {
  const result = parseTimetable(page({ title: '课程表', text: '课程表', tables: [{ headers: ['节次', '星期一', '星期二'], rows: [['1-2', '课程甲\n教师甲', '']] }] }));
  assert.equal(result.status, 'unstructured');
  assert.deepEqual(result.records, []);
  assert.equal(result.evidence.tables[0].rows[0][1], '课程甲\n教师甲');
});

test('course catalogs and study plans do not become a personal timetable through navigation text', () => {
  for (const title of ['选课目录', '培养计划', '同济大学研究生管理系统']) {
    const snapshot = page({
      title, text: '导航：我的课表 高等讲堂 培养计划\n课程目录\n课程甲 3 学分',
      tables: [{ headers: ['课程名称', '学分', '任课教师', '学期'], rows: [['课程甲', '3', '教师甲', '2026 秋季']] }],
    });
    const result = parseTimetable(snapshot);
    assert.equal(result.status, 'needs_page_selection', title);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.evidence.tables, snapshot.tables);
  }
  const emptyCatalog = parseTimetable(page({
    title: '选课目录', text: '导航：我的课表\n暂无数据',
    tables: [{ headers: ['课程名称', '学分'], rows: [] }],
  }));
  assert.equal(emptyCatalog.status, 'needs_page_selection');
});

test('a generic page title still permits explicit schedule columns, without using menu text', () => {
  const result = parseTimetable(page({
    title: '同济大学研究生管理系统', text: '课程甲 教师甲 第 3-10 周',
    tables: [{ headers: ['课程名称', '上课周次', '上课教室'], rows: [['课程甲', '3-10', '教室甲']] }],
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, [{ course: '课程甲', week: '3-10', location: '教室甲' }]);
});

test('an explicitly selected timetable page may expose only course-name columns', () => {
  const result = parseTimetable(page({
    title: '同济大学', url: 'https://1.tongji.edu.cn/#/student/timetable',
    tables: [{ headers: ['课程名称', '任课教师'], rows: [['课程甲', '教师甲']] }],
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, [{ course: '课程甲', teacher: '教师甲' }]);
});

test('graduate timetable headings map teaching arrangements verbatim without personal fixture data', () => {
  const result = parseTimetable(page({
    title: '同济大学', url: 'https://1.tongji.edu.cn/GraduateStudentTimeTable',
    text: '研究生课表 示例课程甲 示例教师',
    tables: [{
      headers: ['', '新课程序号', '课程名称', '重修', '必/选修', '考试/查', '教学方式', '学分', '教师', '教学安排', '备注', '校区'],
      rows: [['1', 'EXAMPLE-001', '示例课程甲', '否', '选修', '考查', '课堂教学', '2', '示例教师', '1-8 周，星期三 3-4 节；示例楼 101', '示例备注', '示例校区']],
    }],
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, [{
    course: '示例课程甲', courseCode: 'EXAMPLE-001', teacher: '示例教师',
    time: '1-8 周，星期三 3-4 节；示例楼 101', notes: '示例备注', campus: '示例校区',
  }]);
  assert.equal(result.records[0].day, undefined);
  assert.equal(result.records[0].location, undefined);
  assert.equal(result.records[0].week, undefined);
});

test('ragged and duplicate columns are not assigned to the wrong fields', () => {
  const ragged = parseTimetable(page({ title: '课表', tables: [{ headers: ['课程名称', '教师', '地点'], rows: [['课程甲', '四平路教室']] }] }));
  assert.equal(ragged.status, 'unstructured');
  assert.deepEqual(ragged.records, []);
  assert.match(ragged.warnings.join(' '), /列数不同/);
  const duplicate = parseTimetable(page({ title: '课表', tables: [{ headers: ['课程名称', '课程名', '教师'], rows: [['课程甲', '课程乙', '教师甲']] }] }));
  assert.equal(duplicate.status, 'unstructured');
  assert.deepEqual(duplicate.records, []);
});

test('explicit empty state is distinct from loading and from an unrelated page', () => {
  assert.equal(parseTimetable(page({ title: '学生课表', text: '暂无数据' })).status, 'empty');
  assert.equal(parseTimetable(page({ title: '学生课表', text: '加载中 暂无数据' })).status, 'unstructured');
  assert.equal(parseTimetable(page({ title: '校园门户', text: '欢迎使用，暂无数据' })).status, 'needs_page_selection');
  assert.equal(parseTimetable(page({ title: '课表', tables: [{ headers: ['课程名称'], rows: [] }] })).status, 'unstructured');
});

test('lecture completion counts are progress, never invented lecture events', () => {
  const result = parseLectures(page({ title: '高等讲堂完成情况', text: '研究生高等讲堂', tables: [{ headers: ['项目', '应修次数', '已修次数', '成绩'], rows: [['校级', '8', '5', '未完成'], ['院级', '4', '2', '未完成']] }] }));
  assert.equal(result.status, 'ok');
  assert.equal(result.dataType, 'progress');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.progress[0], { label: '校级', required: '8', completed: '5', status: '未完成' });
  assert.equal(result.progress[0].remaining, undefined);
});

test('wide lecture progress and named lectures remain separate', () => {
  const result = parseLectures(page({ title: '高等讲堂', text: '高等讲堂', tables: [
    { headers: ['校级应修数', '校级已修数', '院级应修数', '院级已修数'], rows: [['8', '5', '4', '2']] },
    { headers: ['讲座名称', '主讲人', '讲座时间', '地点'], rows: [['报告甲', '报告人甲', '2026-11-15 14:00', '地点甲']] },
  ] }));
  assert.equal(result.dataType, 'mixed');
  assert.equal(result.records.length, 1);
  assert.equal(result.progress.length, 1);
  assert.equal(result.records[0].title, '报告甲');
  assert.equal(result.progress[0].schoolCompleted, '5');
});

test('graduate lecture cards retain explicit requirements even when the lecture list is empty', () => {
  const text = '心得录入与评价\n最终成绩：未完成\n6/\n2\n校级应通过次数 / 校级通过次数\n5/\n1\n院级应通过次数 / 院级通过次数\n0/\n0\n本院院级应通过次数 / 本院院级通过次数\n3/\n1\n慕课应通过次数 / 慕课通过次数\n讲座\n序号\n暂无数据 共0条';
  const result = parseLectures(page({
    title: '同济大学', url: 'https://1.tongji.edu.cn/evaluate', text,
    tables: [{ headers: ['序号', '讲座名称', '讲座时间', '讲座级别', '讲座语言', '操作'], rows: [] }],
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.dataType, 'progress');
  assert.equal(result.overallStatus, '未完成');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.progress.map(({ label, required, completed }) => ({ label, required, completed })), [
    { label: '校级', required: '6', completed: '2' },
    { label: '院级', required: '5', completed: '1' },
    { label: '本院院级', required: '0', completed: '0' },
    { label: '慕课', required: '3', completed: '1' },
  ]);
  assert.equal(result.progress[0].sourceText, '6/\n2\n校级应通过次数 / 校级通过次数');
  assert.equal(result.evidence.text, text);
  assert.equal(result.progress[0].remaining, undefined);
});

test('lecture card numbers require contiguous matching labels and do not absorb unrelated counts', () => {
  const result = parseLectures(page({
    title: '高等讲堂', text: '6/\n2\n校级应通过次数 / 院级通过次数\n5/\n1\n无关文字\n院级应通过次数 / 院级通过次数\n0/\n0\n本院院级通过次数 / 本院院级应通过次数',
  }));
  assert.equal(result.status, 'unstructured');
  assert.deepEqual(result.progress, []);
  assert.deepEqual(result.records, []);
});

test('named lecture rows map their displayed level and language', () => {
  const result = parseLectures(page({
    title: '高等讲堂',
    tables: [{ headers: ['序号', '讲座名称', '讲座时间', '讲座级别', '讲座语言', '操作'], rows: [['1', '示例讲座', '示例时间', '校级', '中文', '查看']] }],
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.dataType, 'lectures');
  assert.deepEqual(result.records, [{ title: '示例讲座', time: '示例时间', category: '校级', language: '中文' }]);
});

test('library preserves the exact availability and distinguishes borrowing dates', () => {
  const catalog = parseLibrary(page({ url: 'https://webpac.tongji.edu.cn/#/Home', title: '馆藏检索', tables: [{ headers: ['题名', '馆藏地', '索书号', '可借状态'], rows: [['图书甲', '嘉定校区图书馆', 'A123', '在馆（仅供阅览）']] }] }));
  assert.equal(catalog.status, 'ok');
  assert.equal(catalog.dataType, 'catalog');
  assert.equal(catalog.records[0].status, '在馆（仅供阅览）');
  assert.equal(catalog.records[0].available, undefined);
  const borrowing = parseLibrary(page({ title: '我的图书馆', text: '当前借阅', tables: [{ headers: ['书名', '借出日期', '应还日期'], rows: [['图书甲', '2026-11-01', '2026-12-01']] }] }));
  assert.equal(borrowing.dataType, 'borrowing');
  assert.equal(borrowing.records[0].dueDate, '2026-12-01');
});

test('source URL keeps useful page identity but removes authentication parameters', () => {
  const result = parseTimetable(page({ url: 'https://1.tongji.edu.cn/timetable?semester=2026&access_token=SECRET#/?id_token=HIDDEN', title: '我的课表' }));
  assert.match(result.source.url, /semester=2026/);
  assert.doesNotMatch(result.source.url, /SECRET|HIDDEN/);
  assert.doesNotMatch(parseTimetable(page({ url: 'https://1.tongji.edu.cn/#access_token=SECRET&state=HIDDEN' })).source.url, /SECRET|HIDDEN/);
  assert.equal(parseLibrary(page({ url: 'javascript:alert(1)' })).source.url, '');
});

test('a generic book list is not mislabeled as global catalog availability', () => {
  const result = parseLibrary(page({ title: '我的图书馆', tables: [{ headers: ['书名', '状态'], rows: [['图书甲', '正常']] }] }));
  assert.equal(result.status, 'ok');
  assert.equal(result.dataType, 'unknown');
});

const catalogCards = '检索结果\n共\n120\n条\n1. [图书]\n示例线性代数\n. 第2版\nAI解读\nO151.2/ZX000\n示例作者\n示例出版社\n2020\n978-0-0000-0000-0\n描述...\n纸本\n(\n3\n) /\n可借\n(\n2\n)\n2. [图书]\n示例书乙\nAI解读\nO1/AAA\n描述...\n纸本\n(\n4\n) /\n可借\n(\n0\n)';

test('catalog result cards map explicit availability without guessing author or publisher', () => {
  const result = parseLibrary(page({
    url: 'https://webpac.tongji.edu.cn/opac/openlink.php#/searchList', title: '同济大学图书馆', text: catalogCards,
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.dataType, 'catalog');
  assert.equal(result.totalResults, 120);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].title, '示例线性代数 . 第2版');
  assert.equal(result.records[0].callNumber, 'O151.2/ZX000');
  assert.equal(result.records[0].paperCopies, 3);
  assert.equal(result.records[0].availableCopies, 2);
  assert.match(result.records[0].summaryText, /示例线性代数/);
  assert.equal(result.records[0].author, undefined);
  assert.equal(result.records[0].publisher, undefined);
  assert.equal(result.records[1].availableCopies, 0);
});

test('catalog cards accept nonbreaking spaces and a unique explicit total before the list', () => {
  const result = parseLibrary(page({
    url: 'https://webpac.tongji.edu.cn/opac/openlink.php#/searchList', title: '检索结果',
    text: '学科聚类\n数学 80\n语言 40\n共\n120\n条\n相关度\n' + catalogCards.slice(catalogCards.indexOf('1. [图书]')).replaceAll('. [', '.\u00a0['),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.totalResults, 120);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].title, '示例线性代数 . 第2版');
});

test('multiple explicit counts before catalog cards are ambiguous and not selected as a total', () => {
  const result = parseLibrary(page({
    url: 'https://webpac.tongji.edu.cn/#/searchList', title: '检索结果',
    text: '共\n120\n条\n另一分组\n共\n120\n条\n' + catalogCards.slice(catalogCards.indexOf('1. [图书]')),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.totalResults, undefined);
  assert.equal(result.records.length, 2);
});

test('homepage recommendations and book detail routes do not masquerade as search cards', () => {
  for (const url of ['https://webpac.tongji.edu.cn/#/Home', 'https://webpac.tongji.edu.cn/#/bookDetails']) {
    const result = parseLibrary(page({ url, title: '同济大学图书馆', text: catalogCards }));
    assert.deepEqual(result.records, []);
    assert.equal(result.totalResults, undefined);
  }
  const detailWithSearchTitle = parseLibrary(page({ url: 'https://webpac.tongji.edu.cn/#/bookDetails', title: '检索结果', text: catalogCards }));
  assert.deepEqual(detailWithSearchTitle.records, []);
});

test('partial catalog cards keep known fields and never fill missing availability with zero', () => {
  const result = parseLibrary(page({
    url: 'https://webpac.tongji.edu.cn/#/searchList', title: '检索结果', truncated: true,
    text: '检索结果\n共\n120\n条\n1. [图书]\n示例线性代数\nAI解读\nO151.2/ZX000\n纸本\n(\n3\n) /\n可借\n(\n',
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.records[0].paperCopies, 3);
  assert.equal(result.records[0].availableCopies, undefined);
  assert.equal(result.records[0].incomplete, true);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(' '), /缺失数量不代表零/);
});

test('catalog facet numbers do not become total results and uncertain classification lines stay raw', () => {
  const result = parseLibrary(page({
    title: '检索结果', url: 'https://webpac.tongji.edu.cn/#/searchList',
    text: '学科聚类\n120\n1. [学位论文]\n示例论文\nAI解读\n2020/2021\n978-0-0000-0000-0\n',
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.totalResults, undefined);
  assert.equal(result.records[0].resourceType, '学位论文');
  assert.equal(result.records[0].callNumber, undefined);
  assert.equal(result.records[0].paperCopies, undefined);
  assert.equal(result.records[0].availableCopies, undefined);
  assert.equal(parseLibrary(page({ title: '检索结果', text: '正在检索 暂无数据 共0条' })).status, 'unstructured');
});

test('huge snapshots are bounded and reported as incomplete', () => {
  const result = parseTimetable(page({ title: '课表', text: '课表'.repeat(10000), tables: Array.from({ length: 20 }, () => ({ headers: ['课程名称', '教师'], rows: Array.from({ length: 1000 }, () => ['课'.repeat(10000), '师'.repeat(10000)]) })) }));
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length < 40000);
  assert.ok(result.evidence.text.length <= 5000);
  assert.ok(result.evidence.tables.length <= 8);
});

test('browser-reported truncation survives parsing even when the received evidence is short', () => {
  for (const snapshot of [
    page({ title: '课表', text: '课表', truncated: true }),
    page({ title: '课表', tables: [{ headers: ['课程名称'], rows: [['示例课程']], truncated: true }] }),
  ]) {
    const result = parseTimetable(snapshot);
    assert.equal(result.truncated, true);
    assert.match(result.warnings.join(' '), /截断/);
  }
});

test('missing snapshots do not throw or pretend that a query succeeded', () => {
  for (const parse of [parseTimetable, parseLectures, parseLibrary]) {
    const result = parse(undefined);
    assert.equal(result.status, 'needs_page_selection');
    assert.deepEqual(result.records, []);
  }
});
