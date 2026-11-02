/**
 * 诗窗桌面端。自己开窗口，不外跳浏览器。
 * 内嵌本地服务，界面仍用 public/ 这一套。
 */

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ close: () => Promise<void> } | null} */
let serverHandle = null;

function configurePaths() {
  const userData = app.getPath("userData");
  process.env.SHICI_CONFIG = path.join(userData, "config.local.json");
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
  return `http://${serverHandle.host}:${serverHandle.port}/`;
}

function createWindow(startUrl) {
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
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = startUrl.replace(/\/$/, "");
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(startUrl);
}

async function ready() {
  configurePaths();
  try {
    const startUrl = await bootServer();
    await createWindow(startUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("诗窗未能启动", message);
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
