import { isSchoolUrl } from './config.mjs';

const CATALOG = 'https://webpac.tongji.edu.cn/opac/openlink.php';
const RANK_URL = CATALOG + '#/readRange';
const HOME_URL = CATALOG + '#/Home';
const SEARCH_WAIT_MS = 30000;

const normalize = value => (value || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]/gu, '');
const workTitle = title => normalize(title?.replace(/[.．。\s]*第[一二三四五六七八九十\d]+版\s*$/u, ''));
const isBookNumber = value => /^[A-Z]{1,3}\d[A-Z\d.\-]*\/[A-Z\d][A-Z\d.,\-/]*(?:[（(]\d+[）)])?$/i.test(value);
const hasRank = book => Boolean(book.popularity);

function authorMatches(responsibility, query) {
  const first = responsibility?.normalize('NFKC').replace(/^\s*(?:\([^)]*\)|\[[^\]]*\]|【[^】]*】)\s*/u, '')
    .split(/[;；,，、]|(?:编著|著|撰|编|译|主编)\s*/u, 1)[0];
  // Prefer the leading credited author. Later responsibilities often include translators.
  return normalize(first) === normalize(query);
}

function matches(book, { query, match }) {
  if (match === 'author') return authorMatches(book.author, query);
  const fields = [normalize(book.title), normalize(book.author)];
  return query.normalize('NFKC').split(/\s+/u).map(normalize).filter(Boolean)
    .every(term => fields.some(field => field.includes(term)));
}

export function recommendFromSources({ query, match = 'keyword', limit = 5, browsePopular = false }, catalog, ranking) {
  const result = new Map();
  const key = book => book.id ? book.id + ':' + (book.callNumber || '') : book.callNumber && workTitle(book.title) + ':' + book.callNumber;
  for (const book of ranking.books) {
    if (book.title && (browsePopular || matches(book, { query, match })) && key(book)) result.set(key(book), book);
  }
  for (const book of catalog.books) {
    if (!book.title || (match === 'author' && !authorMatches(book.author, query)) || !key(book)) continue;
    const matched = ranking.books.filter(rank => {
      if (rank.callNumber && book.callNumber && rank.callNumber !== book.callNumber) return false;
      if (rank.id && rank.id === book.id) return true;
      return rank.callNumber && rank.callNumber === book.callNumber &&
        workTitle(rank.title) === workTitle(book.title) && normalize(rank.author) === normalize(book.author);
    });
    if (matched.length === 1) {
      const rank = matched[0];
      result.set(key(rank), {
        ...rank,
        isbn: book.isbn || rank.isbn,
        availableCopies: book.availableCopies ?? rank.availableCopies,
      });
    } else if (!result.has(key(book))) {
      result.set(key(book), book);
    }
  }

  // Group alternate editions for presentation while keeping the exact ranked
  // edition and its availability together.
  const priority = (a, b) => Number(hasRank(b)) - Number(hasRank(a)) ||
    (a.popularity?.rank ?? Infinity) - (b.popularity?.rank ?? Infinity) ||
    Number((b.availableCopies ?? 0) > 0) - Number((a.availableCopies ?? 0) > 0);
  const seen = new Set();
  const candidates = [...result.values()].sort(priority).filter(book => {
    const key = workTitle(book.title) + ':' + normalize(book.author);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit).map((book, index) => ({
    number: index + 1,
    ...book,
    ...(book.callNumber && isBookNumber(book.callNumber) ? {
      request: { query: book.isbn || book.title, callNumber: book.callNumber },
    } : {}),
  }));
  return {
    kind: 'book_recommendations',
    status: candidates.length ? (candidates.some(hasRank) ? 'ok' : 'no_rank_match')
      : catalog.status === 'ok' || catalog.status === 'empty' || (browsePopular && ranking.status === 'empty')
        ? 'no_matches_in_view' : 'page_pending',
    ...(browsePopular ? { browsePopular } : { query, match }), candidates,
    catalog: { status: catalog.status, url: HOME_URL, pagesRead: catalog.status === 'ok' ? 1 : 0 },
    ranking: { status: ranking.status, url: ranking.url, period: ranking.period, scope: ranking.scope,
      entriesRead: ranking.books.length, metric: '借阅次数' },
    fetchedAt: new Date().toISOString(),
    contentTrust: 'untrusted_page_data',
  };
}

function extractCatalogBooks() {
  const books = [];
  for (const anchor of document.querySelectorAll('a[href*="/bookDetails/"]')) {
    const link = /^#\/searchList\/bookDetails\/(\d+)$/.exec(anchor.hash);
    const heading = /^\s*\d+[.．、]\s*\[图书\]\s*(.+)$/u.exec(anchor.innerText.trim());
    if (!link || !heading || !anchor.getClientRects().length) continue;
    const card = anchor.closest('[class*="rightContent___"]');
    const fields = card?.querySelectorAll('[class*="easymode___"] > [class*="modeInfo___"]');
    if (!fields || fields.length < 3) continue;
    const publication = fields[2].innerText.trim();
    const count = /可借\s*[（(]\s*(\d+)\s*[）)]/u.exec(card.innerText);
    books.push({
      id: link[1], title: heading[1].slice(0, 300), author: fields[1].innerText.trim().slice(0, 180),
      callNumber: fields[0].innerText.trim().slice(0, 100), publication: publication.slice(0, 180),
      isbn: publication.match(/\b97[89](?:-?\d){10}\b/u)?.[0],
      availableCopies: count ? Number(count[1]) : undefined,
    });
  }
  return books;
}

async function readCatalog(page, query) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const input = page.locator('#searchInput:visible');
  await input.fill(query, { timeout: 12000 });
  await input.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/searchList') &&
    ([...document.querySelectorAll('a[href*="/bookDetails/"]')].some(a =>
      a.getClientRects().length && /^\s*\d+[.．、]\s*\[/.test(a.innerText)) ||
    /无检索结果|没有检索到|未检索到/.test(document.body.innerText)),
  null, { timeout: SEARCH_WAIT_MS });
  const books = await page.evaluate(extractCatalogBooks);
  return { status: books.length ? 'ok' : 'empty', books };
}

function rankRows(rows) {
  // Only expose the fields shown in the public catalogue and an ISBN for
  // precise follow-up. The first page is already sorted by loan count.
  return rows.slice(0, 40).flatMap((row, index) => {
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 300) : '';
    const loans = row.loanCount;
    if (!title || !Number.isSafeInteger(loans) || loans < 0) return [];
    const availability = row.canLoanCount;
    return [{
      title,
      author: String(row.author ?? '').trim().slice(0, 180),
      publication: [row.publish, row.pubDate].filter(Boolean).join(' ').slice(0, 180),
      callNumber: String(row.callNo ?? '').trim().slice(0, 100),
      availableCopies: Number.isSafeInteger(availability) && availability >= 0 ? availability : undefined,
      isbn: String(row.isbn ?? '').match(/\b97[89](?:-?\d){10}\b/u)?.[0],
      popularity: { rank: index + 1, loans, source: 'borrow_ranking', period: '最近一年' },
    }];
  });
}

async function readRanking(page, discipline) {
  await page.goto(RANK_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByRole('tab', { name: '热门借阅', exact: true }).waitFor({ timeout: 12000 });
  const school = page.getByText('同济大学', { exact: true }).filter({ visible: true });
  await school.click({ timeout: 12000 });
  if (discipline) await page.getByText(discipline, { exact: true }).filter({ visible: true }).click();
  const period = page.locator('.ant-select-selection-selected-value').filter({ hasText: /^最近一周$/ });
  await period.click({ timeout: 12000 });
  const chooseRankOption = async (name, rows) => {
    // A recent-week request may still be running after choosing a school or
    // discipline. Only read the response to the requested annual controls.
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      if (url.origin !== new URL(CATALOG).origin || url.pathname !== '/find/index/getHotLoan') return false;
      try {
        const params = response.request().postDataJSON();
        return params?.statRange === 365 && params.sortType === 1 && params.page === 1 &&
          params.rows === rows && Boolean(params.libCode) && Boolean(params.disCode) === Boolean(discipline);
      } catch { return false; }
    }, { timeout: 18000 });
    const [response] = await Promise.all([
      responsePromise,
      page.locator('.ant-select-dropdown:visible').getByRole('option', { name, exact: true }).click(),
    ]);
    if (!response.ok()) throw new Error('ranking_unavailable');
    const body = await response.json();
    if (!body.success || !Array.isArray(body.data?.result)) throw new Error('ranking_unavailable');
    return rankRows(body.data.result);
  };
  let books = await chooseRankOption('最近一年', 10);
  const pageSize = page.getByText(/^10\s*条\/页$/u).filter({ visible: true });
  if (await pageSize.count() === 1) {
    try {
      await pageSize.click();
      books = await chooseRankOption('40 条/页', 40);
    } catch { /* The verified first page remains a valid sample. */ }
  }
  return { status: books.length ? 'ok' : 'empty', url: RANK_URL, scope: discipline || '全部学科',
    period: '最近一年', books };
}

export async function recommendBooks(browser, { query, match = 'keyword', limit = 5, discipline, browsePopular = false } = {}) {
  const valid = browsePopular === true ? query === undefined
    : browsePopular === false && typeof query === 'string' && Boolean(normalize(query)) && query.length <= 100;
  if (!valid) return { status: 'invalid_query', message: '请指定作者、书名片段或主题关键词，也可选择浏览热门借阅榜。' };
  if (!isSchoolUrl(browser.config.services.library) ||
      new URL(browser.config.services.library).hostname !== 'webpac.tongji.edu.cn') {
    return { status: 'needs_page_selection', message: '该推荐流程使用同济新版馆藏页面。' };
  }
  const context = await browser.ensureContext();
  async function inspect(read, fallback) {
    const page = await context.newPage();
    try {
      if (browser.config.headless) await page.setViewportSize({ width: 1440, height: 1000 });
      return await read(page);
    }
    catch { return fallback; }
    finally { await page.close().catch(() => {}); }
  }
  const [catalog, ranking] = await Promise.all([
    browsePopular ? { status: 'not_requested', books: [] }
      : inspect(page => readCatalog(page, query), { status: 'unavailable', books: [] }),
    inspect(page => readRanking(page, discipline), { status: 'unavailable', url: RANK_URL, books: [] }),
  ]);
  return recommendFromSources({ query, match, limit, browsePopular }, catalog, ranking);
}
