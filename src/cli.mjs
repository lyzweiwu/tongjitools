import { CampusBrowser } from './browser.mjs';
import { makeConfig } from './config.mjs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const [command = 'doctor', subject, keyword] = process.argv.slice(2);
const config = makeConfig();
const browser = new CampusBrowser(config);
const print = result => console.log(JSON.stringify(result, null, 2));
try {
  if (['doctor', 'status'].includes(command)) print(browser.status());
  else if (command === 'login' && ['academic', 'library'].includes(subject)) {
    print(await browser.openLogin(subject));
    console.error('请在浏览器完成登录和页面定位。此终端接受：status、read academic、read library、query timetable、query lectures、books 书名、close。关闭浏览器也会结束会话。');
    const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
    terminal.on('line', line => {
      browser.run(async () => {
        const [op, arg, ...rest] = line.trim().split(/\s+/);
        if (op === 'status') print(browser.status());
        else if (op === 'read' && ['academic', 'library'].includes(arg)) print(await browser.readCurrent(arg));
        else if (op === 'query' && ['timetable', 'lectures'].includes(arg)) print(await browser.query(arg));
        else if (op === 'books' && arg) print(await browser.searchBooks([arg, ...rest].join(' ')));
        else if (op === 'close') await browser.close();
        else print({ status: 'invalid_command', message: '只接受查询命令。请在学校网页输入登录信息，不要在终端输入密码。' });
      }).catch(() => print({ status: 'error', message: '操作失败，请检查浏览器页面。' }));
    });
    await once(browser.context, 'close');
    terminal.close();
  } else if (command === 'query' && ['timetable', 'lectures'].includes(subject)) print(await browser.query(subject));
  else if ((command === 'books' && subject) || (command === 'query' && subject === 'books' && keyword)) print(await browser.searchBooks(command === 'books' ? subject : keyword));
  else if (command === 'read' && ['academic', 'library'].includes(subject)) print(await browser.readCurrent(subject));
  else if (command === 'close') print(await browser.close());
  else { console.error('用法：doctor | status | login academic|library | query timetable|lectures | books "书名" | read academic|library | close'); process.exitCode = 2; }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: /Chrome|浏览器|入口/.test(error.message) ? error.message.split('\n')[0] : '读取失败，请检查浏览器页面与网络。' }));
  process.exitCode = 1;
} finally { await browser.close(); }
