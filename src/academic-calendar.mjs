// Public Tongji calendars. Bind both the week anchor and the bell schedule to
// a confirmed term. Calendar "end" dates below are inclusive term boundaries,
// including the vacation, as listed by the academic management system.
// https://api.tongji.edu.cn/docs/interface/teaching_management_data/educational_administration_data/term_calendar_info/v1_rt_teaching_info_semester
const periods = [
  ['08:00', '08:45'], ['08:50', '09:35'], ['10:00', '10:45'], ['10:50', '11:35'],
  ['13:30', '14:15'], ['14:20', '15:05'], ['15:30', '16:15'], ['16:20', '17:05'],
  ['18:30', '19:15'], ['19:20', '20:05'], ['20:10', '20:55'],
];

const terms = {
  // https://xxgk.tongji.edu.cn/index.php?classid=3077&newsid=20229&t=show
  '2025-2026-1': { start: '2025-09-15', end: '2026-03-01', periods },
  // https://caup.tongji.edu.cn/_upload/article/files/52/ba/d408fa7b4ddea41a9a04f86f3165/d3783f20-04f1-4fc8-975e-8a7a3dc4634b.pdf
  '2025-2026-2': { start: '2026-03-02', end: '2026-09-13', periods },
  // Calendar and opening notice corroborate week 1. CAUP's fall schedule also
  // labels the eleven periods with the times above, including graduate courses.
  // https://xxgk.tongji.edu.cn/index.php?classid=3077&newsid=21359&t=show
  // https://news.tongji.edu.cn/info/1008/95093.htm
  // https://caup.tongji.edu.cn/caupen/d0/84/c33820a381060/page.htm
  '2026-2027-1': { start: '2026-09-14', end: '2027-02-21', periods },
};

export const timezone = 'Asia/Shanghai';
const shanghaiDate = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const termByStart = start => Object.entries(terms).find(([, term]) => term.start === start)?.[0];

function termLabel(value = '') {
  const label = value.normalize('NFKC').replace(/\s/g, '').replace(/[–—－~～至]/g, '-')
    .replace(/^(?:当前|所选)?(?:学年学期|学期):?/, '')
    .replace(/(?:研究生|个人|学生|我的)?(?:课表|课程表)$/, '');
  const full = /^(\d{4})-(\d{4})(?:学年)?-?第?([12一二])(?:学期)?$/.exec(label);
  if (full && Number(full[2]) === Number(full[1]) + 1) return `${full[1]}-${full[2]}-${/[1一]/.test(full[3]) ? 1 : 2}`;
  const seasonal = /^(\d{4})年?(春|秋)季?学期$/.exec(label);
  if (!seasonal) return null;
  const year = Number(seasonal[1]);
  return seasonal[2] === '秋' ? `${year}-${year + 1}-1` : `${year - 1}-${year}-2`;
}

export function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value) ? date : null;
}

export function resolveCalendar(timetable, suppliedStart, now) {
  const rowLabels = timetable.records.map(record => record.semester).filter(Boolean);
  const labels = [...new Set([...rowLabels, ...(timetable.calendarEvidence?.termLabels || [])].map(termLabel).filter(Boolean))];
  if (labels.length > 1 || rowLabels.some(label => !termLabel(label))) {
    return { reason: '课表含不同或无法识别的学期，请在教务页面打开单一学期的课表。' };
  }
  const id = labels[0];
  const term = terms[id];
  const today = shanghaiDate.format(now);
  if (!suppliedStart && (!term || today < term.start || today > term.end)) {
    return { reason: '无法从课表和已核验校历确认当前学期。请核对页面所选学期，并提供该学期第一教学周星期一（semesterStartDate）。' };
  }
  if (term && suppliedStart && suppliedStart !== term.start) {
    return { reason: `指定的起始日期与课表学期 ${id} 的官方校历（${term.start}）不一致。` };
  }
  const start = suppliedStart || term.start;
  const inferredId = termByStart(start);
  const calendarYear = id?.split('-')[id.endsWith('-1') ? 0 : 1];
  if (id && ((inferredId && id !== inferredId) || start.slice(0, 4) !== calendarYear)) {
    return { reason: '指定的起始日期与页面学期不一致，请核对第一教学周和所选课表。' };
  }
  return { start, id: id || inferredId, ...(term || terms[inferredId]) };
}
