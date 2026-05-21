const NormalSdk = require("@normalframework/applications-sdk");

const grpc = require('@grpc/grpc-js');

const { HplDriverService } = require('@buf/normalframework_nf.grpc_node/normalgw/hpl/v1/driver_grpc_pb');
const messages = require('@buf/normalframework_nf.grpc_node/normalgw/hpl/v1/driver_pb');
const pointMessages = require('@buf/normalframework_nf.grpc_node/normalgw/hpl/v1/point_pb');
const { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js');

const axios = require("axios");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const server = new grpc.Server();
var started = false
var g_sdk = undefined
var g_config

// WSI token cache. Re-auth ~60s before claimed expiry, and on 401
// (Desigo's claimed TTL is unreliable).
var cachedToken = ""
var tokenExpiresAt = 0

// protocolId -> array of normalized commands available on that property:
//   [{ commandId, isDefault, parameters: [{Name, DataType, DefaultValue}] }, ...]
// Cleared per-point on POST failure so the next write re-discovers.
const commandCache = new Map();

// Value.ValuetypeCase from @buf/normalframework_nf.grpc_node/normalgw/hpl/v1/point_pb.
// A null write (oneof = NULL or unset) is the NF convention for "release my hold".
const VALUETYPE_NOT_SET = 0;
const VALUETYPE_NULL = 2;
const VALUETYPE_REAL = 6;
const VALUETYPE_DOUBLE = 7;

async function getToken(http, force) {
  const REFRESH_BUFFER_MS = 60 * 1000;
  if (!force && cachedToken && tokenExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cachedToken;
  }
  const { data } = await http.post(
    g_config.baseUrl + "/token",
    new URLSearchParams({
      grant_type: "password",
      username: g_config.username,
      password: g_config.password,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    }
  );
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function makeError(uuid, message) {
  const driverError = new messages.DriverError();
  driverError.setUuid(uuid);
  const errorMsg = new pointMessages.Error();
  errorMsg.setMessage(message);
  errorMsg.setTs(new Timestamp());
  driverError.setError(errorMsg);
  return driverError;
}

function isoToTimestamp(iso) {
  const ts = new Timestamp();
  if (!iso) return ts;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return ts;
  ts.setSeconds(Math.floor(ms / 1000));
  ts.setNanos((ms % 1000) * 1000000);
  return ts;
}

async function fetchValues(http, ids, refresh) {
  const token = await getToken(http, refresh);
  try {
    const resp = await http.post(
      g_config.baseUrl + "/values",
      ids,
      {
        headers: {
          "authorization": "Bearer " + token,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return resp.data || [];
  } catch (e) {
    if (e.response && e.response.status === 401 && !refresh) {
      cachedToken = "";
      return fetchValues(http, ids, true);
    }
    throw e;
  }
}

async function discoverCommands(http, protocolId, refresh) {
  if (!refresh && commandCache.has(protocolId)) return commandCache.get(protocolId);
  const token = await getToken(http, refresh);
  let resp;
  try {
    resp = await http.get(
      g_config.baseUrl + "/commands/" + encodeURIComponent(protocolId),
      {
        headers: { authorization: "Bearer " + token },
        timeout: 15000,
      }
    );
  } catch (e) {
    if (e.response && e.response.status === 401 && !refresh) {
      cachedToken = "";
      return discoverCommands(http, protocolId, true);
    }
    throw e;
  }
  const arr = Array.isArray(resp.data) ? resp.data : [];
  const entry = arr[0] || {};
  const cmds = (entry.Commands || []).map((c) => ({
    commandId: c.Id,
    isDefault: !!c.IsDefault,
    parameters: (c.Parameters || []).map((p) => ({
      Name: p.Name,
      DataType: p.DataType,
      DefaultValue: p.DefaultValue,
    })),
  }));
  commandCache.set(protocolId, cmds);
  return cmds;
}

function pickWriteCommand(cmds) {
  const hasValue = (c) => c.parameters.some((p) => p.Name === "Value");
  return (
    cmds.find((c) => c.isDefault && hasValue(c)) ||
    cmds.find((c) => c.commandId === "Write") ||
    cmds.find((c) => c.isDefault) ||
    cmds.find(hasValue) ||
    null
  );
}

function pickReleaseCommand(cmds) {
  return (
    cmds.find((c) => c.commandId === "Release") ||
    cmds.find((c) => c.commandId === "ReleaseAll") ||
    cmds.find((c) => /release/i.test(c.commandId)) ||
    null
  );
}

async function postCommand(http, protocolId, cmd, valueForValueParam, refresh) {
  const token = await getToken(http, refresh);
  const body = cmd.parameters.map((p) =>
    p.Name === "Value" && valueForValueParam !== undefined && valueForValueParam !== null
      ? { Name: p.Name, DataType: p.DataType, Value: String(valueForValueParam) }
      : { Name: p.Name, DataType: p.DataType, Value: p.DefaultValue == null ? "" : String(p.DefaultValue) }
  );
  try {
    await http.post(
      g_config.baseUrl + "/commands/" + encodeURIComponent(protocolId) + "/" + encodeURIComponent(cmd.commandId),
      body,
      {
        headers: {
          authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
  } catch (e) {
    if (e.response && e.response.status === 401 && !refresh) {
      cachedToken = "";
      return postCommand(http, protocolId, cmd, valueForValueParam, true);
    }
    throw e;
  }
}

server.addService(HplDriverService, {
  read: async (call, callback) => {
    const http = axios;
    const reads = call.request.getReadsList();
    const reply = new messages.ReadReply();
    const results = [];
    const errors = [];

    if (reads.length === 0) {
      callback(null, reply);
      return;
    }

    const idToUuid = new Map();
    const ids = [];
    for (const r of reads) {
      const point = r.getPoint();
      const uuid = point.getUuid();
      const pid = point.getProtocolId();
      if (!pid) {
        errors.push(makeError(uuid, "missing protocol_id"));
        continue;
      }
      idToUuid.set(pid, uuid);
      ids.push(pid);
    }
    if (ids.length === 0) {
      reply.setErrorsList(errors);
      callback(null, reply);
      return;
    }

    // Desigo's /values can take ~hundreds of ids per call. 500 matches
    // trend-data.js and stays well within typical session limits.
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      let values;
      try {
        values = await fetchValues(http, slice, false);
      } catch (e) {
        const msg = "/values: " + (e.response?.status || "") + " " + e.message;
        for (const id of slice) {
          errors.push(makeError(idToUuid.get(id), msg));
        }
        continue;
      }

      for (const item of values) {
        const pid = item.OriginalObjectOrPropertyId || "";
        const uuid = idToUuid.get(pid);
        if (!uuid) continue;
        const v = item.Value;
        if (!v) { errors.push(makeError(uuid, "no Value in response")); continue; }
        if (!v.QualityGood) { errors.push(makeError(uuid, "bad quality")); continue; }
        const real = parseFloat(v.Value);
        if (Number.isNaN(real)) { errors.push(makeError(uuid, "non-numeric value: " + v.Value)); continue; }

        const value = new pointMessages.Value();
        value.setReal(real);
        value.setTs(isoToTimestamp(v.Timestamp));
        const result = new messages.PointReadResult();
        result.setUuid(uuid);
        result.setHplValue(value);
        results.push(result);
      }
    }

    reply.setResultsList(results);
    reply.setErrorsList(errors);
    callback(null, reply);
  },

  write: async (call, callback) => {
    const http = axios;
    const writes = call.request.getWritesList();
    const reply = new messages.WriteReply();
    const errors = [];

    for (const w of writes) {
      const point = w.getPoint();
      const uuid = point.getUuid();
      const pid = point.getProtocolId();
      if (!pid) {
        errors.push(makeError(uuid, "missing protocol_id"));
        continue;
      }

      // A WriteValue whose oneof is unset, or whose inner Value oneof is
      // NULL/unset, is the NF convention for "release my priority slot".
      const wval = w.getValue();
      const normalized = wval && wval.hasNormalized() ? wval.getNormalized() : null;
      const valueCase = normalized ? normalized.getValuetypeCase() : VALUETYPE_NOT_SET;
      const isRelease = !normalized || valueCase === VALUETYPE_NULL || valueCase === VALUETYPE_NOT_SET;

      let cmds;
      try {
        cmds = await discoverCommands(http, pid, false);
      } catch (e) {
        errors.push(makeError(uuid, "/commands GET: " + (e.response?.status || "") + " " + e.message));
        continue;
      }
      if (!cmds.length) {
        errors.push(makeError(uuid, "no commands available"));
        continue;
      }

      if (isRelease) {
        const releaseCmd = pickReleaseCommand(cmds);
        if (!releaseCmd) {
          errors.push(makeError(uuid, "point has no Release command"));
          continue;
        }
        try {
          await postCommand(http, pid, releaseCmd, null, false);
          g_sdk && g_sdk.logEvent && g_sdk.logEvent(`released ${pid} via ${releaseCmd.commandId}`);
        } catch (e) {
          commandCache.delete(pid);
          errors.push(makeError(uuid, `/commands POST ${releaseCmd.commandId}: ${e.response?.status || ""} ${e.message}`));
        }
        continue;
      }

      // Extract a numeric value from whichever oneof case is set. Desigo's
      // Value parameter for AV/AO is ExtendedReal, so we coerce to a number.
      let real;
      switch (valueCase) {
        case VALUETYPE_REAL: real = normalized.getReal(); break;
        case VALUETYPE_DOUBLE: real = normalized.getDouble(); break;
        case 3: real = normalized.getBoolean() ? 1 : 0; break; // BOOLEAN
        case 4: real = normalized.getUnsigned(); break;        // UNSIGNED
        case 5: real = normalized.getSigned(); break;          // SIGNED
        default:
          errors.push(makeError(uuid, "unsupported value type case: " + valueCase));
          continue;
      }

      const writeCmd = pickWriteCommand(cmds);
      if (!writeCmd) {
        errors.push(makeError(uuid, "no writable command available"));
        continue;
      }
      try {
        await postCommand(http, pid, writeCmd, real, false);
        g_sdk && g_sdk.logEvent && g_sdk.logEvent(`wrote ${pid}=${real} via ${writeCmd.commandId}`);
      } catch (e) {
        commandCache.delete(pid);
        errors.push(makeError(uuid, `/commands POST ${writeCmd.commandId}: ${e.response?.status || ""} ${e.message}`));
      }
    }

    reply.setErrorsList(errors);
    callback(null, reply);
  },
});

module.exports = async ({ points, sdk, config, args }) => {
  g_sdk = sdk;
  g_http = sdk.http;
  if (started) return;
  g_config = config;
  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("missing username, password, or base url");
  }
  server.bindAsync('[::]:10002', grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      sdk.logEvent('grpc bindAsync failed: ' + err.message);
      console.log('bind failed:', err.message);
      return;
    }
    sdk.logEvent('grpc server bound on port ' + port + '; methods=read,write');
    console.log('Server listening on port ' + port);
    server.start();
    started = true;
  });
};
