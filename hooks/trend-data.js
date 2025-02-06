const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");

const batch_size = 500;
const NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
 
var token = ""
var expirationTime = 0

/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({sdk, config, points}) => {
  http = axios;

  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("missing username, password, or base url")
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/gm, '')
  console.log(config) 
  console.log(Date.now(), expirationTime)
  if (token == "" || expirationTime - Date.now() < 15 * 60 * 1000) {
    try{
      const { data } = await http.post(config.baseUrl + "/token", {
        grant_type: "password",
        username: config.username,
        password: config.password,
        }, {
         headers: {
           'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 15000,
    });
    token=data.access_token ;
    expirationTime = Date.now() + data.expires_in;
    console.log(data)

    } catch (e) {
        console.log("catch", e)
        throw e 
    }
  }

  let object_ids = []
  for (let i = 0; i < points.length; i++) {
    if (points[i].attrs["objectId"]) {
        object_ids.push(points[i].attrs["objectId"])
    }
  }

  let total_updates = 0
  for (let i = 0; i < object_ids.length; i += batch_size) {
    var values;
    try {
     values = await http.post(config.baseUrl+"/values", object_ids.slice(i, i+batch_size), { headers: {
          "authorization": "Bearer " + token
        },
          timeout: 15000,
    })
   } catch  (error) {
  if (error.response && error.response.status === 401) {
    token = ""
    sdk.logEvent("received 401.  clearing token")
    return NormalSdk.InvokeError
  }   
    }
    sdk.logEvent(`Processing ${values.data.length} values` )

      for (let i = 0; i < values.data.length; i ++) {
        console.log(values.data[i])
        let val = values.data[i].Value
        //  console.log(values.data[i])
        if (!val.QualityGood) {
            continue
        }
      var ts, real
      try{
          ts = Date.parse(val.Timestamp)
          real = parseFloat(val.Value)
      } catch {
          continue
      }
      let uuid = uuidv5(values.data[i].OriginalObjectOrPropertyId, NAMESPACE)
      console.log(uuid, values.data[i].OriginalObjectOrPropertyId, ts, real)

      let res = await sdk.http.post(`http://${process.env.NFURL}/api/v1/point/data`, {
          uuid: uuid,
          layer: "hpl:desigocc",
          values: [
              {
                  ts: val.Timestamp,
                  real: real,
              }
          ]
      })
      total_updates += 1

    }
  }
  sdk.logEvent(`Polling finished with ${total_updates} new values`)
}
