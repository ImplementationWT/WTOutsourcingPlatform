// Servidor de desarrollo simulado en :5173: lee el clon en cada petición (como el HMR).
const http = require("node:http");
const fs = require("node:fs");
http
  .createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    if (req.url === "/state") {
      const installs = fs.existsSync("/app/node_modules/.installs") ? fs.readFileSync("/app/node_modules/.installs", "utf8").trim().split("\n").length : 0;
      const { NODE_ENV, FORCE_ADMIN_PASSWORD_CHANGE, MONGODB_DB, MONGODB_URI } = process.env;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ installs, NODE_ENV, FORCE_ADMIN_PASSWORD_CHANGE, MONGODB_DB, mongoHost: new URL(MONGODB_URI).host, uid: process.getuid() }));
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><p>${fs.readFileSync("/app/message.txt", "utf8").trim()}</p>`);
  })
  .listen(5173, "0.0.0.0");
