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

test('navigation query parameter names do not match ordinary tab queries', () => {
  assert.equal(core.matchesTab('https://google.com/search?newwindow=1&q=unrelated', 'Unrelated - Google Search', 'new'), false);
  assert.equal(core.matchesTab('https://newapi.example/', 'Dashboard', 'new'), true);
  assert.equal(core.matchesTab('https://example.com/%E6%96%B0', 'Dashboard', '新'), true);
  assert.equal(core.matchesTab('https://google.com/search?newwindow=1', 'Google', 'newwindow=1'), true);
});

test('a full tab list keeps a search slot while preserving the highest-priority result', () => {
  const tabs = [result('pin'), result('tab1'), result('tab2')];
  const search = result('search', {type:2});
  assert.deepEqual(core.takeWithinSpan([...tabs, search], 3, () => 1, search).map(r => r.id), ['pin','tab1','search']);
  assert.deepEqual(core.takeWithinSpan([...tabs, search], 1, () => 1, search).map(r => r.id), ['pin']);
  assert.deepEqual(core.takeWithinSpan([search, ...tabs], 3, () => 1, search).map(r => r.id), ['search','pin','tab1']);
});

test('force-search modifier follows platform and leaves composition and other combinations alone', () => {
  const event = {key:'Enter', metaKey:true};
  assert.equal(core.isForceSearchKey(event, 'macosx'), true);
  assert.equal(core.isForceSearchKey({key:'Enter',ctrlKey:true}, 'linux'), true);
  assert.equal(core.isForceSearchKey({key:'Enter',ctrlKey:true}, 'macosx'), false);
  for (const extra of [{shiftKey:true},{altKey:true},{isComposing:true},{ctrlKey:true}])
    assert.equal(core.isForceSearchKey({...event,...extra}, 'macosx'), false);
});

test('force search uses typed text instead of completion or selected-tab URL', () => {
  assert.equal(core.searchText('https://newapi.example/', 'new', 'new', true), 'new');
  assert.equal(core.searchText('fresh', 'fresh', 'old'), 'fresh');
  assert.equal(core.searchText('other', 'old', 'other', true), 'other');
  assert.equal(core.searchText('', 'old', 'old'), '');
  assert.equal(core.searchText('https://example.com/', null, ''), 'https://example.com/');
});


test('finished queries cannot replace current URL and search actions stay distinct', () => {
  assert.equal(core.searchText('https://another.example/', 'new', 'new', false), 'https://another.example/');
  assert.equal(core.matchesTab('https://example.com/?q=x#anchor', '', 'https://example.com/?q=x#anchor'), true);
  assert.equal(core.matchesTab('about:config', '', 'about:config'), true);
  assert.equal(core.isPlainSearch(result('search', {type:2,payload:{query:'new'}}), types), true);
  assert.equal(core.isPlainSearch(result('private', {type:2,payload:{query:'new',inPrivateWindow:true}}), types), false);
});
