import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSeatQuery } from '../src/seat-query.mjs';

test('seat dates use Shanghai midnight and advance across years and leap days', () => {
  assert.equal(normalizeSeatQuery({date:'今天'},new Date('2026-11-14T20:00:00Z')).date,'2026-11-15');
  assert.equal(normalizeSeatQuery({date:'明天'},new Date('2026-12-31T10:00:00Z')).date,'2027-01-01');
  assert.equal(normalizeSeatQuery({date:'明天'},new Date('2028-02-28T10:00:00Z')).date,'2028-02-29');
});
test('seat requests preserve requested times and normalize campus and floor', () => {
  const q=normalizeSeatQuery({date:'2026-11-16',startTime:'14:00',endTime:'16:00',floor:'2F',campus:'四平路'});
  assert.equal(q.campus,'四平路校区图书馆'); assert.equal(q.floor,'二楼'); assert.equal(q.startTime,'14:00'); assert.equal(q.endTime,'16:00');
});
test('invalid seat dates, incomplete times and reversed intervals are rejected', () => {
  for (const q of [{date:'2026-02-29'},{date:'2026-13-01'},{startTime:'14:00'},{startTime:'24:00',endTime:'25:00'},{startTime:'16:00',endTime:'14:00'},{limit:51}]) assert.throws(()=>normalizeSeatQuery(q));
});
