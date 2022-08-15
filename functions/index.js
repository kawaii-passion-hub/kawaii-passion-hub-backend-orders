const fetch = require('node-fetch');
// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions');

// The Firebase Admin SDK to access Realtime Database.
const admin = require('firebase-admin');
admin.initializeApp();

exports.mirrorCron = functions.pubsub.schedule('every 5 minutes').onRun((context) => {
    console.log('This will be run every 5 minutes!');

    return null;
});

// On sign up.
exports.processSignUp = functions.auth.user().onCreate(async (user) => {
    var db = admin.database();
    var whitelisted = await db.ref('users/whitelisted').get();

    // Check if user meets role criteria.
    if (user.email &&
        user.emailVerified &&
        whitelisted.val().includes(user.email)
    ) {
      const customClaims = {
        whitelisted: true
      };
  
      try {
        // Set custom user claims on this newly created user.
        await admin.auth().setCustomUserClaims(user.uid, customClaims);
  
        // Update real-time database to notify client to force refresh.
        const metadataRef = db.ref('metadata/' + user.uid);
  
        // Set the refresh time to the current UTC timestamp.
        // This will be captured on the client to force a token refresh.
        await  metadataRef.set({refreshTime: new Date().getTime()});
      } catch (error) {
        console.log(error);
      }
    }
  });

exports.mirrorTest = functions.runWith({ secrets: ["API_ID", "API_SECRET"] }).https.onRequest(async (req, res) => {
    let body = '';

    await shopLogin().then(data => body = data).catch(err => res.status(400).end(JSON.stringify(err)));

    if (!body || !body.token_type || !body.access_token) {
        return res.status(404).end('Unable to fetch the app data :/');
    }

    const auth = `${body.token_type} ${body.access_token}`;
    
    await getProducts(auth).then(data => body = data).catch(err => res.status(400).end(JSON.stringify(err)));
    var products = Object.fromEntries(body.data.map((p) => [p.productNumber.replace(/\./g,"-"), p]));

    if (!body || !body.data) {
        return res.status(404).end('Unable to fetch the app data :/');
    }
    
    body = '';
    await getOrders(auth).then(data => body = data).catch(err => res.status(400).end(JSON.stringify(err)));
    var orders = Object.fromEntries(body.data.map((p) => [p.orderNumber.replace(/\./g,"-"), p]));

    if (!body || !body.data) {
        return res.status(404).end('Unable to fetch the app data :/');
    }

    var db = admin.database();
    await db.ref().update({
        products: products,
        orders: orders
    }, (error) => {
        if (error) {
          body = error;
        }
        else {
            body = "Sucessfully added data";
        }
    });

    res.send(body);
});

exports.logOrderCreation = functions.database.ref('orders/{id}')
    .onCreate((snapshot, context) => {
        console.log(`Order created occured ${snapshot.toJSON()}`);
        return null;
    });

exports.logorderStateChange = functions.database.ref('orders/{id}/stateId')
    .onUpdate((change, context) => {
        console.log(`Order state changed ${change.before.toJSON()} -> ${change.after.toJSON()}`);
        return null;
    });

async function getProducts(auth) {
    return await getShopApiResponse(auth, '/api/product?');
}

async function getOrders(auth) {
    return await getShopApiResponse(auth, '/api/order?');
}

async function getShopApiResponse(auth, endpoint) {
    return await fetch(`${process.env.SHOP_URL}${endpoint}`,
    {
        method: 'GET',
        headers: {
            'Authorization': auth,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    }).then (response => {
        if (response.status != 200){
            throw `fetch Error: ${response.status} ${response.statusText}`
        }
        return response.json();
    });
}

async function shopLogin() {
    return await fetch(`${process.env.SHOP_URL}/api/oauth/token`,
    {
        method: 'POST',
        headers: {
            'Authorization': '',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: process.env.API_ID,
            client_secret: process.env.API_SECRET
        })
    }).then (response => {
        if (response.status != 200){
            throw `fetch Error: ${response.status} ${response.statusText}`
        }
        return response.json();
    });
}