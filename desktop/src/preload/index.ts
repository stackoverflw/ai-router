/**
 * Preload 桥。
 *
 * 渲染进程只能通过这里暴露的 API 访问主进程能力：
 * 保持 `contextIsolation: true` + `nodeIntegration: false`，
 * 不把 ipcRenderer 或 Node 能力直接交给页面。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  AppSettings,
  CloudSettings,
  ExecutionEvent,
  PullProgress,
} from '../shared/types.js';
import { IPC } from '../shared/types.js';

const api = {
  // ---- 路由与执行 ----
  route: (prompt: string) => ipcRenderer.invoke(IPC.route, prompt),
  run: (prompt: string) => ipcRenderer.invoke(IPC.run, prompt),

  onExecutionEvent: (handler: (event: ExecutionEvent) => void) => {
    const listener = (_event: unknown, payload: ExecutionEvent): void => handler(payload);
    ipcRenderer.on(IPC.executionEvent, listener);
    return () => ipcRenderer.removeListener(IPC.executionEvent, listener);
  },

  // ---- 模型 ----
  listLocalModels: () => ipcRenderer.invoke(IPC.listLocalModels),
  listModelPresets: () => ipcRenderer.invoke(IPC.listModelPresets),
  pullModel: (name: string) => ipcRenderer.invoke(IPC.pullModel, name),
  cancelPull: (name: string) => ipcRenderer.invoke(IPC.cancelPull, name),
  deleteModel: (name: string) => ipcRenderer.invoke(IPC.deleteModel, name),

  onPullProgress: (handler: (progress: PullProgress) => void) => {
    const listener = (_event: unknown, payload: PullProgress): void => handler(payload);
    ipcRenderer.on(IPC.pullProgress, listener);
    return () => ipcRenderer.removeListener(IPC.pullProgress, listener);
  },

  // ---- 提供商状态 ----
  providerStatus: () => ipcRenderer.invoke(IPC.providerStatus),

  // ---- Ollama 进程托管 ----
  startOllama: () => ipcRenderer.invoke(IPC.startOllama),
  stopOllama: () => ipcRenderer.invoke(IPC.stopOllama),

  // ---- 设置 ----
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC.saveSettings, settings),
  testCloudConnection: (cloud: CloudSettings) => ipcRenderer.invoke(IPC.testCloudConnection, cloud),

  // ---- 系统 ----
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('aiRouter', api);
