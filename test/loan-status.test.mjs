import test from 'node:test';
import assert from 'node:assert/strict';
import { loanDateStatus, loanFromEvidence, loanQueryDate } from '../src/loan-status.mjs';

const today = '2026-11-20';

test('due today, tomorrow, overdue and the local reminder threshold use calendar days', () => {
  assert.deepEqual(loanDateStatus(today, today), { dueDate: today, daysRemaining: 0, overdueDays: 0, status: 'due_today' });
  assert.deepEqual(loanDateStatus('2026-11-21', today), { dueDate: '2026-11-21', daysRemaining: 1, overdueDays: 0, status: 'due_soon' });
  assert.deepEqual(loanDateStatus('2026-11-17', today), { dueDate: '2026-11-17', daysRemaining: -3, overdueDays: 3, status: 'overdue' });
  assert.equal(loanDateStatus('2026-11-23', today).status, 'due_soon');
  assert.equal(loanDateStatus('2026-11-24', today).status, 'normal');
  assert.equal(loanDateStatus('2026-11-24', today, 4).status, 'due_soon');
  assert.equal(loanDateStatus('2026-11-21', today, 0).status, 'normal');
});

test('Shanghai midnight is independent of the OS timezone across month, year and leap day', () => {
  assert.equal(loanQueryDate(new Date('2026-12-31T15:59:59Z')), '2026-12-31');
  const shanghaiNewYear = loanQueryDate(new Date('2026-12-31T08:00:00-08:00'));
  assert.equal(shanghaiNewYear, '2027-01-01');
  assert.equal(loanDateStatus('2026-12-31', shanghaiNewYear).daysRemaining, -1);
  assert.equal(loanDateStatus('2028-03-01', '2028-02-28').daysRemaining, 2);
  assert.equal(loanDateStatus('2026-12-01', '2026-11-30').daysRemaining, 1);
});

test('date parsing requires a valid, unambiguous date and ignores OPAC countdown text', () => {
  for (const date of [undefined, '', '2026-02-29', '2026-11-31', '2026-12/1', '11/20/2026', '今天', '2026/11/20 25:00', '2026-11-20/2026-11-21']) {
    assert.deepEqual(loanDateStatus(date, today), { dueDate: null, daysRemaining: null, overdueDays: null, status: 'unknown' });
  }
  assert.equal(loanDateStatus('2026年11月20日', today).dueDate, today);
  assert.equal(loanDateStatus('2026.11.20 09:01:00', today).status, 'due_today');
  assert.equal(loanDateStatus('2026/11/20距离还书还有3天', today).status, 'due_today');
  assert.equal(loanDateStatus('2026-11-19已超期0天', today).status, 'overdue');
});

test('eligibility uses explicit evidence and never extrapolates from renewal count, overdue or action', () => {
  const row = { title: '虚构书目', borrowDate: '2026-10-18', dueDate: '2026-11-19', hasRenewalAction: true };
  const counted = loanFromEvidence({ ...row, renewalCount: '0' }, today, 3);
  assert.equal(counted.renewalCount, 0);
  assert.equal(counted.renewalEligibility, 'requires_official_confirmation');
  assert.equal(loanFromEvidence({ ...row, renewalCount: '2次' }, today, 3).renewalCount, 2);
  const notAvailable = loanFromEvidence({ ...row, eligibility: '不可续借：已被其他读者预约' }, today, 3);
  assert.equal(notAvailable.renewalEligibility, 'ineligible');
  assert.equal(notAvailable.renewalReason, '已被其他读者预约');
  const unknown = loanFromEvidence({ ...row, hasRenewalAction: false, renewalCount: '未知' }, today, 3);
  assert.equal(unknown.renewalEligibility, 'unknown');
  assert.equal(Object.hasOwn(unknown, 'renewalCount'), false);
  assert.equal(loanFromEvidence({ ...row, eligibility: '可续借' }, today, 3).renewalEligibility, 'eligible');
  const conflict = loanFromEvidence({ ...row, eligibility: '可续借', renewalNote: '续借次数已满' }, today, 3);
  assert.equal(conflict.renewalEligibility, 'ineligible');
});
