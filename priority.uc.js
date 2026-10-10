// SPDX-License-Identifier: MIT
// Sine window entrypoint; process logic lives in a system module so it survives
// closing the first window that loaded the mod.
(function () {
  if (window.location.href !== "chrome://browser/content/browser.xhtml") return;
  const uri = Services.io.newURI(Components.stack.filename.split("?")[0]);
  const moduleURI = Services.io.newURI("priority.sys.mjs", null, uri).spec;
  const api = ChromeUtils.importESModule(moduleURI).attach(window);
  if (api && typeof window.addUnloadListener === "function") {
    window.addUnloadListener(() => api.destroy());
  }
})();
