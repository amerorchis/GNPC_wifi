// Imports
const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const queryString = require("query-string");
const path = require("path");
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "../public")));

// Drip Client
const client = require("drip-nodejs")({
  token: process.env.DRIPTOKEN,
  accountId: process.env.DRIPACCOUNT
});

// Express Middleware  - BodyParser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve Static Files
app.use(express.static("public"));

// GET '/' Endpoint
app.get(["/", "/apgar", "/depot", "/stmary"], (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "index.html"));
});

// GET error page
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "404.html"));
});

// POST Endpoint
app.post(["/", "/submit", "/depot", "/stmary"], (req, res) => {
  const getHost = url => {
    return url.replace(/^((\w+:)?\/\/[^\/]+\/?).*$/, "$1");
  };

  // Parse URL to Get Queries
  const referer = req.get("referer");
  const query = referer.replace(getHost(referer), "");
  const parsedQuery = queryString.parse(query);
  const base_grant_url = parsedQuery.base_grant_url;
  const user_continue_url = parsedQuery.user_continue_url;
  const node_mac = parsedQuery.node_mac;
  const client_ip = parsedQuery.client_ip;
  const client_mac = parsedQuery.client_mac;
  console.log('Email:', req.body.email);
  console.log('Node Mac:', node_mac);

  if (!base_grant_url) {
    return res.sendFile(path.join(__dirname, "../public", "404.html"));
  }

  let loginUrl = base_grant_url;
  if (user_continue_url) {
    loginUrl += "?continue_url=" + user_continue_url + "&duration=1800";
  }

  // Get Drip Payload
  const subscriberPayload = {
    subscribers: [
      {
        email: req.body.email,
        tags: ["Gated Login"],
      }
    ]
  };

  const eventPayload = {
    events: [
      {
        email: req.body.email,
        action: 'Wifi Login',
      }
    ]
  };

  // Send Drip Info and Redirect
  client
    .createUpdateSubscriber(subscriberPayload)
    .then(response => {
      console.log("Drip createUpdateSubscriber response code:", response.statusCode);
      return client.recordEvent(eventPayload);
    })
    .then(eventResponse => {
      console.log("Drip recordEvents response code:", eventResponse.statusCode);
      res.redirect(303, loginUrl);
    })
    .catch(error => {
      console.error("Error in Drip operations:", error.message);
      if (error.response) {
        console.error("Error details:", error.response.body);
      }
      res.status(500).send("An error occurred while processing your request.");
    });
});

// Start Server
app.listen(port, () => {
  console.log("Listening on " + port);
});