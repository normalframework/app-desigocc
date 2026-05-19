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

// Module-level WSI token cache. Re-auth ~60s before the cached expiry,
// and on 401 (Desigo's claimed TTL is unreliable).
var cachedToken = ""
var tokenExpiresAt = 0

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
    return driverError
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
    const { data } = await http.post(g_config.baseUrl + "/token", {
      grant_type: "password",
      "username": g_config.username,
      "password": g_config.password,
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 150000,
    });
    const auth_headers = { "authorization": "Bearer " + data.access_token };
    for (const write of writes) {
      const point = write.getPoint();
      const value = write.getValue().getNormalized().getReal();
      const res = await http.get(g_config.baseUrl + "/commands/" + point.getProtocolId(), {
        headers: auth_headers,
      });
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
      console.log('❌ bind failed:', err.message);
      return;
    }
    sdk.logEvent('grpc server bound on port ' + port + '; methods=read,write');
    console.log('✅ Server listening on port ' + port);
    server.start();
    started = true;
  });
};
