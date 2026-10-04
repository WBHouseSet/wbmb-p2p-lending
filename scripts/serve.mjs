// Serves a built site (WEB_DIR, default dist-live). Static files only: GET/HEAD, no directory
// listing, nothing outside WEB_DIR.
//
//   LISTEN           plain HTTP, comma-separated host:port (default 0.0.0.0:5000)
//   REDIRECT_LISTEN  optional HTTP listener for the router's port 80: answers Let's Encrypt
//                    challenges from ACME_DIR and sends everything else to https://PUBLIC_HOST
//   TLS_LISTEN       optional HTTPS listener for the router's port 443, with TLS_CERT/TLS_KEY;
//                    it starts only once both files exist (until the first certificate is
//                    issued the rest keeps running). Restart the service after a renewal.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const CHALLENGE = "/.well-known/acme-challenge/";

const addresses = (list) =>
  String(list || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const at = x.lastIndexOf(":");
      return { host: x.slice(0, at), port: Number(x.slice(at + 1)) };
    });

const reply = (res, code, text, headers = {}) => {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(text);
};
// The decoded path of a request, or null when it cannot be decoded.
function pathname(req) {
  try {
    return decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return null;
  }
}
// A file strictly inside `root`, or null.
function inside(root, name) {
  if (name.includes("\0")) return null;
  const file = path.join(root, name);
  return file.startsWith(root + path.sep) ? file : null;
}
function sendFile(req, res, file, headers) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return reply(res, 404, "Not Found");
    res.writeHead(200, { "Content-Length": stat.size, ...headers });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  });
}

function siteHandler(root) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return reply(res, 405, "Method Not Allowed");
    let name = pathname(req);
    if (name === null) return reply(res, 400, "Bad Request");
    if (name.endsWith("/")) name += "index.html";
    const file = inside(root, name);
    if (!file) return reply(res, 404, "Not Found");
    sendFile(req, res, file, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      // Bundle files carry a content hash in their name; the page and its settings must stay fresh.
      "Cache-Control": name.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
  };
}

// Port 80: Let's Encrypt HTTP-01 challenges, otherwise a redirect to the one configured host
// (never the request's Host header, so this cannot be used as an open redirect).
function redirectHandler(acmeDir, publicHost) {
  return (req, res) => {
    const name = pathname(req);
    if (name === null) return reply(res, 400, "Bad Request");
    if (name.startsWith(CHALLENGE)) {
      const token = name.slice(CHALLENGE.length);
      if (!acmeDir || !/^[A-Za-z0-9_-]+$/.test(token))
        return reply(res, 404, "Not Found");
      return sendFile(req, res, path.join(acmeDir, CHALLENGE, token), {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    const target = new URL(req.url, "http://x");
    reply(res, 301, "Moved Permanently", {
      Location: `https://${publicHost}${target.pathname}${target.search}`,
    });
  };
}

const listenOn = (server, { host, port }) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

export async function startServer({
  webDir,
  listen = "0.0.0.0:5000",
  acmeDir,
  redirectListen,
  publicHost,
  tlsListen,
  tlsCert,
  tlsKey,
  log = console.log,
}) {
  const root = path.resolve(webDir || "dist-live");
  if (!fs.existsSync(path.join(root, "index.html")))
    throw new Error(
      `${root}/index.html 이 없습니다. 먼저 빌드해야 합니다 (docs/MAINNET.md 참고).`,
    );
  if (redirectListen && !/^[A-Za-z0-9.-]+$/.test(publicHost || ""))
    throw new Error(
      "REDIRECT_LISTEN 에는 PUBLIC_HOST(공개 도메인)가 필요합니다.",
    );
  const site = siteHandler(root);
  const servers = [];
  const ports = { http: [] };
  for (const a of addresses(listen)) {
    const s = http.createServer(site);
    servers.push(s);
    ports.http.push(await listenOn(s, a));
    log(`${root} 을 http://${a.host}:${ports.http.at(-1)} 에서 제공합니다.`);
  }
  for (const a of addresses(redirectListen)) {
    const s = http.createServer(
      redirectHandler(acmeDir && path.resolve(acmeDir), publicHost),
    );
    servers.push(s);
    ports.redirect = await listenOn(s, a);
    log(
      `http://${a.host}:${ports.redirect} → https://${publicHost} (인증서 확인 응답 포함)`,
    );
  }
  for (const a of addresses(tlsListen)) {
    if (
      !tlsCert ||
      !tlsKey ||
      !fs.existsSync(tlsCert) ||
      !fs.existsSync(tlsKey)
    ) {
      log(
        `인증서가 아직 없어 HTTPS(${a.host}:${a.port})는 시작하지 않았습니다.`,
      );
      continue;
    }
    const s = https.createServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      site,
    );
    servers.push(s);
    ports.tls = await listenOn(s, a);
    log(`${root} 을 https://${a.host}:${ports.tls} 에서 제공합니다.`);
  }
  return {
    ports,
    close: () =>
      Promise.all(servers.map((s) => new Promise((r) => s.close(() => r())))),
  };
}

if (process.argv[1]?.endsWith("serve.mjs")) {
  const server = await startServer({
    webDir: process.env.WEB_DIR,
    listen: process.env.LISTEN || "0.0.0.0:5000",
    acmeDir: process.env.ACME_DIR,
    redirectListen: process.env.REDIRECT_LISTEN,
    publicHost: process.env.PUBLIC_HOST,
    tlsListen: process.env.TLS_LISTEN,
    tlsCert: process.env.TLS_CERT,
    tlsKey: process.env.TLS_KEY,
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await server.close();
      process.exit(0);
    });
}
