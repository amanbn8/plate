// Plate — the API, shared by the local server (server.js) and the Vercel function (api/index.js).
// Stores your log through a store (store.js), forwards recognition requests to the OpenAI API so
// your key never reaches the browser, and — when APP_PASSWORD is set — locks the API behind a login.
// Works with any OpenAI-compatible endpoint (set OPENAI_BASE_URL).
const crypto = require("crypto");

const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const API_URL = BASE_URL + "/chat/completions";
// OpenAI's own API uses max_completion_tokens; many compatible providers still expect max_tokens.
const TOKEN_PARAM = process.env.OPENAI_TOKEN_PARAM || (BASE_URL.includes("api.openai.com") ? "max_completion_tokens" : "max_tokens");
const MOCK = process.env.MOCK === "1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// ---- helpers ----
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// "today" for the step-count Shortcut: Vercel runs in UTC, so use the configured zone (default India).
const TZ = process.env.TZ_NAME || "Asia/Kolkata";
const todayKey = () => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); } catch { return keyOf(new Date()); } };
function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const badJson = () => Object.assign(new Error("Invalid JSON"), { status: 400 });
async function readBody(req, limit = 20 * 1024 * 1024) {
  // On Vercel the runtime has already buffered the body; its req.body getter parses JSON and
  // throws on malformed input.
  if (process.env.VERCEL) {
    let b;
    try { b = req.body; } catch { throw badJson(); }
    if (b !== undefined) {
      if (b === null || b === "") return {};
      if (Buffer.isBuffer(b) || typeof b === "string") { try { return JSON.parse(String(b)); } catch { throw badJson(); } }
      return b;
    }
  }
  const form = /x-www-form-urlencoded/i.test(req.headers["content-type"] || "");
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (form) return resolve(Object.fromEntries(new URLSearchParams(text)));
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(badJson()); }
    });
    req.on("error", reject);
  });
}

// ---- accounts (only when APP_PASSWORD is set) ----
// The owner (first user) logs in with APP_PASSWORD; their data stays where it always was. Other
// people create an account with INVITE_CODE and get their own separate log. Passwords are
// stored as salted scrypt hashes. The session cookie is "v2.<username>.<signature>"; the
// signature covers the password hash, so changing a password signs that person's devices out.
const COOKIE = "plate_auth";
const OWNER = (process.env.OWNER_USERNAME || "aman").toLowerCase();
const INVITE_CODE = process.env.INVITE_CODE || "";
const { USERNAME_RE } = require("./store");
const legacyToken = () => crypto.createHmac("sha256", APP_PASSWORD).update("plate-login-v1").digest("hex"); // cookies from before accounts
const secret = () => process.env.SESSION_SECRET || crypto.createHmac("sha256", APP_PASSWORD).update("plate-session-v2").digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString("hex"))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: await scrypt(pw, salt) }; }
const sign = (username, rec) => crypto.createHmac("sha256", secret()).update(username + "|" + (rec ? rec.hash : "owner")).digest("hex");
const sessionFor = (username, rec) => `v2.${username}.${sign(username, rec)}`;
const ownerUser = () => ({ username: OWNER, store: "owner", owner: true });
async function checkPassword(users, username, password) {
  username = String(username || "").trim().toLowerCase();
  if ((!username || username === OWNER) && same(password || "", APP_PASSWORD)) return { user: ownerUser(), rec: null };
  if (!USERNAME_RE.test(username) || username === OWNER) return null;
  const rec = await users.get(username);
  if (!rec) { await scrypt(password, "x".repeat(32)); return null; } // same work either way
  return same(await scrypt(password, rec.salt), rec.hash) ? { user: { username, store: username, owner: false, name: rec.name }, rec } : null;
}
// Who is making this request? null means "log in first".
async function whoIs(req, users) {
  if (!APP_PASSWORD) return ownerUser(); // local, no password: single user
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (cookie) {
    if (same(cookie, legacyToken())) return ownerUser();
    const m = cookie.match(/^v2\.([a-z0-9_.-]{3,20})\.([0-9a-f]{64})$/);
    if (m) {
      if (m[1] === OWNER) { if (same(m[2], sign(OWNER, null))) return ownerUser(); }
      else { const rec = await users.get(m[1]); if (rec && same(m[2], sign(m[1], rec))) return { username: m[1], store: m[1], owner: false, name: rec.name }; }
    }
  }
  // Step-count Shortcuts: "Bearer <APP_PASSWORD>" for the owner, "Bearer <username>:<password>" for others.
  const b = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (b) {
    if (same(b, APP_PASSWORD)) return ownerUser();
    const i = b.indexOf(":");
    if (i > 0) return (await checkPassword(users, b.slice(0, i), b.slice(i + 1)))?.user || null;
  }
  return null;
}
function authCookie(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" || !!req.socket?.encrypted;
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
const YEAR = 60 * 60 * 24 * 400;
const publicUser = (u) => u && { username: u.username, owner: !!u.owner, name: u.name || "" };

// ---- AI model call (OpenAI Chat Completions) ----
async function askAI({ prompt, image, mediaType, images, maxTokens, json }) {
  if (MOCK) return mockAnswer(prompt, !!image || (Array.isArray(images) && images.length > 0));
  if (!API_KEY) { const e = new Error("No OPENAI_API_KEY set. Add it to .env and restart the server."); e.code = "no_key"; e.status = 503; throw e; }
  const content = [{ type: "text", text: prompt }];
  // One photo (`image`) or several pages of a menu (`images`: [{ data, mediaType }], up to 10).
  const pics = Array.isArray(images) ? images.slice(0, 10) : image ? [{ data: image, mediaType }] : [];
  for (const pic of pics) if (pic && typeof pic.data === "string")
    content.push({ type: "image_url", image_url: { url: `data:${pic.mediaType || "image/jpeg"};base64,${pic.data}`, detail: "high" } });
  const payload = { model: MODEL, messages: [{ role: "user", content }], [TOKEN_PARAM]: Math.min(Number(maxTokens) || 2000, 4000) };
  if (json && process.env.OPENAI_JSON_MODE !== "0") payload.response_format = { type: "json_object" };
  // Stay inside the Vercel function's time limit (vercel.json maxDuration) so the app gets a clear error.
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), process.env.VERCEL ? 110000 : 120000);
  let r;
  try {
    r = await fetch(API_URL, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const e = new Error(err.name === "AbortError" ? "The AI model took too long to answer. Try again." : "Couldn't reach the AI API. Check your internet connection.");
    e.code = "network"; e.status = 502; throw e;
  } finally { clearTimeout(timer); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `AI API error ${r.status}`;
    // OpenAI also answers 429 when the account has no credit left; that needs a different fix.
    const noCredit = data?.error?.code === "insufficient_quota" || /no credits|exceeded your current quota|billing/i.test(msg);
    const code = r.status === 401 || r.status === 403 ? "auth" : noCredit ? "no_credit" : r.status === 429 ? "rate_limited" : r.status >= 500 ? "overloaded"
      : r.status === 404 || /model|image/i.test(msg) ? "model" : "upstream_error";
    console.error(`AI API ${r.status}: ${msg}`);
    const e = new Error(msg); e.code = code; e.status = r.status === 429 && !noCredit ? 429 : 502; throw e;
  }
  const choice = data.choices?.[0] || {};
  const c = choice.message?.content;
  const text = (Array.isArray(c) ? c.map((p) => p.text || "").join("\n") : c || "").trim();
  if (!text && choice.message?.refusal) { const e = new Error(choice.message.refusal); e.code = "refused"; e.status = 502; throw e; }
  return { text, truncated: choice.finish_reason === "length" };
}

// ---- barcode lookup (Open Food Facts — free, no key needed) ----
async function lookupBarcode(code) {
  let r;
  try {
    r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`, {
      headers: { "User-Agent": "Plate-app (personal nutrition tracker)" }, signal: AbortSignal.timeout(15000),
    });
  } catch {
    const e = new Error("Couldn't reach the product database. Try again in a moment.");
    e.code = "network"; e.status = 502; throw e;
  }
  // Open Food Facts answers 404 for unknown products; anything else that isn't OK is an outage.
  if (!r.ok && r.status !== 404) { const e = new Error("The product database isn't answering right now. Try again in a moment."); e.code = "network"; e.status = 502; throw e; }
  const data = await r.json().catch(() => ({}));
  if (data.status !== 1 || !data.product) {
    const e = new Error("No product found for that barcode."); e.code = "not_found"; e.status = 404; throw e;
  }
  const p = data.product, n = p.nutriments || {};
  const per100 = {
    // Some products only list kilojoules.
    k: Number(n["energy-kcal_100g"]) || (Number(n["energy-kj_100g"] || n["energy_100g"]) || 0) / 4.184,
    p: Number(n["proteins_100g"]) || 0,
    c: Number(n["carbohydrates_100g"]) || 0,
    f: Number(n["fat_100g"]) || 0,
    fib: Number(n["fiber_100g"]) || 0,
    sug: Number(n["sugars_100g"]) || 0,
    na: (Number(n["sodium_100g"]) || 0) * 1000,
  };
  const servingGrams = Math.round(Number(p.serving_quantity)) || 100;
  const servingLabel = servingGrams === 100 ? "100 g" : (p.serving_size || `${servingGrams} g`);
  return {
    name: p.product_name || p.generic_name || "Packaged food",
    brand: p.brands || "",
    servingGrams, servingLabel, per100,
    // Some products are listed without any nutrition filled in.
    incomplete: !per100.k && !per100.p && !per100.c && !per100.f,
  };
}

// Canned answers so the whole app can be tried without a key (MOCK=1)
function mockAnswer(prompt, hasImage) {
  if (prompt.includes("nutrition information label")) return { text: JSON.stringify({ name: "Masala oats", serving_grams: 40, calories: 150, protein: 5, carbs: 25, fat: 3.5, fiber: 3.8, sugar: 2.1, added_sugar: 2.1, sodium: 420, note: "" }), truncated: false };
  if (prompt.includes("restaurant menu")) return { text: JSON.stringify({ restaurant: "Punjab Grill", picks: [
    { name: "Tandoori chicken (half)", portion: "half, 4 pieces", grams: 250, calories: 420, protein: 52, carbs: 8, fat: 19, fiber: 1, sugar: 3, sodium: 900, why: "High protein and grilled, so it covers most of the protein you still need.", tip: "Have it with mint chutney and salad instead of naan." },
    { name: "Dal tadka", portion: "1 bowl", grams: 200, calories: 260, protein: 12, carbs: 30, fat: 10, fiber: 6, sugar: 2, sodium: 700, why: "Moderate calories with fibre and some protein.", tip: "Ask for less ghee in the tadka." },
    { name: "Tandoori roti", portion: "1 roti", grams: 50, calories: 145, protein: 5, carbs: 28, fat: 1.5, fiber: 3, sugar: 1, sodium: 180, why: "Much lighter than butter naan.", tip: "One is enough with the chicken." }],
    avoid: [{ name: "Butter chicken", why: "~700 kcal a bowl, mostly cream and butter." }, { name: "Garlic butter naan", why: "~350 kcal each." }], note: "" }), truncated: false };
  if (prompt.includes("Read the product barcode")) return { text: JSON.stringify({ code: "5449000000996" }), truncated: false };
  // A chain item described in words: no database match, the brand's figures instead.
  // The shake case as Gemini actually answered it: the whole reply wrapped in a list.
  if (/User's details[^\n]*whey/i.test(prompt)) return { text: JSON.stringify([{ items: [
    { name: "C9 nutrition iso ripped whey protein", db: "whey-protein", grams: 30, confidence: "high", nutrition: { calories: 110, protein: 24, carbs: 2, fat: 1, fiber: 0, sugar: 1, added_sugar: 0, sodium: 120 } },
  ], note: "Estimated 1 standard scoop." }]), truncated: false };
  if (/User's details[^\n]*subway/i.test(prompt)) return { text: JSON.stringify({ items: [
    { name: "Paneer Tikka Sub, 6-inch (Subway)", db: null, grams: 230, confidence: "high", nutrition: { calories: 420, protein: 18, carbs: 52, fat: 15, fiber: 4, sugar: 7, added_sugar: 4, sodium: 900 } },
  ], note: "" }), truncated: false };
  if (prompt.includes("end-of-day note")) return { text: "Good protein from the dal and curd today. Tomorrow, swap one fried snack for roasted chana or sprouts to cut fat and add fibre.", truncated: false };
  return { text: JSON.stringify({ items: [
    { name: "Roti", db: "roti-chapati", grams: 160, confidence: "high", nutrition: null },
    { name: "Dal", db: "dal-fry", grams: 150, confidence: "high", nutrition: null },
    { name: "Kadhi pakora", db: "kadhi", grams: 250, confidence: "medium", nutrition: null },
    { name: "Mixed pakora", db: "onion-pakora", grams: 120, confidence: "medium", nutrition: { calories: 372, protein: 8, carbs: 32, fat: 23, fiber: 4, sugar: 3, added_sugar: 0, sodium: 540 } },
    { name: hasImage ? "Aloo sabzi" : "Pickle", db: hasImage ? "aloo-sabzi" : null, grams: hasImage ? 80 : 15,
      confidence: "low", nutrition: hasImage ? null : { calories: 30, protein: 0.3, carbs: 1, fat: 3, fiber: 0.6, sugar: 0.5, added_sugar: 0, sodium: 600 } },
  ], note: "Mock result: set OPENAI_API_KEY and remove MOCK=1 for real recognition." }), truncated: false };
}

// Step counts from iPhone Shortcuts arrive in many shapes: 8423, "8,423", "8423 steps",
// a list of Health samples (added up), or {value: 8423}.
function parseSteps(v) {
  if (Array.isArray(v)) return v.reduce((a, x) => a + parseSteps(x), 0);
  if (v && typeof v === "object") return parseSteps(v.value ?? v.quantity ?? v.steps ?? v.sum ?? 0);
  const n = Number(String(v ?? "").replace(/,/g, "").match(/\d+(\.\d+)?/)?.[0] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ---- merging saves from several devices ----
// The app sends the day as it now looks plus what it looked like when it last heard from the
// server (baseIds / baseWater). Applying only that difference to the stored day means a phone
// and a laptop can both add or remove food without either wiping out the other's changes.
function mergeDay(prev, body) {
  const entries = Array.isArray(body.entries) ? body.entries.filter((e) => e && typeof e === "object" && e.id) : [];
  const water = Math.max(0, Math.min(30, Number(body.water) || 0));
  if (!Array.isArray(body.baseIds)) return { entries, water }; // older app version: plain replace
  const base = new Set(body.baseIds), local = new Map(entries.map((e) => [e.id, e]));
  const have = new Set(prev.entries.map((e) => e.id));
  // Entries this device changed in place (edited) take this device's version; anything else it
  // merely still holds keeps the server's copy, so a stale device can't undo another's edits.
  const edited = new Set(Array.isArray(body.edited) ? body.edited : []);
  return {
    entries: prev.entries.filter((e) => !(base.has(e.id) && !local.has(e.id)))
      .map((e) => edited.has(e.id) && local.has(e.id) ? local.get(e.id) : e)
      .concat(entries.filter((e) => !base.has(e.id) && !have.has(e.id))),
    water: Number(body.baseWater) === water ? prev.water || 0 : water,
  };
}
// Settings: take only the top-level fields this device changed since it last loaded them.
function mergeSettings(server, local, base) {
  const out = { ...(server || {}) };
  for (const k of new Set([...Object.keys(local || {}), ...Object.keys(base || {})]))
    if (JSON.stringify(local?.[k]) !== JSON.stringify(base?.[k])) { if (local && k in local) out[k] = local[k]; else delete out[k]; }
  return out;
}
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ---- API routes ----
// Returns false when the path isn't an API route, so the caller can serve static files.
function createApi(stores) {
  const shared = stores.shared, users = stores.users;
  const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  return async function handleApi(req, res, p) {
    if (!p.startsWith("/api/")) return false;
    try {
      // Online, never run without a password: the log and the AI key would be open to anyone.
      if (process.env.VERCEL && !APP_PASSWORD && p !== "/api/status") return send(res, 503, { code: "no_password", error: "Set APP_PASSWORD in the Vercel project, then redeploy." }), true;

      if (p === "/api/status" && req.method === "GET") {
        const me = await whoIs(req, users).catch(() => null);
        return send(res, 200, { ai: MOCK || !!API_KEY, mock: MOCK, model: MOCK ? "mock" : MODEL, authRequired: !!APP_PASSWORD, authed: !!me, user: publicUser(me), signup: !!(APP_PASSWORD && INVITE_CODE) }), true;
      }

      if (p === "/api/login" && req.method === "POST") {
        if (!APP_PASSWORD) return send(res, 200, { ok: true, user: publicUser(ownerUser()) }), true;
        // At most 10 wrong passwords per address per 15 minutes, and 50 overall per hour.
        const ip = clientIp(req);
        const [mine, all] = await Promise.all([shared.hit("login:" + ip, 900), shared.hit("login:all", 3600)]);
        if (mine > 10 || all > 50) return send(res, 429, { code: "rate_limited", error: "Too many attempts. Wait 15 minutes and try again." }), true;
        const body = await readBody(req, 10 * 1024);
        const ok = await checkPassword(users, body.username, body.password);
        if (!ok) {
          await new Promise((r) => setTimeout(r, 800)); // slow down guessing
          return send(res, 401, { code: "bad_password", error: "Wrong username or password" }), true;
        }
        await shared.clearHits("login:" + ip);
        return send(res, 200, { ok: true, user: publicUser(ok.user) }, "application/json", { "Set-Cookie": authCookie(req, sessionFor(ok.user.username, ok.rec), YEAR) }), true;
      }

      if (p === "/api/signup" && req.method === "POST") {
        if (!APP_PASSWORD || !INVITE_CODE) return send(res, 403, { code: "signup_closed", error: "New accounts aren't open right now." }), true;
        const ip = clientIp(req);
        if ((await shared.hit("signup:" + ip, 3600)) > 10) return send(res, 429, { code: "rate_limited", error: "Too many attempts. Try again in an hour." }), true;
        const body = await readBody(req, 10 * 1024);
        if (!same(String(body.invite || "").trim(), INVITE_CODE)) { await new Promise((r) => setTimeout(r, 800)); return send(res, 403, { code: "bad_invite", error: "That invite code isn't right." }), true; }
        const username = String(body.username || "").trim().toLowerCase(), password = String(body.password || ""), name = String(body.name || "").trim().slice(0, 40);
        if (!USERNAME_RE.test(username)) return send(res, 400, { code: "bad_username", error: "Usernames are 3–20 characters: letters, numbers, dot, dash or underscore." }), true;
        if (username === OWNER || username === "owner") return send(res, 409, { code: "taken", error: "That username is taken." }), true;
        if (password.length < 8) return send(res, 400, { code: "weak_password", error: "Use a password of at least 8 characters." }), true;
        const rec = { ...(await hashPassword(password)), name, created: Date.now() };
        if (!(await users.add(username, rec))) return send(res, 409, { code: "taken", error: "That username is taken." }), true;
        await stores.forUser(username).setSettings({ name });
        return send(res, 200, { ok: true, user: { username, owner: false, name } }, "application/json", { "Set-Cookie": authCookie(req, sessionFor(username, rec), YEAR) }), true;
      }

      if (p === "/api/logout" && req.method === "POST")
        return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": authCookie(req, "", 0) }), true;

      const me = await whoIs(req, users);
      if (!me) return send(res, 401, { code: "login_required", error: "Log in first" }), true;
      const store = stores.forUser(me.store);

      if (p === "/api/password" && req.method === "POST") {
        if (me.owner) return send(res, 400, { code: "owner", error: "Your password is the app password; change APP_PASSWORD on Vercel." }), true;
        const body = await readBody(req, 10 * 1024), rec = await users.get(me.username);
        if (!rec || !same(await scrypt(body.current || "", rec.salt), rec.hash)) return send(res, 401, { code: "bad_password", error: "Your current password isn't right." }), true;
        if (String(body.next || "").length < 8) return send(res, 400, { code: "weak_password", error: "Use a new password of at least 8 characters." }), true;
        const next = { ...rec, ...(await hashPassword(body.next)) };
        await users.put(me.username, next);
        return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": authCookie(req, sessionFor(me.username, next), YEAR) }), true;
      }

      if (p === "/api/state" && req.method === "GET") return send(res, 200, await store.getState()), true;

      let m;
      if ((m = p.match(/^\/api\/day\/([\d-]+)$/)) && !DATE_RE.test(m[1])) return send(res, 400, { code: "invalid_request", error: "Bad date" }), true;
      if (m && req.method === "GET") return send(res, 200, (await store.getDay(m[1])) || { entries: [], water: 0, steps: 0 }), true;
      if (m && req.method === "PUT") {
        const body = await readBody(req);
        const prev = (await store.getDay(m[1])) || { entries: [], water: 0, steps: 0 };
        // Steps are owned by /api/steps (the app's Edit button and the Health Shortcut); the store
        // keeps them separately, so this save can't overwrite them.
        await store.putDay(m[1], mergeDay(prev, body));
        return send(res, 200, { ok: true, day: await store.getDay(m[1]) }), true;
      }
      // Lets an iOS Shortcut push today's Health step count without touching food entries.
      if ((m = p.match(/^\/api\/steps\/(\d{4}-\d{2}-\d{2}|today)$/)) && req.method === "PUT") {
        if (m[1] !== "today" && !DATE_RE.test(m[1])) return send(res, 400, { code: "invalid_request", error: "Bad date" }), true;
        const body = await readBody(req);
        const key = m[1] === "today" ? todayKey() : m[1];
        const steps = Math.min(200000, Math.max(0, Math.round(parseSteps(body.steps ?? body.value ?? body))));
        await store.setSteps(key, steps);
        return send(res, 200, { ok: true, date: key, steps }), true;
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const body = await readBody(req);
        // { v: 2, settings, base } from this app version; a bare settings object from older ones.
        const merged = body && body.v === 2 ? mergeSettings(await store.getSettings(), body.settings, body.base) : body;
        if (!merged || typeof merged !== "object" || Array.isArray(merged)) return send(res, 400, { code: "invalid_request", error: "Bad settings" }), true;
        await store.setSettings(merged);
        return send(res, 200, { ok: true, settings: merged }), true;
      }
      if ((m = p.match(/^\/api\/barcode\/([0-9]{6,14})$/)) && req.method === "GET") {
        return send(res, 200, await lookupBarcode(m[1])), true;
      }
      if (p === "/api/ai" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.prompt || typeof body.prompt !== "string") return send(res, 400, { code: "invalid_request", error: "Missing prompt" }), true;
        const started = Date.now();
        const out = await askAI(body);
        // AI_DEBUG=1 logs the start of each reply, for working out why a food came back wrong.
        if (process.env.AI_DEBUG === "1") console.log("AI reply:", String(out.text || "").replace(/\s+/g, " ").slice(0, 400));
        const n = Array.isArray(body.images) ? body.images.length : body.image ? 1 : 0;
        console.log(`AI ${n > 1 ? n + "-image" : n ? "photo" : "text"} request answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return send(res, 200, out), true;
      }
      return send(res, 404, { error: "Not found" }), true;
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { code: e.code || "server_error", error: e.message || "Server error" });
      return true;
    }
  };
}

module.exports = { createApi, MOCK, API_KEY, MODEL, BASE_URL, APP_PASSWORD, INVITE_CODE };
