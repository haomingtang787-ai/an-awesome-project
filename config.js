/**
 * 接口配置。
 *
 * 默认值在这里。密钥、地址、模型和轮次写在 config.local.json，不进仓库。
 * 页面的「接口设置」会写那个文件。模型必须支持 OpenAI 兼容的 function calling。
 *
 * 密钥的落盘形式：
 * - 桌面端：写 apiKeyEnc（safeStorage 加密，Windows 走 DPAPI），明文不落盘；
 * - 命令行：没有 safeStorage，退回 apiKey 明文，并把文件权限收到 0600。
 * 两种形式都能读，老版本的明文文件可以无缝升级。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { configFile } from "./lib/paths.js";
import { canEncrypt, decryptString, encryptString } from "./lib/secret.js";

const localFile = configFile();

const defaults = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  maxIterations: 8,
};

/**
 * @returns {typeof defaults & { keyEncrypted: boolean }}
 */
function readLocal() {
  let raw;
  try {
    raw = readFileSync(localFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...defaults, keyEncrypted: false };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("config.local.json 不是合法的 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.local.json 须是一个对象。");
  }

  let apiKey = "";
  let keyEncrypted = false;
  if (typeof parsed.apiKeyEnc === "string" && parsed.apiKeyEnc) {
    // 换了机器或换了 Windows 用户，DPAPI 解不开，此时按“未配置”处理，让用户重填。
    apiKey = decryptString(parsed.apiKeyEnc) ?? "";
    keyEncrypted = true;
  } else if (typeof parsed.apiKey === "string") {
    apiKey = parsed.apiKey;
  }

  return {
    apiKey,
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : defaults.baseUrl,
    model: typeof parsed.model === "string" ? parsed.model : defaults.model,
    maxIterations: Number.isInteger(parsed.maxIterations) ? parsed.maxIterations : defaults.maxIterations,
    keyEncrypted,
  };
}

const loaded = readLocal();

/** @type {typeof defaults} */
const config = {
  apiKey: loaded.apiKey,
  baseUrl: loaded.baseUrl,
  model: loaded.model,
  maxIterations: loaded.maxIterations,
};

/** 密钥是否以密文形式存在磁盘上（用于设置页提示）。 */
export const keyEncrypted = loaded.keyEncrypted;

/**
 * 判断字符串配置是否已填写。
 * @param {unknown} value
 * @returns {boolean}
 */
function isFilled(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 启动前检查配置。缺项或格式不对时抛出错误，由命令行打印后退出。
 * @param {typeof config} [target]
 */
export function assertConfig(target = config) {
  const missing = [];
  if (!isFilled(target.apiKey)) missing.push("apiKey");
  if (!isFilled(target.baseUrl)) missing.push("baseUrl");
  if (!isFilled(target.model)) missing.push("model");

  if (missing.length > 0) {
    throw new Error(
      `请先填写 ${missing.join("、")}。可在页面的「接口设置」里填写，结果会写入 config.local.json，不会进仓库。所用模型必须支持 function calling（工具调用）。`,
    );
  }

  if (!Number.isInteger(target.maxIterations) || target.maxIterations < 1) {
    throw new Error("工具轮次须为大于 0 的整数。");
  }

  let base;
  try {
    base = new URL(target.baseUrl);
  } catch {
    throw new Error("接口地址不是合法网址。示例：https://api.deepseek.com");
  }

  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("接口地址须以 http:// 或 https:// 开头。");
  }

  if (/\/chat\/completions\/?$/i.test(base.pathname)) {
    throw new Error("接口地址不要包含 /chat/completions，程序会自动拼接。示例：https://api.deepseek.com");
  }
}

/**
 * 把已经通过 assertConfig 的配置写入 config.local.json，并更新内存中的对象。
 * @param {{ apiKey: string, baseUrl: string, model: string, maxIterations: number }} next
 */
export async function saveConfig(next) {
  const normalized = {
    apiKey: String(next.apiKey ?? "").trim(),
    baseUrl: String(next.baseUrl ?? "").trim().replace(/\/+$/, ""),
    model: String(next.model ?? "").trim(),
    maxIterations: next.maxIterations,
  };
  assertConfig(normalized);

  const encrypted = encryptString(normalized.apiKey);
  const onDisk = encrypted
    ? { apiKeyEnc: encrypted, baseUrl: normalized.baseUrl, model: normalized.model, maxIterations: normalized.maxIterations }
    : { apiKey: normalized.apiKey, baseUrl: normalized.baseUrl, model: normalized.model, maxIterations: normalized.maxIterations };

  writeFileSync(localFile, `${JSON.stringify(onDisk, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  config.apiKey = normalized.apiKey;
  config.baseUrl = normalized.baseUrl;
  config.model = normalized.model;
  config.maxIterations = normalized.maxIterations;
  return { encrypted: Boolean(encrypted) };
}

export default config;
