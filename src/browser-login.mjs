import { displayUrl, isSchoolUrl } from './config.mjs';

const authUrl = /^https:\/\/iam\.tongji\.edu\.cn\/idp\/authcenter\/ActionAuthChain(?:[?#]|$)/u;
export const passwordManagerFlags = ['--enable-automation', '--password-store=basic', '--use-mock-keychain'];

// Runs within the official page. Return only the action outcome.
export function submitBrowserAutofill() {
  if (location.origin !== 'https://iam.tongji.edu.cn' ||
      location.pathname !== '/idp/authcenter/ActionAuthChain') return false;
  const visible = element => element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const user = document.querySelector('input#j_username[type="text"]');
  const secret = document.querySelector('input#j_password[type="password"]');
  const button = document.querySelector('button#loginButton');
  const form = secret?.form;
  if (![user, secret, button, form].every(visible) || button.disabled ||
      form !== user.form || form !== button.form || button.textContent.trim() !== '登录') return false;
  const action = new URL(form.action);
  if (action.origin !== location.origin || action.pathname !== '/idp/AuthnEngine') return false;
  const otherInput = [...form.querySelectorAll('input')].some(input =>
    input !== user && input !== secret && !['hidden', 'checkbox', 'submit', 'button'].includes(input.type) && visible(input));
  if (otherInput || !user.value || !secret.matches(':autofill')) return false;
  button.click();
  return true;
}

export async function openBrowserLogin(browser, page, service) {
  const existingTabs = new Set(browser.context.pages());
  if (serverIsCatalog(page.url()) && service === 'library') {
    const signIn = page.getByText('登录', { exact: true }).filter({ visible: true });
    await signIn.waitFor({ state: 'visible', timeout: 14000 }).catch(() => {});
    if (await signIn.count() === 1) await signIn.click({ timeout: 4000 }).catch(() => {});
  }

  let officialPage;
  const deadline = Date.now() + 15000;
  do {
    for (const tab of browser.context?.pages() || []) {
      if (tab.isClosed() || !authUrl.test(tab.url())) continue;
      if (tab === page || (!existingTabs.has(tab) && await tab.opener() === page)) {
        officialPage = tab;
        break;
      }
    }
    if (officialPage) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  if (officialPage) {
    await officialPage.bringToFront().catch(() => {});
    await officialPage.locator('input#j_password:visible').waitFor({ timeout: 4500 }).catch(() => {});
    if (!browser.loginAttempts.has(officialPage)) {
      const autofillDeadline = Date.now() + 2200;
      do {
        const submitted = await officialPage.evaluate(submitBrowserAutofill).catch(() => false);
        if (submitted) {
          browser.loginAttempts.add(officialPage);
          return { status: 'login_submitted', service,
            message: '已用 Chrome 自动填充的凭证发起登录，请在业务页面确认结果。若学校要求验证，请在浏览器处理。' };
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < autofillDeadline && authUrl.test(officialPage.url()));
    }
  }

  return { status: 'user_action_required', service, url: displayUrl((officialPage || page).url()),
    message: officialPage
      ? '请在同济认证页面选择 Chrome 中保存的账号，或自行登录。若要保存凭证，可使用 Chrome 的密码管理器。'
      : '请等待同济业务页面加载，点击页面上的登录后，使用 Chrome 中保存的账号或自行完成认证。' };
}

function serverIsCatalog(value) {
  if (!isSchoolUrl(value)) return false;
  const url = new URL(value);
  return url.hostname === 'webpac.tongji.edu.cn' && ['/', '/opac/openlink.php'].includes(url.pathname) &&
    /^#\/(?:Home|searchList)(?:\/|$)/u.test(url.hash);
}
