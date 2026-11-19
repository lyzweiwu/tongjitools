import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { exportTimetable } from '../src/calendar-export.mjs';
import { CampusBrowser } from '../src/browser.mjs';
import { parseTimetable } from '../src/parse.mjs';

const now = new Date('2026-11-20T01:02:03Z');
const term = '2026-2027学年第1学期';
const schedulePage = {
  title: '同济大学', url: 'https://1.tongji.edu.cn/GraduateStudentTimeTable',
  selectedTerms: [term], text: '我的课表\n学生姓名：PRIVATE_FIXTURE\n学号：PRIVATE_NUMBER',
};
const headers = ['新课程序号', '课程名称', '教师', '教学安排', '备注', '校区'];
const row = (time, code = 'FIX-001', course = '虚构课程', notes = '') => [code, course, '示例教师', time, notes, '示例校区'];
const snapshot = (rows, extra = {}) => ({
  ...schedulePage, tables: [{ headers, rows }], ...extra,
});

async function fixture(t, page) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tongji-calendar-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const browser = new CampusBrowser({ dataDir });
  // Go through the shared browser query/parse entry point without a school
  // connection. Use an explicit fixture only for the rendered snapshot.
  browser.pageFor = async () => ({ url: () => page.url });
  browser.snapshot = async (tab, service, options) => {
    assert.equal(service, 'academic');
    assert.equal(options.forExport, true);
    return { status: 'ok', ...page };
  };
  browser.tryNavigation = async () => ({ navigated: false, candidates: [] });
  return { dataDir, run: options => exportTimetable(browser, options, now) };
}

function readEvents(ics) {
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(ics.replaceAll('\r\n', ''), /[\r\n]/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  const text = ics.replaceAll('\r\n ', '');
  const events = [...text.matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)END:VEVENT\r\n/g)].map(([, body]) =>
    Object.fromEntries(body.trimEnd().split('\r\n').map(line => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })));
  for (const event of events) {
    for (const field of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'DESCRIPTION'])
      assert.ok(Object.hasOwn(event, field), field);
    for (const field of ['DTSTAMP', 'DTSTART', 'DTEND']) assert.match(event[field], /^\d{8}T\d{6}Z$/);
    assert.ok(event.DTSTART < event.DTEND);
  }
  assert.equal(new Set(events.map(event => event.UID)).size, events.length);
  return events;
}

test('default resolves the visible current term and expands continuous and bounded week ranges', async t => {
  const f = await fixture(t, snapshot([row('第 1–16 周，周二 3-4 节；示例楼 101'), row('4～12周 周三 9节 示例楼102', 'FIX-002')]));
  const result = await f.run();
  assert.equal(result.status, 'exported');
  assert.equal(result.eventCount, 25);
  assert.equal(result.courseCount, 2);
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.semesterStartDate, '2026-09-14');
  assert.equal(path.dirname(result.filePath), path.join(await realpath(f.dataDir), 'exports'));
  const events = readEvents(await readFile(result.filePath, 'utf8'));
  assert.equal(events.length, result.eventCount);
  assert.equal(events[0].DTSTART, '20260915T020000Z');
  assert.equal(events[0].DTEND, '20260915T033500Z');
  assert.equal(events[0].DTSTAMP, '20261120T010203Z');
  assert.equal(events[0].LOCATION, '示例校区 示例楼 101');
  assert.equal(events.at(-1).DTSTART, '20261229T020000Z');
  assert.equal(events.filter(event => event.DTSTART.endsWith('103000Z')).length, 9);
  if (process.platform !== 'win32') assert.equal((await stat(result.filePath)).mode & 0o777, 0o600);
});

test('odd, even, and explicitly listed weeks stay distinct', async t => {
  const f = await fixture(t, snapshot([
    row('周一 1节（1-9周（单）） 示例楼101', 'ODD', '单周课'),
    row('1-10（双周） 星期二 2节 示例楼102', 'EVEN', '双周课'),
    row('第1周、第3周、第5周、第7周 周三 3节 示例楼103', 'LIST', '不连续课'),
  ]));
  const result = await f.run();
  assert.equal(result.status, 'exported');
  const events = readEvents(await readFile(result.filePath, 'utf8'));
  const weeksOf = course => events.filter(event => event.SUMMARY === course)
    .map(event => Number(/第 (\d+) 周/.exec(event.DESCRIPTION)[1]));
  assert.deepEqual(weeksOf('单周课'), [1, 3, 5, 7, 9]);
  assert.deepEqual(weeksOf('双周课'), [2, 4, 6, 8, 10]);
  assert.deepEqual(weeksOf('不连续课'), [1, 3, 5, 7]);
});

test('one course can meet multiple times a week and change room and time between weeks', async t => {
  const f = await fixture(t, snapshot([
    row('1-2周 周一 1-2节；示例楼 101\n1-4周 星期四 5-6节 示例楼 303\n3-4周 周一 3-4节 至善楼 202'),
    row('1-2周 周一 1-2节 示例楼 101'),
  ]));
  const result = await f.run();
  assert.equal(result.status, 'exported');
  assert.equal(result.courseCount, 1);
  const events = readEvents(await readFile(result.filePath, 'utf8'));
  assert.equal(events.length, 8);
  assert.equal(events.find(event => event.DTSTART === '20260914T000000Z').LOCATION, '示例校区 示例楼 101');
  assert.equal(events.find(event => event.DTSTART === '20260928T020000Z').LOCATION, '示例校区 至善楼 202');
  assert.equal(events.filter(event => event.LOCATION.endsWith('303')).length, 4);
});

test('separate schedule columns and explicit Shanghai times cross UTC day and year boundaries', async t => {
  const f = await fixture(t, {
    ...schedulePage,
    tables: [{
      headers: ['课程名称', '周次', '星期', '上课开始时间', '上课结束时间', '教学楼', '教室'],
      rows: [['凌晨课', '16-17', '星期五', '00:15', '00:55', '示例楼', '101']],
    }],
  });
  const result = await f.run();
  assert.equal(result.status, 'exported');
  const events = readEvents(await readFile(result.filePath, 'utf8'));
  assert.deepEqual(events.map(event => event.DTSTART), ['20261231T161500Z', '20270107T161500Z']);
  assert.equal(events[0].DTEND, '20261231T165500Z');
  assert.equal(events[0].LOCATION, '示例楼 101');
});

test('folds UTF-8 without splitting Chinese or emoji, escapes TEXT, and uses only course fields', async t => {
  const course = '课程😀'.repeat(25) + ';周次,上册\\附录\r\n续';
  const f = await fixture(t, snapshot([], { tables: [{
    headers: ['课程名称', '任课教师', '课程编号', '周次', '星期', '节次', '教室', '备注', '学生姓名', '学号'],
    rows: [[course, '教师甲,教师乙', 'SYNTHETIC', '1', '1', '3', '楼A;101', 'PRIVATE_NOTE',
      'PRIVATE_NAME', 'PRIVATE_NUMBER']],
  }] }));
  const result = await f.run({ calendarName: '课表;甲,乙\\附\n录' });
  const bytes = await readFile(result.filePath);
  const ics = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const [event] = readEvents(ics);
  assert.match(ics, /\r\n /);
  assert.match(ics, /X-WR-CALNAME:课表\\;甲\\,乙\\\\附\\n录/);
  assert.equal(event.SUMMARY, course.replace(';', '\\;').replace(',', '\\,').replace('\\附', '\\\\附').replace('\r\n', '\\n'));
  assert.equal(event.LOCATION, '楼A\\;101');
  assert.match(event.DESCRIPTION, /教师：教师甲\\,教师乙\\n课程编号：SYNTHETIC/);
  assert.doesNotMatch(ics + JSON.stringify(result), /PRIVATE_|VALARM|ATTENDEE|ORGANIZER|RRULE/);
});

test('unconfirmed changes preserve dates; explicit cancels, moves and extra classes affect only their targets', async t => {
  const f = await fixture(t, snapshot([row('1-4周 周四 1节 示例楼101（节假日安排另行通知）')]));
  const base = await f.run();
  const original = readEvents(await readFile(base.filePath, 'utf8'));
  assert.equal(original.length, 4);
  assert.ok(original.some(event => event.DTSTART === '20261001T000000Z'));
  assert.ok(base.warnings.some(warning => warning.includes('「虚构课程」有调课相关备注')));
  const result = await f.run({ scheduleChanges: [
    { action: 'cancel', courseCode: 'FIX-001', date: '2026-10-01', startTime: '08:00' },
    { action: 'move', courseCode: 'FIX-001', date: '2026-09-24', startTime: '08:00',
      newDate: '2026-09-27', newTime: ['13:00', '13:45'], newLocation: '示例楼505' },
    { action: 'add', courseCode: 'FIX-001', date: '2026-09-17', startTime: '08:00', newDate: '2026-09-19' },
  ] });
  assert.equal(result.appliedChanges, 3);
  const events = readEvents(await readFile(result.filePath, 'utf8'));
  assert.deepEqual(events.map(event => event.DTSTART), ['20260917T000000Z', '20260919T000000Z', '20260927T050000Z', '20261008T000000Z']);
  assert.equal(events[2].LOCATION, '示例楼505');
  assert.equal(events[2].UID, original[1].UID);
  const invalid = await f.run({ scheduleChanges: [{ action: 'cancel', courseCode: 'FIX-001', date: '2026-10-01', startTime: '08:50' }] });
  assert.equal(invalid.status, 'invalid_schedule_changes');
  assert.equal(invalid.filePath, undefined);
});

test('partial export enumerates unreadable arrangements, malformed rows and conflicting meetings', async t => {
  const f = await fixture(t, snapshot([
    row('1周 周一 1节 示例楼101；时间另行通知'),
    row('双周 周一 1节', 'FIX-002', '缺周次课'),
    row('1-2周 周二 12节', 'FIX-003', '未知节次课'),
    row('1周 周一 1节 示例楼102'),
    row('1周 周三 1节 示例楼103', 'FIX-004', '可导出课'),
    ['FIX-005', '列数不足'],
  ]));
  const result = await f.run();
  assert.equal(result.status, 'partial_export');
  assert.equal(result.courseCount, 1);
  assert.equal(result.eventCount, 1);
  assert.equal(result.omitted.length, 5);
  assert.deepEqual(result.omitted[0], { table: 1, row: 6, reason: '列数与表头不符' });
  assert.ok(result.omitted.some(item => item.course === '未知节次课'));
  assert.ok(result.omitted.some(item => item.course === '缺周次课'));
  assert.ok(result.omitted.some(item => item.courseCode === 'FIX-001' && item.arrangement === 2));
  assert.ok(result.omitted.some(item => item.date === '2026-09-14' && item.startTime === '08:00'));
  assert.equal(readEvents(await readFile(result.filePath, 'utf8'))[0].SUMMARY, '可导出课');
});

test('requires a matching semester and validated bell times instead of guessing', async t => {
  const f = await fixture(t, snapshot([row('1周 星期二 12节 示例楼100')], { selectedTerms: [] }));
  for (const options of [{}, { semesterStartDate: '2026-09-14' }]) {
    const result = await f.run(options);
    assert.equal(result.status, 'needs_calendar_info');
    assert.equal(result.filePath, undefined);
  }
  assert.deepEqual(await readdir(f.dataDir), []);
  assert.equal((await f.run({ semesterStartDate: '2026-02-30' })).status, 'invalid_input');
  assert.equal((await f.run({ semesterStartDate: '2026-09-15' })).status, 'invalid_input');
  const result = await f.run({ semesterStartDate: '2026-09-14', periodTimes: { 12: ['21:00', '21:45'] } });
  assert.equal(result.status, 'exported');
  const [event] = readEvents(await readFile(result.filePath, 'utf8'));
  assert.equal(event.DTSTART, '20260915T130000Z');
  assert.equal(event.DTEND, '20260915T134500Z');

  for (const selectedTerms of [['2025-2026-2'], [term, '2025-2026-2'], ['2027-2028-1']]) {
    const other = await fixture(t, snapshot([row('1周 周一 1节')], { selectedTerms }));
    assert.equal((await other.run()).status, 'needs_calendar_info');
    assert.equal((await other.run({ semesterStartDate: '2026-09-14' })).status, 'needs_calendar_info');
  }
});

test('known term lookup respects Shanghai midnight and handles an explicitly selected later semester', async t => {
  const page = snapshot([row('1周 周一 1节 示例楼101')]);
  const stub = { config: {}, query: async () => parseTimetable(page, { forExport: true }) };
  assert.equal((await exportTimetable(stub, {}, new Date('2026-09-13T15:59:59Z'))).status, 'needs_calendar_info');
  const f = await fixture(t, snapshot([row('1周 周一 08:00-08:45 示例楼101')], { selectedTerms: ['2027-2028学年第一学期'] }));
  const result = await f.run({ semesterStartDate: '2027-09-06' });
  assert.equal(result.status, 'exported');
  assert.equal(readEvents(await readFile(result.filePath, 'utf8'))[0].DTSTART, '20270906T000000Z');
});

test('pagination is marked partial and clipped or loading pages produce no file', async t => {
  const rows = [row('1周 周一 1节 示例楼101')];
  const paginated = await fixture(t, snapshot(rows, { text: '我的课表\n共 3 条' }));
  assert.equal((await paginated.run()).status, 'partial_export');
  for (const [status, page] of [
    ['unstructured', snapshot(rows, { truncated: true })],
    ['page_pending', snapshot(rows, { text: '我的课表\n加载中' })],
  ]) {
    const f = await fixture(t, page);
    assert.equal((await f.run()).status, status);
    assert.deepEqual(await readdir(f.dataDir), []);
  }
});

test('invalid paths, missing directories and unwritable destinations do not create an export', async t => {
  const f = await fixture(t, snapshot([row('1周 周一 1节 示例楼101')]));
  assert.equal((await f.run({ outputDir: './exports' })).status, 'invalid_input');
  assert.equal((await f.run({ outputDir: f.dataDir + '/../exports' })).status, 'invalid_input');
  const missing = await f.run({ outputDir: path.join(f.dataDir, 'missing') });
  assert.equal(missing.status, 'output_error');
  assert.match(missing.message, /不存在/);
  const file = path.join(f.dataDir, 'file');
  await writeFile(file, 'example');
  assert.equal((await f.run({ outputDir: file })).status, 'output_error');
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const readOnly = path.join(f.dataDir, 'readonly');
    await mkdir(readOnly, { mode: 0o500 });
    try {
      assert.equal((await f.run({ outputDir: readOnly })).status, 'output_error');
      assert.deepEqual(await readdir(readOnly), []);
    } finally { await chmod(readOnly, 0o700); }
  }
});

test('parallel exports keep stable UIDs, never clobber files, and skip a symlink at the target filename', async t => {
  const f = await fixture(t, snapshot([row('1-2周 周一 1节 示例楼101')]));
  const sentinel = path.join(f.dataDir, 'existing.txt');
  const existing = path.join(f.dataDir, 'tongji-timetable-2026-09-14.ics');
  await writeFile(sentinel, 'keep me');
  if (process.platform === 'win32') await writeFile(existing, 'keep me');
  else await symlink(sentinel, existing);
  const [a, b] = await Promise.all([f.run({ outputDir: f.dataDir }), f.run({ outputDir: f.dataDir })]);
  assert.equal(a.status, 'exported');
  assert.equal(b.status, 'exported');
  assert.notEqual(a.filePath, b.filePath);
  assert.equal(await readFile(existing, 'utf8'), 'keep me');
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me');
  assert.deepEqual(readEvents(await readFile(a.filePath, 'utf8')).map(event => event.UID),
    readEvents(await readFile(b.filePath, 'utf8')).map(event => event.UID));
  assert.equal((await readdir(f.dataDir)).some(file => file.startsWith('.timetable-')), false);
  if (process.platform !== 'win32') {
    const alias = path.join(f.dataDir, 'linked-dir');
    await symlink(f.dataDir, alias);
    assert.equal((await f.run({ outputDir: alias })).status, 'output_error');
  }
});

test('login expiry, unreadable pages, and explicit empty results keep their query status and write nothing', async t => {
  for (const [status, page] of [
    ['login_required', { ...schedulePage, title: '统一身份认证', url: 'https://iam.tongji.edu.cn/login?ticket=PRIVATE_TICKET' }],
    ['unstructured', snapshot([], { tables: [{ headers: ['节次', '星期一'], rows: [['1-2', '示例课']] }] })],
    ['empty', snapshot([], { text: '我的课表\n暂无数据' })],
    ['needs_page_selection', snapshot([], { title: '培养计划' })],
    ['page_unavailable', { ...schedulePage, status: 'page_unavailable', message: '页面不可用' }],
    ['page_pending', { ...schedulePage, status: 'page_pending' }],
  ]) {
    const f = await fixture(t, page);
    const result = await f.run();
    assert.equal(result.status, status);
    assert.equal(result.filePath, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    assert.deepEqual(await readdir(f.dataDir), []);
  }
});

test('CLI validates export JSON and the selected output path before opening a browser', () => {
  const cli = new URL('../src/cli.mjs', import.meta.url);
  for (const params of ['{', '{"outputDir":"../escape"}', '{"calendarName":""}']) {
    const run = spawnSync(process.execPath, [fileURLToPath(cli), 'export-timetable', params], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'invalid_input');
  }
});
