// Where the log lives. Two interchangeable stores with the same methods:
//   fileStore()  — data/plate-db.json on this computer (used by `npm start`)
//   redisStore() — Upstash Redis over its REST API (used on Vercel, where files don't persist)
//
// Photo thumbnails make up almost all of the log's size, so getState() only includes them for
// recent days; older entries come back with `thumb: null, hasThumb: true` and the app fetches
// that day with getDay() when it's opened. In Redis they're kept in their own hash for the same
// reason, with the entry holding `thumb: true` as a marker.
//
// Steps are written separately (setSteps) from food and water (putDay), so the Health Shortcut
// and a meal saved at the same moment can't overwrite each other.
const fs = require("fs");
const path = require("path");

const THUMB_DAYS = 14;
const cutoffKey = (days) => { const d = new Date(Date.now() - days * 864e5); return d.toISOString().slice(0, 10); };
const stripThumbs = (day) => ({ ...day, entries: (day.entries || []).map((e) => e.thumb ? { ...e, thumb: null, hasThumb: true } : e) });

function fileStore(file = path.join(__dirname, "data", "plate-db.json")) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = { days: {}, settings: null };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); db.days ||= {}; } catch {}
  let writing = Promise.resolve();
  const hits = new Map();
  function persist() {
    const snapshot = JSON.stringify(db);
    const done = writing.catch(() => {}).then(() => new Promise((res, rej) => {
      const tmp = file + ".tmp";
      fs.writeFile(tmp, snapshot, (err) => { if (err) return rej(err);
        fs.rename(tmp, file, (e) => e ? rej(e) : res()); });
    }));
    writing = done;
    return done.catch((e) => { console.error("Save failed:", e.message); throw Object.assign(new Error("Couldn't save to disk"), { status: 500, code: "db_error" }); });
  }
  return {
    name: "file",
    async getState({ thumbDays = THUMB_DAYS } = {}) {
      const since = cutoffKey(thumbDays), days = {};
      for (const [k, d] of Object.entries(db.days)) days[k] = k >= since ? d : stripThumbs(d);
      return { days, settings: db.settings };
    },
    async getDay(k) { return db.days[k] || null; },
    async putDay(k, d) {
      // Entries that already had a stored thumb keep it.
      const prev = new Map((db.days[k]?.entries || []).map((e) => [e.id, e.thumb]));
      db.days[k] = { entries: (d.entries || []).map((e) => e.thumb === true || (e.hasThumb && !e.thumb) ? { ...e, thumb: prev.get(e.id) || null, hasThumb: undefined } : e),
        water: d.water || 0, steps: db.days[k]?.steps || 0 };
      await persist();
    },
    async setSteps(k, n) { db.days[k] = { entries: [], water: 0, ...db.days[k], steps: n }; await persist(); },
    // Counter that resets after `ttl` seconds (used to limit login attempts).
    async hit(key, ttl) { const now = Date.now(), c = hits.get(key); const n = c && c.until > now ? c.n + 1 : 1; hits.set(key, { n, until: c && c.until > now ? c.until : now + ttl * 1000 }); return n; },
    async clearHits(key) { hits.delete(key); },
    async getSettings() { return db.settings; },
    async setSettings(s) { db.settings = s; await persist(); },
  };
}

// The Vercel Upstash integration sets KV_REST_API_*; a direct Upstash database gives UPSTASH_REDIS_REST_*.
const REDIS_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

function redisStore(url = REDIS_URL(), token = REDIS_TOKEN(), prefix = "plate") {
  if (!url || !token) throw new Error("No Redis configured. Set KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN).");
  const DAYS = `${prefix}:days`, THUMBS = `${prefix}:thumbs`, STEPS = `${prefix}:steps`, SETTINGS = `${prefix}:settings`;
  const base = url.replace(/\/+$/, "");
  async function call(pathName, body) {
    let r;
    try {
      r = await fetch(base + pathName, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { throw Object.assign(new Error("Couldn't reach the database."), { status: 502, code: "db_error" }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw Object.assign(new Error("Database error: " + (j.error || r.status)), { status: 502, code: "db_error" });
    return j;
  }
  const cmd = async (...args) => (await call("", args)).result;
  // Several commands in one round trip; each item is { result } or { error }.
  const pipe = async (cmds) => {
    const out = await call("/pipeline", cmds);
    const bad = out.find?.((x) => x.error);
    if (bad) throw Object.assign(new Error("Database error: " + bad.error), { status: 502, code: "db_error" });
    return out.map((x) => x.result);
  };
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // Fill `thumb: true` markers from the thumbs hash (in place).
  async function fillThumbs(entries) {
    const want = entries.filter((e) => e.thumb === true);
    if (!want.length) return;
    const vals = await cmd("HMGET", THUMBS, ...want.map((e) => e.id));
    want.forEach((e, i) => { e.thumb = vals[i] || null; });
  }
  const getRaw = async (k) => { const s = await cmd("HGET", DAYS, k); return s ? parse(s) : null; };
  const withSteps = async (k, d) => { const n = await cmd("HGET", STEPS, k); return n == null ? d : { entries: [], water: 0, ...d, steps: Number(n) || 0 }; };

  return {
    name: "redis",
    async getState({ thumbDays = THUMB_DAYS } = {}) {
      const [flat, stepsFlat, settings] = await pipe([["HGETALL", DAYS], ["HGETALL", STEPS], ["GET", SETTINGS]]);
      const since = cutoffKey(thumbDays), days = {}, recent = [];
      for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        const k = flat[i], d = parse(flat[i + 1]); if (!d) continue;
        if (k >= since) { days[k] = d; recent.push(...(d.entries || [])); } else days[k] = stripThumbs(d);
      }
      for (let i = 0; i + 1 < (stepsFlat || []).length; i += 2)
        (days[stepsFlat[i]] ||= { entries: [], water: 0 }).steps = Number(stepsFlat[i + 1]) || 0;
      await fillThumbs(recent);
      return { days, settings: settings ? parse(settings) : null };
    },
    async getDay(k) { const d = await getRaw(k); if (d) await fillThumbs(d.entries || []); return withSteps(k, d); },
    async putDay(k, d) {
      const prev = await getRaw(k);
      const cmds = [], keep = new Set();
      const entries = (d.entries || []).map((e) => {
        const { hasThumb, ...rest } = e;
        if (typeof e.thumb === "string" && e.thumb) { cmds.push(["HSET", THUMBS, e.id, e.thumb]); keep.add(e.id); return { ...rest, thumb: true }; }
        if (e.thumb === true || hasThumb) { keep.add(e.id); return { ...rest, thumb: true }; }
        return rest;
      });
      const gone = (prev?.entries || []).filter((e) => e.thumb && !keep.has(e.id)).map((e) => e.id);
      if (gone.length) cmds.push(["HDEL", THUMBS, ...gone]);
      cmds.push(["HSET", DAYS, k, JSON.stringify({ entries, water: d.water || 0, steps: prev?.steps || 0 })]);
      await pipe(cmds);
    },
    async setSteps(k, n) { await cmd("HSET", STEPS, k, String(n)); },
    async hit(key, ttl) { const [, n] = await pipe([["SET", `${prefix}:rl:${key}`, "0", "EX", String(ttl), "NX"], ["INCR", `${prefix}:rl:${key}`]]); return Number(n) || 0; },
    async clearHits(key) { await cmd("DEL", `${prefix}:rl:${key}`); },
    async getSettings() { const s = await cmd("GET", SETTINGS); return s ? parse(s) : null; },
    async setSettings(s) { await cmd("SET", SETTINGS, JSON.stringify(s)); },
  };
}

module.exports = { fileStore, redisStore };

// ---- several people ----
// Each person's log lives in its own store. The owner (the app's first user) keeps the original
// location, so existing data needs no migration. Accounts are kept in a separate registry.
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,19}$/;

function fileStores(ownerFile = path.join(__dirname, "data", "plate-db.json")) {
  const dir = path.dirname(ownerFile), usersFile = path.join(dir, "users.json"), cache = new Map();
  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersFile, "utf8")) || {}; } catch {}
  const owner = fileStore(ownerFile);
  return {
    kind: "file", shared: owner,
    forUser(username) {
      if (!username || username === "owner") return owner;
      if (!USERNAME_RE.test(username)) throw new Error("bad username");
      if (!cache.has(username)) cache.set(username, fileStore(path.join(dir, "users", username + ".json")));
      return cache.get(username);
    },
    users: {
      async get(u) { return users[u] || null; },
      async put(u, rec) { users[u] = rec; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(usersFile + ".tmp", JSON.stringify(users)); fs.renameSync(usersFile + ".tmp", usersFile); },
      async add(u, rec) { if (users[u]) return false; await this.put(u, rec); return true; },
    },
  };
}

function redisStores(url = REDIS_URL(), token = REDIS_TOKEN()) {
  const owner = redisStore(url, token, "plate"), cache = new Map();
  const call = async (args) => {
    const r = await fetch(url.replace(/\/+$/, ""), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok || j.error) throw Object.assign(new Error("Database error"), { status: 502, code: "db_error" });
    return j.result;
  };
  return {
    kind: "redis", shared: owner,
    forUser(username) {
      if (!username || username === "owner") return owner;
      if (!USERNAME_RE.test(username)) throw new Error("bad username");
      if (!cache.has(username)) cache.set(username, redisStore(url, token, `plate:u:${username}`));
      return cache.get(username);
    },
    users: {
      async get(u) { const s = await call(["HGET", "plate:users", u]); try { return s ? JSON.parse(s) : null; } catch { return null; } },
      async put(u, rec) { await call(["HSET", "plate:users", u, JSON.stringify(rec)]); },
      // HSETNX: only one of two simultaneous sign-ups for the same name can win.
      async add(u, rec) { return (await call(["HSETNX", "plate:users", u, JSON.stringify(rec)])) === 1; },
    },
  };
}

module.exports.fileStores = fileStores;
module.exports.redisStores = redisStores;
module.exports.USERNAME_RE = USERNAME_RE;
