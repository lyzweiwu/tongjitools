import test from 'node:test';
import assert from 'node:assert/strict';
import { isSchoolUrl, displayUrl, makeConfig } from '../src/config.mjs';

test('school URL boundary rejects impostor domains, credentials and non-HTTPS schemes', () => {
  assert.equal(isSchoolUrl('https://1.tongji.edu.cn/a'), true);
  for (const url of ['https://tongji.edu.cn.evil.example/', 'https://eviltongji.edu.cn/', 'http://1.tongji.edu.cn/', 'https://a:b@1.tongji.edu.cn/', 'file:///tmp/a', 'javascript:alert(1)', 'https://1.tongji.edu.cn:9999/']) assert.equal(isSchoolUrl(url), false, url);
  assert.throws(() => makeConfig({ TONGJI_ACADEMIC_URL: 'https://evil.example/' }));
});

test('display URLs do not reveal SSO tickets in query or fragment', () => {
  assert.equal(displayUrl('https://1.tongji.edu.cn/callback?ticket=SECRET#access_token=SECRET'), 'https://1.tongji.edu.cn/callback');
  assert.equal(displayUrl('https://webpac.tongji.edu.cn/?ticket=SECRET#/Home?token=SECRET'), 'https://webpac.tongji.edu.cn/#/Home');
});

test('direct connection is opt-in for the dedicated browser', () => {
  assert.equal(makeConfig({}).directConnection, false);
  assert.equal(makeConfig({ TONGJI_DIRECT_CONNECTION: '1' }).directConnection, true);
  assert.equal(makeConfig({ TONGJI_DIRECT_CONNECTION: '0' }).directConnection, false);
});
