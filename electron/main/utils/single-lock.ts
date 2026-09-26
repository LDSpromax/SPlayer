import { app } from "electron";
import { systemLog } from "../logger";
import mainWindow from "../windows/main-window";
import { processProtocolFromCommand } from "./protocol";

/**
 * 初始化单实例锁
 * @returns 如果当前实例获得了锁，返回 true；否则返回 false
 */
export const initSingleLock = (): boolean => {
  const gotTheLock = app.requestSingleInstanceLock();
  // 如果未获得锁，退出当前实例
  if (!gotTheLock) {
    app.quit();
    systemLog.warn("❌ 已有一个实例正在运行");
    return false;
  }
  // 当第二个实例启动时触发
  else {
    app.on("second-instance", (_, commandLine) => {
      if (!processProtocolFromCommand(commandLine)) {
        systemLog.warn("❌ 第二个实例将要启动");
      } else {
        systemLog.info("🚀 第二个实例将要启动，通过 Custom Protocol");
      }
      // 主窗口已关闭则重建，否则直接显示，避免「关掉窗口后重新打开进不去」
      if (!mainWindow.getWin()) {
        mainWindow.create();
      } else {
        mainWindow.showWindow();
      }
    });
  }
  return true;
};
