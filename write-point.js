const NormalSdk = require("@normalframework/applications-sdk");

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Import generated service definition and messages
const { HplDriverService } = require('@buf/normalframework_nf.grpc_node/normalgw/hpl/v1/driver_grpc_pb');
const messages = require('@buf/normalframework_nf.grpc_node/normalgw/hpl/v1/driver_pb');
const { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js');

const axios = require("axios");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const server = new grpc.Server();
var started = false
var g_sdk = undefined

function makeError(uuid, message) {
    const driverError = new messages.DriverError();
    driverError.setUuid(uuid);
    const errorMsg = new messages.Error();
    errorMsg.setMessage(message);
    errorMsg.setTs(new Timestamp()); // optional timestamp
    driverError.setError(errorMsg);
    return driverError
}

server.addService(HplDriverService, {
  write: async (call, callback) => {
    const http = axios;

    const writes = call.request.getWritesList(); // returns array of PointWrite objects      
    const reply = new messages.WriteReply();
    const errors = [];
    const { data } = await http.post(g_config.baseUrl + "/token", {
      grant_type: "password",
      "username": g_config.username,
      "password": g_config.password,
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 150000,
    })
    const auth_headers = {
        "authorization": "Bearer " + data.access_token
      }
    console.log(auth_headers)


    for (const write of writes) {
      const point = write.getPoint();
      const value = write.getValue().getNormalized().getReal();

      let res = await http.get(g_config.baseUrl + "/commands/" + point.getProtocolId(), {
        headers: auth_headers
      })
      console.log(res.data)
    console.log(point.getProtocolId())
    console.log(value)
    }
    reply.setErrorsList(errors);
    callback(null, reply);
  }
});

var g_config
/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({points, sdk, config, args}) => {
  g_sdk = sdk
  g_http = sdk.http
  if (started) {
    return
  }
  g_config = config
 if (!config.username || !config.password || !config.baseUrl) {
    return NormalSdk.InvokeError("missing username, password, or base url")
  }

  await server.bindAsync('[::1]:10002', grpc.ServerCredentials.createInsecure(), () => {
  console.log('✅ Server listening on port 10002');
  server.start();
  started = true;
});

};