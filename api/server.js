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

// Session cooldown: after a guest's 30-minute session ends, their device
// (client_mac) must wait before it can sign in again. State lives in
// Upstash Redis (Vercel Marketplace) via its REST API; every failure path
// fails OPEN so a storage problem never blocks park WiFi.
const SESSION_SECONDS = 1800;
const COOLDOWN_SECONDS = parseInt(process.env.WIFI_COOLDOWN_SECONDS || "1800", 10);
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const fs = require("fs");
const cooldownTemplate = fs.readFileSync(path.join(__dirname, "cooldown.html"), "utf8");

async function kv(command) {
  if (!KV_URL || !KV_TOKEN) return null; // not configured -> cooldown disabled
  try {
    const response = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("KV responded " + response.status);
    return (await response.json()).result;
  } catch (error) {
    console.error("KV error (failing open):", error.message);
    return null;
  }
}

// Returns null if the grant may proceed, or minutes remaining if cooling down.
// Records the grant timestamp on a device's first grant of a session.
async function checkCooldown(client_mac) {
  if (!client_mac) return null;
  const key = "grant:" + client_mac.toLowerCase();
  const grantedAt = await kv(["GET", key]);
  const now = Math.floor(Date.now() / 1000);
  if (grantedAt) {
    const age = now - parseInt(grantedAt, 10);
    if (age >= SESSION_SECONDS) {
      return Math.max(1, Math.ceil((SESSION_SECONDS + COOLDOWN_SECONDS - age) / 60));
    }
    return null; // mid-session re-splash (e.g. roaming between APs): allow, keep original clock
  }
  await kv(["SET", key, String(now), "EX", String(SESSION_SECONDS + COOLDOWN_SECONDS)]);
  return null;
}

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
app.post(["/", "/submit", "/depot", "/stmary"], async (req, res) => {
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

  // Enforce the post-session cooldown for this device
  const cooldownMinutes = await checkCooldown(client_mac);
  if (cooldownMinutes !== null) {
    console.log("Cooldown active for", client_mac, "-", cooldownMinutes, "min left");
    return res.status(429).send(cooldownTemplate.replace(/{{minutes}}/g, String(cooldownMinutes)));
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
  const recordTasks = [
    client.createUpdateSubscriber(subscriberPayload),
    client.recordEvent(eventPayload)
  ];
  if (!location && node_mac) {
    // Unmapped AP: remember its MAC so it can be identified and added to AP_LOCATIONS
    recordTasks.push(kv(["SADD", "wifi:unknown_macs", node_mac.toLowerCase()]));
  }
  Promise.all(recordTasks)
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