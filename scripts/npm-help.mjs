/**
 * Print Shichuang npm scripts.
 */

const lines = [
  "Shichuang (诗窗) npm scripts:",
  "",
  "  npm run desktop      Open the desktop window (dev)",
  "  npm run build:exe    Build dist/诗窗.exe",
  "  npm start            Local web server only (http://127.0.0.1:8787)",
  "  npm run cli          Terminal chat",
  "  npm run build:data   Rebuild data/",
  "  npm run help         Show this list",
];

console.log(lines.join("\n"));
