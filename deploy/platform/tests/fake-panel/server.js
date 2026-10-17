// API del panel simulada (solo pruebas): canjea el pase "pase-bueno" y valida la cookie.
const http = require("node:http");
const HOST = "preview-acme.apps.test";
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://panel");
    const host = req.headers["x-preview-host"];
    if (url.pathname === "/api/ai/preview/auth") {
      if (host === HOST && url.searchParams.get("t") === "pase-bueno") {
        res.writeHead(302, { location: "/", "set-cookie": "lp_preview=cookie-buena; Path=/; HttpOnly" });
        return res.end();
      }
      res.writeHead(401);
      return res.end("caducado");
    }
    if (url.pathname === "/api/ai/preview/check") {
      // nginx no debe reenviar las cookies de la app: solo X-Preview-Pass.
      const ok = host === HOST && req.headers["x-preview-pass"] === "cookie-buena" && !req.headers.cookie;
      res.writeHead(ok ? 204 : 401);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  })
  .listen(3001, "127.0.0.1");
