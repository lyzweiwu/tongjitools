// Real Chrome, entirely fictional UI and intercepted requests. Never books a seat.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CampusBrowser} from '../src/browser.mjs';
import {makeConfig} from '../src/config.mjs';
import {normalizeSeatQuery} from '../src/seat-query.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new CampusBrowser({...makeConfig(),headless:true,dataDir:path.join(root,'.local','seat-smoke-profile')});
const today=normalizeSeatQuery().date,tomorrow=normalizeSeatQuery({date:'明天'}).date;
let submissions=0, mismatch=false, missing=false, failQuery=false;
const html=String.raw`<!doctype html><html><body><title>虚构座位测试</title><input value="PRIVATE_DO_NOT_RETURN"><div hidden>PRIVATE_DO_NOT_RETURN</div><main id="home"><div class="item"><div class="text" onclick="openScreen('ordinary')">座位预约</div></div><div class="item"><div class="text" onclick="openScreen('exam')">考研座位</div></div><div class="item"><div class="text" onclick="openScreen('research')">研修座位</div></div></main><script>
let type='ordinary',day=${JSON.stringify(today)},campus='嘉定校区图书馆',floor='六楼',region='';
const dates=[${JSON.stringify(today)},${JSON.stringify(tomorrow)}];
async function openScreen(t){type=t;await (await fetch('/reserve/index/quickSelect')).json();render();}
function section(label,values,selected){return '<div class="section"><p class="subtitle">'+label+'</p>'+values.map(v=>'<div class="item btnV2 '+(v===selected?'active':'')+'" onclick="choose(\''+label+'\',\''+v+'\')"><div class="'+(label==='日期'?'day':'text')+'">'+v+'</div>'+(label==='日期'?'':'<div class="info">空余：2 总数：3</div>')+'</div>').join('')+'</div>';}
function render(){document.querySelector('#home').innerHTML=section('日期',type==='ordinary'?dates:[dates[0]],day)+section('馆舍',['嘉定校区图书馆','四平路校区图书馆'],campus)+section('楼层',type==='ordinary'?['六楼','七楼']:['二楼'],floor)+section('区域',['北区','南区'],region)+'<button onclick="map()">确定选择</button>';}
async function choose(label,value){if(label==='日期'){day=value;await (await fetch('/reserve/index/quickSelect')).json();}if(label==='馆舍')campus=value;if(label==='楼层')floor=value;if(label==='区域')region=value;render();}
async function map(){const data=await(await fetch(type==='ordinary'?'/api/Seat/seat':'/api/Study/StudyAreaDetail')).json();let overlay=document.createElement('aside');overlay.className='map';overlay.innerHTML='<p class="title">'+campus+'-'+floor+'-'+region+'</p><div class="seat-info-r"><span class="status">空余 '+data.available+'</span></div><div class="reg-time">08:00 - 22:30</div>'+(type!=='ordinary'?'<span class="init">未获得</span>':'')+'<span onclick="document.querySelector(\'.grid-seat\').style.display=\'block\'">列表模式</span><div class="seat-selected">已选座位号：-</div><div class="grid-seat" style="display:none">'+data.seats.map(s=>'<div class="btn" onclick="select(this)">'+s+'</div>').join('')+'</div><button onclick="this.closest(\'.map\').remove()">返回</button><button class="reserve" disabled onclick="submit()">立即预约</button>';document.body.append(overlay);}
function select(el){document.querySelector('.seat-selected').textContent='已选座位号：'+el.textContent;document.querySelector('.reserve').disabled=false;}
async function submit(){await fetch('/fixture/submit',{method:'POST'});const toast=document.createElement('div');toast.className='van-toast';toast.textContent='预约成功';document.body.append(toast);}
</script></body></html>`;
try {
  const context=await browser.ensureContext();
  context.on('page',page=>page.on('pageerror',error=>console.error('Fixture page error:',error.message)));
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/fixture/submit'){submissions++;return route.fulfill({json:{ok:true}});}
    if(u.pathname.toLowerCase().includes('/api/seat/seat')||u.pathname.includes('/api/Study/StudyAreaDetail')) return route.fulfill({json:{available:mismatch?3:missing?0:2,seats:missing?[]:['T001','T003']}});
    if(u.pathname==='/reserve/index/quickSelect') {await new Promise(r=>setTimeout(r,300));return route.fulfill({status:failQuery?503:200,json:{ok:true}});}
    return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  const absent=await browser.querySeats({date:'明天',floor:'二楼',startTime:'14:00',endTime:'16:00'});
  assert.equal(absent.status,'needs_floor_selection',JSON.stringify(absent));assert.equal(absent.timeMatch,'unsupported');assert.ok(absent.alternativeSeatTypes.some(t=>t.seatType==='exam'));assert.equal(submissions,0);
  const timed=await browser.querySeats({date:'明天',floor:'六楼',startTime:'14:00',endTime:'16:00',limit:4});
  assert.equal(timed.status,'unsupported_time_range',JSON.stringify(timed));assert.equal(timed.candidates.length,4);assert.ok(timed.candidates.every(c=>!c.selectionId&&!c.timeMatches));
  assert.equal(JSON.stringify(timed).includes('PRIVATE_DO_NOT_RETURN'),false);assert.equal(submissions,0);
  const available=await browser.querySeats({date:'明天',floor:'六楼',limit:4});
  assert.equal(available.status,'ok',JSON.stringify(available));assert.equal(new Set(available.candidates.map(c=>c.region)).size,2);
  const id=available.candidates[0].selectionId;
  assert.equal((await browser.reserveSeat({selectionId:id})).status,'confirmation_required');assert.equal(submissions,0);
  assert.equal((await browser.reserveSeat({selectionId:'fabricated',confirm:true})).status,'selection_expired');
  assert.equal((await browser.reserveSeat({selectionId:id,confirm:true})).status,'reserved');assert.equal(submissions,1);
  assert.equal((await browser.reserveSeat({selectionId:id,confirm:true})).status,'selection_expired');assert.equal(submissions,1);
  const stale=await browser.querySeats({date:'明天',floor:'六楼'});missing=true;
  const gone=await browser.reserveSeat({selectionId:stale.candidates[0].selectionId,confirm:true});
  assert.notEqual(gone.status,'reserved');assert.equal(submissions,1);missing=false;
  mismatch=true;const incomplete=await browser.querySeats({date:'明天',floor:'六楼'});
  assert.equal(incomplete.status,'page_pending');assert.deepEqual(incomplete.candidates,[]);assert.equal(browser.seatChoices.size,0);mismatch=false;
  const exam=await browser.querySeats({date:'今天',floor:'二楼',seatType:'exam'});
  assert.equal(exam.status,'permission_required');assert.ok(exam.candidates.every(c=>!c.selectionId));
  failQuery=true;const failed=await browser.querySeats({date:'明天',floor:'六楼'});
  assert.equal(failed.status,'query_failed');assert.deepEqual(failed.candidates,[]);
  console.log(JSON.stringify({status:'ok',checks:['floor_alternatives','exact_times_not_promised','two_region_candidates','private_fields_excluded','confirmation_required','fabricated_choices_rejected','one_submission_after_recheck','single_use_choice','changed_availability','incomplete_lists_rejected','exam_permission','query_failure_not_empty_result'],mockSubmissions:submissions,realSubmissions:0}));
} finally {await browser.close();}
