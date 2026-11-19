import { CampusBrowser } from './browser.mjs';
import { makeConfig } from './config.mjs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const [command = 'doctor', subject, keyword, ...additional] = process.argv.slice(2);
const config = makeConfig();
const browser = new CampusBrowser(config);
const print = result => console.log(JSON.stringify(result, null, 2));
async function exportTimetable(json) {
  let options;
  try { options = JSON.parse(json || '{}'); }
  catch { return { status: 'invalid_input', message: 'export-timetable 接受一个 JSON 参数。' }; }
  return browser.exportTimetable(options);
}
try {
  if (['doctor', 'status'].includes(command)) print(browser.status());
  else if (command === 'preferences') print(await browser.configurePreferences(JSON.parse(subject || '{}')));
  else if (command === 'login' && ['academic', 'library', 'seats'].includes(subject)) {
    print(await browser.openLogin(subject));
    console.error('请在浏览器完成登录和页面定位。此终端接受：status、preferences [JSON]、read academic、read library、read seats、query timetable、query lectures、export-timetable [JSON]、books 书名、my-loans、check-renewal [书名]、recommend-books JSON查询条件、prepare-book 书名或ISBN [索书号]、seats JSON查询条件、close。关闭浏览器也会结束会话。');
    const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
    terminal.on('line', line => {
      browser.run(async () => {
        const exportCommand = /^export-timetable(?:\s+([\s\S]*))?$/.exec(line.trim());
        if (exportCommand) return print(await exportTimetable(exportCommand[1]));
        const [op, arg, ...rest] = line.trim().split(/\s+/);
        if (op === 'status') print(browser.status());
        else if (op === 'preferences') print(await browser.configurePreferences(JSON.parse([arg, ...rest].join(' ').trim() || '{}')));
        else if (op === 'read' && ['academic', 'library', 'seats'].includes(arg)) print(await browser.readCurrent(arg));
        else if (op === 'query' && ['timetable', 'lectures'].includes(arg)) print(await browser.query(arg));
        else if (op === 'books' && arg) print(await browser.searchBooks([arg, ...rest].join(' ')));
        else if (op === 'my-loans' && !arg) print(await browser.queryMyLoans());
        else if (op === 'check-renewal') print(await browser.checkRenewal(arg ? { titles: [[arg, ...rest].join(' ')] } : {}));
        else if (op === 'recommend-books' && arg) print(await browser.recommendBooks(JSON.parse([arg, ...rest].join(' '))));
        else if (op === 'prepare-book' && arg) print(await browser.prepareBookRequest({ query: arg, callNumber: rest.join(' ') || undefined }));
        else if (op === 'seats') print(await browser.querySeats(JSON.parse([arg,...rest].join(' ') || '{}')));
        else if (op === 'close') await browser.close();
        else print({ status: 'invalid_command', message: '只接受查询与不提交的准备命令。请在学校网页输入登录信息，不要在终端输入密码。' });
      }).catch(() => print({ status: 'error', message: '操作失败，请检查浏览器页面。' }));
    });
    await once(browser.context, 'close');
    terminal.close();
  } else if (command === 'prepare-book' && subject) print(await browser.prepareBookRequest({ query: subject, callNumber: keyword }));
  else if (command === 'export-timetable') print(await exportTimetable(subject));
  else if (command === 'my-loans' && subject === undefined) print(await browser.queryMyLoans());
  else if (command === 'check-renewal') print(await browser.checkRenewal(subject === undefined
    ? {} : { titles: [subject, keyword, ...additional].filter(value => value !== undefined) }));
  else if (command === 'recommend-books' && subject) print(await browser.recommendBooks(JSON.parse(subject)));
  else if (command === 'seats') print(await browser.querySeats(subject ? JSON.parse(subject) : {}));
  else if (command === 'query' && ['timetable', 'lectures'].includes(subject)) print(await browser.query(subject));
  else if ((command === 'books' && subject) || (command === 'query' && subject === 'books' && keyword)) print(await browser.searchBooks(command === 'books' ? subject : keyword));
  else if (command === 'read' && ['academic', 'library', 'seats'].includes(subject)) print(await browser.readCurrent(subject));
  else if (command === 'close') print(await browser.close());
  else { console.error('用法：doctor | status | preferences [JSON] | login academic|library|seats | query timetable|lectures | export-timetable [JSON] | books "书名" | my-loans | check-renewal ["书名" ...] | recommend-books JSON查询条件 | prepare-book "书名或ISBN" [索书号] | seats JSON查询条件 | read academic|library|seats | close'); process.exitCode = 2; }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: /Chrome|浏览器|入口/.test(error.message) ? error.message.split('\n')[0] : '读取失败，请检查浏览器页面与网络。' }));
  process.exitCode = 1;
} finally { await browser.close(); }
