# Plate: Indian calorie & nutrition tracker

Snap a photo of your meal. An OpenAI vision model identifies each food, estimates the grams,
matches it to a built-in database of 348 foods and drinks spanning Indian and other major world cuisines
(Italian, Chinese, Mexican, Japanese, Thai, Mediterranean, American, Korean) plus mocktails, cocktails, beer, wine and spirits, and logs calories,
protein, carbs, fat, fibre, sugar (total and added) and sodium.

## Run it

Needs **Node.js 18 or newer** (check with `node -v`). There is nothing to install.

1. Add your OpenAI API key (from https://platform.openai.com/api-keys). Easiest way:
   ```
   node setup.js sk-proj-your-key-here
   ```
   That creates a `.env` file for you. (Or make `.env` by hand — see below.)
2. Start the server:
   ```
   npm start
   ```
3. Open http://localhost:3000

### Making .env by hand instead

Create a new text file called `.env` in this folder with one line:
```
OPENAI_API_KEY=sk-proj-your-key-here
```
Note: files starting with a dot are hidden by default. On Mac press Cmd+Shift+. in Finder to see them; on Windows, turn on "Hidden items" in the View menu; on Linux use `ls -a`. Using `node setup.js` above avoids this.

Want to try it before adding a key? Run `npm run mock` for sample answers.

## Online version (Vercel)

Plate is deployed at **https://plate-app-psi.vercel.app** and works from any network. It asks for the
app password once per device, then stays logged in for about a year (Goals → This device → Log out).

- Code: `api/index.js` (Vercel function) → `app.js` (API) → `store.js` (Upstash Redis).
  `public/` is served as static files. `.vercelignore` keeps `.env` and `data/` off Vercel.
- Settings live in Vercel (Project → Settings → Environment Variables): `OPENAI_API_KEY`,
  `APP_PASSWORD`, and the `KV_*` variables from the connected Upstash Redis database.
  Optional: `OPENAI_MODEL`, `TZ_NAME` (time zone for the Shortcut's "today", default `Asia/Kolkata`).
- Deploy changes: `npx vercel deploy --prod`
- Copy a local log into Redis: `npx vercel env pull .env.vercel --environment=production`, then
  `node migrate-to-redis.js .env.vercel` (refuses to overwrite unless `--force`). Delete `.env.vercel` after.
- Point the local server at the online database instead of `data/plate-db.json`: run with `STORE=redis`
  and the `KV_REST_API_URL` / `KV_REST_API_TOKEN` values in `.env`.

## Use it on your phone

The terminal prints a second address such as `http://192.168.1.5:3000`.
Open that on your phone while it's on the same Wi-Fi. **Snap a meal** opens the camera directly.

To use it away from home Wi-Fi, this setup runs over [Tailscale](https://tailscale.com) — install
it on your Mac and iPhone, sign into the same account on both, and open the app at your Mac's
Tailscale address (e.g. `http://your-mac-name.tailXXXXXX.ts.net:3000`) instead of the LAN address.
Your Mac needs to be awake and the server running (see "Keeping it running" below).

### Install it as an app on iPhone (PWA)

Plate ships as an installable web app with its own icon, splash color, and full-screen
(no browser bar) mode.

1. Make sure your Mac and iPhone are on the same Wi-Fi and the server is running.
2. On your iPhone, open **Safari** (must be Safari, not Chrome) and go to the LAN address
   the terminal printed, e.g. `http://192.168.1.5:3000`.
3. Tap the **Share** icon → **Add to Home Screen** → **Add**.
4. Launch Plate from your Home Screen — it opens full-screen with its own icon, just like
   a native app.

Notes:
- Your Mac's IP address can change between Wi-Fi sessions, which will break the Home
  Screen icon; run the server on your Mac and reopen the address in Safari if that happens.
- The app still needs your Mac's server running and reachable — it's a local app, not a
  hosted one, so it won't work off that Wi-Fi network.

### Keeping it running

The server is installed as a background service (`~/Library/LaunchAgents/com.plate.server.plist`)
that starts automatically when you log into your Mac and restarts itself if it ever crashes. Your
Mac still needs to be powered on and awake (not asleep) for the app to be reachable. Useful commands:
```
launchctl kickstart -k gui/$(id -u)/com.plate.server   # restart it
launchctl bootout gui/$(id -u)/com.plate.server         # stop it permanently
```
Logs: `~/Library/Logs/plate-server.log` and `plate-server.err.log`.

## Personalising it

Go to the **Goals** tab → **Profile** → enter your name. The Today page will then greet you
with "Hey \<name\>" instead of just the date.

## Step count

The Today page shows a **Steps** card with a daily goal (edit the goal in Goals → Your daily
goals → Steps). You can tap **Edit** on the card to type in a step count by hand at any time.

To sync it automatically from Apple Health (a website can't read HealthKit), set up an iOS
Shortcut automation that sends the day's total to Plate. The same guide, with the exact address
and header for whoever is logged in, is in the app under **Goals → Steps from iPhone**.

1. **Shortcuts** → **Automation** → **+** → **Time of Day** (e.g. 10:00 PM, Daily) → **Run Immediately**.
   Add a second automation at 2:00 PM for updates during the day.
2. **Find Health Samples** → type **Steps**, filter **Start Date is Today**
   (with an Apple Watch, also **Source is** your iPhone, so steps aren't counted twice).
3. **Calculate Statistics** → **Sum** of the Health Samples. (Sending the samples themselves
   gives a list of small readings, not the day's total.)
4. **Get Contents of URL**:
   - URL: `https://plate-app-psi.vercel.app/api/steps/today`
   - Method: `PUT`
   - Headers: `Authorization` = `Bearer <APP_PASSWORD>` for the owner, or
     `Bearer <username>:<password>` for anyone else
   - Request body: **JSON**, a **Number** field `steps` set to the Statistics result
5. Tap ▶︎ to test; today's steps appear on the Dashboard.

The endpoint accepts `8423`, `"8,423"`, a list of samples (added up), or form data, and "today"
uses India time (`TZ_NAME` to change it).

## Barcode scanning

Tap **Barcode** in Add food, photograph a product's barcode, and its nutrition (from the free
[Open Food Facts](https://world.openfoodfacts.org) database, no API key needed) loads into the
review panel for you to check and add. Browsers with a built-in barcode reader (Chrome) decode it
on-device; Safari on iPhone doesn't have one, so the AI model reads the digits printed under the
bars instead, and a check-digit test catches misreads. Not every packaged product is in the
database — if a barcode isn't found, use **Scan label** or **Describe** instead.

## Using it on two devices

Your phone and laptop can both have Plate open. Each save sends only that device's changes, so
food added on one isn't wiped out by the other. Changes that can't be saved (offline, server
down) stay on the device, show a "will retry" message, and are sent when the app is online or
reopened. Photos older than 14 days load when you open that day, which keeps the app fast as the
log grows. After 10 wrong passwords, logins from that address are blocked for 15 minutes.

## Where things live

- `public/index.html`: the whole app, including the food database
- `server.js`: local server — serves `public/` and the API from `app.js`
- `app.js` / `store.js` / `api/index.js`: the API, the file/Redis stores, and the Vercel entry point
- `data/plate-db.json`: your food log, created on first save. Back this file up to keep your history.

## Settings (.env)

| Name | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | none | Required for photo recognition |
| `OPENAI_MODEL` | `gpt-4o` | Model used for recognition. Must accept images |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at any OpenAI-compatible API |
| `OPENAI_JSON_MODE` | on | Set `0` if your provider rejects `response_format` |
| `PORT` | `3000` | Port to run on |
| `MOCK` | off | `1` returns sample answers without calling the API |
| `APP_PASSWORD` | none | When set, the app and API need this password (set on Vercel) |
| `STORE` | file | `redis` uses the Upstash database instead of `data/plate-db.json` |

## Troubleshooting

- **"The server has no API key"**: create `.env` as in step 1, then restart `npm start`.
- **"The API rejected the key"**: the key is wrong, or the account has no credit.
- **"The model wasn't found or can't read images"**: set `OPENAI_MODEL` to a vision-capable model your account can use.
- **HEIC photos won't open in Chrome**: use Safari, or on iPhone set Settings > Camera > Formats > Most Compatible.
- Every recognition request is logged in the terminal, with how long it took.
