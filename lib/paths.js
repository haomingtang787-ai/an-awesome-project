/**
 * 程序根目录与数据目录。
 * 桌面端打包后，数据在 extraResources，密钥写在用户目录。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 代码所在根目录（开发时是仓库根，打包后是 asar 内）。
 */
export function appRoot() {
  return process.env.SHICI_ROOT || moduleRoot;
}

/**
 * 检索数据目录。
 */
export function dataDir() {
  return process.env.SHICI_DATA || join(appRoot(), "data");
}

/**
 * @param {...string} parts
 */
export function dataFile(...parts) {
  return join(dataDir(), ...parts);
}

/**
 * 本地密钥文件。
 */
export function configFile() {
  return process.env.SHICI_CONFIG || join(appRoot(), "config.local.json");
}
