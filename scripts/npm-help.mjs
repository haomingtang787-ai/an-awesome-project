/**
 * Print Shichuang npm scripts.
 */

const lines = [
  "Shichuang (诗窗) npm scripts:",
  "",
  "  npm run desktop      Open the desktop window (dev)",
  "  npm run build:exe    Build dist/诗窗.exe (uses npmmirror Electron binaries)",
  "  npm start            Local web server only (use the printed URL with ?t=)",
  "  npm run cli          Terminal chat",
  "  npm run build:data   Rebuild data/",
  "  npm run help         Show this list",
  "",
  "  Web debug tip: open the full URL printed by npm start (includes ?t=).",
  "  Or set SHICI_DEV_NO_TOKEN=1 to skip the token check on localhost.",
];

console.log(lines.join("\n"));
