// One-time copy of data/plate-db.json into the Redis database Vercel uses.
//   npx vercel env pull .env.vercel     (downloads the Redis URL + token)
//   node migrate-to-redis.js .env.vercel
// Refuses to overwrite a Redis database that already has days in it unless you add --force.
const fs = require("fs"), path = require("path");
const envFile = process.argv[2] || ".env.vercel";
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const { redisStore } = require("./store");
(async () => {
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "plate-db.json"), "utf8"));
  const remote = redisStore();
  const existing = await remote.getState();
  if (Object.keys(existing.days).length && !process.argv.includes("--force")) {
    console.error(`Redis already has ${Object.keys(existing.days).length} days. Re-run with --force to overwrite them.`); process.exit(1);
  }
  for (const [k, d] of Object.entries(local.days || {})) { await remote.putDay(k, d); if (d.steps) await remote.setSteps(k, d.steps); }
  if (local.settings) await remote.setSettings(local.settings);
  console.log(`Copied ${Object.keys(local.days || {}).length} days and settings to Redis.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
