import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { chromium } from 'playwright-core';

export const { version } = createRequire(import.meta.url)('../package.json');

export function isSchoolUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password &&
      (!u.port || u.port === '443') &&
      (u.hostname === 'tongji.edu.cn' || u.hostname.endsWith('.tongji.edu.cn'));
  } catch { return false; }
}

// Query strings can contain SSO tickets. Never return them to a model or a log.
export function displayUrl(value) {
  try {
    const u = new URL(value);
    const route = u.hash.startsWith('#/') ? u.hash.split('?')[0] : '';
    return `${u.origin}${u.pathname}${route}`;
  } catch { return ''; }
}

const browserNames = { chrome: 'Google Chrome', edge: 'Microsoft Edge', chromium: 'Chromium', custom: '自定义 Chromium 浏览器' };

function executable(file) {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(file).isFile();
  } catch { return false; }
}

function browserType(file) {
  const name = file.split(/[\\/]/u).pop().toLowerCase();
  if (name === 'msedge.exe' || name.startsWith('microsoft edge') || /^microsoft-edge(?:-stable)?$/u.test(name)) return 'edge';
  if (/chromium/u.test(name) || /(?:^|[\\/])chromium[-_]/iu.test(file) || /Chrome for Testing/iu.test(file)) return 'chromium';
  if (/^(?:google chrome|google-chrome(?:-stable)?|chrome(?:\.exe)?)$/u.test(name)) return 'chrome';
  return 'custom';
}

export function detectBrowser(env = process.env, {
  platform = process.platform, home = homedir(), isExecutable = executable,
  playwrightPath = chromium.executablePath(),
} = {}) {
  const requested = env.TONGJI_BROWSER || 'auto';
  if (!['auto', 'chrome', 'edge', 'chromium'].includes(requested)) {
    throw new Error('浏览器选项 TONGJI_BROWSER 只接受 auto、chrome、edge 或 chromium。');
  }
  const explicit = env.TONGJI_BROWSER_PATH || env.TONGJI_CHROME_PATH;
  const filePath = platform === 'win32' ? path.win32 : path.posix;
  const makeBrowser = (type, file) => ({ type, name: browserNames[type], path: file });
  if (explicit) {
    if (!filePath.isAbsolute(explicit) || !isExecutable(explicit)) {
      throw new Error('浏览器路径无效。请用 TONGJI_BROWSER_PATH 设置可执行文件的绝对路径。');
    }
    return makeBrowser(requested !== 'auto' ? requested : browserType(explicit), explicit);
  }

  const dirs = (env.PATH || '').split(filePath.delimiter).filter(folder => filePath.isAbsolute(folder));
  const fromPath = names => dirs.flatMap(folder => names.map(name => filePath.join(folder, name)));
  const paths = {
    chrome: fromPath(['google-chrome', 'google-chrome-stable']),
    edge: fromPath(['microsoft-edge', 'microsoft-edge-stable']),
    chromium: fromPath(['chromium', 'chromium-browser']),
  };
  if (platform === 'darwin') {
    for (const [type, name] of Object.entries(browserNames).filter(([type]) => type !== 'custom')) {
      paths[type].push(...['/Applications', path.posix.join(home, 'Applications')]
        .map(folder => path.posix.join(folder, `${name}.app`, 'Contents', 'MacOS', name)));
    }
  } else if (platform === 'win32') {
    const roots = [env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'],
      env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean);
    for (const [type, parts] of Object.entries({
      chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
      edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      chromium: ['Chromium', 'Application', 'chrome.exe'],
    })) paths[type].push(...roots.map(folder => filePath.join(folder, ...parts)));
  } else {
    paths.chrome.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    paths.edge.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
    paths.chromium.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  if (playwrightPath) paths.chromium.push(playwrightPath);
  for (const type of requested === 'auto' ? ['chrome', 'edge', 'chromium'] : [requested]) {
    const file = paths[type].find(isExecutable);
    if (file) return makeBrowser(type, file);
  }
  return null;
}

export function makeConfig(env = process.env) {
  const base = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'TongjiCampusLocal')
    : process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'TongjiCampusLocal')
      : path.join(homedir(), '.local', 'share', 'tongji-campus-local');
  const academicUrl = env.TONGJI_ACADEMIC_URL || 'https://1.tongji.edu.cn/';
  const libraryUrl = env.TONGJI_LIBRARY_URL || 'https://webpac.tongji.edu.cn/opac/openlink.php#/Home';
  const seatsUrl = env.TONGJI_SEATS_URL || 'https://space.tongji.edu.cn/';
  for (const url of [academicUrl, libraryUrl, seatsUrl]) {
    if (!isSchoolUrl(url)) throw new Error('入口必须是 HTTPS 同济大学域名（tongji.edu.cn）的网页。');
  }
  const browser = detectBrowser(env);
  return {
    dataDir: path.resolve(env.TONGJI_CAMPUS_DATA_DIR || base),
    browser,
    headless: env.TONGJI_HEADLESS === '1',
    directConnection: env.TONGJI_DIRECT_CONNECTION === '1',
    services: { academic: academicUrl, library: libraryUrl, seats: seatsUrl },
  };
}

export function isServiceUrl(value, service, config) {
  if (!isSchoolUrl(value)) return false;
  const host = new URL(value).hostname;
  if (/^(iam|idp|sso|ids)\./i.test(host)) return false;
  const libraryHosts = new Set(['webpac.tongji.edu.cn', 'lib.tongji.edu.cn', 'www.lib.tongji.edu.cn', new URL(config.services.library).hostname]);
  const seatHost = new URL(config.services.seats || 'https://space.tongji.edu.cn/').hostname;
  if (service === 'seats') return host === seatHost;
  if (service === 'library') return host !== seatHost && libraryHosts.has(host);
  return service === 'academic' && host !== seatHost && !libraryHosts.has(host);
}
