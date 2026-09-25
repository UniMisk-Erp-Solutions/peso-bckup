/**

 * Local-only architecture lab — CommonJS (Node 6+).

 * Does NOT modify production peso-bckup main, Vercel, or .46/.68 configs.

 * Branch priyanshu — L7 dual-stack (replaces greatest) + current leastconn demo.

 */

var http = require("http");

var https = require("https");

var urlMod = require("url");



var LAB_PORT = 8787;

var CACHE_TTL_MS = 5000;

var cache = {};

var APP46 = "http://192.168.23.46:54321";

var APP68 = "http://192.168.23.68:54321";

var BACKENDS = [

  { id: "app46", url: APP46 },

  { id: "app68", url: APP68 },

];

var connCount = { app46: 0, app68: 0 };

var readSplitCounter = 0;

var net = require("net");

var SIDECARS = {

  redis46: { host: "127.0.0.1", port: 6379, role: "Local Redis (server .46 slot)" },

  redis68: { host: "127.0.0.1", port: 6380, role: "Local Redis (server .68 slot)" },

  pgbouncer46: { host: "127.0.0.1", port: 6432, role: "PgBouncer (.46 slot)" },

  pgbouncer68: { host: "127.0.0.1", port: 6433, role: "PgBouncer (.68 slot)" },

};

var stats = {

  current: 0,

  l7Dual: 0,

  byBackend: { app46: 0, app68: 0, other: 0 },

};

function tcpOpen(host, port, timeoutMs, cb) {

  var done = false;

  var sock = net.createConnection({ host: host, port: port });

  function finish(ok) {

    if (done) return;

    done = true;

    try {

      sock.destroy();

    } catch (e) {}

    cb(ok);

  }

  sock.setTimeout(timeoutMs || 400);

  sock.on("connect", function () {

    finish(true);

  });

  sock.on("timeout", function () {

    finish(false);

  });

  sock.on("error", function () {

    finish(false);

  });

}

function probeSidecars(cb) {

  var keys = Object.keys(SIDECARS);

  var out = {};

  var left = keys.length;

  keys.forEach(function (k) {

    var s = SIDECARS[k];

    tcpOpen(s.host, s.port, 400, function (ok) {

      out[k] = { up: ok, port: s.port, role: s.role };

      left--;

      if (left === 0) cb(out);

    });

  });

}



function corsHeaders(req) {

  var origin = req.headers.origin || "*";

  return {

    "access-control-allow-origin": origin,

    "access-control-allow-credentials": "true",

    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",

    "access-control-allow-headers":

      "apikey,authorization,content-type,x-client-info,x-supabase-api-version,accept,prefer,x-upsert",

    "access-control-max-age": "86400",

  };

}



function writeHeadCors(req, res, code, extra) {

  var h = corsHeaders(req);

  if (extra) {

    for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k];

  }

  res.writeHead(code, h);

}



function pickBackendLeastconn() {

  var best = BACKENDS[0];

  for (var i = 0; i < BACKENDS.length; i++) {

    if (connCount[BACKENDS[i].id] < connCount[best.id]) best = BACKENDS[i];

  }

  connCount[best.id]++;

  return best;

}



function releaseBackend(id) {

  connCount[id] = Math.max(0, (connCount[id] || 0) - 1);

}



/** L7 dual: writes/auth → .46; REST reads 50% .46 primary / 50% .68 replica */

function l7DualRoute(method, pathname) {

  method = (method || "GET").toUpperCase();

  var p = pathname || "/";

  if (p.indexOf("/auth/v1") === 0) {

    return { id: "app46-auth", url: APP46 };

  }

  if (p.indexOf("/storage/v1") === 0) {

    return { id: "app46-storage", url: APP46 };

  }

  if (p.indexOf("/realtime/v1") === 0) {

    return { id: "app46-realtime", url: APP46 };

  }

  if (p.indexOf("/rest/v1") === 0 || p.indexOf("/graphql/v1") === 0) {

    if (

      method === "POST" ||

      method === "PUT" ||

      method === "PATCH" ||

      method === "DELETE"

    ) {

      return { id: "app46-primary-write", url: APP46 };

    }

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {

      readSplitCounter++;

      if (readSplitCounter % 2 === 0) {

        return { id: "app46-primary-read-50", url: APP46 };

      }

      return { id: "app68-replica-read-50", url: APP68 };

    }

  }

  return pickBackendLeastconn();

}



function bumpStats(mode, backendId) {

  if (mode === "l7-dual") stats.l7Dual++;

  else stats.current++;

  if (backendId.indexOf("app68") === 0 || backendId === "app68") {

    stats.byBackend.app68++;

  } else if (backendId.indexOf("app46") === 0 || backendId === "app46") {

    stats.byBackend.app46++;

  } else stats.byBackend.other++;

}



function proxyRequest(targetBase, reqPath, headers, body, onDone) {

  var target = urlMod.parse(targetBase + reqPath);

  var lib = target.protocol === "https:" ? https : http;

  var opts = {

    method: headers.method || "GET",

    hostname: target.hostname,

    port: target.port || 80,

    path: target.path,

    headers: headers,

    timeout: 30000,

  };

  var preq = lib.request(opts, function (pres) {

    var chunks = [];

    pres.on("data", function (c) {

      chunks.push(c);

    });

    pres.on("end", function () {

      onDone(null, pres.statusCode || 502, Buffer.concat(chunks));

    });

  });

  preq.on("error", function (err) {

    onDone(err);

  });

  if (body && body.length) preq.write(body);

  preq.end();

}



function handleGateway(mode, reqPath, req, body, res) {

  var fwd = {

    method: req.method,

    apikey: req.headers.apikey,

    authorization: req.headers.authorization,

    accept: req.headers.accept || "application/json",

    "content-type": req.headers["content-type"],

  };

  var useLeastconn = mode === "current";

  var backend;

  var usedLeastconn = false;

  if (useLeastconn) {

    backend = pickBackendLeastconn();

    usedLeastconn = true;

  } else {

    backend = l7DualRoute(req.method, reqPath);

    if (backend.id === "app46" || backend.id === "app68") usedLeastconn = true;

  }

  bumpStats(mode, backend.id);

  var cacheKey = mode + ":" + req.method + ":" + reqPath + ":" + (fwd.authorization || "");

  var hit = cache[cacheKey];

  if (req.method === "GET" && hit && hit.expires > Date.now()) {

    writeHeadCors(req, res, 200, {

      "x-lab-arch": mode,

      "x-lab-backend": hit.backend,

      "x-lab-cache": "HIT",

    });

    res.end(hit.body);

    if (usedLeastconn) releaseBackend(backend.id);

    return;

  }

  proxyRequest(backend.url, reqPath, fwd, body, function (err, code, buf) {

    if (usedLeastconn) releaseBackend(backend.id);

    if (err) {

      writeHeadCors(req, res, 502, {

        "x-lab-arch": mode,

        "x-lab-backend": backend.id,

      });

      res.end(backend.id + ": " + err.message);

      return;

    }

    if (req.method === "GET" && code === 200) {

      cache[cacheKey] = {

        body: buf,

        backend: backend.id,

        expires: Date.now() + CACHE_TTL_MS,

      };

    }

    writeHeadCors(req, res, code, {

      "x-lab-arch": mode,

      "x-lab-backend": backend.id,

      "x-lab-cache": "MISS",

    });

    res.end(buf);

  });

}



function handleL7Path(parsed, req, body, res) {

  var prefix = parsed.pathname.indexOf("/lab/l7-dual/") === 0 ? "/lab/l7-dual/" : "/lab/greatest/";

  var pg = parsed.pathname.replace(prefix, "/") + (parsed.search || "");

  if (pg.indexOf("/") !== 0) pg = "/" + pg;

  handleGateway("l7-dual", pg, req, body, res);

}



var dashboardHtml =

  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>PesoWise Local Lab (priyanshu)</title>" +

  "<style>body{font-family:system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}pre{background:#111;color:#0f0;padding:1rem;font-size:12px}" +

  ".tag{display:inline-block;padding:2px 8px;border-radius:4px;margin-right:6px;font-size:12px}" +

  ".cur{background:#dbeafe}.l7{background:#dcfce7}button{margin:4px;padding:8px 12px}</style></head><body>" +

  "<h1>Localhost arch lab <span class=\"tag l7\">L7 dual-stack</span></h1>" +

  "<p>No changes to production or <strong>main</strong> repo. LAN Kong .46 / .68 if reachable.</p>" +

  "<p><span class=\"tag cur\">current</span><code>/lab/current/</code> — blind leastconn (prod-like LB)</p>" +

  "<p><span class=\"tag l7\">l7-dual</span><code>/lab/l7-dual/</code> — writes/auth→.46; REST reads 50% .46 / 50% .68</p>" +

  "<p><code>/lab/greatest/</code> alias of <code>l7-dual</code> (legacy URL)</p>" +

  "<input id=\"key\" style=\"width:100%\" placeholder=\"Pesowise anon key\">" +

  "<br><br><button onclick=\"runCur()\">10 GET current</button> <button onclick=\"runL7()\">10 GET l7-dual</button> " +

  "<button onclick=\"runMix()\">20 mixed l7-dual</button> <button onclick=\"loadStats()\">Stats</button>" +

  "<pre id=\"out\">Ready</pre><script>" +

  "async function hit(u,k,m){m=m||'GET';var o={method:m,headers:{}};if(k){o.headers.apikey=k;o.headers.Authorization='Bearer '+k;}" +

  "if(m!=='GET'&&m!=='HEAD')o.headers['Content-Type']='application/json';if(m==='POST')o.body='{}';" +

  "var t0=Date.now();var r=await fetch(u,o);return {status:r.status,ms:Date.now()-t0,arch:r.headers.get('x-lab-arch'),backend:r.headers.get('x-lab-backend')};}" +

  "async function runCur(){var k=document.getElementById('key').value.trim();var L=[];for(var i=0;i<10;i++)L.push(JSON.stringify(await hit('/lab/current/rest/v1/',k)));document.getElementById('out').textContent=L.join('\\n');}" +

  "async function runL7(){var k=document.getElementById('key').value.trim();var L=[];for(var i=0;i<10;i++)L.push(JSON.stringify(await hit('/lab/l7-dual/rest/v1/',k)));document.getElementById('out').textContent=L.join('\\n');}" +

  "async function runMix(){var k=document.getElementById('key').value.trim();var L=[];var paths=[['/lab/l7-dual/rest/v1/','GET'],['/lab/l7-dual/auth/v1/health','GET'],['/lab/l7-dual/auth/v1/settings','GET'],['/lab/l7-dual/rest/v1/rpc/x','POST']];" +

  "for(var i=0;i<20;i++){var p=paths[i%paths.length];L.push(JSON.stringify(await hit(p[0],k,p[1])));}document.getElementById('out').textContent=L.join('\\n');}" +

  "async function loadStats(){document.getElementById('out').textContent=await (await fetch('/lab/stats')).text();}" +

  "</script></body></html>";



var server = http.createServer(function (req, res) {

  var parsed = urlMod.parse(req.url, true);

  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });

    res.end(dashboardHtml);

    return;

  }

  if (parsed.pathname === "/lab/stats") {

    probeSidecars(function (sidecars) {

      res.writeHead(200, { "content-type": "application/json" });

      res.end(

        JSON.stringify({

          branch: "priyanshu",

          architecture: "l7-dual-stack+redis+pgbouncer",

          port: LAB_PORT,

          backends: { app46: APP46, app68: APP68 },

          sidecars: sidecars,

          sidecarsStart: "docker compose -f docker-compose.l7.yml up -d",

          stats: stats,

          connCount: connCount,

          readSplitCounter: readSplitCounter,

        })

      );

    });

    return;

  }



  var bodyChunks = [];

  req.on("data", function (d) {

    bodyChunks.push(d);

  });

  req.on("end", function () {

    if (req.method === "OPTIONS") {

      writeHeadCors(req, res, 204, {});

      res.end();

      return;

    }

    var body = Buffer.concat(bodyChunks);

    var pathCurrent = "/lab/current/";

    var pathLegacy = "/lab/proxy/";



    if (parsed.pathname.indexOf("/lab/direct/46") === 0) {

      var p46 = parsed.pathname.replace("/lab/direct/46", "") + (parsed.search || "");

      var fwd46 = {

        method: req.method,

        apikey: req.headers.apikey,

        authorization: req.headers.authorization,

        accept: req.headers.accept || "application/json",

      };

      proxyRequest(APP46, p46, fwd46, body, function (err, code, buf) {

        if (err) {

          res.writeHead(502);

          res.end(String(err.message));

          return;

        }

        res.writeHead(code, { "x-lab-backend": "app46-direct" });

        res.end(buf);

      });

      return;

    }



    if (

      parsed.pathname.indexOf("/lab/l7-dual/") === 0 ||

      parsed.pathname.indexOf("/lab/greatest/") === 0

    ) {

      handleL7Path(parsed, req, body, res);

      return;

    }



    if (

      parsed.pathname.indexOf(pathCurrent) === 0 ||

      parsed.pathname.indexOf(pathLegacy) === 0

    ) {

      var prefix =

        parsed.pathname.indexOf(pathCurrent) === 0 ? pathCurrent : pathLegacy;

      var pc = parsed.pathname.replace(prefix, "/") + (parsed.search || "");

      if (pc.indexOf("/") !== 0) pc = "/" + pc;

      handleGateway("current", pc, req, body, res);

      return;

    }



    res.writeHead(404, { "content-type": "text/plain" });

    res.end("Not found. Use /lab/current/ or /lab/l7-dual/");

  });

});



server.listen(LAB_PORT, "127.0.0.1", function () {

  console.log("PesoWise local arch lab — L7 dual-stack (priyanshu)");

  console.log("  http://127.0.0.1:" + LAB_PORT + "/");

  console.log("  l7-dual:  /lab/l7-dual/rest/v1/");

  console.log("  current:  /lab/current/rest/v1/");

  console.log("  LAN Kong: " + APP46 + " | " + APP68);

  console.log("  Sidecars: docker compose -f docker-compose.l7.yml up -d");

  console.log("  Redis .46/.68 -> :6379 / :6380 | PgBouncer -> :6432 / :6433");

});


