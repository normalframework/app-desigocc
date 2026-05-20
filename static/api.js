// Plugin-side helpers exposed on window.NF.
// Loaded as a plain <script> from index.html (NOT a module) because
// vue3-sfc-loader can't import ES modules from inside a .vue file.

(function () {
  const NF = {};

  // App id is provided by the host (?applicationId=...) or by the
  // static-serve URL (/api/v1/apps/static/<appId>/...). NEVER hardcoded.
  NF.getAppId = function () {
    const qp = new URLSearchParams(window.location.search);
    const fromQuery = qp.get("applicationId") || qp.get("app_id");
    if (fromQuery) return fromQuery;
    const m = /\/api\/v1\/apps\/static\/([^/?]+)/.exec(window.location.pathname);
    if (m) return m[1];
    const hp = window.location.hash
      ? new URLSearchParams(window.location.hash.slice(1))
      : null;
    const fromHash = hp && (hp.get("applicationId") || hp.get("app_id"));
    if (fromHash) return fromHash;
    throw new Error(
      "Cannot derive app id from window.location: pathname='" +
        window.location.pathname +
        "', search='" +
        window.location.search +
        "'"
    );
  };

  NF.getAuthToken = function () {
    const qp = new URLSearchParams(window.location.search);
    let t = qp.get("token") || qp.get("auth_token");
    if (!t && window.location.hash) {
      const hp = new URLSearchParams(window.location.hash.slice(1));
      t = hp.get("token") || hp.get("auth_token");
    }
    return t;
  };

  function authHeaders(extra) {
    const h = Object.assign(
      { "Content-Type": "application/json", Accept: "application/json" },
      extra || {}
    );
    const t = NF.getAuthToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  async function jfetch(url, options) {
    const resp = await fetch(url, options);
    if (resp.status === 401 || resp.status === 403) {
      window.location.reload();
      throw new Error("auth failed; reloading");
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        "HTTP " + resp.status + " " + resp.statusText + ": " + body.slice(0, 200)
      );
    }
    return resp.json();
  }

  // hookName -> hookId cache.
  let _hookIdsByName = null;
  NF.getHookIds = async function (appId) {
    if (_hookIdsByName) return _hookIdsByName;
    const data = await jfetch(window.location.origin + "/api/v1/apps", {
      headers: authHeaders(),
    });
    const app = (data.applications || []).find((a) => a.id === appId);
    if (!app) throw new Error("App '" + appId + "' not found in /api/v1/apps");
    const map = {};
    for (const h of app.hooks || []) map[h.name] = h.id;
    _hookIdsByName = map;
    return map;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Invoke an on-request hook by name, wait for terminal state, return
  // the parsed JSON in HookResult.returnValue.
  NF.invokeHook = async function (hookName, args, opts) {
    args = args || {};
    opts = opts || {};
    const appId = NF.getAppId();
    const ids = await NF.getHookIds(appId);
    const hookId = ids[hookName];
    if (!hookId)
      throw new Error("Hook '" + hookName + "' not found on app '" + appId + "'");

    const flatArgs = {};
    for (const k of Object.keys(args)) {
      const v = args[k];
      flatArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
    }

    const start = await jfetch(
      window.location.origin +
        "/api/v1/apps/" +
        encodeURIComponent(appId) +
        "/hooks/" +
        encodeURIComponent(hookId),
      { method: "POST", headers: authHeaders(), body: JSON.stringify(flatArgs) }
    );
    const pid = start.pid;
    if (!pid)
      throw new Error("StartHook returned no pid: " + JSON.stringify(start));

    const deadline = Date.now() + (opts.timeoutMs || 30000);
    const pollMs = opts.pollMs || 400;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const data = await jfetch(
        window.location.origin +
          "/api/v1/apps/" +
          encodeURIComponent(appId) +
          "/hooks/" +
          encodeURIComponent(hookId) +
          "/results?page_size=10",
        { headers: authHeaders() }
      );
      const r = (data.results || []).find((x) => x.pid === pid);
      if (!r) continue;
      if (r.state === "STATE_ENQUEUED" || r.state === "STATE_RUNNING") continue;
      if (r.state === "STATE_SUCCESS") {
        try {
          return JSON.parse(r.returnValue || "{}");
        } catch (e) {
          throw new Error("Hook returned non-JSON: " + r.returnValue);
        }
      }
      const msg =
        (r.error && r.error.message) ||
        (r.events && r.events[0] && r.events[0].message) ||
        r.state;
      throw new Error(
        "Hook '" + hookName + "' failed (" + r.state + "): " + msg
      );
    }
    throw new Error(
      "Hook '" + hookName + "' timed out after " + (opts.timeoutMs || 30000) + "ms"
    );
  };

  // Streaming variant: polls /results and surfaces the running event log
  // to onEvent(events) so a UI can show live progress. events[] is in
  // reverse chronological order (most recent first). Resolves with the
  // parsed returnValue when terminal, throws on error or timeout.
  NF.invokeHookStreaming = async function (hookName, args, onEvent, opts) {
    args = args || {};
    opts = opts || {};
    const appId = NF.getAppId();
    const ids = await NF.getHookIds(appId);
    const hookId = ids[hookName];
    if (!hookId) throw new Error("Hook '" + hookName + "' not found on app '" + appId + "'");
    const flatArgs = {};
    for (const k of Object.keys(args)) {
      const v = args[k];
      flatArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    const start = await jfetch(
      window.location.origin + "/api/v1/apps/" + encodeURIComponent(appId) +
        "/hooks/" + encodeURIComponent(hookId),
      { method: "POST", headers: authHeaders(), body: JSON.stringify(flatArgs) }
    );
    const pid = start.pid;
    if (!pid) throw new Error("StartHook returned no pid: " + JSON.stringify(start));
    const deadline = Date.now() + (opts.timeoutMs || 4 * 60 * 60 * 1000);
    const pollMs = opts.pollMs || 1500;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const data = await jfetch(
        window.location.origin + "/api/v1/apps/" + encodeURIComponent(appId) +
          "/hooks/" + encodeURIComponent(hookId) + "/results?page_size=10",
        { headers: authHeaders() }
      );
      const r = (data.results || []).find((x) => x.pid === pid);
      if (!r) continue;
      if (onEvent && r.events) {
        try { onEvent(r.events, r.state); } catch (_) {}
      }
      if (r.state === "STATE_ENQUEUED" || r.state === "STATE_RUNNING") continue;
      if (r.state === "STATE_SUCCESS") {
        try { return JSON.parse(r.returnValue || "{}"); }
        catch (e) { throw new Error("Hook returned non-JSON: " + r.returnValue); }
      }
      const msg = (r.error && r.error.message) || (r.events && r.events[0] && r.events[0].message) || r.state;
      throw new Error("Hook '" + hookName + "' failed (" + r.state + "): " + msg);
    }
    throw new Error("Hook '" + hookName + "' timed out after " + (opts.timeoutMs || 4 * 60 * 60 * 1000) + "ms");
  };

  NF.discover = {
    loadConfig: () => NF.invokeHook("discover", { action: "load_config" }),
    // saveConfig accepts a partial — pass only the fields you want to update.
    // selectedViews / selectedDisciplines / selectedNodes are all optional.
    saveConfig: (partial) =>
      NF.invokeHook("discover", Object.assign({ action: "save_config" }, partial || {})),
    listViews: (systemId) =>
      NF.invokeHook(
        "discover",
        systemId
          ? { action: "list_views", systemId: String(systemId) }
          : { action: "list_views" }
      ),
    listDisciplines: () =>
      NF.invokeHook("discover", { action: "list_disciplines" }),
    listObjectTypes: () =>
      NF.invokeHook("discover", { action: "list_object_types" }),
    listChildren: (systemId, viewId, designation) =>
      NF.invokeHook("discover", {
        action: "list_children",
        systemId: String(systemId),
        viewId: String(viewId),
        designation: designation,
      }, { timeoutMs: 45000 }),
    listNodeProperties: (objectId, managedTypeName) =>
      NF.invokeHook("discover", {
        action: "list_node_properties",
        objectId,
        managedTypeName: managedTypeName || "",
      }, { timeoutMs: 30000 }),
    downloadProgram: (objectId) =>
      NF.invokeHook("discover", { action: "download_program", objectId }, { timeoutMs: 60000 }),
    hasGraphic: (objectId) =>
      NF.invokeHook("discover", { action: "has_graphic", objectId }, { timeoutMs: 15000 }),
    listGraphics: (designation) =>
      NF.invokeHook("discover", { action: "list_graphics", designation }, { timeoutMs: 20000 }),
    getGraphic: (objectId) =>
      NF.invokeHook("discover", { action: "get_graphic", objectId }, { timeoutMs: 60000 }),
    resetCache: () => NF.invokeHook("discover", { action: "reset_cache" }),
  };

  // Selective import. selectedNodes / selectedDisciplines / selectedObjectTypes
  // are optional — when omitted the hook reads them from state/config.json.
  // onProgress(events, state) receives the live hook event log as the
  // import runs; pass null to ignore.
  NF.importSelected = (opts, onProgress) =>
    NF.invokeHookStreaming(
      "import-selected",
      Object.assign({}, opts || {}),
      onProgress || null,
      // Big trees take a long time; cap at 4 hours.
      { timeoutMs: 4 * 60 * 60 * 1000, pollMs: 1500 }
    );

  window.NF = NF;
})();
