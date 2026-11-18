import { mkdir, chmod, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { displayUrl, isSchoolUrl, isServiceUrl, makeConfig } from './config.mjs';
import { parseTimetable, parseLectures, parseLibrary } from './parse.mjs';
import { prepareBookRequest } from './library-flow.mjs';
import { recommendBooks } from './book-recommendations.mjs';
import { querySeats, reserveSeat } from './seat-flow.mjs';
import { readPreferences, resetPreferences, savePreferences } from './preferences.mjs';
import { openBrowserLogin, passwordManagerFlags } from './browser-login.mjs';

export const NAVIGATION = {
  timetable: /^(查看课表|我的课表|个人课表|学生课表|课表查询|课程表|课表)$/,
  lectures: /^(高等讲堂|高等讲堂信息|高等讲堂查询|我的高等讲堂|高等讲堂完成情况)$/,
};

export async function extractFrame(frame) {
  // Read rendered text only. Input values, scripts, hidden nodes, cookies and
  // browser storage are deliberately outside this snapshot.
  return frame.evaluate(() => {
    const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const clean = value => (value || '').replace(/[\t ]+/g, ' ').trim();
    const limit = (value, n) => clean(value).slice(0, n);
    let remainingTableChars = 18000;
    const tableRoots = [...document.querySelectorAll('.ant-table, .el-table, table, [role="table"], [role="grid"]')].filter(visible);
    const tables = tableRoots.filter(el => !tableRoots.some(other => other !== el && other.contains(el))).slice(0, 8).map(table => {
        const rowEls = [...table.querySelectorAll('tr, [role="row"]')].filter(visible);
        const allRows = rowEls.slice(0, 121).map(row => ({
          isHeader: !!row.querySelector('th, [role="columnheader"]'),
          cells: [...row.querySelectorAll('th, td, [role="columnheader"], [role="cell"], [role="gridcell"]')]
            .filter(visible).slice(0, 20).map(cell => {
              const value = limit(cell.innerText, Math.min(800, Math.max(0, remainingTableChars)));
              remainingTableChars -= value.length;
              return value;
            }),
        })).filter(row => row.cells.length);
        const headerIndex = allRows.findIndex(row => row.isHeader);
        return {
          headers: headerIndex >= 0 ? allRows[headerIndex].cells : [],
          rows: allRows.filter((_, i) => i !== headerIndex).map(row => row.cells),
          truncated: rowEls.length > 121 || remainingTableChars <= 0,
        };
      });
    // Clone only to omit editable/form content from body text. No hidden input
    // values or page source are read into the result.
    const lines = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let total = 0;
    while ((node = walker.nextNode()) && total < 16000) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, noscript, textarea, input, select, [contenteditable="true"]') || !visible(parent)) continue;
      const value = clean(node.textContent);
      if (value) { lines.push(value); total += value.length + 1; }
    }
    const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 100)
      .map(a => ({ text: limit(a.innerText, 80), url: a.href })).filter(a => a.text);
    return { title: document.title, text: lines.join('\n').slice(0, 16000), tables, links };
  });
}

export class CampusBrowser {
  constructor(config = makeConfig()) {
    this.config = config;
    this.context = null;
    this.pages = new Map();
    this.queue = Promise.resolve();
    this.seatChoices = new Map();
    this.loginAttempts = new WeakSet();
    this.activeLoginMode = null;
  }

  get browserProfile() {
    const type = this.config.browser?.type;
    const suffix = type && type !== 'chrome' ? `-${type}` : '';
    return {
      directory: path.join(this.config.dataDir, `browser-profile${suffix}`),
      sessionFile: path.join(this.config.dataDir, `session-state${suffix}.json`),
    };
  }

  // One browser operation at a time, even when a host parallelizes tool calls.
  run(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async ensureContext() {
    if (this.context) return this.context;
    const browser = this.config.browser;
    if (!browser) throw new Error('未找到兼容浏览器。请安装 Chrome 或 Edge，或运行 sh bin/setup.sh --with-browser 安装 Chromium。');
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.dataDir, 0o700);
    const { loginMode } = await this.preferences();
    const chromeQuickLogin = loginMode === 'browser' && browser.type === 'chrome' && !this.config.headless;
    try {
      this.context = await chromium.launchPersistentContext(this.browserProfile.directory, {
        executablePath: browser.path,
        headless: this.config.headless,
        viewport: null,
        acceptDownloads: false,
        ...(chromeQuickLogin ? { ignoreDefaultArgs: passwordManagerFlags } : {}),
        args: ['--no-first-run', '--no-default-browser-check', ...(this.config.directConnection ? ['--no-proxy-server'] : [])],
      });
    } catch {
      throw new Error(`${browser.name} 独立浏览器启动失败。请检查该浏览器的安装及系统权限，或关闭占用专用会话的窗口后重试。`);
    }
    this.activeLoginMode = loginMode;
    this.context.setDefaultTimeout(4000);
    // Session cookies and sessionStorage may otherwise disappear on browser
    // exit. Keep them in the same private local directory, never tool output.
    try {
      const serialized = await readFile(this.browserProfile.sessionFile, 'utf8');
      if (serialized.length <= 5_000_000) {
        const saved = JSON.parse(serialized);
        const cookies = (saved.cookies || []).filter(c => {
          const domain = String(c.domain || '').replace(/^\./, '');
          return domain === 'tongji.edu.cn' || domain.endsWith('.tongji.edu.cn');
        });
        await this.context.addCookies(cookies);
        await this.context.addInitScript(({ origins }) => {
          const values = origins[location.origin];
          if (values && Object.keys(sessionStorage).length === 0) {
            for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
          }
        }, { origins: saved.sessionStorage || {} });
      }
    } catch { /* First login or an expired/unreadable local state: use the school login UI. */ }
    this.context.on('close', () => { this.context = null; this.activeLoginMode = null; this.pages.clear(); });
    return this.context;
  }

  async saveSession() {
    if (!this.context) return;
    try {
      const cookies = (await this.context.cookies()).filter(c => {
        const domain = String(c.domain || '').replace(/^\./, '');
        return domain === 'tongji.edu.cn' || domain.endsWith('.tongji.edu.cn');
      });
      const sessionStorage = {};
      for (const p of this.context.pages().filter(p => Object.keys(this.config.services).some(service => isServiceUrl(p.url(), service, this.config)))) {
        sessionStorage[new URL(p.url()).origin] = await p.evaluate(() => Object.fromEntries(Object.entries(window.sessionStorage))).catch(() => ({}));
      }
      const value = JSON.stringify({ cookies, sessionStorage });
      if (value.length > 5_000_000) return;
      const sessionFile = this.browserProfile.sessionFile;
      const temp = `${sessionFile}.tmp`;
      await writeFile(temp, value, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, sessionFile);
    } catch { /* A query can still work when local session persistence is unavailable. */ }
  }

  status() {
    return {
      status: 'ok', version: '0.5.1', browserRunning: !!this.context,
      browserFound: !!this.config.browser,
      browserName: this.config.browser?.name ?? null,
      browserType: this.config.browser?.type ?? null,
      chromeFound: this.config.browser?.type === 'chrome',
      quickLoginSupported: this.config.browser?.type === 'chrome',
      sessionProfileExists: Boolean(this.config.browser) && existsSync(this.browserProfile.directory),
      sessions: [...this.pages.entries()].filter(([, p]) => !p.isClosed())
        .map(([service, page]) => ({ service, url: displayUrl(page.url()) })),
      note: '已保存浏览器配置不代表仍然登录。登录有效性需读取目标业务页面确认。',
    };
  }

  async pageFor(service, navigate = true) {
    const context = await this.ensureContext();
    const remembered = this.pages.get(service);
    // A user may have opened a business page in another tab manually.
    const candidates = context.pages().filter(p => !p.isClosed() && isServiceUrl(p.url(), service, this.config));
    const page = candidates.at(-1) || (remembered && !remembered.isClosed() ? remembered : await context.newPage());
    this.pages.set(service, page);
    if (navigate && !isServiceUrl(page.url(), service, this.config)) {
      try { await page.goto(this.config.services[service], { waitUntil: 'domcontentloaded', timeout: 25000 }); }
      catch { /* An SSO redirect or slow resource can time out; inspect the actual page below. */ }
      await page.waitForFunction(() => (document.body?.innerText || '').trim().length > 20,
        null, { timeout: 8000 }).catch(() => {});
    }
    return page;
  }

  preferences() { return readPreferences(this.config.dataDir); }

  async configurePreferences({ reset = false, ...changes } = {}) {
    if (reset) await resetPreferences(this.config.dataDir);
    const settings = Object.keys(changes).length
      ? await savePreferences(this.config.dataDir, changes)
      : await this.preferences();
    return {
      status: 'ok',
      preferences: settings,
      loginModeAppliesOnNextBrowserStart: this.activeLoginMode !== null && this.activeLoginMode !== settings.loginMode,
    };
  }

  async openLogin(service) {
    const page = await this.pageFor(service);
    await page.bringToFront();
    const { loginMode } = await this.preferences();
    if (loginMode === 'browser' && this.activeLoginMode === 'browser' &&
        this.config.browser?.type === 'chrome' && !this.config.headless) {
      return openBrowserLogin(this, page, service);
    }
    return {
      status: 'user_action_required', service, url: displayUrl(page.url()),
      message: '请在已打开的插件专用浏览器中，确认域名后自行完成学校登录。登录后打开需要查询的课表／高等讲堂／馆藏／座位页面，再继续查询。不要在聊天中发送密码、验证码或 Cookie。',
    };
  }

  async snapshot(page, service) {
    const current = page.url();
    if (!isSchoolUrl(current)) {
      return { url: displayUrl(current), title: '', text: '', tables: [], links: [],
        status: 'user_action_required', message: '当前页面不在同济域名内。请在浏览器中完成登录并返回学校业务页面。' };
    }
    const frames = page.frames().filter(frame => isSchoolUrl(frame.url()));
    for (const frame of frames) {
      const authHost = /^(iam|idp|sso|ids)\./i.test(new URL(frame.url()).hostname);
      const passwordVisible = await frame.locator('input[type="password"]:visible').count().catch(() => 0);
      if (authHost || passwordVisible) return {
        status: 'login_required', url: displayUrl(current), title: '需要用户登录',
        text: '', tables: [], links: [], message: '请在插件专用浏览器中自行完成学校登录后重试。',
      };
    }
    const parts = [];
    for (const frame of frames.slice(0, 6)) {
      try { parts.push(await extractFrame(frame)); } catch { /* Frame changed during SSO/navigation. */ }
    }
    let tableBudget = 24000;
    let truncated = false;
    const tables = [];
    for (const table of parts.flatMap(p => p.tables).slice(0, 8)) {
      if (tableBudget <= 0) { truncated = true; break; }
      const trimCell = cell => { const value = cell.slice(0, Math.max(0, tableBudget)); tableBudget -= value.length; return value; };
      const headers = table.headers.map(trimCell);
      const rows = [];
      for (const row of table.rows) {
        if (tableBudget <= 0) { truncated = true; break; }
        rows.push(row.map(trimCell));
      }
      truncated ||= table.truncated || tableBudget <= 0;
      tables.push({ headers, rows });
    }
    const text = parts.map(p => p.text).filter(Boolean).join('\n').slice(0, 20000);
    const links = parts.flatMap(p => p.links).filter(a => isSchoolUrl(a.url))
      .map(a => ({ ...a, url: displayUrl(a.url) })).slice(0, 100);
    const title = parts[0]?.title || await page.title().catch(() => '');
    if (/Whitelabel Error Page|This site can.t be reached|ERR_CONNECTION_|status=404/.test(text)) return {
      status: 'page_unavailable', url: displayUrl(current), title, text: '', tables: [], links: [],
      message: '学校网页返回错误页面，无法读取。请检查入口或网络后重试。',
    };
    if (!text && !tables.length) return {
      status: 'page_unavailable', url: displayUrl(current), title, text: '', tables: [], links,
      message: '页面尚未加载或当前网络无法访问。请检查校园网／VPN，并在浏览器确认页面可正常显示。',
    };
    await this.saveSession();
    return { status: 'ok', service, url: displayUrl(current), title, text, tables, links,
      fetchedAt: new Date().toISOString(), truncated, contentTrust: 'untrusted_page_data' };
  }

  async readCurrent(service) {
    const page = await this.pageFor(service);
    return this.snapshot(page, service);
  }

  async waitForFresh(page, service, before, timeout = 8000) {
    const fingerprint = s => JSON.stringify(s.tables?.length ? s.tables : s.text);
    const original = fingerprint(before);
    const deadline = Date.now() + timeout;
    let previous;
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      const current = await this.snapshot(page, service);
      if (current.status === 'login_required') return current;
      const signature = fingerprint(current);
      if (current.status === 'ok' && signature !== original && !/正在(?:加载|检索)|加载中|loading\s*\.{1,3}/i.test(current.text)) {
        if (previous === signature) return current;
        previous = signature;
      } else previous = undefined;
    }
    return {
      status: 'page_pending', url: displayUrl(page.url()),
      message: '尚未确认目标页面／新检索结果已加载，未返回旧结果。请在浏览器确认后重新读取当前页面。',
    };
  }

  async tryNavigation(page, kind) {
    const candidates = [];
    for (const frame of page.frames().filter(f => isSchoolUrl(f.url()))) {
      const controls = frame.getByText(NAVIGATION[kind], { exact: true });
      for (let i = 0; i < Math.min(await controls.count(), 12); i++) {
        const control = controls.nth(i);
        if (!await control.isVisible()) continue;
        const label = (await control.innerText()).trim();
        if (!NAVIGATION[kind].test(label)) continue;
        const href = await control.evaluate(el => el.closest('a')?.getAttribute('href') || null);
        if (href && !href.startsWith('#') && !isSchoolUrl(new URL(href, frame.url()).href)) continue;
        candidates.push({ control, label });
      }
    }
    if (candidates.length !== 1) return { navigated: false, candidates: candidates.map(c => c.label) };
    await candidates[0].control.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    return { navigated: true, label: candidates[0].label };
  }

  async query(kind) {
    const page = await this.pageFor('academic');
    if (new URL(page.url()).hostname === '1.tongji.edu.cn' && new URL(page.url()).pathname === '/workbench') {
      await page.getByText('查看课表', { exact: true }).waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    }
    let snapshot = await this.snapshot(page, 'academic');
    if (snapshot.status !== 'ok') return snapshot;
    const parse = kind === 'timetable' ? parseTimetable : parseLectures;
    let result = parse(snapshot);
    if (['needs_page_selection', 'unstructured'].includes(result.status) && result.records.length === 0) {
      let navigation = await this.tryNavigation(page, kind);
      // The observed Tongji workbench hides the academic sidebar. Its
      // read-only "查看课表" link opens the academic area and its lecture menu.
      if (!navigation.navigated && kind === 'lectures' && new URL(page.url()).hostname === '1.tongji.edu.cn' && new URL(page.url()).pathname === '/workbench') {
        const scheduleLink = page.getByText('查看课表', { exact: true });
        if (await scheduleLink.count() === 1) {
          await scheduleLink.click();
          await page.getByText('我的高等讲堂', { exact: true }).first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
          navigation = await this.tryNavigation(page, kind);
        }
      }
      if (navigation.navigated) {
        snapshot = await this.waitForFresh(page, 'academic', snapshot);
        if (snapshot.status !== 'ok') return snapshot;
        result = parse(snapshot);
      }
      result.navigation = { navigated: navigation.navigated, candidates: navigation.candidates || [] };
    }
    return { ...result, fetchedAt: new Date().toISOString(),
      nextStep: ['needs_page_selection', 'unstructured'].includes(result.status)
        ? `请在插件专用浏览器打开${kind === 'timetable' ? '个人课表' : '高等讲堂'}页面后重新查询。当前内容不能用于断言没有记录。` : undefined };
  }

  async searchBooks(query) {
    const page = await this.pageFor('library');
    const u = new URL(page.url());
    const knownCatalog = u.hostname === 'webpac.tongji.edu.cn' && u.pathname === '/opac/openlink.php';
    if (knownCatalog && !u.hash.startsWith('#/Home')) {
      await page.goto(this.config.services.library, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.locator('input[type="text"]:visible').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    }
    if (new URL(page.url()).hostname === 'webpac.tongji.edu.cn' && new URL(page.url()).hash.startsWith('#/Home')) {
      await page.locator('input[type="text"]:visible').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    }
    const first = await this.snapshot(page, 'library');
    if (first.status !== 'ok') return first;
    const homePage = new URL(page.url()).hostname === 'webpac.tongji.edu.cn' && new URL(page.url()).pathname === '/opac/openlink.php' && new URL(page.url()).hash.startsWith('#/Home');
    const inputs = homePage ? page.locator('input[type="text"]:visible')
      : page.locator('input[type="search"]:visible, input[placeholder*="书名"]:visible, input[placeholder*="检索"]:visible, input[placeholder*="搜索"]:visible, input[aria-label*="检索"]:visible');
    const buttons = page.getByRole('button', { name: /^(检索|搜索|查询|Search)$/i });
    if (await inputs.count() !== 1 || (!homePage && await buttons.count() !== 1)) return {
      status: 'needs_page_selection', query, url: first.url,
      message: '未唯一识别书目检索框和检索按钮。请在插件专用浏览器中手动搜索书名，再调用 campus_read_current_page(service="library") 读取结果。',
    };
    await inputs.fill(query);
    if (homePage) await inputs.press('Enter');
    else await buttons.click();
    const snapshot = await this.waitForFresh(page, 'library', first, 18000);
    if (snapshot.status !== 'ok') return snapshot;
    return { ...parseLibrary(snapshot), query, fetchedAt: new Date().toISOString() };
  }

  async close() {
    this.seatChoices.clear();
    if (this.context) { await this.saveSession(); await this.context.close(); }
    return { status: 'ok', message: '已关闭插件的独立浏览器。登录配置保留在本机；这不会撤销学校端会话。' };
  }

  async recommendBooks(options) { return recommendBooks(this, options); }

  async openBookRequest(options) { return prepareBookRequest(this, options, { handoff: true }); }

  async prepareBookRequest(options) {
    return prepareBookRequest(this, options);
  }

  async querySeats(options) { return querySeats(this, options); }
  async reserveSeat(options) { return reserveSeat(this, options); }
}
