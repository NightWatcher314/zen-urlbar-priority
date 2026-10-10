// SPDX-License-Identifier: MIT
/* Sine window script. No network requests or browser profile writes. */

  const PREFIX = "mod.urlbar-priority.";
  const DEFAULTS = Object.freeze({
    pinnedTabs: 120, openTabs: 100, bookmarks: 60, history: 50,
    searchSuggestions: 20, heuristic: 0, other: 10,
  });
  const normalizeProvider = name => (name || "").replace(/^UrlbarProvider/, "");

  function parseOverrides(text) {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Provider 权重必须是 JSON 对象。");
    }
    const overrides = new Map();
    for (const [name, weight] of Object.entries(value)) {
      if (!name.trim() || typeof weight !== "number" || !Number.isFinite(weight)) {
        throw new Error("Provider 名称不能为空，权重必须是有限数字。");
      }
      overrides.set(normalizeProvider(name), weight);
    }
    return overrides;
  }

  function category(result, types, sources, isPinned) {
    if (result.type === types.TAB_SWITCH) {
      return isPinned(result) ? "pinnedTabs" : "openTabs";
    }
    if (result.heuristic) return "heuristic";
    if (result.source === sources.BOOKMARKS) return "bookmarks";
    if (result.source === sources.HISTORY) return "history";
    if (result.type === types.SEARCH && result.payload?.suggestion) {
      return "searchSuggestions";
    }
    return "other";
  }

  function rank(results, config, types, sources, isPinned) {
    return results.map((result, index) => {
      const provider = normalizeProvider(result.providerName);
      const group = category(result, types, sources, isPinned);
      return { result, index, weight: config.overrides.get(provider) ?? config.weights[group] };
    }).sort((a, b) => b.weight - a.weight || a.index - b.index).map(item => item.result);
  }

  function shouldSort(context, types, sources = {}) {
    const text = context.searchString?.trim();
    // Respect explicit engine/restriction mode, bookmark keywords and Zen commands.
    return Boolean(text && !context.searchMode && !context.restrictToken &&
      context.restrictSource == null && !/^[@%*^+#?>]/.test(text) &&
      !context.results.some(r => r.type === types.KEYWORD ||
        r.payload?.providesSearchMode || r.payload?.zenAction || r.payload?.isZenAction ||
        (r.heuristic && sources.ZEN_ACTIONS !== undefined && r.source === sources.ZEN_ACTIONS)));
  }

  function takeWithinSpan(results, max, span) {
    const selected = [];
    let used = 0;
    for (const result of results) {
      const size = span(result);
      if (used + size > max) continue;
      selected.push(result);
      used += size;
    }
    return selected;
  }

export const core = { DEFAULTS, parseOverrides, category, rank, shouldSort, takeWithinSpan };

export function attach(win) {
  if (win.location.href !== "chrome://browser/content/browser.xhtml") return;
  win.ZenUrlbarPriority?.destroy();

  function importUrlbar(name) {
    try {
      return ChromeUtils.importESModule(`moz-src:///browser/components/urlbar/${name}.sys.mjs`);
    } catch {
      return ChromeUtils.importESModule(`resource:///modules/${name}.sys.mjs`);
    }
  }

  try {
    const managerModule = importUrlbar("UrlbarProvidersManager");
    const manager = managerModule.ProvidersManager?.getInstanceForSap("urlbar") ??
      managerModule.UrlbarProvidersManager;
    const { UrlbarUtils, UrlbarProvider } = importUrlbar("UrlbarUtils");
    let enums = UrlbarUtils;
    try {
      enums = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs").UrlbarShared;
    } catch { /* Firefox versions before the UrlbarShared split. */ }
    let Result;
    try {
      Result = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarResult.mjs").UrlbarResult;
    } catch {
      Result = importUrlbar("UrlbarResult").UrlbarResult;
    }
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
    const muxer = manager?.muxers?.get("UnifiedComplete");
    if (!muxer || typeof muxer.sort !== "function") {
      throw new Error("当前浏览器没有可用的 UnifiedComplete 地址栏排序接口。");
    }

    function readConfig() {
      const weights = {};
      for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const value = Services.prefs.getPrefType(PREFIX + key);
        const raw = value === Services.prefs.PREF_INT
          ? Services.prefs.getIntPref(PREFIX + key)
          : value === Services.prefs.PREF_STRING
            ? Number(Services.prefs.getStringPref(PREFIX + key)) : fallback;
        weights[key] = Number.isFinite(raw) ? raw : fallback;
      }
      const overrides = parseOverrides(Services.prefs.getStringPref(PREFIX + "providers", "{}"));
      return { weights, overrides, enabled: Services.prefs.getBoolPref(PREFIX + "enabled", true) };
    }

    function pinnedKeys(context) {
      const keys = new Set();
      for (const browserWin of Services.wm.getEnumerator("navigator:browser")) {
        if (PrivateBrowsingUtils.isWindowPrivate(browserWin) !== Boolean(context.isPrivate)) continue;
        for (const tab of browserWin.gBrowser?.tabs || []) {
          if (!tab.pinned && !tab.hasAttribute("zen-essential")) continue;
          const container = context.isPrivate ? "private" : Number(tab.getAttribute("usercontextid") || 0);
          keys.add(`${container}\n${tab.linkedBrowser.currentURI.spec}`);
        }
      }
      return keys;
    }

    function cloneHeuristic(result, heuristic) {
      if (typeof result.toWire === "function" && typeof Result.fromWire === "function") {
        return Result.fromWire({ ...result.toWire(), heuristic });
      }
      // Legacy Firefox result classes have a positional constructor and writable flags.
      const copy = new Result(result.type, result.source, { ...result.payload }, result.payloadHighlights);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(result))) {
        Object.defineProperty(copy, key, descriptor);
      }
      Object.defineProperty(copy, "heuristic", { value: heuristic, writable: true, configurable: true });
      return copy;
    }

    // One shared hook per browser process; every Sine window owns a reference.
    const KEY = Symbol.for("NightWatcher.URLBarPriority");
    let state = muxer[KEY];
    if (!state) {
      const original = muxer.sort;
      state = { owners: new Set(), original, error: null, config: null };
      state.reload = () => {
        try { state.config = readConfig(); state.error = null; }
        catch (error) { state.config = { enabled: false }; state.error = error.message; }
      };
      state.reload();
      state.observer = { observe: state.reload };
      Services.prefs.addObserver(PREFIX, state.observer);
      // Native Places/Zen Sidebar can cap their candidates before the muxer sees
      // them. Query live tabs separately so older pins are not lost to that cap.
      state.tabProvider = new class UrlbarProviderPriorityTabs extends UrlbarProvider {
        get name() { return "UrlbarProviderPriorityTabs"; }
        get type() { return enums.PROVIDER_TYPE.PROFILE; }
        async isActive(context) {
          return state.config.enabled &&
            Services.prefs.getBoolPref("browser.urlbar.suggest.openpage", true) &&
            context.sources.includes(enums.RESULT_SOURCE.TABS) &&
            shouldSort({ ...context, results: [] }, enums.RESULT_TYPE, enums.RESULT_SOURCE);
        }
        async startQuery(context, addCallback, controller) {
          // The originating controller owns the window. Focus can change while
          // providers run, so never infer ownership from the most recent window.
          const browserWin = controller?.browserWindow || controller?.input?.window || context.window;
          if (!browserWin?.gBrowser || PrivateBrowsingUtils.isWindowPrivate(browserWin) !== Boolean(context.isPrivate)) return;
          const tokens = context.searchString.toLowerCase().trim().split(/\s+/);
          const space = browserWin.gZenWorkspaces?.activeWorkspace;
          const candidates = [];
          for (const tab of browserWin.gBrowser.tabs) {
            if (tab === browserWin.gBrowser.selectedTab || tab.hidden || tab.closing) continue;
            const tabSpace = tab.getAttribute("zen-workspace-id");
            if (space && tabSpace && tabSpace !== space && !tab.hasAttribute("zen-essential")) continue;
            const url = tab.linkedBrowser.currentURI.spec;
            if (!url || url === "about:blank") continue;
            const title = tab.label || url;
            const text = `${url}\n${title}`.toLowerCase();
            if (!tokens.every(token => text.includes(token))) continue;
            const container = context.isPrivate ? (enums.PRIVATE_USER_CONTEXT_ID ?? -1) :
              Number(tab.getAttribute("usercontextid") || 0);
            const payload = { url, title, icon: tab.image || `page-icon:${url}` };
            let result;
            if (typeof Result.fromWire === "function") {
              payload.userContext = UrlbarUtils.getUserContextData(container);
              result = new Result({ type: enums.RESULT_TYPE.TAB_SWITCH,
                source: enums.RESULT_SOURCE.TABS, payload, providerName: this.name });
            } else {
              payload.userContextId = container;
              result = new Result(enums.RESULT_TYPE.TAB_SWITCH, enums.RESULT_SOURCE.TABS, payload, {});
              result.providerName = this.name;
            }
            candidates.push(result);
          }
          const keys = pinnedKeys(context);
          const isPinned = result => keys.has(`${context.isPrivate ? "private" :
            result.payload.userContextId ?? result.payload.userContext?.id ?? 0}\n${result.payload.url}`);
          for (const result of rank(candidates, state.config, enums.RESULT_TYPE, enums.RESULT_SOURCE, isPinned)
            .slice(0, context.maxResults)) addCallback(this, result);
        }
      }();
      manager.registerProvider(state.tabProvider);
      state.wrapper = function (context, unsortedResults) {
        const config = state.config;
        if (!config.enabled) return original.call(this, context, unsortedResults);
        const max = context.maxResults;
        const span = result => Math.max(1, result.resultSpan || 1);
        // Let native filtering/deduplication run before our final limit; a low-ranked
        // group must not evict the matching open tab before we can rank it.
        const incoming = unsortedResults || context.results;
        context.maxResults = Math.max(max, incoming.reduce((sum, r) => sum + span(r), 0));
        let returnValue;
        try { returnValue = original.call(this, context, unsortedResults); }
        finally { context.maxResults = max; }
        if (!shouldSort(context, enums.RESULT_TYPE, enums.RESULT_SOURCE)) {
          // Run again with the native limit, preserving special queries exactly.
          return original.call(this, context, unsortedResults);
        }
        try {
          const keys = pinnedKeys(context);
          const isPinned = result => keys.has(`${context.isPrivate ? "private" :
            result.payload.userContextId ?? result.payload.userContext?.id ?? 0}\n${result.payload.url}`);
          let results = rank(context.results, config, enums.RESULT_TYPE, enums.RESULT_SOURCE, isPinned);
          const first = results[0];
          const safeTypes = [enums.RESULT_TYPE.URL, enums.RESULT_TYPE.TAB_SWITCH, enums.RESULT_TYPE.SEARCH];
          // Native view/input expects the default result to be heuristic. Clone only
          // changed flags; never mutate provider-owned results shared across updates.
          if (first && !first.heuristic && safeTypes.includes(first.type)) {
            results = results.map((r, i) => (i === 0 || r.heuristic) ? cloneHeuristic(r, i === 0) : r);
          } else if (first && !first.heuristic) {
            const heuristicIndex = results.findIndex(r => r.heuristic);
            if (heuristicIndex > 0) results.unshift(results.splice(heuristicIndex, 1)[0]);
          }
          context.results = takeWithinSpan(results, max, span);
          context.heuristicResult = context.results.find(r => r.heuristic) || null;
        } catch (error) {
          state.error = error.message;
          console.error("[URL Bar Priority] Using native results:", error);
          return original.call(this, context, unsortedResults);
        }
        return returnValue;
      };
      muxer.sort = state.wrapper;
      muxer[KEY] = state;
    }
    state.owners.add(win);
    const input = win.gURLBar;
    const originalPick = input.pickResult;
    const pickWrapper = function (...args) {
      // Firefox 157 can make TAB_SWITCH rows navigate by default and expose a
      // separate switch button. Use that native button action for our normal pick;
      // keep explicit menu/button actions and modifier-based navigation intact.
      const modern = args[0]?.result;
      const result = modern ? args[0].result : args[0];
      const elementIndex = modern ? null : 2;
      const element = modern ? args[0].element : args[elementIndex];
      if (!state.config.enabled || !this.view.queryContext ||
          !shouldSort(this.view.queryContext, enums.RESULT_TYPE, enums.RESULT_SOURCE) ||
          result?.type !== enums.RESULT_TYPE.TAB_SWITCH ||
          !Services.prefs.getBoolPref("browser.urlbar.secondaryActions.switchToTab", false) ||
          this.hasAttribute("action-override") || element?.dataset?.action || element?.dataset?.command) {
        return originalPick.apply(this, args);
      }
      const target = element || this.view.selectedElement;
      if (!target?.dataset) return originalPick.apply(this, args);
      const previous = target.dataset.action;
      target.dataset.action = "tabswitch";
      if (modern) args[0] = { ...args[0], element: target };
      else args[elementIndex] = target;
      try { return originalPick.apply(this, args); }
      finally {
        if (previous === undefined) delete target.dataset.action;
        else target.dataset.action = previous;
      }
    };
    input.pickResult = pickWrapper;
    const api = {
      status() {
        return { active: muxer.sort === state.wrapper && state.config.enabled,
          error: state.error, owners: state.owners.size };
      },
      providers() { return manager.providers.map(p => p.name).sort(); },
      results() {
        return (win.gURLBar.view.queryContext?.results || []).map(r => ({
          provider: r.providerName, type: r.type, source: r.source, heuristic: r.heuristic,
        }));
      },
      destroy() {
        if (win.ZenUrlbarPriority !== api) return;
        if (input.pickResult === pickWrapper) input.pickResult = originalPick;
        state.owners.delete(win);
        if (!state.owners.size) {
          // A later mod may have wrapped our hook. Leave that chain harmless
          // rather than overwriting its wrapper during our uninstall.
          state.config = { enabled: false };
          if (muxer.sort === state.wrapper) muxer.sort = state.original;
          Services.prefs.removeObserver(PREFIX, state.observer);
          manager.unregisterProvider(state.tabProvider);
          delete muxer[KEY];
        }
        win.removeEventListener("unload", api.destroy);
        delete win.ZenUrlbarPriority;
      },
    };
    win.ZenUrlbarPriority = api;
    win.addEventListener("unload", api.destroy, { once: true });
    return api;
  } catch (error) {
    console.error("[URL Bar Priority] Initialization failed:", error);
  }
}
