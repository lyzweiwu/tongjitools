import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendBooks, recommendFromSources } from '../src/book-recommendations.mjs';

const author = '(日) 样例作者著';
const ranked = { id: '12', title: '样例推理', author, callNumber: 'I313.45/T12-2/2', availableCopies: 2,
  popularity: { rank: 8, loans: 30, source: 'borrow_ranking' } };
const ranking = { status: 'ok', books: [ranked] };
const options = { query: '样例作者', match: 'author' };

test('author recommendations keep ranked editions and exclude biographies and translators', () => {
  const books = [
    { id: '11', title: '样例推理. 第2版', author, availableCopies: 7 },
    { id: '13', title: '样例作者研究', author: '另一位作者著', availableCopies: 20 },
    { id: '14', title: '译作', author: '另一位作者著, 样例作者译' },
    { id: '15', title: '另一部推理', author, availableCopies: 8 },
  ];
  const result = recommendFromSources(options, { status: 'ok', books }, ranking);
  assert.deepEqual(result.candidates.map(book => book.id), ['12', '15']);
  assert.equal(result.candidates[0].availableCopies, 2);
  assert.equal(result.candidates[0].request.callNumber, 'I313.45/T12-2/2');
  assert.equal(result.candidates[1].popularity, undefined);
});

test('same record joins catalogue metadata and ranked loan counts', () => {
  const isbn = '978-0-123-45678-9';
  const books = [{ id: ranked.id, title: ranked.title, author, isbn, availableCopies: 1 }];
  const result = recommendFromSources(options, { status: 'ok', books }, ranking);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].popularity.loans, 30);
  assert.equal(result.candidates[0].availableCopies, 1);
  assert.equal(result.candidates[0].request.query, isbn);
});

test('catalogue fallback distinguishes unavailable rankings from zero popularity', () => {
  const books = [{ id: '20', title: '夜间故事', author, availableCopies: 4 }];
  const result = recommendFromSources({ query: '悬疑' }, { status: 'ok', books }, { status: 'unavailable', books: [] });
  assert.equal(result.status, 'no_rank_match');
  assert.equal(result.ranking.status, 'unavailable');
  assert.equal(result.candidates[0].popularity, undefined);
});

test('a recommendation without a topic uses the public ranking and excludes catalogue fallback', async () => {
  const catalog = { status: 'not_requested', books: [] };
  const result = recommendFromSources({ browsePopular: true, limit: 1 }, catalog, ranking);
  assert.equal(result.status, 'ok');
  assert.equal(result.catalog.pagesRead, 0);
  assert.equal(result.candidates[0].popularity.rank, ranked.popularity.rank);
  assert.equal(Object.hasOwn(result, 'query'), false);
  assert.equal(recommendFromSources({ browsePopular: true }, catalog, { status: 'empty', books: [] }).status, 'no_matches_in_view');
  let tabsOpened = 0;
  let navigated;
  const unavailable = await recommendBooks({
    config: { services: { library: 'https://webpac.tongji.edu.cn/opac/openlink.php' } },
    ensureContext: async () => ({
      newPage: async () => {
        tabsOpened++;
        return { goto: async url => { navigated = url; throw new Error('fixture'); }, close: async () => {} };
      },
    }),
  }, { browsePopular: true });
  assert.equal(tabsOpened, 1);
  assert.match(navigated, /#\/readRange$/);
  assert.equal(unavailable.status, 'page_pending');
});
