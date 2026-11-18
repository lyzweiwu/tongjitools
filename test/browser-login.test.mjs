import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { submitBrowserAutofill } from '../src/browser-login.mjs';

function exercise({ filled = true, extraInput = false, origin = 'https://iam.tongji.edu.cn',
  action = 'https://iam.tongji.edu.cn/idp/AuthnEngine' } = {}) {
  let clicks = 0;
  const visible = () => [{}];
  const form = { action, getClientRects: visible,
    querySelectorAll: () => extraInput ? [user, secret, { type: 'text', getClientRects: visible }] : [user, secret] };
  const user = { form, value: 'synthetic account', getClientRects: visible };
  const secret = { form, matches: selector => selector === ':autofill' && filled, getClientRects: visible };
  const button = { form, click: () => { clicks++; }, textContent: '登录', getClientRects: visible };
  const controls = [user, secret, button];
  const selectors = ['input#j_username[type="text"]', 'input#j_password[type="password"]', 'button#loginButton'];
  const outcome = runInNewContext(`(${submitBrowserAutofill.toString()})()`, {
    location: { origin, pathname: '/idp/authcenter/ActionAuthChain' },
    document: { querySelector: selector => controls[selectors.indexOf(selector)] },
    getComputedStyle: () => ({ visibility: 'visible' }),
    URL,
  });
  return { outcome, clicks };
}

test('quick login uses verified Chrome autofill only on the official login form', () => {
  assert.deepEqual(exercise(), { outcome: true, clicks: 1 });
  for (const options of [
    { filled: false }, { extraInput: true },
    { origin: 'https://another.tongji.edu.cn' }, { action: 'https://another.tongji.edu.cn/idp/AuthnEngine' },
  ]) assert.deepEqual(exercise(options), { outcome: false, clicks: 0 });
});
