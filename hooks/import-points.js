const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");


const batch_size = 100

const NAMESPACE = "fe927c12-7f2f-11ee-a65f-af8737c274cc"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

 

/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({sdk, config}) => {
  http = sdk.http;

  if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("missing username, password, or base url")
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/gm, '')
  console.log(config)
  const { data } = await http.post(config.baseUrl + "/token", {
    grant_type: "password",
    "username": config.username,
    "password": config.password,
    }, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
          timeout: 15000,

  })

  if (!config.viewId || !config.systemId) {
    sdk.event("Desigo view ID is not configured.  Loading the available system views!")
    let views = await http.get(config.baseUrl+"/systembrowser", {
      headers: {
        "authorization": "Bearer " + data.access_token
    },
    })
    for (let i = 0; i < views.data.length; i ++) {
      sdk.event(`view systemId=${views.data[i].SystemId} viewId=${views.data[i].ViewId} descriptor=${views.data[i].Descriptor} designation=${views.data[i].Designation}`)
    }
    sdk.event("Please select a systemId and viewId and update the configuration.")
    return
  }
  let total = 0
  let added = 0

  for (let page = 0; page < 1000; page ++) { 
    let views = await http.get(config.baseUrl+`/systembrowser/${config.systemId}/${config.viewId}?size=${batch_size}&page=${page}&searchString=*&diciplineFilter=50`, {
      headers: {
        "authorization": "Bearer " + data.access_token
      },
      timeout: 15000,
    })

    let nodes = views.data.Nodes
    let points = []
    if (nodes.length == 0) {
      break
    }
    // create a device point so Device Health will work
    await http.post(`http://${process.env.NFURL}/api/v1/point/points`, {
      "points": [ {
        layer: "hpl:desigocc",
        uuid: NAMESPACE,
        device_uuid: NAMESPACE,
        name: config.baseUrl,
        point_type: "DEVICE"
      }
      ]
    })

    for (let i = 0; i < nodes.length; i++) {
      console.log(nodes[i].ObjectId)
      if (nodes[i].Attributes.DefaultProperty == "Present_Value" || nodes[i].Attributes.DefaultProperty == "Value") {
        let system_name =  nodes[i].Designation.split(":")[0]
        points.push({
          layer: "hpl:desigocc",
          uuid: uuidv5(nodes[i].ObjectId, NAMESPACE),
          name: nodes[i].Name,
          device_uuid: NAMESPACE,
          attrs: {
            "objectId": nodes[i].ObjectId,
            "designation": nodes[i].Designation,
            "designationTokens": nodes[i].Designation.replace(/[\_\.]/g, " ") + " " +  nodes[i].ObjectId.replace(/[\_\.]/g, " "),
            "managedTypeName": nodes[i].Attributes.ManagedTypeName,
            "objectModelName": nodes[i].Attributes.ObjectModelName,
            "systemName": system_name,
          },
          protocol_id: nodes[i].ObjectId,
          point_type: "POINT",
        })
      } else {
              console.log(nodes[i])
      }
    }
    sdk.event(`Adding ${points.length} points`)
    added += points.length
    total += nodes.length
    let res = await http.post(`http://${process.env.NFURL}/api/v1/point/points`, {
      "points": points,
    })
  }
  sdk.event(`finsihed import. ${added}/${total} imported`)
};
