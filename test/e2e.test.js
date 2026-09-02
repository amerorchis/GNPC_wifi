// End-to-end test: real server.js + drip-nodejs v3, Drip API + Upstash REST mocked locally.
const http = require("http");
const assert = require("assert");

const path = require("path");
const REPO = path.join(__dirname, "..");
const captured = [];

// --- Drip API mock ---
const dripMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : null;
    captured.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
    const failing = JSON.stringify(parsed || {}).includes("dripfail");
    res.writeHead(failing ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(failing ? { errors: ["boom"] } : { ok: true }));
  });
});

// --- Upstash Redis REST mock (cooldown state + unknown MAC set) ---
const kvStore = new Map();
let kvFail = false;
let kvSetCount = 0;
const kvMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (kvFail) { res.writeHead(500); return res.end("{}"); }
    if (req.headers.authorization !== "Bearer testkvtoken") { res.writeHead(401); return res.end("{}"); }
    const cmd = JSON.parse(body);
    let result = null;
    if (cmd[0] === "GET") {
      const e = kvStore.get(cmd[1]);
      result = e && e.exp > Date.now() / 1000 ? e.value : null;
    } else if (cmd[0] === "SET") {
      kvSetCount++;
      kvStore.set(cmd[1], { value: cmd[2], exp: Date.now() / 1000 + parseInt(cmd[4], 10) });
      result = "OK";
    } else if (cmd[0] === "SADD") {
      const set = kvStore.get(cmd[1]) || { value: new Set(), exp: Infinity };
      set.value.add(cmd[2]);
      kvStore.set(cmd[1], set);
      result = 1;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
  });
});
kvMock.listen(9998);

dripMock.listen(9999, () => {
  process.env.KV_REST_API_URL = "http://127.0.0.1:9998";
  process.env.KV_REST_API_TOKEN = "testkvtoken";
  process.env.DRIPTOKEN = "testtoken";
  process.env.DRIPACCOUNT = "1234567";
  process.env.PORT = "3123";
  require(`${REPO}/node_modules/drip-nodejs/lib/helpers.js`).baseUrl = "http://127.0.0.1:9999/";
  require(`${REPO}/api/server.js`);
  setTimeout(runTest, 400);
});

const GRANT = "https%3A%2F%2Fn143.network-auth.com%2Fsplash%2Fgrant";
const CONNECTED = "?continue_url=" + encodeURIComponent("https://glacier.org/connected/") + "&duration=1800";
const EXPECTED_LOC = "https://n143.network-auth.com/splash/grant" + CONNECTED;

function post(pathname, referer, email) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (referer) headers.Referer = referer;
  return fetch(`http://127.0.0.1:3123${pathname}`, {
    method: "POST", redirect: "manual", headers,
    body: `email=${encodeURIComponent(email)}`,
  });
}

async function runTest() {
  try {
    // 1. Happy path: unknown AP MAC; user_continue_url in referer must be ignored
    const res = await post("/",
      `https://splash.example.com/?base_grant_url=${GRANT}&user_continue_url=https%3A%2F%2Fwww.example.com%2F&node_mac=aa%3Abb&client_ip=1.2.3.4&client_mac=cc%3Add`,
      "test@example.com");
    assert.strictEqual(res.status, 303, `expected 303, got ${res.status}`);
    assert.strictEqual(res.headers.get("location"), EXPECTED_LOC);
    assert.strictEqual(captured.length, 2, `expected 2 Drip calls, got ${captured.length}`);
    const sub = captured.find((c) => c.url === "/v2/1234567/subscribers");
    const evt = captured.find((c) => c.url === "/v2/1234567/events");
    assert.ok(sub && evt, "both Drip endpoints called");
    assert.strictEqual(sub.auth, "Basic " + Buffer.from("testtoken").toString("base64"));
    assert.deepStrictEqual(sub.body, { subscribers: [{ email: "test@example.com", tags: ["Gated Login"] }] });
    assert.deepStrictEqual(evt.body, { events: [{ email: "test@example.com", action: "Wifi Login",
      properties: { location: "Unknown", node_mac: "aa:bb" } }] });

    // 1b. Known AP MAC (uppercase) -> wifi_location custom field, no location tag
    captured.length = 0;
    const resLoc = await post("/",
      `https://splash.example.com/?base_grant_url=${GRANT}&node_mac=E0%3ACB%3ABC%3A4A%3AFB%3A68`,
      "apgar@example.com");
    assert.strictEqual(resLoc.status, 303);
    const subLoc = captured.find((c) => c.url === "/v2/1234567/subscribers");
    const evtLoc = captured.find((c) => c.url === "/v2/1234567/events");
    assert.deepStrictEqual(subLoc.body, { subscribers: [{ email: "apgar@example.com",
      tags: ["Gated Login"], custom_fields: { wifi_location: "Apgar" } }] });
    assert.deepStrictEqual(evtLoc.body, { events: [{ email: "apgar@example.com", action: "Wifi Login",
      properties: { location: "Apgar", node_mac: "E0:CB:BC:4A:FB:68" } }] });
    captured.length = 0;

    // 2. Missing referer -> 404, no Drip calls
    const resNoRef = await post("/", null, "noref@example.com");
    assert.strictEqual(resNoRef.status, 404);
    assert.strictEqual(captured.length, 0);

    // 3. Referer without base_grant_url -> 404, no Drip calls
    const res2 = await post("/", "https://splash.example.com/", "test2@example.com");
    assert.strictEqual(res2.status, 404);
    assert.strictEqual(captured.length, 0);

    // 4. No user_continue_url -> same connected-page redirect
    const res3 = await post("/stmary", `https://splash.example.com/?base_grant_url=${GRANT}`, "test3@example.com");
    assert.strictEqual(res3.status, 303);
    assert.strictEqual(res3.headers.get("location"), EXPECTED_LOC);
    assert.strictEqual(captured.length, 2);

    // 5. Drip outage -> guest must STILL be redirected
    const res4 = await post("/", `https://splash.example.com/?base_grant_url=${GRANT}`, "dripfail@example.com");
    assert.strictEqual(res4.status, 303, `Drip failure must not block WiFi, got ${res4.status}`);
    assert.strictEqual(res4.headers.get("location"), EXPECTED_LOC);

    // 6. GET routes serve the splash form; self-hosted assets only
    for (const p of ["/", "/apgar", "/depot", "/stmary"]) {
      const r = await fetch(`http://127.0.0.1:3123${p}`);
      const text = await r.text();
      assert.strictEqual(r.status, 200, `GET ${p} -> ${r.status}`);
      assert.ok(text.toLowerCase().includes("<form"), `GET ${p} serves the form`);
      assert.ok(!text.includes("code.jquery.com") && !text.includes("stackpath.bootstrapcdn.com"), "no CDN scripts");
      assert.ok(text.includes("/css/bootstrap.min.css"), "local bootstrap linked");
    }

    // 7. Unknown GET path -> 404
    assert.strictEqual((await fetch("http://127.0.0.1:3123/nope")).status, 404);

    // 8. Static assets: cache headers on assets, not HTML; jpg background live
    const css = await fetch("http://127.0.0.1:3123/css/main.css");
    assert.strictEqual(css.headers.get("cache-control"), "public, max-age=86400");
    assert.ok((await css.text()).includes("glacier-background.jpg"));
    assert.strictEqual((await fetch("http://127.0.0.1:3123/img/glacier-background.jpg")).status, 200);
    assert.strictEqual((await fetch("http://127.0.0.1:3123/css/bootstrap.min.css")).status, 200);
    const home = await fetch("http://127.0.0.1:3123/");
    assert.notStrictEqual(home.headers.get("cache-control"), "public, max-age=86400");

    // 8b. Unknown AP MACs are collected for identification; known ones are not
    const unknownSet = kvStore.get("wifi:unknown_macs");
    assert.ok(unknownSet && unknownSet.value.has("aa:bb"), "unknown node_mac collected");
    assert.ok(!unknownSet.value.has("e0:cb:bc:4a:fb:68"), "known AP not collected");

    // 9a. Test 1 stored grant:cc:dd; immediate re-submit = mid-session, granted, clock not reset
    assert.ok(kvStore.has("grant:cc:dd"), "first grant recorded in KV");
    const setsBefore = kvSetCount;
    const resMid = await post("/", `https://splash.example.com/?base_grant_url=${GRANT}&client_mac=cc%3Add`, "test@example.com");
    assert.strictEqual(resMid.status, 303, "mid-session re-splash must be granted");
    assert.strictEqual(kvSetCount, setsBefore, "mid-session re-grant must not reset the clock");

    // 9b. Session used up (grant 1900s ago) -> 429 cooldown page, no Drip calls
    const now = Math.floor(Date.now() / 1000);
    kvStore.set("grant:11:22", { value: String(now - 1900), exp: now + 1700 });
    captured.length = 0;
    const resCool = await post("/", `https://splash.example.com/?base_grant_url=${GRANT}&client_mac=11%3A22`, "cooldown@example.com");
    assert.strictEqual(resCool.status, 429, `expected 429 during cooldown, got ${resCool.status}`);
    const coolBody = await resCool.text();
    assert.ok(coolBody.includes("29 minute"), "cooldown page shows remaining minutes");
    assert.ok(!coolBody.includes("{{minutes}}"), "placeholder replaced");
    assert.strictEqual(captured.length, 0, "no Drip calls during cooldown");

    // 9c. Cooldown expired -> granted again
    kvStore.delete("grant:11:22");
    assert.strictEqual((await post("/", `https://splash.example.com/?base_grant_url=${GRANT}&client_mac=11%3A22`, "cooldown@example.com")).status, 303);

    // 9d. KV outage -> fail open
    kvFail = true;
    assert.strictEqual((await post("/", `https://splash.example.com/?base_grant_url=${GRANT}&client_mac=ee%3Aff`, "kvdown@example.com")).status, 303, "KV outage must fail open");
    kvFail = false;

    // 9e. MAC case-insensitivity: uppercase CC:DD still matches mid-session grant
    const setsBefore9e = kvSetCount;
    assert.strictEqual((await post("/", `https://splash.example.com/?base_grant_url=${GRANT}&client_mac=CC%3ADD`, "test@example.com")).status, 303);
    assert.strictEqual(kvSetCount, setsBefore9e, "uppercase MAC matches lowercase grant");

    console.log("ALL TESTS PASSED");
    process.exit(0);
  } catch (err) {
    console.error("TEST FAILED:", err.message);
    console.error("Captured:", JSON.stringify(captured, null, 2));
    process.exit(1);
  }
}
