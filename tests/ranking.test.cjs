const { test } = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('../priority.sys.mjs');
const types = { TAB_SWITCH: 1, SEARCH: 2, URL: 3, KEYWORD: 4 };
const sources = { BOOKMARKS: 1, HISTORY: 2 };
const config = { weights: core.DEFAULTS, overrides: new Map() };
const result = (id, values = {}) => ({ id, type: types.URL, payload: {}, ...values });

test('existing pinned tab wins over new navigation, other tabs and history', () => {
  const items = [result('new', { heuristic: true }), result('history', { source: 2 }),
    result('tab', { type: 1 }), result('pin', { type: 1 })];
  assert.deepEqual(core.rank(items, config, types, sources, r => r.id === 'pin').map(r => r.id),
    ['pin', 'tab', 'history', 'new']);
  assert.equal(items[0].heuristic, true, 'provider-owned data remains untouched');
});

test('provider overrides work with both legacy and modern provider names', () => {
  const cfg = { ...config, overrides: core.parseOverrides('{"SearchSuggestions":500,"UrlbarProviderPlaces":200}') };
  const items = [result('tab', { type: 1, providerName: 'Other' }),
    result('history', { source: 2, providerName: 'Places' }),
    result('search', { type: 2, providerName: 'UrlbarProviderSearchSuggestions', payload: { suggestion: 'q' } })];
  assert.deepEqual(core.rank(items, cfg, types, sources, () => false).map(r => r.id), ['search', 'history', 'tab']);
});

test('equal weights preserve native ordering, zero and negative overrides are valid', () => {
  const cfg = { weights: { ...core.DEFAULTS, other: 0 }, overrides: core.parseOverrides('{"One":0,"Two":-10}') };
  const items = [result('a', { providerName: 'One' }), result('b'), result('c', { providerName: 'Two' })];
  assert.deepEqual(core.rank(items, cfg, types, sources, () => false).map(r => r.id), ['a', 'b', 'c']);
});

test('invalid overrides are rejected rather than partially applied', () => {
  for (const input of ['[]', 'null', '{"Places":"100"}', '{"":1}', 'oops']) {
    assert.throws(() => core.parseOverrides(input));
  }
});

test('explicit search modes, bookmark keywords and empty queries retain native behavior', () => {
  for (const context of [
    { searchString: '' }, { searchString: '@google q' }, { searchString: '% q' },
    { searchString: 'q', searchMode: { engineName: 'Google' } },
    { searchString: 'needle %', restrictToken: { value: '%' } },
    { searchString: 'q', restrictSource: 1 },
    { searchString: 'keyword q', results: [result('keyword', { type: 4 })] },
    { searchString: 'q', results: [result('mode', { payload: { providesSearchMode: true } })] },
    { searchString: '> new', results: [result('command', { payload: { zenAction: true } })] },
  ]) assert.equal(core.shouldSort({ results: [], ...context }, types), false);
  assert.equal(core.shouldSort({ searchString: 'github', results: [] }, types), true);
});

test('ordinary Zen action suggestions do not suppress tab/provider priority', () => {
  const action = result('new-space', { type: 8, source: 9, payload: { zenAction: true } });
  const pin = result('new-api', { type: 1 });
  for (const heuristic of [false, true]) {
    action.heuristic = heuristic;
    const context = { searchString: 'new', results: [action, pin] };
    assert.equal(core.shouldSort(context, types), true);
    assert.equal(core.rank(context.results, config, types, sources, () => true)[0], pin);
  }
});

test('final cap honors multi-row results and continues after a result that cannot fit', () => {
  const items = [result('tab'), result('large', { resultSpan: 3 }), result('history')];
  assert.deepEqual(core.takeWithinSpan(items, 2, r => r.resultSpan || 1).map(r => r.id), ['tab', 'history']);
});
