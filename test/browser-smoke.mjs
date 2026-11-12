// Explicit integration check; not part of the default unit-test glob.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampusBrowser } from '../src/browser.mjs';
import { makeConfig } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new CampusBrowser({ ...makeConfig(), headless: true, dataDir: path.join(root, '.local', 'browser-smoke-profile') });
const home = '<html><title>研究生门户</title><body><a href="/graduate/timetable">查看课表</a><p>培养计划</p><table><tr><th>课程名称</th><th>学分</th></tr><tr><td>旧培养计划</td><td>2</td></tr></table></body></html>';
const timetable = '<html><title>个人课表</title><body><h1>个人课表</h1><a href="/evaluate">我的高等讲堂</a><input value="DO_NOT_LEAK_INPUT"><div hidden>DO_NOT_LEAK_HIDDEN</div><a href="/x?ticket=DO_NOT_LEAK_TICKET">详情</a><div class="el-table"><div class="el-table__header-wrapper"><table><tr><th>课程名称</th><th>上课地点</th><th>教学安排</th></tr></table></div><div class="el-table__body-wrapper"><table><tr><td>测试研究生课程</td><td>测试教学楼</td><td>周一 1-2节</td></tr></table></div></div></body></html>';
const lectures = '<html><title>我的高等讲堂</title><body><h1>心得录入与评价</h1><div>最终成绩：未完成</div><div>6/<br>2<br>校级应通过次数 / 校级通过次数</div><table><tr><th>讲座名称</th><th>讲座级别</th></tr></table><p>暂无数据 共0条</p></body></html>';
const library = '<html><title>馆藏检索</title><body><input type="text" onkeydown="if(event.key === \'Enter\')setTimeout(() => {document.querySelector(\'td\').textContent=\'新检索图书\';history.replaceState({},\'\',\'#/searchList\')}, 700)"><table><tr><th>书名</th><th>馆藏状态</th></tr><tr><td>旧检索图书</td><td>在馆</td></tr></table></body></html>';
try {
  const context = await browser.ensureContext();
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    const html = u.hostname === 'webpac.tongji.edu.cn' ? library : u.pathname === '/evaluate' ? lectures : u.pathname.includes('timetable') ? timetable : home;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  const result = await browser.query('timetable');
  assert.equal(result.status, 'ok');
  assert.equal(result.records[0].course, '测试研究生课程');
  const page = browser.pages.get('academic');
  const snapshot = await browser.snapshot(page, 'academic');
  assert.equal(/DO_NOT_LEAK/.test(JSON.stringify(snapshot)), false, 'input, hidden text or query ticket leaked');
  const newer = await context.newPage();
  await newer.goto('https://1.tongji.edu.cn/graduate/timetable');
  assert.equal(await browser.pageFor('academic'), newer, 'new manual business tab ignored');
  const lectureResult = await browser.query('lectures');
  assert.equal(lectureResult.status, 'ok');
  assert.equal(lectureResult.progress[0].completed, '2');
  assert.equal(lectureResult.records.length, 0);
  const books = await browser.searchBooks('新检索图书');
  assert.equal(books.status, 'ok');
  assert.equal(books.records[0].title, '新检索图书');
  assert.equal(books.records[0].status, '在馆');
  const unchanged = await browser.waitForFresh(newer, 'academic', await browser.snapshot(newer, 'academic'), 900);
  assert.equal(unchanged.status, 'page_pending');
  await context.addCookies([{ name: 'fixture-session', value: 'FIXTURE_COOKIE_ONLY', domain: '1.tongji.edu.cn', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await newer.evaluate(() => sessionStorage.setItem('fixture-token', 'FIXTURE_STORAGE_ONLY'));
  await browser.close();
  const restoredContext = await browser.ensureContext();
  await restoredContext.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: timetable }));
  const restoredPage = await browser.pageFor('academic');
  assert.equal(await restoredPage.evaluate(() => sessionStorage.getItem('fixture-token')), 'FIXTURE_STORAGE_ONLY');
  assert.ok((await restoredContext.cookies()).some(c => c.name === 'fixture-session' && c.value === 'FIXTURE_COOKIE_ONLY'));
  assert.equal(/FIXTURE_COOKIE_ONLY|FIXTURE_STORAGE_ONLY/.test(JSON.stringify(await browser.snapshot(restoredPage, 'academic'))), false);
  console.log(JSON.stringify({ status: 'ok', checks: ['real_chrome_launch', 'workbench_navigation', 'split_table_parsing', 'credential_exclusion', 'new_tab_selection', 'lecture_card_navigation', 'async_search_freshness', 'unchanged_results_rejected', 'local_session_restore_without_exposure'] }));
} finally { await browser.close(); }
