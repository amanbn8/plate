// Vercel entry point: every /api/* request is rewritten here (see vercel.json).
// The log lives in Upstash Redis, because Vercel doesn't keep files between requests.
const { createApi } = require("../app");
const { redisStores } = require("../store");

let handleApi;
module.exports = async (req, res) => {
  try { handleApi ||= createApi(redisStores()); }
  catch (e) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ code: "no_db", error: e.message })); }
  const url = new URL(req.url, "http://localhost");
  // The rewrite passes the original path along in case the runtime reports /api/index.
  const p = url.pathname === "/api/index" && url.searchParams.has("path") ? "/api/" + url.searchParams.get("path") : url.pathname;
  if (!(await handleApi(req, res, p))) { res.statusCode = 404; res.end("Not found"); }
};
