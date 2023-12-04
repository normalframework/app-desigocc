const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");


const batch_size = 10

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
        parent_uuid: NAMESPACE,
        name: config.baseUrl,
        point_type: "DEVICE"
        }
      ]
    })
    let object_ids = []
    for (let i = 0; i < nodes.length; i++) {
      object_ids.push(nodes[i].ObjectId)
    }
    let prop_reply = await http.post(`${config.baseUrl}/properties?readAllProperties=True`, object_ids, {
          headers: {
            "authorization": "Bearer " + data.access_token
          },
          timeout: 15000,
        })
    for (let i = 0; i < prop_reply.data.length; i++) {
      let point = prop_reply.data[i]

      for (let j = 0; j < point.Properties.length; j++) {
        let prop = point.Properties[j]
        if (prop.Type == "ExtendedEnum" || prop.Type == "ExtendedReal") {
          let system_name = nodes[i].Designation.split(":")[0]
          let full_objectname = point.ObjectId + "." + prop.PropertyName
          console.log(full_objectname)
          points.push({
            layer: "hpl:desigocc",
            uuid: uuidv5(full_objectname, NAMESPACE),
            name: nodes[i].Name + ":" + prop.PropertyName,
            parent_uuid: NAMESPACE,
            protocol_id: full_objectname,
            attrs: {
              "objectId": full_objectname,
              "designation": nodes[i].Designation,
              "designationTokens": nodes[i].Designation.replace(/[\_\.]/g, " ") + " " +  full_objectname.replace(/[\_\.\:]/g, " "),
              "managedTypeName": nodes[i].Attributes.ManagedTypeName,
              "objectModelName": nodes[i].Attributes.ObjectModelName,
              "systemName": system_name,
              "propertyName": prop.PropertyName,
          },
          point_type: "POINT",
        })
        }
      }
    }
  
    sdk.event(`Adding ${points.length} points`)
    added += points.length
    total += nodes.length
    let res = await http.post(`http://${process.env.NFURL}/api/v1/point/points`, {
      "points": points,
    }, {
      timeout: 15000
    })
  }
  sdk.event(`finsihed import. ${added}/${total} imported`)
};
