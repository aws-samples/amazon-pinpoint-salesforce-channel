let response
const jsforce = require('jsforce')
const axios = require('axios')
const moment = require('moment')
const jwt = require('jsonwebtoken')
const url = require('url')
const querystring = require('querystring')
const AWS = require('aws-sdk')
const pinpoint = new AWS.Pinpoint()

function generateSFJWT () {
  var consumerKey = process.env.SFCONSUMERKEY
  var awsApiUser = process.env.SFAPIUSERNAME
  var instanceUrl = process.env.SFLOGINURL

  // Rebuild cert from environment variable.
  var beginPk = '-----BEGIN PRIVATE KEY-----\n'
  var endPk = '\n-----END PRIVATE KEY-----\n'
  var privateKey = beginPk + process.env.SFPRIVATEKEY.split(' ').concat().join('\n') + endPk

  // Build JWT
  var jwtparams = {
    iss: consumerKey,
    prn: awsApiUser,
    aud: instanceUrl,
    exp: parseInt(moment().add(2, 'minutes').format('X'))
  }

  var token = jwt.sign(jwtparams, privateKey, { algorithm: 'RS256' })

  return token
}

function buildSFObjectFromEndpoint (endpointId, endpoint) {
  // Customize this method as needed to update the SF object based on your enpoint Attributes.
  // The following are the bare minimum fields for a Lead Object
  return {
    FirstName: endpoint.Attributes.FirstName[0],
    LastName: endpoint.Attributes.LastName[0],
    Company: endpoint.Attributes.Company[0],
    Pinpoint_Endpoint_ID__c: endpointId //requires adding "Pinpoint Endpoint ID" as a Custom field on the Lead Record
  }
}

function processInserts (conn, campaignID, sfObject, endpoints, pinpointEvents) {
  return new Promise((resolve, reject) => {
    try {
      var endpointsToInsert = []
      var updateAttribute = process.env.UPDATEATTRIBUTE

      Object.keys(endpoints).forEach(function (endpointID) {
        var endpoint = endpoints[endpointID]

        if (updateAttribute) {
          if (!updateAttribute || !endpoint.Attributes[updateAttribute][0]) {
            // endpoint has an update field, but it's empty, so perform an insert.
            endpointsToInsert.push(buildSFObjectFromEndpoint(endpointID, endpoint))
            pinpointEvents[endpointID] = createPinpointEvent(endpointID, campaignID, sfObject, 'insert')
          }
        }
      })

      if (endpointsToInsert.length === 1) {
        // Just a single record to insert, so make single API call
        console.log('Found Single Object to Insert:')

        conn.sobject(sfObject).create(endpointsToInsert[0], function (err, ret) {
          console.log(JSON.stringify(ret))
          if (err || !ret.success) {
            console.error(err, ret)
          } else {
            console.log('Created record id : ' + ret.id)
          }
          resolve()
        })
      } else if (endpointsToInsert.length > 1) {
        // Multiple records to insert, so make use of bulk api to optimize API call limits.

        console.log('Found Multiple Objects to Insert')

        conn.bulk.load(sfObject, 'insert', endpointsToInsert, function (err, rets) {
          if (err) {
            // console.error(err)
            // pinpointEvents[endpoint.ID] = createFailureEvent(endpoint.ID, campaignID, sfObject, "insert", err)
          } else {
            for (var i = 0; i < rets.length; i++) {
              console.log(JSON.stringify(rets[i]))
              if (rets[i].success) {
                console.log('#' + (i + 1) + ' inserted successfully, id = ' + rets[i].id)
              } else {
                console.log('#' + (i + 1) + ' insert error occurred, message = ' + rets[i].errors.join(', '))
              }
            }
          }
          resolve()
        })
      } else {
        // nothing to process...just return
        resolve()
      }
    } catch (ex) {
      reject(ex)
    }
  })
}

function processUpdates (conn, campaignID, sfObject, endpoints, pinpointEvents) {
  return new Promise((resolve, reject) => {
    try {
      var endpointsToUpdate = []
      var updateAttribute = process.env.UPDATEATTRIBUTE

      Object.keys(endpoints).forEach(function (endpointID) {
        var endpoint = endpoints[endpointID]

        if (updateAttribute) {
          if (endpoint.Attributes[updateAttribute] && endpoint.Attributes[updateAttribute][0]) {
            var tempObject = buildSFObjectFromEndpoint(endpointID, endpoint)
            tempObject.Id = endpoint.Attributes[updateAttribute][0]
            endpointsToUpdate.push(tempObject)

            pinpointEvents[endpointID] = createPinpointEvent(endpointID, campaignID, sfObject, 'update')
          }
        }
      })

      if (endpointsToUpdate.length === 1) {
        // Just a single record to update, so make single API call
        console.log('Found Single Object to Update:')

        conn.sobject(sfObject).update(endpointsToUpdate[0], function (err, ret) {
          console.log(JSON.stringify(ret))
          if (err || !ret.success) {
            console.error(err, ret)
          } else {
            console.log('Updated record id : ' + ret.id)
          }
          resolve()
        })
      } else if (endpointsToUpdate.length > 1) {
        // Multiple records to update, so make use of bulk api to optimize API call limits.

        console.log('Found Multiple Objects to Update')

        conn.bulk.load(sfObject, 'update', endpointsToUpdate, function (err, rets) {
          if (err) {
            console.error(err)
          } else {
            for (var i = 0; i < rets.length; i++) {
              console.log(JSON.stringify(rets[i]))
              if (rets[i].success) {
                console.log('#' + (i + 1) + ' updated successfully, id = ' + rets[i].id)
              } else {
                console.log('#' + (i + 1) + ' update error occurred, message = ' + rets[i].errors.join(', '))
              }
            }
          }
          resolve()
        })
      } else {
        // Nothing to process...just return
        resolve()
      }
    } catch (ex) {
      reject(ex)
    }
  })
}

function createPinpointEvent (endpointID, campaignID, objectType, action) {
  var customEvent = {
    Endpoint: {},
    Events: {}
  }

  customEvent.Events[`salesforce_${endpointID}_${campaignID}`] = {
    EventType: 'salesforce.push',
    Timestamp: moment().toISOString(),
    Attributes: {
      campaignID: campaignID,
      objectType: objectType,
      action: action
    }
  }
  return customEvent
}

function processEvents (applicationId, events) {
  return new Promise((resolve) => {
    var params = {
      ApplicationId: applicationId,
      EventsRequest: {
        BatchItem: events
      }
    }

    pinpoint.putEvents(params, function (err) {
      if (err) {
        console.log(err, err.stack)
        resolve() // Just going to log and return
      } else {
        resolve()
      }
    })
  })
}

function addSFObjects (event) {
  return new Promise((resolve, reject) => {
    try {
      if (event.Endpoints.length === 0) {
        resolve({ message: 'no endpoints to process' })
      }
      var params = {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: generateSFJWT()
      }

      var tokenURL = new url.URL('/services/oauth2/token', process.env.SFLOGINURL).toString()

      axios.post(tokenURL, querystring.stringify(params))
        .then(function (res) {
          var conn = new jsforce.Connection({
            instanceUrl: res.data.instance_url,
            accessToken: res.data.access_token
          })

          var sfObject = process.env.SFOBJECTTYPE
          var campaignID = event.CampaignId
          var pinpointEvents = {}

          processInserts(conn, campaignID, sfObject, event.Endpoints, pinpointEvents)
            .then(function () {
              return processUpdates(conn, campaignID, sfObject, event.Endpoints, pinpointEvents)
            })
            .then(function () {
              return processEvents(event.ApplicationId, pinpointEvents)
            })
            .then(function () {
              resolve({ message: 'success' })
            })
            .catch(function (err) {
              console.error(`unhandled exception updating salesforce: ${JSON.stringify(err)}`)
              reject({ message: `unhandled exception: ${err}` })
            })
        })
        .catch(function (err) {
          console.error(`error getting token: ${JSON.stringify(err)}`)
          reject({ message: `error getting token: ${err}` })
        })
    } catch (err) {
      console.error(`unknown error: ${JSON.stringify(err)}`)
      reject({ message: `unknown error: ${JSON.stringify(err)}` })
    }
  })
}

exports.handler = async (event, context) => {
  console.log(JSON.stringify(event))
  var body = await addSFObjects(event)

  response = {
    statusCode: 200,
    body: JSON.stringify(body)
  }

  return response
}
