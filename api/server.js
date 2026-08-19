// Imports
const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const queryString = require("query-string");
const path = require("path");
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "../public"), {
  setHeaders(res, filePath) {
    // Long-cache assets, but never the HTML pages themselves
    if (!filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  }
}));

// Drip Client
const client = require("drip-nodejs")({
  token: process.env.DRIPTOKEN,
  accountId: process.env.DRIPACCOUNT
});

// Meraki AP MAC address -> park location (list provided by IT, 2026-08-18)
const AP_LOCATIONS = {
  "e0:cb:bc:4a:fb:68": "Apgar",
  "ac:17:c8:10:ee:c3": "Many Glacier",
  "ac:17:c8:10:ef:0b": "Belton / Depot",
  "ac:17:c8:10:ef:0c": "St Mary"
};

// Express Middleware  - BodyParser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// GET '/' Endpoint
app.get(["/", "/apgar", "/depot", "/stmary"], (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "index.html"));
});

// GET error page
app.get("*", (req, res) => {
  res.status(404).sendFile(path.join(__dirname, "../public", "404.html"));
});

// POST Endpoint
app.post(["/", "/submit", "/depot", "/stmary"], (req, res) => {
  const getHost = url => {
    return url.replace(/^((\w+:)?\/\/[^\/]+\/?).*$/, "$1");
  };

  // Parse URL to Get Queries
  const referer = req.get("referer");
  if (!referer) {
    return res.status(404).sendFile(path.join(__dirname, "../public", "404.html"));
  }
  const query = referer.replace(getHost(referer), "");
  const parsedQuery = queryString.parse(query);
  const base_grant_url = parsedQuery.base_grant_url;
  const node_mac = parsedQuery.node_mac;
  const client_ip = parsedQuery.client_ip;
  const client_mac = parsedQuery.client_mac;
  const location = AP_LOCATIONS[(node_mac || "").toLowerCase()];
  console.log('Email:', req.body.email);
  console.log('Node Mac:', node_mac, '->', location || 'Unknown');

  if (!base_grant_url) {
    return res.status(404).sendFile(path.join(__dirname, "../public", "404.html"));
  }

  // After Meraki grants access, send the guest to the Conservancy's connected page
  const loginUrl = base_grant_url
    + "?continue_url=" + encodeURIComponent("https://glacier.org/connected/")
    + "&duration=1800";

  // Get Drip Payload
  // drip-nodejs v3 wraps these into {subscribers: [...]} / {events: [...]} itself,
  // so pass the bare subscriber/event objects (v2 required pre-wrapped payloads)
  const subscriberPayload = {
    email: req.body.email,
    tags: ["Gated Login"],
  };
  if (location) {
    subscriberPayload.custom_fields = { wifi_location: location };
  }

  const eventPayload = {
    email: req.body.email,
    action: 'Wifi Login',
    properties: {
      location: location || "Unknown",
      node_mac: node_mac || "unknown",
    },
  };

  // Send Drip Info and Redirect. The two Drip calls run in parallel, and a
  // Drip failure must not block the guest's WiFi access - always redirect.
  Promise.all([
    client.createUpdateSubscriber(subscriberPayload),
    client.recordEvent(eventPayload)
  ])
    .then(([subscriberResponse, eventResponse]) => {
      console.log("Drip createUpdateSubscriber response code:", subscriberResponse.status);
      console.log("Drip recordEvents response code:", eventResponse.status);
    })
    .catch(error => {
      console.error("Error in Drip operations:", error.message);
      if (error.response) {
        console.error("Error details:", error.response.data);
      }
    })
    .then(() => {
      res.redirect(303, loginUrl);
    });
});

// Start Server
app.listen(port, () => {
  console.log("Listening on " + port);
});