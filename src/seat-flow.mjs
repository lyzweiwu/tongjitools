import { randomUUID } from 'node:crypto';
import { displayUrl, isServiceUrl } from './config.mjs';
import { normalizeSeatQuery } from './seat-query.mjs';

const LABELS = {ordinary:'座位预约', exam:'考研座位', research:'研修座位'};
const TTL = 5 * 60 * 1000;
function readSections() {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  return Object.fromEntries([...document.querySelectorAll('.section')].filter(visible).map(section => [
    section.querySelector('p.subtitle')?.innerText.trim(),
    [...section.querySelectorAll('.item')].filter(visible).slice(0,80).map(e=>({
      label:(e.querySelector('.text, .day')?.innerText || '').trim().slice(0,80),
      active:e.classList.contains('active'),
      available:Number(e.innerText.match(/空余[：:]\s*(\d+)/)?.[1] ?? NaN),
      total:Number(e.innerText.match(/总数[：:]\s*(\d+)/)?.[1] ?? NaN),
    })),
  ]));
}
function section(page, label) { return page.locator('.section').filter({has:page.locator('p.subtitle').filter({hasText:new RegExp(`^${label}$`)})}); }
async function settle(page) {
  let previous='', stable=0;
  const deadline=Date.now()+6000;
  while(Date.now()<deadline) {
    const current=await page.evaluate(readSections);
    const text=JSON.stringify(current);
    if(text===previous && current['馆舍']?.length && ++stable>=2) return current;
    if(text!==previous) stable=0;
    previous=text;
    await page.waitForTimeout(150);
  }
  throw new Error('page_pending');
}
async function observed(page, pathname, action) {
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).hostname==='space.tongji.edu.cn' && new URL(r.url()).pathname.toLowerCase()===pathname.toLowerCase(),{timeout:15000});
  const [response]=await Promise.all([responsePromise,action()]);
  if(!response.ok()) throw new Error('query_failed');
  await response.finished();
}
async function choose(page, label, value) {
  const root=section(page,label);
  const items=root.locator('.item');
  const labels=await items.evaluateAll(nodes=>nodes.map(e=>(e.querySelector('.text, .day')?.innerText||'').trim()));
  const indices=labels.flatMap((s,i)=>s===value?[i]:[]);
  if(indices.length!==1) throw new Error('page_structure_changed');
  const item=items.nth(indices[0]);
  if(!(await item.getAttribute('class'))?.split(/\s+/).includes('active')) {
    if(label==='日期') await observed(page,'/reserve/index/quickSelect',()=>item.click());
    else await item.click();
  }
  const selected=await settle(page);
  if(!selected[label]?.some(item=>item.label===value&&item.active)) throw new Error('page_pending');
  return selected;
}
async function openRegion(browser,page,query,region) {
  await choose(page,'区域',region);
  const endpoint=query.seatType==='ordinary' ? '/api/Seat/seat' : '/api/Study/StudyAreaDetail';
  await observed(page,endpoint,()=>page.getByRole('button',{name:'确定选择',exact:true}).click());
  if(!isServiceUrl(page.url(),'seats',browser.config)) throw new Error('page_structure_changed');
  const titles=await page.locator('p.title').allInnerTexts();
  if(!titles.some(t=>t.trim()===`${query.campus}-${query.floor}-${region}`)) throw new Error('page_structure_changed');
  await page.getByText('列表模式',{exact:true}).click();
  await page.locator('.grid-seat').waitFor({state:'attached',timeout:10000});
  await page.waitForFunction(()=>{
    const root=document.querySelector('.grid-seat');
    const available=Number(document.querySelector('.seat-info-r .status')?.textContent.match(/空余\s*(\d+)/)?.[1] ?? NaN);
    return root && Number.isFinite(available) && root.children.length===available;
  },null,{timeout:6000});
  // In the observed official list, only free seats have a .btn entry. Compare
  // its count to the map's explicit free count before calling them available.
  return page.evaluate(()=>{
    const roots=[...document.querySelectorAll('.grid-seat')];
    const seats=roots.length===1 ? [...roots[0].children].filter(e=>e.classList.contains('btn') && !e.classList.contains('disabled') && e.getAttribute('aria-disabled')!=='true').map(e=>e.textContent.trim()).filter(s=>/^[\w\u4e00-\u9fff-]{1,30}$/.test(s)) : [];
    const available=Number(document.querySelector('.seat-info-r .status')?.innerText.match(/空余\s*(\d+)/)?.[1] ?? NaN);
    const permission=[...document.querySelectorAll('.init')].some(e=>e.getClientRects().length && /未获得/.test(e.innerText)) ? 'not_granted' : 'unknown';
    return {seats,available:Number.isFinite(available)?available:null,period:[...document.querySelectorAll('.reg-time, .reg-date.active')].map(e=>e.innerText.trim()).join(' '),permission};
  });
}

export async function querySeats(browser, options={}, {recordChoices=true}={}) {
  const query=normalizeSeatQuery(options);
  browser.seatChoices ||= new Map();
  if(recordChoices) browser.seatChoices.clear();
  let page;
  let step='open_entry';
  const result=(status,fields={})=>({kind:'seat_query',status,query,submitted:false,exactTimeSupported:false,
    timeMatch:query.startTime?'unsupported':'not_requested',
    timeNotice:'当前适配的普通座位按日、考研/研修座位按期预约，不能锁定指定小时区间。普通座位次日预约须在次日8:30前签到。',
    ...fields,url:page?displayUrl(page.url()):undefined,fetchedAt:new Date().toISOString(),contentTrust:'untrusted_page_data'});
  try {
    page=await browser.pageFor('seats');
    if(browser.config.headless) await page.setViewportSize({width:1280,height:900});
    await page.goto(browser.config.services.seats,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
    await page.waitForFunction(()=>document.querySelector('input[type="password"]') || [...document.querySelectorAll('.item .text')].some(e=>e.innerText==='座位预约'),null,{timeout:8000}).catch(()=>{});
    const auth=await browser.snapshot(page,'seats');
    if(auth.status!=='ok') return result(auth.status,{message:auth.message});
    if(new URL(browser.config.services.seats).hostname!=='space.tongji.edu.cn') return result('needs_page_selection',{message:'仅适配同济官方空间预约系统。'});
    step='open_seat_screen';
    await observed(page,'/reserve/index/quickSelect',()=>page.getByText(LABELS[query.seatType],{exact:true}).click());
    let sections=await settle(page);
    const dates=sections['日期']||[];
    // Long-term seats expose the current period, not a daily time-slot picker.
    if(!dates.some(d=>d.label===query.date)) return result('date_not_available',{availableDates:dates.map(d=>d.label),message:'页面未提供该日期。考研/研修座位按期预约，不能把当前期余位解释为指定日期时段可预约。'});
    step='select_date';
    sections=await choose(page,'日期',query.date);
    if(!sections['馆舍']?.some(s=>s.label===query.campus)) return result('needs_campus_selection',{campuses:sections['馆舍']||[]});
    step='select_campus';
    sections=await choose(page,'馆舍',query.campus);
    if(!sections['楼层']?.some(s=>s.label===query.floor)) return result('needs_floor_selection',{floors:sections['楼层']||[],
      ...(query.campus==='四平路校区图书馆'&&query.floor==='二楼'&&query.seatType==='ordinary'?{alternativeSeatTypes:[{seatType:'exam',label:'考研座位',note:'综合阅览楼二楼属于考研专座，按期预约并需资格，不能改成普通小时预约。'}]}:{})});
    step='select_floor';
    sections=await choose(page,'楼层',query.floor);
    const regions=sections['区域']||[];
    if(query.region&&!regions.some(r=>r.label===query.region)) return result('needs_region_selection',{regions});
    if(!regions.length) return result('page_pending',{message:'未读取到区域；不能据此判定没有座位。'});
    const chosen=query.region?regions.filter(r=>r.label===query.region):regions.slice(0,6);
    const perRegion=Math.max(1,Math.ceil(query.limit/chosen.length));
    const candidates=[],details=[];
    for(const region of chosen) {
      step='read_region_seats';
      const data=await openRegion(browser,page,query,region.label);
      const consistent=data.available!==null && data.seats.length===data.available && new Set(data.seats).size===data.seats.length;
      details.push({region:region.label,available:data.available,listed:data.seats.length,consistent,period:data.period,permission:data.permission});
      if(consistent) for(const seat of data.seats.slice(0,perRegion)) {
        const choice={date:query.date,campus:query.campus,floor:query.floor,region:region.label,seat,seatType:query.seatType,period:data.period,availability:'available',timeMatches:!query.startTime};
        if(recordChoices&&!query.startTime&&query.seatType==='ordinary') {
          choice.selectionId=randomUUID();
          browser.seatChoices.set(choice.selectionId,{query:{...query,region:region.label},seat,expiresAt:Date.now()+TTL});
        }
        candidates.push(choice);
      }
      step='return_to_regions';
      await page.getByRole('button',{name:'返回',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.grid-seat'),null,{timeout:6000});
    }
    await browser.saveSession();
    const incomplete=details.some(d=>!d.consistent);
    if(incomplete&&recordChoices) browser.seatChoices.clear();
    return result(incomplete?'page_pending':query.startTime?'unsupported_time_range':details.some(d=>d.permission==='not_granted')?'permission_required':candidates.length?'ok':'no_available_seats',{
      regions,details,candidates:incomplete?[]:candidates.slice(0,query.limit),truncated:regions.length>chosen.length||details.some(d=>d.available>perRegion),
      selectionExpiresInSeconds:300,
      ...(query.seatType!=='ordinary'?{reservationSupported:false,message:'考研/研修座位可查询，资格及周期需按官方页面核对；当前不提供自动提交。'}:{}),
    });
  } catch(error) {
    if(recordChoices) browser.seatChoices.clear();
    return result(error.message==='query_failed'?'query_failed':error.name==='TimeoutError'?'page_pending':'page_structure_changed',{
      message:'未确认新的筛选或座位数据已完整加载，没有返回旧座位。请检查官方页面后重试。',candidates:[],diagnostics:{step,errorType:error.name==='TimeoutError'?'TimeoutError':'Error'},
    });
  }
}

// Explicit user confirmation is required by the workflow. A choice is single-use,
// expires after five minutes, and is checked again in the official UI before the
// one submit click. Never retry a submit whose outcome is unknown.
export async function reserveSeat(browser,{selectionId,confirm}={}) {
  const choice=browser.seatChoices?.get(selectionId);
  const result=(status,fields={})=>({kind:'seat_reservation',status,submitted:false,...fields,fetchedAt:new Date().toISOString()});
  if(confirm!==true) return result('confirmation_required',{message:'请先由用户确定具体日期、馆舍、区域和座位，并确认预约。'});
  if(!choice||choice.expiresAt<Date.now()) return result('selection_expired',{message:'候选已过期，请重新查询后选择。'});
  browser.seatChoices.delete(selectionId);
  const checked=await querySeats(browser,{...choice.query,limit:50},{recordChoices:false});
  if(checked.status!=='ok') return result(checked.status,{message:'重新查询未通过，没有提交。'});
  const page=await browser.pageFor('seats');
  let clicked=false;
  try {
    const data=await openRegion(browser,page,choice.query,choice.query.region);
    if(data.available!==data.seats.length||!data.seats.includes(choice.seat)) return result('seat_unavailable',{message:'该座位已不可选，请重新查询。'});
    const seats=page.locator('.grid-seat > .btn').filter({hasText:new RegExp(`^\\s*${choice.seat.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`)});
    if(await seats.count()!==1) return result('page_structure_changed');
    await seats.click();
    await page.waitForFunction(seat=>document.querySelector('.seat-selected')?.innerText.trim()===`已选座位号：${seat}`,choice.seat,{timeout:4000});
    const button=page.getByRole('button',{name:/立即预约/});
    if(await button.count()!==1||!await button.isEnabled()) return result('reservation_not_open',{message:'官方预约按钮不可用，没有提交。'});
    clicked=true;
    await button.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.van-toast, .van-dialog')].some(e=>e.getClientRects().length && /预约成功|预约失败|已被|无权|签到/.test(e.innerText)),null,{timeout:10000}).catch(()=>{});
    const outcome=await page.locator('.van-toast:visible, .van-dialog:visible').allInnerTexts();
    if(outcome.some(t=>/预约成功/.test(t))) return result('reserved',{submitted:true,seat:choice.seat,date:choice.query.date,campus:choice.query.campus,region:choice.query.region,message:'官方页面显示预约成功。次日预约须在次日8:30前签到。'});
    return result('outcome_unknown',{submitted:null,message:'已点击一次预约，尚未确认最终结果。请在官方页面查看“我的预约”，不要重复提交。'});
  } catch {
    return result(clicked?'outcome_unknown':'page_structure_changed',{submitted:clicked?null:false,message:clicked?'提交结果尚未确认，请查看官方“我的预约”，不要重复提交。':'页面状态变化，没有提交。'});
  }
}
