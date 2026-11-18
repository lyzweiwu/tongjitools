// Real Chrome against synthetic pages only. No requests reach the university.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { CampusBrowser } from '../src/browser.mjs';
import { makeConfig } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new CampusBrowser({ ...makeConfig(), headless: true, directConnection: true,
  dataDir: path.join(root, '.local', 'book-preview-smoke-profile') });
let mode = 'ready';
let writes = 0;
const fixture = variant => `<!doctype html><html><head><title>首页</title></head><body><main id="app"></main><script>
const variant=${JSON.stringify(variant)};
window.fixtureSubmitClicks=0;
const app=document.getElementById('app');
function submitFixture(){ window.fixtureSubmitClicks++; fetch('/submit',{method:'POST'}); }
function results(){
 document.title='检索结果';
 const count=variant==='ambiguous'?2:1;
 app.innerHTML='<p>共 '+count+' 条</p>'+Array.from({length:count},(_,i)=>
 '<article><a href="#/searchList/bookDetails/'+(100+i)+'"><span>'+(i+1)+'. [图书]</span><span>测试线性代数'+(i?' 第二版':'')+'</span></a><p>AI解读</p><p>O151.2/FIXTURE'+(i?'A':'')+(variant==='volumes'?'/1；O151.2/FIXTURE/2':'')+'</p><p>测试出版社</p><p>纸本(1) / 可借(1)</p></article>').join('');
}
function details(){
 document.title='测试线性代数';
 app.innerHTML='<h1>测试线性代数</h1>'+(variant==='loggedout'?'<p>账号 登录 后即可发起请求</p>':
 '<p>可发起委托次数：5 次</p><table><thead><tr><th>索书号</th><th>馆藏地</th><th>可借复本</th><th>当前请求数</th><th>操作</th></tr></thead><tbody><tr><td colspan="5">暂无数据</td></tr></tbody></table>');
 if(variant!=='loggedout')setTimeout(()=>{app.querySelector('tbody').innerHTML='<tr data-row-key="0"><td>O151.2/FIXTURE'+(variant==='volumes'?'/2':'')+'</td><td>测试中文书库</td><td>1</td><td>0</td><td><a style="visibility:hidden">请求</a><a onclick="openForm()">请求</a></td></tr>'; if(variant==='campus'||variant==='local-empty') {
  const row='<tr data-row-key="1"><td>O151.2/FIXTURE</td><td>四平路测试书库</td><td>'+(variant==='campus'?'1':'0')+'</td><td>0</td><td><a onclick="openForm()">请求</a></td></tr>';
  app.querySelector('tbody').insertAdjacentHTML('beforeend',row);
 }},120);
}
function openForm(){
 app.insertAdjacentHTML('beforeend','<div role="dialog"><label>取书地：</label><div role="combobox" tabindex="0" onclick="openOptions()">请选择</div><label>*手机号：</label><input placeholder="请输入手机号码" value="13800138000"><label>*邮箱：</label><input placeholder="请输入邮箱" value="PRIVATE_FIXTURE_EMAIL@example.invalid"><button id="preview-confirm" onclick="submitFixture()">确 定</button><button>取 消</button></div>');
 document.querySelector('input[placeholder="请输入手机号码"]').addEventListener('keydown',e=>{if(e.key==='Enter')submitFixture();});
}
function openOptions(){
 setTimeout(()=>{
  document.querySelector('[role="dialog"]').insertAdjacentHTML('beforeend','<div role="listbox"><div role="option">测试校区-测试图书馆一楼大厅</div><div role="option">另一个测试取书点</div></div>');
  for (const item of document.querySelectorAll('[role=option]')) item.onclick=()=>{
   document.querySelector('[role=combobox]').textContent=item.textContent;
   item.parentElement.remove();
  };
  const old=document.getElementById('preview-confirm'); const newer=old.cloneNode(true); newer.disabled=false; old.replaceWith(newer);
 },120);
}
function home(){
 document.title='首页';
 app.innerHTML='<p>同济馆藏测试入口，仅含虚构数据。</p><input type="text" placeholder="检索">';
 app.querySelector('input').addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  history.replaceState({},'',location.pathname+location.search+'#/searchList');
  app.innerHTML='<p>检索页框架，书目尚未加载。共0条</p><a href="#/searchList/bookDetails/999">推荐书目，非检索结果</a>'; setTimeout(results,variant==='slow'?13000:180);
 });
}
window.addEventListener('hashchange',()=>{ if(location.hash.includes('/bookDetails/'))details(); else if(location.hash==='#/Home')home(); });
if(location.hash.includes('/bookDetails/'))details();else home();
</script></body></html>`;

new Script(fixture('ready').match(/<script>([\s\S]*)<\/script>/)[1]);
try {
  await browser.configurePreferences({reset:true});
  const context = await browser.ensureContext();
  await context.route('**/*', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(mode) });
  });
  const preview = await browser.prepareBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(preview.status, 'ready_for_user_input', JSON.stringify(preview));
  assert.equal(preview.submitted, false);
  assert.equal(preview.submissionDisabled, true);
  assert.equal(preview.form.pickupOptions.length, 2);
  assert.equal(preview.form.hasPhone, true);
  assert.equal(preview.form.hasEmail, true);
  assert.equal(/13800138000|PRIVATE_FIXTURE_EMAIL/.test(JSON.stringify(preview)), false);
  const page = browser.pages.get('library');
  assert.equal(await page.locator('#preview-confirm').isDisabled(), true, 'replaced final button must stay disabled');
  await page.locator('#preview-confirm').dispatchEvent('click');
  await page.locator('input[placeholder="请输入手机号码"]').press('Enter');
  assert.equal(await page.evaluate(() => window.fixtureSubmitClicks), 0, 'preview must block click and Enter submission');
  assert.equal(writes, 0, 'preview must not create a request');

  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=handoff#/Home';
  const handoff = await browser.openBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(handoff.status, 'ready_for_user_submission', JSON.stringify(handoff));
  assert.equal(handoff.submitted, false);
  assert.equal(await page.locator('#preview-confirm').isEnabled(), true);
  assert.equal(/13800138000|PRIVATE_FIXTURE_EMAIL/.test(JSON.stringify(handoff)), false);
  assert.equal(writes, 0, 'handoff must leave submission to the reader');

  mode = 'volumes';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=volumes#/Home';
  const volume = await browser.openBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE/2' });
  assert.equal(volume.status, 'ready_for_user_submission', JSON.stringify(volume));
  assert.equal(volume.book.callNumber, 'O151.2/FIXTURE/2');
  assert.equal(writes, 0);

  mode = 'loggedout';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=loggedout#/Home';
  const loggedOut = await browser.prepareBookRequest({ query: '测试线性代数' });
  assert.equal(loggedOut.status, 'login_required', JSON.stringify(loggedOut));
  assert.equal(await page.locator('[role="dialog"]').count(), 0);

  mode = 'ambiguous';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=ambiguous#/Home';
  const ambiguous = await browser.prepareBookRequest({ query: '测试线性代数' });
  assert.equal(ambiguous.status, 'needs_book_selection', JSON.stringify(ambiguous));
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  assert.equal(writes, 0);
  mode = 'slow';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=slow#/Home';
  const slow = await browser.prepareBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(slow.status, 'ready_for_user_input', JSON.stringify(slow));
  assert.ok(slow.timingsMs.search >= 13000, 'the actual 13-second delay must be exercised');
  assert.equal(slow.diagnostics.limits.searchResultsMs, 25000);
  assert.equal(slow.diagnostics.limits.totalMs, 45000);
  assert.equal(slow.diagnostics.step, 'form.ready');
  assert.equal(slow.submissionDisabled, true);
  assert.equal(writes, 0);
  await browser.configurePreferences({ preferredCampus: '四平路', pickupLocation: '测试校区-测试图书馆一楼大厅' });
  mode = 'campus';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=campus#/Home';
  const local = await browser.openBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(local.status, 'ready_for_user_submission', JSON.stringify(local));
  assert.equal(local.book.sourceLocation, '四平路测试书库');
  assert.equal(local.pickup.pickupPreselected, true);

  mode = 'local-empty';
  browser.config.services.library = 'https://webpac.tongji.edu.cn/opac/openlink.php?fixture=local-empty#/Home';
  const remote = await browser.openBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(remote.status, 'ready_for_user_submission', JSON.stringify(remote));
  assert.equal(remote.sourceSelection.matchesPreferredCampus, false);
  assert.equal(remote.sourceSelection.preferredCampusStock[0].availableCopies, 0);
  await browser.configurePreferences({ allowCrossCampus: false });
  const blocked = await browser.openBookRequest({ query: '测试线性代数', callNumber: 'O151.2/FIXTURE' });
  assert.equal(blocked.status, 'cross_campus_options', JSON.stringify(blocked));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(writes, 0);

  console.log(JSON.stringify({ status: 'ok', checks: ['async_results_ready', 'zero_placeholder_not_empty', 'detail_placeholder_not_empty', 'recommendation_shell_not_results', 'visible_request_action',
    'pickup_and_contact_stop', 'manual_handoff_leaves_form_usable', 'one_volume_selected_from_grouped_card', 'no_contact_values_in_output', 'submit_click_and_enter_blocked',
    'login_required_stops', 'ambiguous_books_stop', 'results_after_13_seconds', 'preferred_campus_outranks_first_row', 'exact_pickup_preselection', 'cross_campus_flag'], slowSearchMs: slow.timingsMs.search, submittedRequests: writes }));
} finally { await browser.configurePreferences({reset:true}); await browser.close(); }
