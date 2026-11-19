import { dateValue, timezone } from './academic-calendar.mjs';

export const defaultLoanDueSoonDays = 3;
export const loanTimezone = timezone;
const shanghaiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function loanQueryDate(now = new Date()) {
  return shanghaiDate.format(now);
}

function readDate(value) {
  const text = value?.normalize('NFKC').trim().replace(/\s*(?:距离还书还有|已超期)\s*\d+\s*天$/u, '');
  const match = /^(\d{4})([-/.年])(\d{1,2})([-/.月])(\d{1,2})(日)?(?:[ T](?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/u.exec(text || '');
  if (!match) return null;
  const [, year, separator, month, nextSeparator, day, suffix] = match;
  if (separator === '年' ? nextSeparator !== '月' || !suffix : separator !== nextSeparator || suffix) return null;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return dateValue(date) ? date : null;
}

export function loanDateStatus(dueText, queryDate, dueSoonDays = defaultLoanDueSoonDays) {
  const dueDate = readDate(dueText);
  if (!dueDate) return { dueDate: null, daysRemaining: null, overdueDays: null, status: 'unknown' };
  const daysRemaining = (dateValue(dueDate) - dateValue(queryDate)) / 86_400_000;
  let status = 'normal';
  if (daysRemaining < 0) status = 'overdue';
  else if (daysRemaining === 0) status = 'due_today';
  else if (daysRemaining <= dueSoonDays) status = 'due_soon';
  return { dueDate, daysRemaining, overdueDays: Math.max(0, -daysRemaining), status };
}

const explicitLimits = /(?:已被(?:其他读者)?预约|(?:图书|该书)已被预约|冻结状态不可续借|已达(?:最大)?续借次数(?:上限)?|续借次数已满|续借已满|续满|未到续借时间|尚未进入续借时间|已超期不可续借|已逾期不可续借|有超期图书不可续借)/u;
const negative = /^(?:不可续借|不能续借|无法续借|不允许续借|不符合续借条件|ineligible|not eligible(?: for renewal)?|cannot renew)(?:\s*[:：].*)?$/iu;
const positive = /^(?:可续借|允许续借|符合续借条件|eligible(?: for renewal)?)$/iu;
const loanStatuses = /^(?:在借|借阅中|正常|正常借阅|未归还|已超期|超期|已逾期|逾期|冻结|遗失|on loan|overdue)$/iu;

export function loanFromEvidence(row, queryDate, dueSoonDays) {
  const evidence = [row.eligibility, row.renewalNote, row.pageStatus].filter(Boolean);
  const reason = evidence.map(text => explicitLimits.exec(text)?.[0]).find(Boolean);
  const prohibited = reason || evidence.some(text => negative.test(text));
  const allowed = evidence.some(text => positive.test(text));
  const renewalEligibility = prohibited ? 'ineligible' : allowed ? 'eligible'
    : row.hasRenewalAction ? 'requires_official_confirmation' : 'unknown';
  const count = /^(\d{1,3})\s*(?:次)?$/u.exec(row.renewalCount?.normalize('NFKC') ?? '');
  return {
    title: row.title,
    ...(row.author ? { author: row.author } : {}),
    borrowDate: readDate(row.borrowDate),
    ...loanDateStatus(row.dueDate, queryDate, dueSoonDays),
    ...(loanStatuses.test(row.pageStatus || '') ? { pageStatus: row.pageStatus } : {}),
    ...(count ? { renewalCount: Number(count[1]) } : {}),
    ...(reason ? { renewalReason: reason } : {}),
    hasRenewalAction: row.hasRenewalAction,
    renewalEligibility,
    displayedRow: row.displayedRow,
  };
}
