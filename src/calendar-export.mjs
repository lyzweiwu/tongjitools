import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { dateValue, resolveCalendar, timezone } from './academic-calendar.mjs';
import { timetableMeetings } from './timetable-meetings.mjs';

const isoDate = z.string().refine(value => Boolean(dateValue(value)), '日期须为有效的 YYYY-MM-DD。');
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const periodTime = z.tuple([clock, clock]).refine(([start, end]) => start < end);
const originalMeeting = {
  courseCode: z.string().trim().min(1).max(100),
  date: isoDate,
  startTime: clock,
};
const rescheduledMeeting = {
  newDate: isoDate,
  newTime: periodTime.optional(),
  newLocation: z.string().trim().min(1).max(200).optional(),
};
export const calendarExportOptions = z.strictObject({
  semesterStartDate: isoDate.refine(value => dateValue(value)?.getUTCDay() === 1, '须为第一教学周星期一。').optional(),
  outputDir: z.string().min(1).max(4096).optional(),
  calendarName: z.string().trim().min(1).max(100).optional(),
  periodTimes: z.record(z.string().regex(/^(?:[1-9]|[12]\d|30)$/), periodTime).optional(),
  scheduleChanges: z.array(z.discriminatedUnion('action', [
    z.strictObject({ ...originalMeeting, action: z.literal('cancel') }),
    z.strictObject({ ...originalMeeting, ...rescheduledMeeting, action: z.literal('move') }),
    z.strictObject({ ...originalMeeting, ...rescheduledMeeting, action: z.literal('add') }),
  ])).max(200).optional(),
});

const DAY_MS = 86400000;
const DEFAULT_NAME = '同济大学课表';
const adjustmentWarning = '请核对教务或学院的节假日、停课、调课与补课通知。导出保留课表所列周次，额外变更仅按已确认的 scheduleChanges 应用。';
const courseKey = record => record.courseCode ? `code:${record.courseCode}` : `name:${record.course}`;
// Contemporary university timetables use China Standard Time year-round.
const at = (date, localTime) => new Date(`${date}T${localTime}:00+08:00`);
const uid = (...parts) => `${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}@tongjitools.local`;
const propertyDate = date => date.toISOString().replace(/[-:]|\.\d{3}/g, '');

function escapeText(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/([;,])/g, '\\$1');
}

function foldLine(line) {
  let result = '';
  let width = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (width + size > 75) {
      result += '\r\n ';
      width = 1;
    }
    result += character;
    width += size;
  }
  return result;
}

function calendarFile(events, calendarName, now) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TongjiTools//Timetable Export//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const item of events) {
    const details = [
      item.teacher && `教师：${item.teacher}`,
      item.courseCode && `课程编号：${item.courseCode}`,
      `教学周次：第 ${item.week} 周`,
      item.change && `安排：${item.change}`,
    ].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT', `UID:${item.uid}`, `DTSTAMP:${propertyDate(now)}`,
      `DTSTART:${propertyDate(at(item.date, item.start))}`, `DTEND:${propertyDate(at(item.date, item.end))}`,
      `SUMMARY:${escapeText(item.course)}`, `LOCATION:${escapeText(item.location)}`,
      `DESCRIPTION:${escapeText(details.join('\n'))}`, 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(foldLine).join('\r\n');
}

function expandTimetable(timetable, calendar, options) {
  const events = new Map();
  const conflicted = new Set();
  const omitted = [...(timetable.calendarEvidence?.omittedRows || [])];
  const warnings = new Set();
  let needsPeriodTimes = false;
  const firstMonday = dateValue(calendar.start).valueOf();
  for (const record of timetable.records) {
    const { course, courseCode, teacher } = record;
    const key = courseKey(record);
    const report = (reason, details) => omitted.push({ course, courseCode, reason, ...details });
    const meetings = timetableMeetings(record, calendar.periods, options.periodTimes);
    if (/调课|停课|补课|改期|取消|节假日/.test(record.notes || '') || meetings.some(meeting => meeting.hasAdjustmentNote)) {
      warnings.add(`「${course}」有调课相关备注，请在教务页面核对。`);
    }
    for (const meeting of meetings) {
      const { issue, arrangement, weeks, day, start, end, location } = meeting;
      if (issue) {
        needsPeriodTimes ||= Boolean(meeting.needsPeriodTimes);
        report(issue, { arrangement });
        continue;
      }
      if (meeting.missingRoom) warnings.add(`「${course}」的部分或全部课次缺少已确认教室。`);
      for (const week of weeks) {
        const date = new Date(firstMonday + ((week - 1) * 7 + day - 1) * DAY_MS).toISOString().slice(0, 10);
        if (calendar.end && date > calendar.end) {
          report('该安排计算所得日期超出已确认学期', { arrangement, week });
          continue;
        }
        const id = uid(calendar.start, key, date, start);
        if (conflicted.has(id)) continue;
        const sameTime = events.get(id);
        const item = { key, uid: id, course, courseCode, teacher, week, date, start, end, location };
        if (!sameTime) events.set(id, item);
        else if (JSON.stringify(sameTime) !== JSON.stringify(item)) {
          events.delete(id);
          conflicted.add(id);
          report('同一课程时段的教室、教师或结束时间冲突', { date, startTime: start });
        }
      }
    }
  }
  if (needsPeriodTimes) warnings.add('请按课表适用的官方作息提供缺失节次的 periodTimes。');
  return { events: [...events.values()], omitted, warnings, needsPeriodTimes };
}

function applyScheduleChanges(events, changes, calendar) {
  const revised = new Map(events.map(event => [event.uid, event]));
  for (const [index, change] of changes.entries()) {
    const id = uid(calendar.start, courseKey(change), change.date, change.startTime);
    const original = revised.get(id);
    const problem = reason => ({ reason: `第 ${index + 1} 条 scheduleChanges：${reason}` });
    if (!original || original.change) return problem('未唯一匹配原课次或该课次已变更。请核对课表是否已包含调整。');
    if (change.action === 'cancel') {
      revised.delete(id);
      continue;
    }
    const [start, end] = change.newTime || [original.start, original.end];
    const date = change.newDate;
    if (date < calendar.start || (calendar.end && date > calendar.end)) return problem('目标日期超出该学期。');
    if ([...revised.values()].some(event => event.key === original.key && event.date === date &&
        (event.uid !== id || change.action === 'add') && start < event.end && event.start < end)) {
      return problem('目标时段与课表中的同一课程重叠。请核对变更是否已反映在课表。');
    }
    const newId = change.action === 'add' ? uid(id, date, start) : id;
    revised.set(newId, {
      ...original, uid: newId, date, start, end, location: change.newLocation || original.location,
      change: change.action === 'add' ? '补课' : '调课',
    });
  }
  return { events: [...revised.values()] };
}

function validOutputDir(value) {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value) || value.split(/[\\/]/).includes('..')) return false;
  return process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value);
}

async function saveCalendar(dataDir, outputDir, start, content) {
  // A chosen output directory must already exist. Only create the default.
  const requested = outputDir || path.join(dataDir, 'exports');
  if (!outputDir) await mkdir(requested, { recursive: true, mode: 0o700 });
  const normalized = path.normalize(requested);
  const root = path.parse(normalized).root;
  const current = await lstat(normalized === root ? root : normalized.replace(/[\\/]+$/, ''));
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw Object.assign(new Error('Invalid output directory'), { code: 'ENOTDIR' });
  }
  const directory = await realpath(requested);
  const staging = await mkdtemp(path.join(directory, '.timetable-'));
  try {
    const tempFile = path.join(staging, 'calendar.ics');
    await writeFile(tempFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    for (let number = 1; number <= 1000; number++) {
      const suffix = number === 1 ? '' : `-${number}`;
      const filePath = path.join(directory, `tongji-timetable-${start}${suffix}.ics`);
      try {
        // Publish the complete file atomically, and fail if any object
        // (including a symlink or a concurrent export) owns this filename.
        await link(tempFile, filePath);
        return filePath;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw Object.assign(new Error('No available filename'), { code: 'EEXIST' });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

const outputErrors = {
  ENOENT: '导出目录不存在，请提供已存在的本机目录。',
  ENOTDIR: '导出路径须为目录，且目录本身不能是符号链接。',
  EACCES: '没有写入导出目录的权限。',
  EPERM: '导出目录无写入权限或所在文件系统不支持安全发布文件。',
  EROFS: '导出目录所在文件系统为只读。',
  ENOTSUP: '该文件系统不支持安全发布文件，请选择本机普通目录。',
  EEXIST: '导出目录中同名文件过多，请选择其他目录。',
  ENOSPC: '导出目录所在磁盘没有足够空间。',
};

export async function exportTimetable(browser, params = {}, now = new Date()) {
  const parsed = calendarExportOptions.safeParse(params);
  if (!parsed.success) return {
    status: 'invalid_input',
    message: '导出参数无效，请核对日期、时间、目录和变更字段。',
    invalidFields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'options'))],
  };
  const { semesterStartDate, outputDir, calendarName = DEFAULT_NAME, scheduleChanges = [] } = parsed.data;
  if (outputDir !== undefined && !validOutputDir(outputDir)) {
    return { status: 'invalid_input', message: 'outputDir 须为已存在的本机绝对目录路径，不能含 .. 或控制字符。' };
  }
  const timetable = await browser.query('timetable', { forExport: true });
  if (timetable.status !== 'ok') {
    const { status, message, nextStep, warnings } = timetable;
    return { status, message: message || nextStep, warnings: warnings || [] };
  }
  if (timetable.calendarEvidence?.loading) {
    return { status: 'page_pending', message: '课表仍在加载，请在浏览器确认完整列表后重试。' };
  }
  if (timetable.truncated) {
    return { status: 'unstructured', message: '可见课表数据已截断，无法确认周次和地点的完整性。请打开完整课程列表后重试。', warnings: timetable.warnings };
  }
  const calendar = resolveCalendar(timetable, semesterStartDate, now);
  if (calendar.reason) return { status: 'needs_calendar_info', message: calendar.reason };

  const expanded = expandTimetable(timetable, calendar, parsed.data);
  const changed = applyScheduleChanges(expanded.events, scheduleChanges, calendar);
  if (changed.reason) return { status: 'invalid_schedule_changes', message: changed.reason };
  const events = changed.events.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  const warnings = new Set([adjustmentWarning, ...expanded.warnings, ...(timetable.warnings || [])]);
  const moreRows = timetable.calendarEvidence?.moreRows;
  if (moreRows) warnings.add('页面记录总数大于已读取行数。请打开其他页核对未读取的课程。');
  const result = {
    semester: calendar.id,
    semesterStartDate: calendar.start,
    timezone,
    courseCount: new Set(events.map(event => event.key)).size,
    eventCount: events.length,
    warnings: [...warnings],
    omitted: expanded.omitted,
    ...(scheduleChanges.length ? { appliedChanges: scheduleChanges.length } : {}),
  };
  if (!events.length) return {
    status: expanded.needsPeriodTimes ? 'needs_calendar_info' : 'no_exportable_events',
    ...result, message: '没有可导出的课次，请核对未导出原因和已确认的变更。',
  };
  try {
    const filePath = await saveCalendar(browser.config.dataDir, outputDir, calendar.start, calendarFile(events, calendarName, now));
    return { status: expanded.omitted.length || moreRows ? 'partial_export' : 'exported', filePath, ...result };
  } catch (error) {
    return { status: 'output_error', message: outputErrors[error.code] || '未能写入本机日历文件，请检查目录及可用空间。' };
  }
}
