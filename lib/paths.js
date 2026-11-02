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
 *
 * 优先级：SHICI_CONFIG > 便携版 exe 同级目录 > 程序根目录。
 * 便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR，跟着 exe 走才不会换台机器就丢配置。
 */
export function configFile() {
  if (process.env.SHICI_CONFIG) return process.env.SHICI_CONFIG;
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return join(portableDir, "config.local.json");
  return join(appRoot(), "config.local.json");
}
