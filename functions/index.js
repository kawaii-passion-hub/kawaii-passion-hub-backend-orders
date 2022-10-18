/* eslint-disable require-jsdoc */
const fetch = require("node-fetch");
const functions = require("firebase-functions");

// The Firebase Admin SDK to access Realtime Database.
const admin = require("firebase-admin");
const newOrderTopic = "new_order";
/* const serviceAccount = require("./service_acounts/serviceAccount.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://kawaii-passion-hub-orders-default-rtdb.firebaseio.com",
}); */
admin.initializeApp();

const authApp = admin.initializeApp({projectId: "kawaii-passion-hub-auth"},
    "kawaii-passion-hub-auth");

exports.mirrorCron = functions
    .runWith({
      secrets: ["API_ID", "API_SECRET"],
      timeoutSeconds: 540,
    })
    .pubsub.schedule("every 15 minutes")
    .onRun(async (_) => {
      const orders = await fetchOrders();

      const db = admin.database();
      await db.ref("orders").update(orders,
          (error) => {
            if (error) {
              console.error("Could not write to database", error);
            }
          });

      let openOrders = 0;
      for (const orderId in orders) {
        if (orders[orderId].stateMachineState.name == "Open") {
          openOrders+=1;
        }
      }

      await db.ref("public/ordersSummary").update({open: openOrders},
          (error) => {
            if (error) {
              console.error("Could not write to database", error);
            }
          });

      console.log("Updated orders.");
    });

exports.authenticate = functions.https.onCall(async (data, _) => {
  const originalJwt = data.jwt;
  let token = {};
  try {
    token = await admin.auth(authApp).verifyIdToken(originalJwt);
  } catch (error) {
    console.error(error);
    throw new functions.https.HttpsError("invalid-argument",
        "The provided JWT was invalid", error);
  }
  const uid = token.user_id;
  const customClaims = {};
  if (token.whitelisted !== undefined) {
    customClaims.whitelisted = token.whitelisted;
  }

  const notification = data.notification;
  if (token.whitelisted && notification != undefined) {
    const response = await admin.messaging().subscribeToTopic(notification,
        newOrderTopic);
    if (response.failureCount == 0) {
      console.log(`Successfully subscribed token ${notification}.`);
    } else {
      console.log(`Errors while subscribing token ${notification}.`);
      response.errors.forEach((error) => {
        console.error(`${error.error.code}: ${error.error.message}`);
        console.log(error.error.stack);
      });
    }
  }

  try {
    const customToken = await admin.auth().createCustomToken(uid, customClaims);
    return customToken;
  } catch (error) {
    console.error(error);
    throw new functions.https.HttpsError("internal",
        "Could not create custom token.", error);
  }
});

exports.newOrder = functions.database.ref("/orders/{orderId}")
    .onCreate(async (snapshot, context) => {
      console.log(`Sending message for new order ${context.params.orderId}.`);
      try {
        const order = snapshot.val();
        const body = `${order.address.firstName} ${order.address.lastName} `+
        `created an order for ${order.price.netPrice}€ (${order.orderNumber})`;
        const message = {
          notification: {
            title: "New order",
            body: body,
          },
          data: {
            id: context.params.orderId,
          },
          topic: newOrderTopic,
        };
        const messageId = await admin.messaging().send(message);
        console.log(`Successfully send ${messageId}.`);
      } catch (error) {
        console.error("Error sending message.", error);
      }
    });

async function fetchOrders() {
  const auth = await shopLogin();
  const body = await getOrders(auth);

  const orders = Object.fromEntries(body.data
      .map((p) => [p.attributes.orderNumber.replace(/\./g, "-"),
        p.attributes]));
  const included = Object.fromEntries(body.included
      .map((p) => [p.id, p.attributes]));

  console.log(`Completing ${Object.keys(orders).length} orders.`);
  await parallelForEach(body.data, async (order) => {
    const orderNumber = order.attributes.orderNumber.replace(/\./g, "-");
    orders[orderNumber].stateMachineState = included[order.attributes.stateId];
    orders[orderNumber].orderCustomer = included[order.relationships
        .orderCustomer.data.id];
    orders[orderNumber].lineItemsUrl = order.relationships
        .lineItems.links.related;
    orders[orderNumber].addressUrl = order.relationships
        .addresses.links.related;
    orders[orderNumber].deliveryUrl = order.relationships
        .deliveries.links.related;
    orders[orderNumber].documentsUrl = order.relationships
        .documents.links.related;
    await completeOrder(orders[orderNumber], auth);
  }, 5);

  return orders;
}

async function completeOrder(order, auth) {
  let details = await getShopApiResponse(auth, order.lineItemsUrl, true);
  const items = Object.fromEntries(await Promise.all(details.data
      .map(async (p) => [p.id, await getAttributesWithWeight(p)])));
  order.lineItems = items;
  delete order.lineItemsUrl;

  details = await getShopApiResponse(auth, order.documentsUrl, true);
  const invoiceNumber = details.data
      .find((d) => d.attributes.config.name === "invoice")
      ?.attributes.config.custom.invoiceNumber;
  if (invoiceNumber) {
    order.invoiceNumber = invoiceNumber;
  }
  delete order.documentsUrl;

  details = await getShopApiResponse(auth, order.addressUrl, true);
  order.address = details.data[0].attributes;
  delete order.addressUrl;

  let countryDetails = await getShopApiResponse(auth, details.data[0]
      .relationships.country.links.related, true);
  order.address.country = countryDetails.data[0].attributes;

  if (order.address.countryStateId) {
    countryDetails = await getShopApiResponse(auth, details.data[0]
        .relationships.countryState.links.related, true);
    order.address.countryState = countryDetails.data[0].attributes;
  }

  details = await getShopApiResponse(auth, order.deliveryUrl, true);
  order.deliveries = details.data[0].attributes;
  order.deliveries.stateMachineState =
    details.included.find((i) => i.type == "state_machine_state").attributes;
  delete order.deliveryUrl;

  details = await getShopApiResponse(auth, details.data[0].relationships
      .shippingMethod.links.related, true);
  order.deliveries.shippingMethod = details.data[0].attributes;

  async function getAttributesWithWeight(lineItem) {
    const result = lineItem.attributes;
    if (result.productId) {
      const details = await getShopApiResponse(auth, lineItem.relationships
          .product.links.related, true);
      result.weight = details.data[0].attributes.weight??0.0;
    }
    return result;
  }
}

async function parallelForEach(array, callback, maxParallel) {
  const chunks = partition(array, maxParallel);
  await Promise.all(chunks.map((c) => asyncForEach(c, callback)));
}

function partition(arr, partitions) {
  const chunkSize = arr.length / partitions;
  const res = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    res.push(chunk);
  }
  return res;
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

async function getOrders(auth) {
  return await getShopApiResponse(auth, "/api/order?");
}

async function getShopApiResponse(auth, endpoint, absolute=false) {
  const url = absolute ? endpoint : `${process.env.SHOP_URL}${endpoint}`;
  const body = await fetch(url,
      {
        method: "GET",
        headers: {
          "Authorization": auth,
          "Content-Type": "application/json",
          "Accept": "*/*",
        },
      }).then((response) => {
    if (response.status != 200) {
      throw new functions.https.HttpsError("permission-denied",
          `Shop API Error: ${url} ${response.status} ${response.statusText}`);
    }
    return response.json();
  });

  if (!body || !body.data) {
    throw new functions.https.HttpsError("internal",
        `Unexpected ${url} data :/`, body);
  }

  return body;
}

async function shopLogin() {
  const body = await fetch(`${process.env.SHOP_URL}/api/oauth/token`,
      {
        method: "POST",
        headers: {
          "Authorization": "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: process.env.API_ID,
          client_secret: process.env.API_SECRET,
        }),
      }).then((response) => {
    if (response.status != 200) {
      throw new functions.https.HttpsError("permission-denied",
          `Authentification Error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  });

  if (!body || !body.token_type || !body.access_token) {
    throw new functions.https.HttpsError("internal",
        "Unexpected auth data :/", body);
  }

  return `${body.token_type} ${body.access_token}`;
}
