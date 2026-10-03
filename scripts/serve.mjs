// Serves a built site (WEB_DIR, default dist-live) over plain HTTP on every address in LISTEN
// (comma-separated host:port, default 0.0.0.0:5000). Static files only: GET/HEAD, no directory
// listing, nothing outside WEB_DIR.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.env.WEB_DIR || "dist-live");
const listen = (process.env.LISTEN || "0.0.0.0:5000").split(",").map((x) => {
  const at = x.lastIndexOf(":");
  return { host: x.slice(0, at), port: Number(x.slice(at + 1)) };
});
if (!fs.existsSync(path.join(root, "index.html")))
  throw new Error(
    `${root}/index.html 이 없습니다. 먼저 빌드해야 합니다 (docs/MAINNET.md 참고).`,
  );

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

const handle = (req, res) => {
  const reply = (code, text) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  };
  if (req.method !== "GET" && req.method !== "HEAD")
    return reply(405, "Method Not Allowed");
  let name;
  try {
    name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return reply(400, "Bad Request");
  }
  if (name.endsWith("/")) name += "index.html";
  const file = path.join(root, name);
  if (!file.startsWith(root + path.sep) || name.includes("\0"))
    return reply(404, "Not Found");
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return reply(404, "Not Found");
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Content-Length": stat.size,
      // Bundle files carry a content hash in their name; the page and its settings must stay fresh.
      "Cache-Control": name.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  });
};
const servers = listen.map(({ host, port }) =>
  http
    .createServer(handle)
    .listen(port, host, () =>
      console.log(`${root} 을 http://${host}:${port} 에서 제공합니다.`),
    ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const server of servers) server.close();
    process.exit(0);
  });
