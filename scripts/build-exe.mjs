/**
 * 打包 Windows 便携版。自动补齐国内 Electron 镜像，再调用 electron-builder。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

process.env.ELECTRON_MIRROR ||= "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= "https://npmmirror.com/mirrors/electron-builder-binaries/";

const cli = require.resolve("electron-builder/cli.js");
const child = spawn(process.execPath, [cli, "--win", "portable", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
