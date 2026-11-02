/**
 * 接口配置。
 *
 * 默认值在这里。密钥、地址、模型和轮次写在 config.local.json，不进仓库。
 * 页面的「接口设置」会写那个文件。模型必须支持 OpenAI 兼容的 function calling。
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { configFile } from "./lib/paths.js";

const localFile = configFile();

const defaults = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  maxIterations: 8,
};

/**
 * @returns {typeof defaults}
 */
function readLocal() {
  let raw;
  try {
    raw = readFileSync(localFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...defaults };
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

  return {
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : defaults.apiKey,
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : defaults.baseUrl,
    model: typeof parsed.model === "string" ? parsed.model : defaults.model,
    maxIterations: Number.isInteger(parsed.maxIterations) ? parsed.maxIterations : defaults.maxIterations,
  };
}

/** @type {typeof defaults} */
const config = readLocal();

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
  await writeFile(localFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  config.apiKey = normalized.apiKey;
  config.baseUrl = normalized.baseUrl;
  config.model = normalized.model;
  config.maxIterations = normalized.maxIterations;
}

export default config;
