// One-time setup: creates your .env file. Run:  node setup.js YOUR_OPENAI_API_KEY [model]
const fs = require("fs"), path = require("path");
const key = (process.argv[2] || "").trim(), model = (process.argv[3] || "gpt-4o").trim();
const file = path.join(__dirname, ".env");
if (fs.existsSync(file)) { console.log("\n  .env already exists. Open it in a text editor to change your key or model.\n"); process.exit(0); }
if (key.length < 20) {
  console.log("\n  Paste your OpenAI API key after the command, like:\n");
  console.log("    node setup.js sk-proj-xxxxxxxx\n");
  console.log("  Optionally add a model name after the key (default gpt-4o).");
  console.log("  Get a key at https://platform.openai.com/api-keys\n");
  process.exit(1);
}
fs.writeFileSync(file, `OPENAI_API_KEY=${key}\nOPENAI_MODEL=${model}\nPORT=3000\n`);
console.log(`\n  Saved .env (model: ${model}). Now run:  npm start\n`);
