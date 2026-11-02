/**
 * 诗窗桌面端。自己开窗口，不外跳浏览器。
 * 内嵌本地服务，界面仍用 public/ 这一套。
 *
 * 安全约定：
 * - 只把令牌传给本窗口的 URL，页面用它在请求头里带回去；
 * - 窗口跳转与外链只放行 http/https，且必须与本地服务同源；
 * - 渲染进程崩溃、服务出错都写日志，比弹一个白屏好查。
 */

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ close: () => Promise<void>, token: string } | null} */
let serverHandle = null;
/** @type {string} */
let logFile = "";

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line, "utf8");
  } catch {
    // 写不了日志就别再抛错
  }
}

/**
 * 配置与日志放哪：便携版跟着 exe 走，安装版放用户目录。
 * 目录不可写时（例如放在 Program Files）回退用户目录。
 */
function resolveStateDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    try {
      fs.accessSync(portableDir, fs.constants.W_OK);
      return portableDir;
    } catch {
      // 只读目录，回退
    }
  }
  return app.getPath("userData");
}

function configurePaths() {
  const stateDir = resolveStateDir();
  logFile = path.join(stateDir, "shichuang.log");
  process.env.SHICI_CONFIG = process.env.SHICI_CONFIG || path.join(stateDir, "config.local.json");
  if (app.isPackaged) {
    process.env.SHICI_ROOT = app.getAppPath();
    process.env.SHICI_DATA = path.join(process.resourcesPath, "data");
  } else {
    process.env.SHICI_ROOT = path.join(__dirname, "..");
    process.env.SHICI_DATA = path.join(__dirname, "..", "data");
  }
}

async function bootServer() {
  const serverUrl = pathToFileURL(path.join(process.env.SHICI_ROOT, "server.js")).href;
  const { startServer } = await import(serverUrl);
  serverHandle = await startServer({ port: 0, quiet: true });
  log("server started", `port=${serverHandle.port}`);
  return `http://127.0.0.1:${serverHandle.port}/`;
}

/**
 * 只放行 http/https，其余协议（file:、smb:、ms-msdt: 之类）一律不打开。
 * @param {string} url
 */
function openExternal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    log("blocked external", parsed.protocol, url);
    return;
  }
  shell.openExternal(parsed.href).catch((error) => log("openExternal failed", String(error)));
}

/**
 * @param {string} url
 * @param {string} base
 */
function isSameOrigin(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function createWindow(startUrl) {
  const token = serverHandle ? serverHandle.token : "";
  const appUrl = `${startUrl}?t=${encodeURIComponent(token)}`;

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: "诗窗",
    backgroundColor: "#f3eee4",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "shichuang.ico")
      : path.join(__dirname, "..", "scripts", "shichuang.ico"),
  });

  Menu.setApplicationMenu(null);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isSameOrigin(url, startUrl)) return;
    event.preventDefault();
    openExternal(url);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log("render-process-gone", details.reason);
  });

  mainWindow.webContents.on("unresponsive", () => {
    log("renderer unresponsive");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(appUrl);
}

async function ready() {
  configurePaths();
  process.on("uncaughtException", (error) => {
    log("uncaughtException", error instanceof Error ? error.stack || error.message : String(error));
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", String(reason));
  });

  try {
    const startUrl = await bootServer();
    await createWindow(startUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("boot failed", message);
    dialog.showErrorBox("诗窗未能启动", `${message}\n\n日志：${logFile}`);
    app.quit();
  }
}

app.whenReady().then(ready);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (serverHandle) {
    const handle = serverHandle;
    serverHandle = null;
    handle.close().catch(() => {});
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    ready();
  }
});
