import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

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

export function makeConfig(env = process.env) {
  const base = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'TongjiCampusLocal')
    : process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'TongjiCampusLocal')
      : path.join(homedir(), '.local', 'share', 'tongji-campus-local');
  const academicUrl = env.TONGJI_ACADEMIC_URL || 'https://1.tongji.edu.cn/';
  const libraryUrl = env.TONGJI_LIBRARY_URL || 'https://webpac.tongji.edu.cn/opac/openlink.php#/Home';
  for (const url of [academicUrl, libraryUrl]) {
    if (!isSchoolUrl(url)) throw new Error('入口必须是 HTTPS 同济大学域名（tongji.edu.cn）的网页。');
  }
  const candidates = [
    env.TONGJI_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return {
    dataDir: path.resolve(env.TONGJI_CAMPUS_DATA_DIR || base),
    chromePath: candidates.find(p => existsSync(p)),
    headless: env.TONGJI_HEADLESS === '1',
    services: { academic: academicUrl, library: libraryUrl },
  };
}

export function isServiceUrl(value, service, config) {
  if (!isSchoolUrl(value)) return false;
  const host = new URL(value).hostname;
  if (/^(iam|idp|sso|ids)\./i.test(host)) return false;
  const libraryHosts = new Set(['webpac.tongji.edu.cn', 'lib.tongji.edu.cn', 'www.lib.tongji.edu.cn', new URL(config.services.library).hostname]);
  return service === 'library' ? libraryHosts.has(host) : !libraryHosts.has(host);
}
