import test from 'node:test';
import assert from 'node:assert/strict';
import { isSchoolUrl, isServiceUrl, displayUrl, makeConfig, detectBrowser } from '../src/config.mjs';

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

test('seat pages do not displace academic or catalog tabs', () => {
  const config=makeConfig({});
  assert.equal(isServiceUrl('https://space.tongji.edu.cn/h5/#/home','seats',config),true);
  assert.equal(isServiceUrl('https://space.tongji.edu.cn/h5/#/home','academic',config),false);
  assert.equal(isServiceUrl('https://space.tongji.edu.cn/h5/#/home','library',config),false);
  assert.equal(isServiceUrl('https://iam.tongji.edu.cn/','seats',config),false);
  assert.equal(isServiceUrl('https://webpac.tongji.edu.cn/','seats',config),false);
  assert.throws(()=>makeConfig({TONGJI_SEATS_URL:'https://evil.example/'}));
});

test('auto detection prefers Chrome and falls back to Edge or Playwright Chromium', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const chromium = '/test/chromium/chrome';
  const detect = (files, requested = undefined) => detectBrowser({ TONGJI_BROWSER: requested }, {
    platform: 'darwin', home: '/test/home', playwrightPath: chromium, isExecutable: file => files.includes(file),
  });
  assert.equal(detect([chrome, edge, chromium]).type, 'chrome');
  assert.equal(detect([edge, chromium]).type, 'edge');
  assert.equal(detect([chromium]).path, chromium);
  assert.equal(detect([chrome, edge, chromium], 'edge').path, edge);
  assert.equal(detect([chrome], 'edge'), null);
  assert.equal(detect([]), null);
});

test('Edge is discovered in Windows x86 Program Files and Linux PATH', () => {
  const programFiles = String.raw`C:\Program Files (x86)`;
  const windowsEdge = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
  assert.equal(detectBrowser({ 'PROGRAMFILES(X86)': programFiles }, {
    platform: 'win32', playwrightPath: null, isExecutable: file => file === windowsEdge,
  })?.type, 'edge');
  assert.equal(detectBrowser({ PATH: '/opt/bin:/usr/bin' }, {
    platform: 'linux', playwrightPath: null, isExecutable: file => file === '/opt/bin/microsoft-edge',
  })?.path, '/opt/bin/microsoft-edge');
});

test('browser override validates an absolute executable and retains the old environment option', () => {
  const options = { platform: 'linux', playwrightPath: null, isExecutable: file => file === '/test/google-chrome' };
  assert.equal(detectBrowser({ TONGJI_CHROME_PATH: '/test/google-chrome' }, options).type, 'chrome');
  assert.throws(() => detectBrowser({ TONGJI_BROWSER_PATH: '/missing' }, options), /浏览器路径无效/);
  assert.throws(() => detectBrowser({ TONGJI_BROWSER_PATH: './chrome' }, options), /绝对路径/);
  assert.throws(() => detectBrowser({ TONGJI_BROWSER: 'safari' }, options), /只接受/);
});
