// Selective import for the Desigo CC plugin (streaming variant).
//
// Reads state/config.json (or args overrides) to learn which (systemId,
// viewId, designation) subtrees the user wants imported and which
// disciplines / object types to keep. Walks each subtree via
// /systembrowser/{s}/{v}/{node} and pipelines results through buffered
// /properties fetches + /point/points inserts without accumulating the
// whole tree in memory.
//
// At 500k points the old "collect everything then process" approach OOMs
// the runtime; this version keeps memory ~constant (just the dedupe Set
// and a small batch buffer).
//
// Preserves the SAME uuid recipe as hooks/import-points.js:
//   uuid = uuidv5(ObjectId + "." + PropertyName, NAMESPACE)
//   NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc"
//
// Skips PPCL programs and other non-importable managed types. The
// original hooks/import-points.js is NOT modified.

const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");

const NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc";
const NODE_BATCH = 100;       // /properties fetch chunk
const POINT_BATCH = 100;      // /point/points insert chunk
const MAX_DEPTH = 50;
const PROGRESS_EVERY = 500;   // emit a progress logEvent every N nodes walked

const SKIP_MANAGED_TYPES = new Set([
  "TrendLog",
  "BACnet Notification Class",
  "BACnet Event Enrollment",
  "TextGroup",
  "Apogee PPCL",
]);

const norisHttpsAgent = new https.Agent({ rejectUnauthorized: false });
let cachedToken = "";
let tokenExpiresAt = 0;

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
  const REFRESH = 60 * 1000;
  if (!force && cachedToken && tokenExpiresAt - Date.now() > REFRESH) return cachedToken;
  if (cachedToken && !force) {
    try {
      await http.delete(`${config.baseUrl}/token`, {
        headers: { authorization: `Bearer ${cachedToken}` },
        timeout: 8000,
        httpsAgent: norisHttpsAgent,
      });
    } catch (_) {}
  }
  cachedToken = "";
  return await authenticate(http, config, sdk);
}

const STATE_DIR = path.join(__dirname, "..", "state");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  } catch (e) {
    return { selectedViews: [], selectedDisciplines: [], selectedObjectTypes: [], selectedNodes: [] };
  }
}

function isValueName(name) { return name === "Value" || name === "Present_Value"; }

function buildPath(systemName, afterSystem, propertyName) {
  const segs = [];
  for (const s of (systemName || "").split(".")) if (s) segs.push(s);
  for (const s of (afterSystem || "").split(".")) {
    if (!s) continue;
    if (segs.length && segs[segs.length - 1] === s) continue;
    segs.push(s);
  }
  if (propertyName) segs.push(propertyName);
  return segs.join("/");
}

async function fetchChildren(http, config, sdk, systemId, viewId, designation, refresh) {
  const url = `${config.baseUrl}/systembrowser/${encodeURIComponent(systemId)}/${encodeURIComponent(viewId)}/${encodeURIComponent(designation)}`;
  const token = await getToken(http, config, sdk, refresh);
  let resp;
  try {
    resp = await http.get(url, {
      headers: { authorization: `Bearer ${token}` },
      timeout: 20000,
      httpsAgent: norisHttpsAgent,
    });
  } catch (e) {
    if (e.response && e.response.status === 401 && !refresh) {
      return fetchChildren(http, config, sdk, systemId, viewId, designation, true);
    }
    sdk.logEvent(`walk ${designation} ${e.response?.status || ""} ${e.message}`);
    return [];
  }
  if (Array.isArray(resp.data)) return resp.data;
  if (resp.data && Array.isArray(resp.data.Nodes)) return resp.data.Nodes;
  return [];
}

async function postPropertiesBatch(http, config, sdk, objectIds, refresh) {
  const token = await getToken(http, config, sdk, refresh);
  try {
    const resp = await http.post(
      `${config.baseUrl}/properties?readAllProperties=True`,
      objectIds,
      {
        headers: { authorization: `Bearer ${token}` },
        timeout: 30000,
        httpsAgent: norisHttpsAgent,
      }
    );
    return resp.data || [];
  } catch (e) {
    if (e.response && e.response.status === 401 && !refresh) {
      return postPropertiesBatch(http, config, sdk, objectIds, true);
    }
    sdk.logEvent(`properties batch error: ${e.response?.status || ""} ${e.message}`);
    return [];
  }
}

function buildPointsForBatch(nodesByObjectId, propsArray) {
  const points = [];
  for (const obj of propsArray) {
    const node = nodesByObjectId.get(obj.ObjectId);
    if (!node) continue;
    if (node.Attributes && SKIP_MANAGED_TYPES.has(node.Attributes.ManagedTypeName)) continue;
    const properties = obj.Properties || [];
    const hasValue = properties.some((p) => isValueName(p.PropertyName));
    for (const prop of properties) {
      if (hasValue && !isValueName(prop.PropertyName)) continue;
      if (prop.Type !== "ExtendedReal" && prop.Type !== "ExtendedEnum") continue;
      const systemName = (node.Designation || "").split(":")[0];
      const fullName = obj.ObjectId + "." + prop.PropertyName;
      const afterSystem = (node.Designation || "").split(":").slice(1).join(":");
      const treePath = buildPath(systemName, afterSystem, prop.PropertyName);
      points.push({
        layer: "hpl:desigocc",
        uuid: uuidv5(fullName, NAMESPACE),
        name: node.Name + ":" + prop.PropertyName,
        parent_uuid: NAMESPACE,
        parent_name: systemName,
        protocol_id: fullName,
        hpl_driver: "hpl:desigocc",
        attrs: {
          objectId: fullName,
          designation: node.Designation,
          path: treePath,
          designationTokens:
            (node.Designation || "").replace(/[\_\.]/g, " ") +
            " " +
            fullName.replace(/[\_\.\:]/g, " "),
          managedTypeName: (node.Attributes && node.Attributes.ManagedTypeName) || "",
          objectModelName: (node.Attributes && node.Attributes.ObjectModelName) || "",
          systemName: systemName,
          propertyName: prop.PropertyName,
        },
        point_type: "POINT",
      });
    }
  }
  return points;
}

async function ensureDevicePoint(http, config) {
  await http.post(`http://${process.env.NFURL}/api/v1/point/points`, {
    points: [
      {
        layer: "hpl:desigocc",
        uuid: NAMESPACE,
        parent_uuid: NAMESPACE,
        name: config.baseUrl,
        point_type: "DEVICE",
      },
    ],
  });
}

async function insertPoints(http, sdk, points) {
  let inserted = 0;
  for (let i = 0; i < points.length; i += POINT_BATCH) {
    const slice = points.slice(i, i + POINT_BATCH);
    try {
      await http.post(
        `http://${process.env.NFURL}/api/v1/point/points`,
        { points: slice },
        { timeout: 30000 }
      );
      inserted += slice.length;
    } catch (e) {
      sdk.logEvent(`point insert batch error: ${e.message}`);
    }
  }
  return inserted;
}

module.exports = async ({ sdk, config, args }) => {
  if (!config.baseUrl || !config.username || !config.password) {
    return NormalSdk.InvokeError("Missing baseUrl/username/password");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/g, "");
  const http = axios;

  const cfg = await loadConfig();
  const selectedNodes = parseArg(args.selectedNodes, cfg.selectedNodes || []);
  const selectedDisciplines = parseArg(args.selectedDisciplines, cfg.selectedDisciplines || []);
  const selectedObjectTypes = parseArg(args.selectedObjectTypes, cfg.selectedObjectTypes || []);
  const dryRun = String(args.dryRun || "").toLowerCase() === "true";

  if (!selectedNodes.length) {
    return NormalSdk.InvokeError("No nodes selected. Save a tree selection first or pass selectedNodes.");
  }

  const disciplineSet = selectedDisciplines.length
    ? new Set(selectedDisciplines.map((d) => Number(d)))
    : null;
  const objectTypeSet = selectedObjectTypes.length
    ? new Set(selectedObjectTypes.map((t) => Number(t)))
    : null;

  sdk.logEvent(
    `import-selected: ${selectedNodes.length} root(s), ` +
    `${selectedDisciplines.length} discipline filter(s), ` +
    `${selectedObjectTypes.length} object-type filter(s), dryRun=${dryRun}`
  );

  // ───────────────────────────────────────────────────────────────────
  // Streaming counters + small buffers. The only structure that grows
  // unbounded is `seen` (set of ObjectIds for dedupe). At 50B/string it's
  // ~25MB for 500k points — acceptable.
  // ───────────────────────────────────────────────────────────────────
  const seen = new Set();
  let buffer = [];

  let walked = 0;
  let unique = 0;
  let afterDiscipline = 0;
  let afterObjectType = 0;
  let totalProps = 0;
  let totalPointsBuilt = 0;
  let totalInserted = 0;
  let nextProgressAt = PROGRESS_EVERY;

  async function flushBuffer() {
    if (!buffer.length) return;
    // discipline + object-type filters happen here, on the small buffer slice.
    const filtered = [];
    for (const n of buffer) {
      const a = n.Attributes || {};
      if (disciplineSet) {
        const did = Number(a.DisciplineId);
        if (!Number.isFinite(did) || !disciplineSet.has(did)) continue;
      }
      afterDiscipline += 1;
      if (objectTypeSet) {
        const tid = Number(a.TypeId);
        if (!Number.isFinite(tid) || !objectTypeSet.has(tid)) continue;
      }
      afterObjectType += 1;
      filtered.push(n);
    }
    buffer = [];
    if (!filtered.length) return;

    if (dryRun) return; // counts only

    const byId = new Map();
    const ids = [];
    for (const n of filtered) {
      if (!n.ObjectId) continue;
      byId.set(n.ObjectId, n);
      ids.push(n.ObjectId);
    }
    if (!ids.length) return;

    const props = await postPropertiesBatch(http, config, sdk, ids, false);
    totalProps += props.length;
    const points = buildPointsForBatch(byId, props);
    totalPointsBuilt += points.length;
    totalInserted += await insertPoints(http, sdk, points);
  }

  async function recordNode(n) {
    walked += 1;
    if (!n.ObjectId || seen.has(n.ObjectId)) return;
    seen.add(n.ObjectId);
    unique += 1;
    buffer.push(n);
    if (buffer.length >= NODE_BATCH) await flushBuffer();
    if (walked >= nextProgressAt) {
      sdk.logEvent(
        `progress walked=${walked} unique=${unique} filtered=${afterObjectType} inserted=${totalInserted}`
      );
      nextProgressAt += PROGRESS_EVERY;
    }
  }

  async function streamWalk(systemId, viewId, designation, depth) {
    if (depth > MAX_DEPTH) {
      sdk.logEvent(`max depth at ${designation}`);
      return;
    }
    const nodes = await fetchChildren(http, config, sdk, systemId, viewId, designation, false);
    for (const n of nodes) {
      await recordNode(n);
      if (n.HasChild) {
        await streamWalk(systemId, viewId, n.Designation, depth + 1);
      }
    }
  }

  try {
    if (!dryRun) await ensureDevicePoint(http, config);

    for (const sel of selectedNodes) {
      const sid = Number(sel.systemId);
      const vid = Number(sel.viewId);
      if (!sid || !vid || !sel.designation) {
        sdk.logEvent(`skipping malformed selection: ${JSON.stringify(sel)}`);
        continue;
      }
      sdk.logEvent(`walking ${sid}/${vid} ${sel.designation}`);
      await streamWalk(sid, vid, sel.designation, 0);
    }
    // Final flush.
    await flushBuffer();

    sdk.logEvent(
      `done walked=${walked} unique=${unique} filtered=${afterObjectType} inserted=${totalInserted}`
    );

    const result = {
      ok: true,
      walked,
      unique,
      afterDisciplineFilter: afterDiscipline,
      afterObjectTypeFilter: afterObjectType,
      propertyRecords: totalProps,
      pointsBuilt: totalPointsBuilt,
      pointsInserted: totalInserted,
    };
    if (dryRun) result.dryRun = true;
    return NormalSdk.InvokeSuccess(JSON.stringify(result));
  } catch (e) {
    sdk.logEvent(`import-selected error: ${e.response?.status || ""} ${e.message}`);
    return NormalSdk.InvokeError(`import-selected: ${e.message}`);
  }
};

function parseArg(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch { return fallback; }
}
