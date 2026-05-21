const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");

const batch_size = 500;
const NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------------------------------------------------------------------------
// Token cache - two-layer guard prevents the every-other-run 401.
//
// The NORIS server has two independent timeouts:
//   1. Token hard expiry  - from expires_in field (~30 days)
//   2. Session inactivity - server kills session after 10 min of no activity
//
// Running at 15-min intervals means the session is always dead by the next
// run even though the token timestamp looks valid. The heartbeat call resets
// the server inactivity timer before each poll, keeping the session alive.
// ---------------------------------------------------------------------------
var token = "";
var expirationTime = 0;      // ms since epoch
var lastUsedAt = 0;          // ms since epoch - updated after each successful run

const REFRESH_BUFFER_MS     = 60  * 1000;   // re-auth 60s before hard expiry
const INACTIVITY_TIMEOUT_MS = 9 * 60 * 1000; // 9 min < 10 min server window

async function getToken(config) {
  const now = Date.now();
  const tokenStillValid    = token && expirationTime - now > REFRESH_BUFFER_MS;
  const sessionStillActive = lastUsedAt && now - lastUsedAt < INACTIVITY_TIMEOUT_MS;

  if (tokenStillValid && sessionStillActive) return token;

  // Log out old token to free the session slot
  if (token) {
    try {
      await axios.delete(config.baseUrl + "/token", {
        headers: { authorization: "Bearer " + token },
        timeout: 10000,
      });
    } catch (_) {}
    token = "";
    lastUsedAt = 0;
  }

  const { data } = await axios.post(config.baseUrl + "/token", {
    grant_type: "password",
    username: config.username,
    password: config.password,
  }, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  token = data.access_token;
  // FIX: expires_in is in SECONDS - multiply by 1000 to convert to ms
  expirationTime = Date.now() + data.expires_in * 1000;
  return token;
}

async function pingHeartbeat(config) {
  try {
    await axios.get(config.baseUrl + "/heartbeat", {
      headers: { authorization: "Bearer " + token },
      timeout: 10000,
    });
  } catch (err) {
    token = "";
    lastUsedAt = 0;
    throw new Error("Heartbeat failed (" + (err.response?.status ?? err.message) + ") - will re-authenticate.");
  }
}

/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 */
module.exports = async ({ sdk, config, points }) => {
  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("missing username, password, or base url");
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/gm, "");

  // Step 1: Authenticate with two-layer cache
  try {
    await getToken(config);
    sdk.logEvent("Authenticated (token valid)");
  } catch (e) {
    token = "";
    lastUsedAt = 0;
    return NormalSdk.InvokeError("Authentication failed: " + e.message);
  }

  // Step 2: Heartbeat - resets server inactivity timer before polling
  try {
    await pingHeartbeat(config);
  } catch (err) {
    sdk.logEvent(err.message);
    try {
      await getToken(config);
      sdk.logEvent("Re-authenticated successfully after heartbeat failure.");
    } catch (reAuthErr) {
      return NormalSdk.InvokeError("Re-auth after heartbeat failure: " + reAuthErr.message);
    }
  }

  // Step 3: Collect objectIds from period-assigned points
  let object_ids = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].attrs["objectId"]) {
      object_ids.push(points[i].attrs["objectId"]);
    }
  }

  if (object_ids.length === 0) {
    sdk.logEvent("No points with objectId attribute - nothing to poll.");
    return;
  }

  // Step 4: Poll values in batches
  let total_updates = 0;

  for (let i = 0; i < object_ids.length; i += batch_size) {
    let values;
    try {
      values = await axios.post(
        config.baseUrl + "/values",
        object_ids.slice(i, i + batch_size),
        {
          headers: { authorization: "Bearer " + token },
          timeout: 15000,
        }
      );
    } catch (error) {
      if (error.response && error.response.status === 401) {
        token = "";
        lastUsedAt = 0;
        sdk.logEvent("Received 401 mid-poll - clearing token. Will re-auth on next run.");
        return;
      }
      sdk.logEvent("Error fetching values batch at offset " + i + ": " + error.message);
      continue;
    }

    // FIX: guard against undefined values before accessing .data
    if (!values || !values.data || values.data.length === 0) continue;

    sdk.logEvent("Processing " + values.data.length + " values");

    for (let j = 0; j < values.data.length; j++) {
      let val = values.data[j].Value;
      if (!val || !val.QualityGood) continue;

      let ts, real;
      try {
        ts   = Date.parse(val.Timestamp);
        real = parseFloat(val.Value);
        if (isNaN(real)) continue;
      } catch {
        continue;
      }

      let uuid = uuidv5(values.data[j].OriginalObjectOrPropertyId, NAMESPACE);

      try {
        await sdk.http.post("http://" + process.env.NFURL + "/api/v1/point/data", {
          uuid: uuid,
          layer: "hpl:desigocc",
          values: [{ ts: val.Timestamp, real: real }],
        });
        total_updates += 1;
      } catch (err) {
        sdk.logEvent("Error posting data: " + err.message);
      }
    }
  }

  // Step 5: Mark session active so inactivity guard stays accurate
  lastUsedAt = Date.now();

  sdk.logEvent("Polling finished with " + total_updates + " new values");
};