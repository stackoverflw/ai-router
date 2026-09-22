/**
 * Electron 主进程入口。
 *
 * 安全基线：contextIsolation 开启、nodeIntegration 关闭、
 * 拒绝任意新窗口与外部导航，只通过 preload 暴露的白名单 IPC 交互。
 */

import { BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isOllamaRunning, startOllama } from './config/ollama.js';
import { loadSettings } from './config/settings.js';
import { registerIpc } from './ipc/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#070b0e',
    autoHideMenuBar: true,
    title: 'AI Router',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // 外部链接交给系统浏览器，应用内不开新窗口。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}

app.whenReady().then(async () => {
  await loadSettings();

  // 启动时不阻塞界面：只在后台探测，必要时尝试拉起 Ollama。
  void (async () => {
    const settings = await loadSettings();
    if (!(await isOllamaRunning(settings.ollamaHost))) {
      // 用户已安装但没开服务时，应用代劳；未安装则静默跳过，界面会给出引导。
      await startOllama(settings.ollamaHost);
    }
  })();

  mainWindow = createWindow();
  registerIpc(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
