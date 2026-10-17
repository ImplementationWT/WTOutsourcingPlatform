const http = require("node:http");
const broken = process.env.FAKE_BROKEN === "1";
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(broken ? 500 : 200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: broken ? "error" : "ok" }));
    }
    if (req.url === "/runtime") {
      // Solo para las pruebas: las variables que fija el compose y la cabecera Host que llega de nginx.
      const { NODE_ENV, TRUST_PROXY_HOPS, PORT, HOST, MONGODB_DB, MONGODB_URI } = process.env;
      const mongoHost = MONGODB_URI ? new URL(MONGODB_URI).host : null;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ NODE_ENV, TRUST_PROXY_HOPS, PORT, HOST, MONGODB_DB, mongoHost, host: req.headers.host, proto: req.headers["x-forwarded-proto"] }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>app</title>");
  })
  .listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0");
