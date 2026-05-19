// Tree-discovery hook for the Desigo CC plugin.
// Dispatches on args.action:
//   list_views         -> GET /systembrowser
//   list_disciplines   -> GET /tables/disciplines/subgroups (with fallback)
//   list_children      -> GET /systembrowser/{s}/{v}/{designation}
//   load_config        -> read state/config.json
//   save_config        -> write state/config.json
//
// Returns JSON via NormalSdk.InvokeSuccess(JSON.stringify(...)) — the SDK's
// message field maps to HookResult.returnValue on the wire.

const NormalSdk = require("@normalframework/applications-sdk");
const axios = require("axios");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const norisHttpsAgent = new https.Agent({ rejectUnauthorized: false });
let cachedToken = "";
let tokenExpiresAt = 0;

// Nodes whose ManagedTypeName matches these are non-importable (filtered
// at import time too, in import-selected.js). Hide them from the tree so
// the UI only shows things that could actually become a point.
const SKIP_MANAGED_TYPES = new Set([
  "TrendLog",
  "BACnet Notification Class",
  "BACnet Event Enrollment",
  "TextGroup",
]);

async function authenticate(http, config, sdk) {
  const { data } = await http.post(
    `${config.baseUrl}/token`,
    new URLSearchParams({
      grant_type: "password",
      username: config.username,
      password: config.password,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
      httpsAgent: norisHttpsAgent,
    }
  );
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  sdk.logEvent(`auth ok user=${data.user_name} ttl=${data.expires_in}s`);
  return cachedToken;
}

async function getToken(http, config, sdk, force) {
  const REFRESH_BUFFER_MS = 60 * 1000;
  if (!force && cachedToken && tokenExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cachedToken;
  }
  if (cachedToken) {
    if (!force) {
      try {
        await http.delete(`${config.baseUrl}/token`, {
          headers: { authorization: `Bearer ${cachedToken}` },
          timeout: 8000,
          httpsAgent: norisHttpsAgent,
        });
      } catch (_) {}
    }
    cachedToken = "";
  }
  return await authenticate(http, config, sdk);
}

async function withFreshToken(http, config, sdk, fn) {
  let token = await getToken(http, config, sdk, false);
  try {
    return await fn(token);
  } catch (e) {
    if (e.response && e.response.status === 401) {
      sdk.logEvent("got 401; re-auth and retry");
      token = await getToken(http, config, sdk, true);
      return await fn(token);
    }
    throw e;
  }
}

const STATE_DIR = path.join(__dirname, "..", "state");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const CACHE_DIR = path.join(STATE_DIR, "cache");
const DEFAULT_CONFIG = { selectedViews: [], selectedDisciplines: [], selectedObjectTypes: [], selectedNodes: [] };

// Local cache for WSI discovery results. Entries are read/written as
// {ts, data} JSON files under state/cache/. No automatic expiry — only
// invalidated by the reset_cache action or by the caller passing
// forceRefresh:"true".
function cacheKeyHex(parts) {
  return crypto.createHash("sha1").update(parts.join("\0")).digest("hex");
}
async function readCache(relPath) {
  try {
    const buf = await fs.readFile(path.join(CACHE_DIR, relPath), "utf-8");
    return JSON.parse(buf);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function writeCache(relPath, data) {
  const full = path.join(CACHE_DIR, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const entry = { ts: new Date().toISOString(), data };
  await fs.writeFile(full, JSON.stringify(entry), "utf-8");
  return entry;
}
async function resetCache() {
  let removed = 0;
  try {
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else { await fs.unlink(p); removed += 1; }
      }
    };
    await walk(CACHE_DIR);
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return removed;
}

async function loadConfig() {
  try {
    const buf = await fs.readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(buf) };
  } catch (e) {
    if (e.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw e;
  }
}
async function saveConfig(next) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const merged = { ...DEFAULT_CONFIG, ...next };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

const FALLBACK_DISCIPLINES = [
  { DisciplineId: 0, DisciplineDescriptor: "Management System" },
  { DisciplineId: 50, DisciplineDescriptor: "Building Automation" },
  { DisciplineId: 100, DisciplineDescriptor: "Fire" },
  { DisciplineId: 200, DisciplineDescriptor: "Security" },
  { DisciplineId: 300, DisciplineDescriptor: "Video" },
  { DisciplineId: 400, DisciplineDescriptor: "Voice Evacuation" },
  { DisciplineId: 500, DisciplineDescriptor: "Power" },
  { DisciplineId: 600, DisciplineDescriptor: "Lighting" },
  { DisciplineId: 700, DisciplineDescriptor: "Shading" },
];

function isValueName(name) {
  return name === "Value" || name === "Present_Value";
}

// Decode one PPCL line record from its hex string. Format:
//   <4-byte header> <01 00 LEN bytes>{3} <trailing flags>
// The third length-prefixed string is the human-readable program line.
function decodePPCLRecord(hexStr) {
  const bytes = new Uint8Array(Math.floor(hexStr.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  let i = 4;
  const parts = [];
  for (let n = 0; n < 3; n++) {
    if (i + 3 > bytes.length) break;
    if (bytes[i] !== 0x01 || bytes[i + 1] !== 0x00) break;
    const len = bytes[i + 2];
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(bytes[i + 3 + j]);
    parts.push(s);
    i += 3 + len;
  }
  return parts[2] || "";
}

async function listDisciplines(http, config, sdk) {
  const candidates = [
    `${config.baseUrl}/tables/disciplines/subgroups`,
    `${config.baseUrl}/tables/disciplines`,
    `${config.baseUrl}/disciplines`,
  ];
  return await withFreshToken(http, config, sdk, async (token) => {
    for (const url of candidates) {
      try {
        const resp = await http.get(url, {
          headers: { authorization: `Bearer ${token}` },
          timeout: 10000,
          httpsAgent: norisHttpsAgent,
        });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          sdk.logEvent(`disciplines via ${url} -> ${resp.data.length}`);
          return { source: url, disciplines: resp.data };
        }
      } catch (e) {
        if (e.response && e.response.status === 401) throw e;
        sdk.logEvent(`disciplines ${url} failed: ${e.response?.status || e.message}`);
      }
    }
    sdk.logEvent(`disciplines: using fallback list (${FALLBACK_DISCIPLINES.length})`);
    return { source: "fallback", disciplines: FALLBACK_DISCIPLINES };
  });
}

async function listViews(http, config, sdk, systemId) {
  const url = systemId
    ? `${config.baseUrl}/systembrowser?systemId=${encodeURIComponent(systemId)}`
    : `${config.baseUrl}/systembrowser`;
  return await withFreshToken(http, config, sdk, async (token) => {
    const resp = await http.get(url, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 15000,
      httpsAgent: norisHttpsAgent,
    });
    sdk.logEvent(`views ${url} -> ${Array.isArray(resp.data) ? resp.data.length : "?"}`);
    return resp.data;
  });
}

// Per PDF §7.6.2: pass the parent Designation as :node. Designations contain
// colons (e.g. "System1.ManagementView:ManagementView") so encodeURIComponent
// is required — the gateway forwards encoded segments through.
async function listChildren(http, config, sdk, systemId, viewId, designation) {
  if (!systemId || !viewId || !designation) {
    throw new Error("list_children requires systemId, viewId, designation");
  }
  const url = `${config.baseUrl}/systembrowser/${encodeURIComponent(systemId)}/${encodeURIComponent(viewId)}/${encodeURIComponent(designation)}`;
  return await withFreshToken(http, config, sdk, async (token) => {
    const resp = await http.get(url, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 20000,
      httpsAgent: norisHttpsAgent,
    });
    const raw = Array.isArray(resp.data)
      ? resp.data
      : (resp.data && Array.isArray(resp.data.Nodes) ? resp.data.Nodes : []);
    const nodes = raw.filter((n) => {
      const mt = n && n.Attributes && n.Attributes.ManagedTypeName;
      return !mt || !SKIP_MANAGED_TYPES.has(mt);
    });
    const hidden = raw.length - nodes.length;
    sdk.logEvent(
      `children ${systemId}/${viewId} '${designation}' -> ${nodes.length}` +
        (hidden ? ` (${hidden} hidden)` : "")
    );
    return nodes;
  });
}

async function listObjectTypes(http, config, sdk) {
  // Same /tables/<name>/subgroups pattern as disciplines (PDF §7.16). Some
  // patch levels mount it under different paths; try a few before failing
  // soft. Returns whatever shape Desigo gives us.
  const candidates = [
    `${config.baseUrl}/tables/objecttypes/subgroups`,
    `${config.baseUrl}/tables/objectTypes/subgroups`,
    `${config.baseUrl}/tables/objecttypes`,
    `${config.baseUrl}/tables/ObjectTypes/subgroups`,
  ];
  return await withFreshToken(http, config, sdk, async (token) => {
    for (const url of candidates) {
      try {
        const resp = await http.get(url, {
          headers: { authorization: `Bearer ${token}` },
          timeout: 10000,
          httpsAgent: norisHttpsAgent,
        });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          sdk.logEvent(`objectTypes via ${url} -> ${resp.data.length}`);
          return { source: url, objectTypes: resp.data };
        }
      } catch (e) {
        if (e.response && e.response.status === 401) throw e;
        sdk.logEvent(`objectTypes ${url} failed: ${e.response?.status || e.message}`);
      }
    }
    sdk.logEvent("objectTypes: no source returned data");
    return { source: "", objectTypes: [] };
  });
}

async function listNodeProperties(http, config, sdk, objectId) {
  return await withFreshToken(http, config, sdk, async (token) => {
    let data;
    try {
      const resp = await http.post(
        `${config.baseUrl}/properties?readAllProperties=True`,
        [objectId],
        {
          headers: { authorization: `Bearer ${token}` },
          timeout: 15000,
          httpsAgent: norisHttpsAgent,
        }
      );
      data = resp.data || [];
    } catch (e) {
      sdk.logEvent(`properties for ${objectId} failed: ${e.response?.status || e.message}`);
      return [];
    }
    const out = [];
    for (const obj of data) {
      const props = obj.Properties || [];
      const hasValue = props.some((p) => p.PropertyName === "Value" || p.PropertyName === "Present_Value");
      for (const prop of props) {
        if (hasValue && !(prop.PropertyName === "Value" || prop.PropertyName === "Present_Value")) continue;
        if (prop.Type !== "ExtendedReal" && prop.Type !== "ExtendedEnum") continue;
        out.push({ PropertyName: prop.PropertyName, Type: prop.Type });
      }
    }
    return out;
  });
}

module.exports = async ({ sdk, config, args }) => {
  const action = (args && args.action) || "";
  sdk.logEvent(`discover action=${action || "(none)"}`);
  if (!config.baseUrl || !config.username || !config.password) {
    return NormalSdk.InvokeError("Missing baseUrl/username/password");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/g, "");
  const http = axios;
  try {
    switch (action) {
      case "load_config": {
        const cfg = await loadConfig();
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, config: cfg }));
      }
      case "save_config": {
        // Each *Args is optional — when omitted we keep the prior value.
        const prior = await loadConfig();
        const next = {
          selectedViews: args.selectedViews !== undefined ? safeParseArray(args.selectedViews) : prior.selectedViews || [],
          selectedDisciplines: args.selectedDisciplines !== undefined ? safeParseArray(args.selectedDisciplines) : prior.selectedDisciplines || [],
          selectedObjectTypes: args.selectedObjectTypes !== undefined ? safeParseArray(args.selectedObjectTypes) : prior.selectedObjectTypes || [],
          selectedNodes: args.selectedNodes !== undefined ? safeParseArray(args.selectedNodes) : prior.selectedNodes || [],
        };
        const saved = await saveConfig(next);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, config: saved }));
      }
      case "list_views": {
        const systemId = args.systemId ? Number(args.systemId) : undefined;
        const file = `views_${systemId || "all"}.json`;
        const force = String(args.forceRefresh || "") === "true";
        if (!force) {
          const cached = await readCache(file);
          if (cached) {
            sdk.logEvent(`cache hit ${file}`);
            return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, views: cached.data, cached: true, cachedAt: cached.ts }));
          }
        }
        const views = await listViews(http, config, sdk, systemId);
        const entry = await writeCache(file, views);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, views, cached: false, cachedAt: entry.ts }));
      }
      case "list_disciplines": {
        const file = "disciplines.json";
        const force = String(args.forceRefresh || "") === "true";
        if (!force) {
          const cached = await readCache(file);
          if (cached) {
            sdk.logEvent(`cache hit ${file}`);
            return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, ...cached.data, cached: true, cachedAt: cached.ts }));
          }
        }
        const result = await listDisciplines(http, config, sdk);
        const entry = await writeCache(file, result);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, ...result, cached: false, cachedAt: entry.ts }));
      }
      case "list_children": {
        const systemId = Number(args.systemId);
        const viewId = Number(args.viewId);
        const designation = args.designation;
        const file = `children/${cacheKeyHex([String(systemId), String(viewId), designation])}.json`;
        const force = String(args.forceRefresh || "") === "true";
        if (!force) {
          const cached = await readCache(file);
          if (cached) {
            sdk.logEvent(`cache hit ${file} (${designation})`);
            return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, nodes: cached.data, cached: true, cachedAt: cached.ts }));
          }
        }
        const nodes = await listChildren(http, config, sdk, systemId, viewId, designation);
        const entry = await writeCache(file, nodes);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, nodes, cached: false, cachedAt: entry.ts }));
      }
      case "list_object_types": {
        const file = "object_types.json";
        const force = String(args.forceRefresh || "") === "true";
        if (!force) {
          const cached = await readCache(file);
          if (cached) {
            sdk.logEvent(`cache hit ${file}`);
            return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, ...cached.data, cached: true, cachedAt: cached.ts }));
          }
        }
        const result = await listObjectTypes(http, config, sdk);
        const entry = await writeCache(file, result);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, ...result, cached: false, cachedAt: entry.ts }));
      }
      case "reset_cache": {
        const removed = await resetCache();
        sdk.logEvent(`reset_cache removed ${removed} file(s)`);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, removed }));
      }
case "download_program": {
        const objectId = args.objectId;
        if (!objectId) return NormalSdk.InvokeError("download_program requires objectId");
        const values = await withFreshToken(http, config, sdk, async (token) => {
          const resp = await http.post(
            `${config.baseUrl}/values`,
            [`${objectId}.AP2`],
            { headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              timeout: 30000, httpsAgent: norisHttpsAgent }
          );
          return resp.data || [];
        });
        if (!values.length || !values[0].Value || !values[0].Value.Value) {
          return NormalSdk.InvokeError(`No PPCL source for ${objectId} (.AP2 returned empty)`);
        }
        const inner = values[0].Value.Value;
        const records = typeof inner === "string" ? JSON.parse(inner) : inner;
        const lines = records.map(decodePPCLRecord).filter((s) => s.length > 0);
        sdk.logEvent(`download_program ${objectId} -> ${lines.length} lines`);
        return NormalSdk.InvokeSuccess(JSON.stringify({
          ok: true, objectId, lineCount: lines.length, source: lines.join("\n"),
        }));
      }
      case "list_node_properties": {
        const objectId = args.objectId;
        if (!objectId) {
          return NormalSdk.InvokeError("list_node_properties requires objectId");
        }
        const managedTypeName = args.managedTypeName || "";
        if (managedTypeName && SKIP_MANAGED_TYPES.has(managedTypeName)) {
          return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, properties: [] }));
        }
        const sha = cacheKeyHex([objectId]);
        const file = `properties/${sha.substr(0, 2)}/${sha.substr(2, 2)}/${sha}.json`;
        const force = String(args.forceRefresh || "") === "true";
        if (!force) {
          const cached = await readCache(file);
          if (cached) {
            sdk.logEvent(`cache hit ${file} (${objectId})`);
            return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, properties: cached.data, cached: true, cachedAt: cached.ts }));
          }
        }
        const properties = await listNodeProperties(http, config, sdk, objectId);
        const entry = await writeCache(file, properties);
        return NormalSdk.InvokeSuccess(JSON.stringify({ ok: true, properties, cached: false, cachedAt: entry.ts }));
      }
      default:
        return NormalSdk.InvokeError(`Unknown action '${action}'.`);
    }
  } catch (e) {
    sdk.logEvent(`discover ${action} error: ${e.response?.status || ""} ${e.message}`);
    return NormalSdk.InvokeError(`${action}: ${e.message}`);
  }
};

function safeParseArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}


