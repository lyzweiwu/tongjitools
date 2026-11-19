// Decode the rendered list view. Each match is anchored because treating a
// fragment of an unknown arrangement as a full meeting can add false events.
const normalize = value => (value || '').normalize('NFKC')
  .replace(/(\d\s*(?:周\s*)?)[–—~至](?=\s*(?:第\s*)?\d)/g, '$1-')
  .replace(/[ \t]+/g, ' ').trim();
const DAY = '(?:星期|礼拜|周)\\s*[一二三四五六日天1-7]';
const PERIOD = '(?:第\\s*)?\\d{1,2}(?:\\s*-\\s*(?:第\\s*)?\\d{1,2})?\\s*节(?:课)?';
const weekNumber = '(?:第\\s*)?\\d{1,2}';
const weekSpan = `${weekNumber}(?:\\s*周?\\s*-\\s*${weekNumber})?`;
const parityMarker = '(?:\\([单双](?:周)?\\)|[单双]周)';
const WEEK = `${weekSpan}(?:\\s*周?\\s*[,、&]\\s*${weekSpan})*\\s*(?:周(?:\\s*${parityMarker})?|${parityMarker})`;
const TOKEN_WEEK = `[({\\[]?(${WEEK})[)}\\]]?`;
const SEP = '[ ,、:]*';
const CLOCK = '(\\d{1,2}:[0-5]\\d)\\s*-\\s*(\\d{1,2}:[0-5]\\d)';
const clockRange = new RegExp(`^\\(?(?:${CLOCK})\\)?(?=$|[ ,、:])`);
const weekFirst = new RegExp(`^${TOKEN_WEEK}${SEP}(${DAY})${SEP}(${PERIOD})?${SEP}(.*)$`);
const dayFirst = new RegExp(`^(${DAY})${SEP}(${PERIOD})${SEP}${TOKEN_WEEK}${SEP}(.*)$`);
const dayClock = new RegExp(`^(${DAY})${SEP}(${CLOCK})${SEP}${TOKEN_WEEK}${SEP}(.*)$`);
const isPlaceholder = value => /^(?:[-—/]+|待定|暂无|未安排|无|待通知|未定)$/.test(value || '');

function expandWeeks(value) {
  const text = normalize(value).replace(/\s/g, '');
  const parity = /\(?([单双])周?\)?$/.exec(text);
  const list = (parity ? text.slice(0, parity.index) : text).replace(/(?:^|([,、&-]))第/g, '$1');
  const weeks = new Set();
  for (const item of list.split(/[,、&]/)) {
    const match = /^(\d{1,2})周?(?:-(\d{1,2})周?)?$/.exec(item);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > 30) return null;
    for (let week = start; week <= end; week++) {
      if (!parity || week % 2 === Number(parity[1] === '单')) weeks.add(week);
    }
  }
  return weeks.size ? [...weeks].sort((a, b) => a - b) : null;
}

function weekday(value) {
  const match = /^(?:(?:星期|礼拜|周)\s*)?([一二三四五六日天1-7])$/.exec(normalize(value));
  return match ? Number(match[1]) || '一二三四五六日'.indexOf(match[1].replace('天', '日')) + 1 : null;
}

function parsePeriods(value) {
  const match = /^(?:第\s*)?(\d{1,2})(?:\s*-\s*(?:第\s*)?(\d{1,2}))?\s*(?:节(?:课)?)?$/.exec(normalize(value));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  return start > 0 && end >= start ? [start, end] : null;
}

function clockTime(value) {
  const padded = normalize(value).padStart(5, '0');
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(padded) ? padded : null;
}

function readLocation(value) {
  if (!value || isPlaceholder(value)) return '';
  // A bare trailing fragment is a venue only when the displayed text indicates
  // a classroom/building or resembles a room number; never copy remarks/URLs.
  const label = /^(?:上课地点|教室|地点)[:：]\s*/;
  if (/(?:上课|停课|调课|补课|取消|改至|改为|待定|通知|教学安排|参见|请|备注|学号|姓名|token|https?:|\\n)/i.test(value.replace(label, ''))) return null;
  return label.test(value) || /(?:楼|教室|教学馆|馆\s*[\dA-Z]|\b[A-Z]?\d{2,}[A-Z]?\b|\d{2,}[A-Z]?$)/i.test(value)
    ? value.replace(label, '') : null;
}

function parseClause(clause) {
  const text = normalize(clause);
  const first = weekFirst.exec(text);
  const second = first ? null : dayFirst.exec(text);
  const third = first || second ? null : dayClock.exec(text);
  if (!first && !second && !third) return null;
  const [week, day, period, tail] = first ? first.slice(1) : second
    ? [second[3], second[1], second[2], second[4]]
    : [third[5], third[1], undefined, `${third[3]}-${third[4]} ${third[6]}`];
  const time = clockRange.exec(tail);
  const venue = tail.slice(time?.[0].length || 0).replace(/^[ ,、:]+/, '');
  const note = /\([^()]*(?:节假日|调课|停课|补课|改期|取消)[^()]*\)$/.exec(venue);
  return {
    week, day, period,
    startTime: time?.[1], endTime: time?.[2],
    location: readLocation((note ? venue.slice(0, note.index) : venue).trim()),
    hasAdjustmentNote: Boolean(note),
  };
}

function meetingInputs(record) {
  const raw = record.time || '';
  const clock = clockRange.exec(normalize(raw));
  if (!raw || isPlaceholder(raw) || clock?.[0] === normalize(raw)) {
    if (clock && (record.startTime && clockTime(record.startTime) !== clockTime(clock[1]) ||
        record.endTime && clockTime(record.endTime) !== clockTime(clock[2]))) {
      return [{ issue: '教学安排与独立时间列冲突' }];
    }
    return [{ ...record, startTime: record.startTime || clock?.[1], endTime: record.endTime || clock?.[2] }];
  }
  const clauses = raw.split(/[;；\r\n]+/).map(value => value.trim()).filter(Boolean);
  const meetings = [];
  for (const [index, clause] of clauses.entries()) {
    if (!clause) continue;
    const meeting = parseClause(clause);
    if (!meeting) {
      meetings.push({ issue: '无法拆解教学安排', arrangement: index + 1 });
      continue;
    }
    // The list view can put the location after a semicolon or line break.
    const followingLocation = clauses[index + 1] && !parseClause(clauses[index + 1]) && readLocation(clauses[index + 1]);
    const useFollowingLocation = meeting.location === '' && Boolean(followingLocation);
    if (useFollowingLocation) {
      meeting.location = followingLocation;
      clauses[index + 1] = '';
    }
    if (meeting.location === null) {
      meetings.push({ issue: '教学安排含无法确认的地点或附注', arrangement: index + 1 });
      continue;
    }
    const fields = { ...record, ...meeting, location: meeting.location || record.location };
    const redundant = [
      ['week', expandWeeks], ['day', weekday], ['period', parsePeriods],
      ['startTime', clockTime], ['endTime', clockTime],
    ];
    if (redundant.some(([key, parse]) => record[key] && meeting[key] &&
        JSON.stringify(parse(record[key])) !== JSON.stringify(parse(meeting[key])))) {
      meetings.push({ issue: '教学安排与独立时间列冲突', arrangement: index + 1 });
      continue;
    }
    for (const [key] of redundant) fields[key] ||= record[key];
    meetings.push({ ...fields, arrangement: index + 1 });
  }
  return meetings;
}

export function timetableMeetings(record, termPeriods, periodTimes) {
  return meetingInputs(record).map(input => {
    if (input.issue) return input;
    const { arrangement } = input;
    const weeks = expandWeeks(input.week);
    const day = weekday(input.day);
    if (!weeks || !day) return { arrangement, issue: '缺少或无法识别教学周次／星期' };
    const periods = parsePeriods(input.period);
    const slot = number => periodTimes?.[number] || termPeriods?.[number - 1];
    let start;
    let end;
    if (input.startTime || input.endTime) {
      start = clockTime(input.startTime);
      end = clockTime(input.endTime);
    } else if (periods) {
      start = slot(periods[0])?.[0];
      end = slot(periods[1])?.[1];
    }
    if (!start || !end || start >= end) {
      return { arrangement, issue: '缺少有效的上课时刻或节次作息', needsPeriodTimes: !input.startTime && !input.endTime && Boolean(periods) };
    }
    const locations = [input.campus, input.building, input.location].filter(value => value && !isPlaceholder(value));
    const location = [...new Set(locations)].filter(value => !locations.some(other => other !== value && other.startsWith(value))).join(' ');
    return {
      arrangement, weeks, day, start, end, location,
      missingRoom: !input.location || isPlaceholder(input.location), hasAdjustmentNote: input.hasAdjustmentNote,
    };
  });
}
