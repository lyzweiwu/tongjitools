// Resolve relative dates in the user's campus timezone, never the host timezone.
export function normalizeSeatQuery({ date = '今天', startTime, endTime, campus = '四平路校区图书馆', floor, seatType = 'ordinary', region, limit = 20 } = {}, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (date === '今天' || date === '明天') {
    const day = new Date(`${today}T00:00:00Z`);
    if (date === '明天') day.setUTCDate(day.getUTCDate() + 1);
    date = day.toISOString().slice(0, 10);
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('日期须为今天、明天或有效的 YYYY-MM-DD。');
  if ((startTime === undefined) !== (endTime === undefined) ||
      (startTime !== undefined && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime >= endTime))) throw new Error('时间须为同一天内起始早于结束的 HH:mm 时段。');
  const floors = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五'];
  const numeric = /^(\d{1,2})(?:楼|层|F)?$/i.exec(String(floor).trim());
  if (numeric && floors[Number(numeric[1])-1]) floor = `${floors[Number(numeric[1])-1]}楼`;
  if (typeof floor === 'string') floor=floor.replace(/层$/,'楼');
  if (campus === '四平路' || campus === '四平路校区') campus = '四平路校区图书馆';
  if (typeof campus !== 'string' || !campus.trim() || campus.length > 60 || (floor !== undefined && (typeof floor !== 'string' || !floor.trim() || floor.length > 20)) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('请提供有效的馆舍、楼层和 1–50 的返回数量。');
  if (!['ordinary','exam','research'].includes(seatType) || (region !== undefined && (typeof region !== 'string' || !region.trim() || region.length > 80))) throw new Error('座位类型或区域无效。');
  return { date, campus: campus.trim(), ...(floor ? {floor:floor.trim()} : {}), seatType, ...(region ? {region:region.trim()} : {}), ...(startTime ? { startTime, endTime } : {}), limit, timeZone: 'Asia/Shanghai' };
}
