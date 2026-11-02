/**
 * 密钥落盘加密。
 *
 * 桌面端（Electron）走系统凭据保护：Windows 是 DPAPI，macOS 是 Keychain，Linux 是 libsecret。
 * 命令行（纯 Node）没有 safeStorage，退回明文，并在保存时收紧文件权限。
 *
 * 用 createRequire 取 electron：在纯 Node 里 require("electron") 只会拿到一个可执行文件路径，
 * safeStorage 为 undefined，不会抛错，正好走明文回退。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @type {{ isEncryptionAvailable?: () => boolean, encryptString?: (s: string) => Buffer, decryptString?: (b: Buffer) => string } | null} */
let safeStorage = null;
try {
  const electron = require("electron");
  safeStorage = electron && electron.safeStorage ? electron.safeStorage : null;
} catch {
  safeStorage = null;
}

/**
 * 当前环境能否加密保存。
 * @returns {boolean}
 */
export function canEncrypt() {
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * 把明文密钥加密成 base64；不能加密时返回 null。
 * @param {string} plain
 * @returns {string | null}
 */
export function encryptString(plain) {
  if (!canEncrypt()) return null;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return null;
  }
}

/**
 * 把 base64 密文解回明文；解不开时返回 null（换了机器、换了用户都会解不开）。
 * @param {string} encoded
 * @returns {string | null}
 */
export function decryptString(encoded) {
  if (!canEncrypt() || typeof encoded !== "string" || !encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}
