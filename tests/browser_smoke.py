"""Run native chrome/address-bar checks in an isolated disposable profile.

uv run --no-project --with marionette-driver python tests/browser_smoke.py /path/to/zen
The script is loaded through Gecko's scriptloader, as Sine loads .uc.js files.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

from marionette_driver.marionette import Marionette
from marionette_driver.keys import Keys


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"<!doctype html><title>{self.path}</title><h1>Local mod test</h1>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else "/usr/bin/firefox"
    script = Path(__file__).resolve().parents[1] / "priority.uc.js"
    sine_source = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    report = {"checks": []}
    m = None
    with tempfile.TemporaryDirectory(prefix="urlbar-priority-test-") as tmp:
        profile = Path(tmp)
        if sine_source:
            sys.path.insert(0, str(script.parent))
            from install import install
            mods_dir = profile / 'chrome/sine-mods'
            mods_dir.mkdir(parents=True)
            (mods_dir / 'mods.json').write_text('{}')
            install(profile, script.parent, apply=True, backup_root=profile / 'installer-backups')
            manifest_dir = profile / 'test-manifest'
            manifest_dir.mkdir()
            (manifest_dir / 'chrome.manifest').write_text(
                f"content userscripts {(sine_source / 'src').as_uri()}/\n"
                f"content sine {mods_dir.as_uri()}/\n")
        (profile / "user.js").write_text('\n'.join([
            'user_pref("marionette.port", 2839);',
            'user_pref("browser.shell.checkDefaultBrowser", false);',
            'user_pref("browser.startup.homepage_override.mstone", "ignore");',
            'user_pref("browser.startup.page", 0);',
            'user_pref("browser.urlbar.suggest.searches", false);',
            'user_pref("browser.urlbar.suggest.quickactions", false);',
            'user_pref("browser.urlbar.secondaryActions.switchToTab", false);',
            'user_pref("browser.urlbar.maxRichResults", 3);',
            'user_pref("zen.welcome-screen.seen", true);',
            'user_pref("zen.welcome-screen.enabled", false);',
            'user_pref("zen.workspaces.show-workspace-indicator", false);',
        ]))
        with (profile / "browser.log").open("w") as log:
            process = subprocess.Popen([binary, "--headless", "--no-remote",
                "--remote-allow-system-access", "--marionette", "--profile", str(profile)],
                stdout=log, stderr=log, env={**os.environ, "MOZ_CRASHREPORTER_DISABLE": "1"})
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError((profile / "browser.log").read_text())
                    try:
                        m = Marionette(host="127.0.0.1", port=2839)
                        m.start_session()
                        break
                    except Exception:
                        time.sleep(0.2)
                else:
                    raise RuntimeError("Marionette did not start")
                m.set_context("chrome")
                report["version"] = m.execute_script("return Services.appinfo.version;")
                report["name"] = m.execute_script("return Services.appinfo.name;")
                m.execute_script('''
                    Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler)
                      .setSubstitution('urlbar-priority-test', Services.io.newURI(arguments[0]));
                ''', script_args=[script.parent.as_uri() + '/'])
                if sine_source:
                    sine_result = m.execute_async_script('''
                        const done = arguments[arguments.length - 1];
                        const manifestPath = arguments[0], prefs = JSON.parse(arguments[1]);
                        (async () => {
                            const directory = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
                            directory.initWithPath(manifestPath);
                            directory.append('chrome.manifest');
                            Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(directory);
                            const utils = ChromeUtils.importESModule('chrome://userscripts/content/core/utils.sys.mjs').default;
                            const blocked = await utils.getScripts({onlyEnabled:true, href:window.location.href});
                            Services.prefs.setBoolPref('sine.allow-unsafe-js', true);
                            const scripts = await utils.getScripts({onlyEnabled:true, href:window.location.href});
                            for (const path of Object.keys(scripts))
                                Services.scriptloader.loadSubScript('chrome://sine/content/' + path, window);
                            const preferences = ChromeUtils.importESModule('chrome://userscripts/content/core/preferences.sys.mjs');
                            const box = document.createXULElement('vbox');
                            for (const pref of prefs) box.append(preferences.parsePref(pref, {rebuildMods() {}}, window));
                            document.documentElement.append(box);
                            const input = box.querySelector('#mod-urlbar-priority-pinnedTabs input');
                            input.value = '150';
                            input.dispatchEvent(new Event('change'));
                            const weight = Services.prefs.getIntPref('mod.urlbar-priority.pinnedTabs');
                            input.value = '120';
                            input.dispatchEvent(new Event('change'));
                            box.remove();
                            done({blocked:Object.keys(blocked).length, scripts:Object.keys(scripts).length,
                              weight, prefs:prefs.length});
                        })().catch(error => done({error:error.message, stack:error.stack}));
                    ''', script_args=[str(manifest_dir), (script.parent / 'preferences.json').read_text()])
                    assert sine_result.get('blocked') == 0 and sine_result.get('scripts') == 1, sine_result
                    assert sine_result.get('weight') == 150, sine_result
                    report['checks'].append('local installer registry passes real Sine JS gate and preferences parser')
                else:
                    m.execute_script("Services.scriptloader.loadSubScript('resource://urlbar-priority-test/priority.uc.js', window);")
                status = m.execute_script("return window.ZenUrlbarPriority?.status() || null;")
                assert status and status["active"], status
                report["checks"].append("scriptloader initializes native muxer hook")

                m.execute_script('''
                    window.__priorityTest = {};
                    const pin = gBrowser.addTrustedTab(arguments[0] + '/pinned-needle');
                    gBrowser.pinTab(pin);
                    window.__priorityTest.pin = pin;
                    for (let i = 0; i < 12; i++) {
                        const tab = gBrowser.addTrustedTab(arguments[0] + '/ordinary-needle-' + i);
                        window.__priorityTest['ordinary' + i] = tab;
                    }
                    gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1];
                ''', script_args=[base])
                time.sleep(2)

                def query(text):
                    m.execute_script("gURLBar.focus(); gURLBar.search(arguments[0]);", script_args=[text])
                    last = None
                    stable = 0
                    for _ in range(50):
                        current = m.execute_script('''
                          return {status:ZenUrlbarPriority.status(),
                            query:gURLBar.view.queryContext?.searchString,
                            results:(gURLBar.view.queryContext?.results || []).map(r => ({
                              type:r.type, url:r.payload.url, provider:r.providerName, heuristic:r.heuristic
                            })), selected:gURLBar.view.selectedResult?.payload.url,
                            value:gURLBar.value};
                        ''')
                        if current == last and current["results"] and current["query"] == text:
                            stable += 1
                            if stable >= 3:
                                return current
                        else:
                            stable = 0
                        last = current
                        time.sleep(.1)
                    raise RuntimeError(f"No stable results: {last}")

                m.execute_script("BrowserCommands.openTab();")
                if report["name"] == "Zen":
                    assert m.execute_script("return gURLBar.hasAttribute('zen-newtab');")
                    report["checks"].append("native Command/Ctrl+T command opens Zen floating new-tab URL bar")
                current = query("needle")
                assert current["status"]["error"] is None, current
                assert current["results"][0]["url"] == base + "/pinned-needle", current
                assert current["selected"] == base + "/pinned-needle", current
                assert len(current["results"]) <= 3, current
                assert current["value"] == "needle", current
                report["checks"].append("oldest pinned tab wins beyond provider and muxer caps; selected without rewriting input")
                count = m.execute_script("return gBrowser.tabs.length;")
                field = m.execute_script("return gURLBar.inputField;")
                field.send_keys(Keys.ENTER)
                time.sleep(.7)
                assert m.execute_script("return gBrowser.selectedTab === __priorityTest.pin;"), current
                assert m.execute_script("return gBrowser.tabs.length;") == count
                report["checks"].append("Enter switches to existing pinned tab; no duplicate tab")

                m.execute_script('''
                    Services.prefs.setBoolPref('browser.urlbar.secondaryActions.switchToTab', true);
                    gBrowser.selectedTab = __priorityTest.ordinary0;
                    BrowserCommands.openTab();
                ''')
                current = query("needle")
                count = m.execute_script("return gBrowser.tabs.length;")
                field = m.execute_script("return gURLBar.inputField;")
                field.send_keys(Keys.ENTER)
                time.sleep(.7)
                assert m.execute_script("return gBrowser.selectedTab === __priorityTest.pin;"), current
                assert m.execute_script("return gBrowser.tabs.length;") == count
                report["checks"].append("Enter still switches with native secondaryActions enabled")

                m.execute_script('''
                    Services.prefs.setIntPref('mod.urlbar-priority.openTabs', 200);
                ''')
                current = query("needle")
                assert "/ordinary-needle-" in current["results"][0]["url"], current
                report["checks"].append("weight changes apply without restart")

                provider = current["results"][0]["provider"]
                m.execute_script('''
                    Services.prefs.setStringPref('mod.urlbar-priority.providers', arguments[0]);
                ''', script_args=[json.dumps({provider: -1000})])
                current = query("needle")
                assert current["results"][0]["provider"] != provider, current
                report["checks"].append("actual provider override moves its results below default navigation/search")

                m.execute_script("Services.prefs.setStringPref('mod.urlbar-priority.providers', '{}');")
                restricted = query("needle %")
                assert restricted["results"][0]["heuristic"], restricted
                assert restricted["results"][0]["type"] != 1, restricted
                report["checks"].append("trailing native tab-restriction token retains native heuristic flags")
                m.execute_script('''
                    window.__restrictedOriginalTab = gBrowser.selectedTab;
                    const index = gURLBar.view.queryContext.results.findIndex(r => r.type === 1);
                    if (index < 0) throw new Error('No native restricted tab result');
                    gURLBar.view.selectedRowIndex = index;
                ''')
                field = m.execute_script("return gURLBar.inputField;")
                field.send_keys(Keys.ENTER)
                time.sleep(.4)
                assert m.execute_script("return gBrowser.selectedTab === __restrictedOriginalTab;")
                report["checks"].append("restricted-query Enter retains native secondary-action navigation")

                m.execute_script("Services.prefs.setStringPref('mod.urlbar-priority.providers', '{broken');")
                status = m.execute_script("return ZenUrlbarPriority.status();")
                assert not status["active"] and status["error"], status
                query("needle")
                report["checks"].append("invalid JSON safely falls back to native results")
                m.execute_script("Services.prefs.setStringPref('mod.urlbar-priority.providers', '{}');")
                m.execute_script("Services.scriptloader.loadSubScript('resource://urlbar-priority-test/priority.uc.js', window);")
                status = m.execute_script("return ZenUrlbarPriority.status();")
                assert status["active"] and status["owners"] == 1, status
                report["checks"].append("reload has one shared hook, not stacked wrappers")
                # A second window must share one muxer and survive the first owner's close.
                first_handle = m.current_chrome_window_handle
                m.execute_script("OpenBrowserWindow();")
                for _ in range(50):
                    handles = m.chrome_window_handles
                    if len(handles) > 1:
                        break
                    time.sleep(.1)
                second_handle = next(h for h in handles if h != first_handle)
                m.switch_to_window(second_handle)
                m.set_context("chrome")
                for _ in range(50):
                    if m.execute_script("return gBrowserInit.delayedStartupFinished;"):
                        break
                    time.sleep(.1)
                m.execute_script("Services.scriptloader.loadSubScript('resource://urlbar-priority-test/priority.uc.js', window);")
                status = m.execute_script("return ZenUrlbarPriority.status();")
                assert status["owners"] == 2, status
                origin_check = m.execute_async_script('''
                    const done = arguments[arguments.length - 1];
                    Services.prefs.setIntPref('mod.urlbar-priority.openTabs', 100);
                    const origin = [...Services.wm.getEnumerator('navigator:browser')].find(w => w.__priorityTest);
                    const {ProvidersManager} = ChromeUtils.importESModule('moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs');
                    const provider = ProvidersManager.getInstanceForSap('urlbar').getProvider('UrlbarProviderPriorityTabs');
                    const urls = [];
                    provider.startQuery({searchString:'needle', maxResults:3, isPrivate:false},
                      (_provider, result) => urls.push(result.payload.url), origin.gURLBar.parentController)
                      .then(() => done(urls), error => done({error:error.message}));
                ''')
                assert any('/ordinary-needle-' in url for url in origin_check), origin_check
                report['checks'].append('local tab provider uses originating controller while another window is focused')
                m.switch_to_window(first_handle)
                m.close_chrome_window()
                m.switch_to_window(second_handle)
                m.set_context("chrome")
                status = m.execute_script("return ZenUrlbarPriority.status();")
                assert status["active"] and status["owners"] == 1, status
                current = query("needle")
                assert current["status"]["error"] is None, current
                report["checks"].append("shared hook survives closing its first owner window")

                m.execute_script("Services.prefs.setIntPref('mod.urlbar-priority.openTabs', 100); OpenBrowserWindow({private:true});")
                for _ in range(50):
                    handles = m.chrome_window_handles
                    if len(handles) > 1:
                        break
                    time.sleep(.1)
                private_handle = next(h for h in handles if h != second_handle)
                m.switch_to_window(private_handle)
                m.set_context("chrome")
                for _ in range(50):
                    if m.execute_script("return gBrowserInit.delayedStartupFinished;"):
                        break
                    time.sleep(.1)
                m.execute_script('''
                    Services.scriptloader.loadSubScript('resource://urlbar-priority-test/priority.uc.js', window);
                    window.__privatePin = gBrowser.addTrustedTab(arguments[0] + '/private-pin-secretneedle');
                    gBrowser.pinTab(__privatePin);
                    for(let i = 0; i < 12; i++) gBrowser.addTrustedTab(arguments[0] + '/private-secretneedle-' + i);
                    gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1];
                ''', script_args=[base])
                time.sleep(1)
                current = query('secretneedle')
                assert current['results'][0]['url'] == base + '/private-pin-secretneedle', current
                field = m.execute_script("return gURLBar.inputField;")
                field.send_keys(Keys.ENTER)
                time.sleep(.4)
                assert m.execute_script("return gBrowser.selectedTab === __privatePin;"), current
                m.switch_to_window(second_handle)
                m.set_context('chrome')
                current = query('secretneedle')
                assert not any(r['type'] == 1 for r in current['results']), current
                report['checks'].append('private oldest pin is prioritized and switches; private tabs stay out of normal results')
                m.switch_to_window(private_handle)
                m.close_chrome_window()
                m.switch_to_window(second_handle)
                m.set_context('chrome')
                m.execute_script("ZenUrlbarPriority.destroy();")
                assert m.execute_script("return typeof window.ZenUrlbarPriority;") == "undefined"
                report["checks"].append("unload removes hook and API")
            except Exception:
                log.flush()
                print((profile / "browser.log").read_text()[-8000:], file=sys.stderr)
                raise
            finally:
                if m:
                    try:
                        m.delete_session()
                    except Exception:
                        pass
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                server.shutdown()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
