import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosePreparationFailure } from '../src/library-flow.mjs';

test('diagnostics separate a slow search, a failed request and a page execution error', () => {
  const timeout = Object.assign(new Error('raw browser details'), { name: 'TimeoutError' });
  assert.equal(diagnosePreparationFailure(timeout, { stage: 'search', step: 'search.wait_results', elapsedMs: 25000 }).status, 'search_timeout');
  assert.equal(diagnosePreparationFailure(timeout, { stage: 'search', step: 'search.wait_results', searchRequests: [{ httpStatus: 503 }] }).status, 'search_request_failed');
  assert.equal(diagnosePreparationFailure(timeout, { stage: 'search', step: 'search.wait_results', searchRequests: [{ failureCode: 'ERR_CONNECTION_CLOSED' }] }).status, 'search_request_failed');
  assert.equal(diagnosePreparationFailure(new TypeError('DOM no longer matches'), { stage: 'search', step: 'search.read_cards' }).status, 'page_structure_changed');
});

test('diagnostics distinguish total budget exhaustion and another step timeout', () => {
  const timeout = { name: 'TimeoutError' };
  assert.equal(diagnosePreparationFailure(timeout, { stage: 'form', step: 'form.wait_phone', elapsedMs: 45001 }).status, 'flow_timeout');
  assert.equal(diagnosePreparationFailure(timeout, { stage: 'form', step: 'form.wait_phone', elapsedMs: 15000 }).status, 'step_timeout');
});

test('diagnostics never serialize raw error messages, stack traces or custom names', () => {
  const error = { name: 'PRIVATE_ERROR_NAME', message: 'https://example.invalid/?ticket=PRIVATE_TICKET', stack: 'PRIVATE_STACK' };
  const diagnosis = diagnosePreparationFailure(error, { stage: 'search', step: 'search.read_cards' });
  assert.equal(diagnosis.errorType, 'Error');
  assert.equal(/PRIVATE|ticket|stack|example/.test(JSON.stringify(diagnosis)), false);
});
