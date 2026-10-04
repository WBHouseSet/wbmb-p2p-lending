// The static server behind the public site: plain HTTP (as today), an HTTP listener that
// answers Let's Encrypt challenges and redirects everything else to HTTPS, and an HTTPS
// listener that starts only once a certificate exists.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";

function get(url, { host, insecure } = {}) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: "GET",
        headers: host ? { Host: host } : {},
        rejectUnauthorized: !insecure,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
// Raw request so a path with ".." reaches the server unnormalised.
function raw(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: target, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("static server", () => {
  let dir, web, acme, cert, key, server;
  const port = (name) => server.ports[name];
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbmb-serve-"));
    web = path.join(dir, "web");
    acme = path.join(dir, "acme");
    fs.mkdirSync(path.join(web, "assets"), { recursive: true });
    fs.writeFileSync(path.join(web, "index.html"), "<p>page</p>");
    fs.writeFileSync(path.join(web, "assets", "a-1234.js"), "x");
    fs.writeFileSync(path.join(dir, "secret.txt"), "outside");
    fs.mkdirSync(path.join(acme, ".well-known", "acme-challenge"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(acme, ".well-known", "acme-challenge", "tok-123"),
      "tok-123.thumb",
    );
    cert = path.join(dir, "cert.pem");
    key = path.join(dir, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=wbmb.example",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    server = await startServer({
      webDir: web,
      listen: "127.0.0.1:0",
      acmeDir: acme,
      redirectListen: "127.0.0.1:0",
      publicHost: "wbmb.example",
      tlsListen: "127.0.0.1:0",
      tlsCert: cert,
      tlsKey: key,
      log: () => {},
    });
  });
  after(async () => {
    await server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plain HTTP still serves the page with the security headers", async () => {
    const r = await get(`http://127.0.0.1:${port("http")[0]}/`);
    assert.equal(r.status, 200);
    assert.equal(r.body, "<p>page</p>");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-cache");
  });

  it("nothing outside the web folder is served, even with ..", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
      const r = await raw(port("http")[0], p);
      assert.equal(r.status, 404, p);
      assert.equal(r.body.includes("outside"), false, p);
    }
  });

  it("the redirect listener answers ACME challenges from the challenge folder", async () => {
    const r = await get(
      `http://127.0.0.1:${port("redirect")}/.well-known/acme-challenge/tok-123`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, "tok-123.thumb");
    assert.match(r.headers["content-type"], /text\/plain/);
  });

  it("a challenge path cannot climb out of the challenge folder", async () => {
    // Either refused, or normalised away and redirected to HTTPS: never the file's content.
    for (const p of [
      "/.well-known/acme-challenge/../../secret.txt",
      "/.well-known/acme-challenge/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/.well-known/acme-challenge/",
    ]) {
      const r = await raw(port("redirect"), p);
      assert.notEqual(r.status, 200, p);
      assert.equal(r.body.includes("outside"), false, p);
    }
  });
  it("everything else on the redirect listener goes to HTTPS on the configured host, never the Host header's", async () => {
    const r = await get(`http://127.0.0.1:${port("redirect")}/x/y?a=1`, {
      host: "evil.example",
    });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, "https://wbmb.example/x/y?a=1");
  });

  it("HTTPS serves the same page with the certificate", async () => {
    const r = await get(`https://127.0.0.1:${port("tls")}/`, {
      insecure: true,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, "<p>page</p>");
    assert.equal(r.headers["cache-control"], "no-cache");
    const a = await get(`https://127.0.0.1:${port("tls")}/assets/a-1234.js`, {
      insecure: true,
    });
    assert.match(a.headers["cache-control"], /immutable/);
  });

  it("without certificate files the HTTPS listener waits, and the rest still runs", async () => {
    const s = await startServer({
      webDir: web,
      listen: "127.0.0.1:0",
      acmeDir: acme,
      redirectListen: "127.0.0.1:0",
      publicHost: "wbmb.example",
      tlsListen: "127.0.0.1:0",
      tlsCert: path.join(dir, "missing.pem"),
      tlsKey: path.join(dir, "missing.key"),
      log: () => {},
    });
    try {
      assert.equal(s.ports.tls, undefined);
      assert.equal(
        (
          await get(
            `http://127.0.0.1:${s.ports.redirect}/.well-known/acme-challenge/tok-123`,
          )
        ).status,
        200,
      );
      assert.equal(
        (await get(`http://127.0.0.1:${s.ports.http[0]}/`)).status,
        200,
      );
    } finally {
      await s.close();
    }
  });

  it("a redirect listener without a configured public host is refused at start", async () => {
    await assert.rejects(
      startServer({
        webDir: web,
        listen: "127.0.0.1:0",
        redirectListen: "127.0.0.1:0",
        log: () => {},
      }),
      /PUBLIC_HOST/,
    );
  });
});
