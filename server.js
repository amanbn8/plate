// Plate — local server. No dependencies: needs Node 18+ (uses built-in fetch).
// Serves the app and the API (app.js), storing your log in data/plate-db.json.
// The same API also runs on Vercel through api/index.js.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---- config (.env is optional) ----
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { createApi, MOCK, API_KEY, MODEL, BASE_URL, APP_PASSWORD, INVITE_CODE } = require("./app");
const { fileStores, redisStores } = require("./store");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");
// STORE=redis points the local server at the same database as the Vercel deployment.
const stores = process.env.STORE === "redis" ? redisStores() : fileStores(process.env.DATA_FILE || undefined);
const handleApi = createApi(stores);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function send(res, status, body, type) { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  if (await handleApi(req, res, p)) return;

  // static files
  let file;
  try { file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : decodeURIComponent(p))); }
  catch { return send(res, 400, "Bad request", "text/plain"); }
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, buf, MIME[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  console.log(`\n  Plate is running\n  On this computer:  http://localhost:${PORT}`);
  if (lan && HOST === "0.0.0.0") console.log(`  On your phone:     http://${lan}:${PORT}  (same Wi-Fi)`);
  console.log(`  Recognition:       ${MOCK ? "MOCK mode (sample answers, no API key used)" : API_KEY ? `${MODEL} via ${BASE_URL}` : "OFF — add OPENAI_API_KEY to .env"}`);
  console.log(`  Storage:           ${stores.kind === "redis" ? "Redis (shared with Vercel)" : process.env.DATA_FILE || "data/plate-db.json"}${APP_PASSWORD ? "  ·  login required" : ""}${INVITE_CODE ? "  ·  sign-up open with invite code" : ""}\n`);
});
