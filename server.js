/**
 * 本地服务：静态界面 + ReAct 接口。
 * 可被桌面端嵌入，也可直接 node server.js 启动。
 * 密钥只留在 config.local.json（或桌面端的用户目录）。
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import config, { assertConfig, saveConfig, keyEncrypted } from "./config.js";
import { ReactAgent, POETRY_SYSTEM_PROMPT, formatRequestError, isAbortError } from "./agent.js";
import { executeTool, getToolDefinitions } from "./tools.js";
import { presentTurn } from "./lib/present.js";
import { appRoot } from "./lib/paths.js";
import { requestJson } from "./lib/http.js";

/** 设为 1 时跳过 API 令牌校验，方便本机网页调试。桌面端仍会带令牌。 */
const DEV_NO_TOKEN = process.env.SHICI_DEV_NO_TOKEN === "1";

const bodyLimit = 1_500_000;

/** 允许访问的 Host 头。只认本机，挡住 DNS rebinding。 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
function isLocalHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(hostname);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {string} token
 * @returns {boolean}
 */
function hasValidToken(req, token) {
  const raw = req.headers["x-shichuang-token"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value, "utf8"), Buffer.from(token, "utf8"));
  } catch {
    return false;
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** DeepSeek 的 OpenAI 兼容地址。模型名从开放平台 GET /models 拉取，不在这里写死。 */
const DEEPSEEK = {
  baseUrl: "https://api.deepseek.com",
};

const agent = new ReactAgent({
  config,
  systemPrompt: POETRY_SYSTEM_PROMPT,
  tools: {
    definitions: getToolDefinitions(),
    execute: executeTool,
  },
});

/** 页面保存后，正在跑的这轮引擎也要用新配置。 */
function applyConfigToAgent() {
  agent.apiKey = config.apiKey;
  agent.baseUrl = config.baseUrl;
  agent.model = config.model;
  agent.maxIterations = config.maxIterations;
}

/**
 * 给页面看的配置。不返回密钥本身。
 */
function settingsView() {
  let ready = true;
  try {
    assertConfig();
  } catch {
    ready = false;
  }
  const key = String(config.apiKey || "").trim();
  return {
    ready,
    baseUrl: config.baseUrl,
    model: config.model,
    maxIterations: config.maxIterations,
    hasKey: key.length > 0,
    keyHint: key ? (keyEncrypted ? "已保存（系统加密）" : "已保存（命令行模式，明文）") : "",
    deepseek: DEEPSEEK,
  };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > bodyLimit) {
        reject(Object.assign(new Error("这段对话太长了，请新开一则再继续。"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} event
 * @param {object} data
 */
function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * @param {unknown} req
 * @param {object} payload
 */
function wantsStream(req, payload) {
  if (payload && payload.stream === true) return true;
  const accept = String(req.headers?.accept || "");
  return accept.includes("text/event-stream");
}

/**
 * @param {Array<{ name: string, ok?: boolean }>} trace
 */
function toolsSummary(trace) {
  return (Array.isArray(trace) ? trace : []).map((item) => ({
    name: item.name,
    ok: Boolean(item.ok),
  }));
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || "{}");
  } catch (error) {
    const status = error && error.status === 413 ? 413 : 400;
    sendJson(res, status, { error: status === 413 ? error.message : "请求不是合法的 JSON。" });
    return;
  }

  const text = String(payload.text ?? "").trim();
  if (!text) {
    sendJson(res, 400, { error: "请先写一点内容。" });
    return;
  }
  if (text.length > 8000) {
    sendJson(res, 400, { error: "这段文字太长了，请分成几次发送。" });
    return;
  }

  try {
    assertConfig();
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const stream = wantsStream(req, payload);
  const history = sanitizeHistory(payload.history);
  const trace = [];
  const ac = new AbortController();
  let settled = false;
  const onResponseClose = () => {
    // 客户端断开或主动 abort fetch 时取消模型请求；正常结束时 settled 已为 true。
    if (!settled) ac.abort();
  };
  res.on("close", onResponseClose);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
  }

  const emitProgress = (data) => {
    if (stream && !res.writableEnded) writeSse(res, "progress", data);
  };

  try {
    const answer = await agent.run(history, text, {
      signal: ac.signal,
      onRound(round) {
        emitProgress({ kind: "round", round });
      },
      onThought(thought) {
        const clipped = String(thought || "").trim().slice(0, 80);
        if (clipped) emitProgress({ kind: "thought", text: clipped });
      },
      onToolCall(name) {
        emitProgress({ kind: "tool", name });
      },
      onToolResult(name, content) {
        let result = null;
        let ok = false;
        try {
          result = JSON.parse(content);
          ok = true;
        } catch {
          ok = false;
        }
        trace.push({ name, ok, result });
        emitProgress({ kind: "tool_done", name, ok });
      },
      onToolError(name) {
        trace.push({ name, ok: false, result: null });
        emitProgress({ kind: "tool_done", name, ok: false });
      },
      onMaxIterations(max) {
        emitProgress({ kind: "max", max });
      },
    });
    settled = true;
    const body = {
      answer,
      history,
      presentation: presentTurn(trace),
      tools: toolsSummary(trace),
    };
    if (stream) {
      writeSse(res, "done", body);
      res.end();
    } else {
      sendJson(res, 200, body);
    }
  } catch (error) {
    settled = true;
    if (isAbortError(error) || ac.signal.aborted) {
      if (stream) {
        if (!res.writableEnded) {
          writeSse(res, "error", { error: "已停止。" });
          res.end();
        }
      } else if (!res.headersSent) {
        sendJson(res, 499, { error: "已停止。" });
      }
      return;
    }
    const message = formatRequestError(error);
    if (stream) {
      if (!res.writableEnded) {
        writeSse(res, "error", { error: message });
        res.end();
      }
    } else {
      sendJson(res, 502, { error: message });
    }
  } finally {
    res.off("close", onResponseClose);
  }
}

/**
 * @param {unknown} history
 */
/** 每轮送进模型的历史预算（粗略按字估算，中文约 2 字一个 token）。 */
const HISTORY_CHAR_BUDGET = 24000;

/**
 * 整理前端回传的历史：
 * - 只留最近 80 条；
 * - 较早的大段工具观测（韵部字表、诗集正文）折叠成占位，避免每轮重复上传；
 * - 总字数超预算时，继续从最早的非工具消息开始折叠。
 * 折叠只改 content，role / tool_call_id 保留，不会破坏 tool_calls 配对。
 *
 * @param {unknown} history
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const rows = history
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ ...item }))
    .slice(-80);

  const keepFrom = Math.max(0, rows.length - 6);
  let budget = HISTORY_CHAR_BUDGET;

  for (let i = 0; i < rows.length; i += 1) {
    const content = typeof rows[i].content === "string" ? rows[i].content : "";
    const size = content.length;

    if (i < keepFrom && rows[i].role === "tool" && size > 600) {
      rows[i].content = `（较早的工具结果已省略，原有 ${size} 字）`;
      continue;
    }

    if (budget - size < 0 && i < keepFrom) {
      rows[i].content = `（较早的对话已省略，原有 ${size} 字）`;
      continue;
    }

    budget -= size;
  }

  return rows;
}

/**
 * @param {string} pathname
 * @param {string} publicDir
 * @returns {string | null}
 */
function fileFor(pathname, publicDir) {
  const decoded = decodeURIComponent(pathname);
  const cleaned = normalize(decoded).replace(/^([/\\])+/, "");
  const full = resolve(publicDir, cleaned);
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null;
  return full;
}

/**
 * 向 OpenAI 兼容的 /models 拉取当前可用模型。密钥只用于这次请求，不写进日志。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleModels(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || "{}");
  } catch (error) {
    const status = error && error.status === 413 ? 413 : 400;
    sendJson(res, status, { error: status === 413 ? error.message : "请求不是合法的 JSON。" });
    return;
  }

  const apiKey = String(payload.apiKey ?? "").trim() || String(config.apiKey || "").trim();
  const baseUrl = String(payload.baseUrl ?? "").trim().replace(/\/+$/, "")
    || String(config.baseUrl || "").trim().replace(/\/+$/, "");

  if (!apiKey) {
    sendJson(res, 400, { error: "请先填写 API 密钥，再拉取模型。" });
    return;
  }
  if (!baseUrl) {
    sendJson(res, 400, { error: "请先填写接口地址。" });
    return;
  }
  let basePath = "";
  try {
    basePath = new URL(baseUrl).pathname;
  } catch {
    sendJson(res, 400, { error: "接口地址不是合法网址。" });
    return;
  }
  if (/\/chat\/completions\/?$/i.test(basePath)) {
    sendJson(res, 400, { error: "接口地址不要包含 /chat/completions。" });
    return;
  }

  try {
    const { status, data } = await requestJson(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 30000,
    });
    if (status < 200 || status >= 300) {
      const detail = typeof data === "object" && data
        ? (data.error?.message || data.message || "")
        : "";
      throw Object.assign(new Error(detail || `HTTP ${status}`), { status, data });
    }
    const rows = Array.isArray(data?.data) ? data.data : [];
    const models = [];
    const seen = new Set();
    for (const row of rows) {
      const id = String(row?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(row?.name || "").trim();
      models.push({ id, name: name && name !== id ? name : "" });
    }
    if (!models.length) {
      sendJson(res, 502, { error: "开放平台没有返回可用模型。" });
      return;
    }
    sendJson(res, 200, { models, baseUrl });
  } catch (error) {
    sendJson(res, 502, { error: formatRequestError(error) });
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleSettings(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || "{}");
  } catch (error) {
    const status = error && error.status === 413 ? 413 : 400;
    sendJson(res, status, { error: status === 413 ? error.message : "请求不是合法的 JSON。" });
    return;
  }

  const apiKey = String(payload.apiKey ?? "").trim() || String(config.apiKey || "").trim();
  const baseUrl = String(payload.baseUrl ?? "").trim();
  const model = String(payload.model ?? "").trim();
  const maxIterations = Number(payload.maxIterations);

  if (!apiKey) {
    sendJson(res, 400, { error: "请填写 API 密钥。" });
    return;
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 32) {
    sendJson(res, 400, { error: "工具轮次须为 1 到 32 的整数。" });
    return;
  }

  try {
    await saveConfig({ apiKey, baseUrl, model, maxIterations });
    applyConfigToAgent();
    sendJson(res, 200, settingsView());
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} filePath
 */
async function sendFile(res, filePath) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("未找到页面。");
      return;
    }
    throw error;
  }
}

/**
 * 简单版号比较：只认 x.y.z。返回 1 / 0 / -1。
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const left = String(a || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const right = String(b || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const UPDATE_RELEASE_API = "https://api.github.com/repos/haomingtang787-ai/an-awesome-project/releases/latest";
/** 国内直连 api.github.com 常失败时的回退地址（同一 JSON）。 */
const UPDATE_RELEASE_MIRRORS = [
  UPDATE_RELEASE_API,
  "https://ghfast.top/" + UPDATE_RELEASE_API,
  "https://mirror.ghproxy.com/" + UPDATE_RELEASE_API,
];

/**
 * 查一下 GitHub 上最新版是多少。离线时返回错误，不阻断使用。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleUpdateCheck(req, res) {
  let current = "0.0.0";
  try {
    const pkg = JSON.parse(await readFile(resolve(appRoot(), "package.json"), "utf8"));
    current = String(pkg.version || current);
  } catch {
    // 读不到就按 0.0.0 处理
  }

  let lastError = "查询更新失败。";
  for (const endpoint of UPDATE_RELEASE_MIRRORS) {
    try {
      const { status, data } = await requestJson(endpoint, {
        headers: { "User-Agent": "shichuang", Accept: "application/vnd.github+json" },
        timeoutMs: 15000,
      });
      if (status !== 200) {
        lastError = `查询更新失败（HTTP ${status}）。`;
        continue;
      }
      const latest = String(data?.tag_name || "").replace(/^v/i, "");
      if (!latest) {
        lastError = "开放平台没有返回版本号。";
        continue;
      }
      const releaseUrl = String(data?.html_url || "")
        || `https://github.com/haomingtang787-ai/an-awesome-project/releases/tag/v${latest}`;
      const assets = Array.isArray(data?.assets) ? data.assets : [];
      const exe = assets.find((item) => {
        const name = String(item?.name || "");
        return /win-x64\.exe$/i.test(name) || /诗窗\.exe$/i.test(name) || /\.exe$/i.test(name);
      });
      sendJson(res, 200, {
        current,
        latest,
        hasUpdate: compareVersions(latest, current) > 0,
        url: releaseUrl,
        downloadUrl: String(exe?.browser_download_url || releaseUrl || ""),
        name: String(data?.name || `诗窗 v${latest}`),
        publishedAt: String(data?.published_at || ""),
      });
      return;
    } catch (error) {
      const code = error && typeof error.code === "string" ? error.code : "";
      if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN" || code === "ETIMEDOUT") {
        lastError = "无法连接 GitHub，请检查网络后再试。";
      } else if (error && (error.name === "TimeoutError" || /超时/.test(String(error.message || "")))) {
        lastError = "查询更新超时，请稍后再试。";
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        lastError = /fetch failed/i.test(detail) ? "无法连接 GitHub，请检查网络后再试。" : detail;
      }
    }
  }

  sendJson(res, 502, { error: lastError });
}

/**
 * 启动本地服务。port 为 0 时由系统分配空闲端口。
 * @param {{ host?: string, port?: number, quiet?: boolean }} [options]
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const host = options.host || "127.0.0.1";
  const token = options.token || randomBytes(16).toString("hex");
  const listenPort = options.port === undefined
    ? (Number(process.env.PORT) || 8787)
    : options.port;
  const quiet = Boolean(options.quiet);
  const publicDir = resolve(appRoot(), "public");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);

      if (url.pathname.startsWith("/api/")) {
        if (!isLocalHost(req)) {
          sendJson(res, 403, { error: "只接受本机访问。" });
          return;
        }
        if (!DEV_NO_TOKEN && !hasValidToken(req, token)) {
          sendJson(res, 401, { error: "缺少访问令牌。请用终端打印的完整地址打开（带 ?t=），或设置 SHICI_DEV_NO_TOKEN=1 做本机调试。" });
          return;
        }
      }

      if (req.method === "GET" && (url.pathname === "/api/ready" || url.pathname === "/api/settings")) {
        sendJson(res, 200, settingsView());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/update") {
        await handleUpdateCheck(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        await handleSettings(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/models") {
        await handleModels(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        await handleChat(req, res);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "不支持这个请求方法。" });
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = fileFor(pathname, publicDir);
      if (!filePath || filePath === publicDir) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("未找到页面。");
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream" });
        res.end();
        return;
      }
      await sendFile(res, filePath);
    } catch (error) {
      if (res.headersSent) return;
      sendJson(res, 500, { error: "页面服务出错了。" });
      if (!quiet) console.error(error instanceof Error ? error.message : error);
    }
  });

  const address = await new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error && error.code === "EADDRINUSE") {
        reject(new Error(`端口 ${listenPort} 已被占用。可以换一个，例如：PORT=8788 npm start`));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, host);
  });

  const port = typeof address === "object" && address ? address.port : listenPort;
  if (!quiet) {
    if (DEV_NO_TOKEN) {
      console.log(`诗窗已打开：http://${host}:${port}/（已关闭令牌校验）`);
    } else {
      console.log(`诗窗已打开：http://${host}:${port}/?t=${token}`);
      console.log("请用上面的完整地址打开；只开端口号会因缺少令牌无法调用接口。");
    }
    console.log("命令行版本仍可用：npm run cli");
  }

  return {
    host,
    port,
    token,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    }),
  };
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
