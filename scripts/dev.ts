#!/usr/bin/env node

/**
 * 跨平台开发启动脚本
 * 自动检测操作系统并设置相应的字符编码
 */

import { spawn } from "child_process";
import os from "os";

// 检测操作系统平台
const platform = os.platform();
const isWindows = platform === "win32";
const isMacOS = platform === "darwin";

console.log(`🚀 检测到操作系统: ${platform}`);

// 设置环境变量
const env: NodeJS.ProcessEnv = { ...process.env };

// 清理会干扰 Electron 正常运行的继承变量
// 这些变量常由宿主 Electron 应用（如 Cherry Studio）注入，
// 会导致 electron 二进制以纯 Node 模式运行、主进程拿不到 BrowserWindow 等 API
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

// 开发模式使用独立端口，避免与正在运行的生产版抢端口（EADDRINUSE）
// 仅在用户未显式指定时生效
env.VITE_SERVER_PORT ??= "25886";
env.VITE_WEB_PORT ??= "14559";

const startElectronVite = (): void => {
  console.log("🔧 正在启动 Electron Vite 开发服务器...");

  // 设置 Node.js 选项
  env.NODE_OPTIONS = "--max-old-space-size=4096";

  // 传递给 electron-vite 的参数
  const runArgs = ["dev"];
  // 前两个参数分别是 node 和此脚本的路径，丢弃它们
  const args = process.argv.slice(2);
  // 添加参数
  if (args.length > 0) {
    runArgs.push(...args);
  }
  // 强制 dev 走 XWayland（X11）：GNOME Wayland 下 Mutter 不支持客户端 setAlwaysOnTop（置顶失效），
  // X11 下置顶与拖拽均正常。通过 -- 透传给 electron-vite，由其转发给 electron 二进制
  if (!args.includes("--ozone-platform=x11")) {
    runArgs.push("--", "--ozone-platform=x11");
  }

  const electronVite = spawn("electron-vite", runArgs, {
    stdio: "inherit",
    shell: true,
    env,
  });

  electronVite.on("close", (code) => {
    console.log(`\n🏁 开发服务器已停止 (退出码: ${code})`);
    process.exit(code ?? 0);
  });

  electronVite.on("error", (err) => {
    console.error("❌ 启动失败:", err.message);
    process.exit(1);
  });

  // 优雅退出处理
  process.on("SIGINT", () => {
    console.log("\n🛑 正在停止开发服务器...");
    electronVite.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    console.log("\n🛑 正在停止开发服务器...");
    electronVite.kill("SIGTERM");
  });
};

if (isWindows) {
  console.log("Windows 环境 - 正在设置代码页为 UTF-8");
  // Windows 环境下先执行 chcp 65001
  const chcp = spawn("chcp", ["65001"], {
    stdio: "inherit",
    shell: true,
    env,
  });

  chcp.on("close", (code) => {
    if (code === 0) {
      console.log("✅ 代码页设置成功");
      startElectronVite();
    } else {
      console.warn("⚠️  代码页设置失败，继续启动...");
      startElectronVite();
    }
  });
} else {
  // macOS 和 Linux 环境
  console.log(`🐧 ${isMacOS ? "macOS" : "Linux"} 环境 - 正在设置 UTF-8 编码`);
  const langVar = env.LC_ALL || env.LANG || "";
  if (langVar.endsWith("UTF-8")) {
    console.log("✅ 当前环境已设置 UTF-8 编码");
  } else {
    if (langVar.startsWith("zh_CN")) {
      env.LC_ALL = "zh_CN.UTF-8";
      env.LANG = "zh_CN.UTF-8";
    } else {
      env.LC_ALL = "en_US.UTF-8";
      env.LANG = "en_US.UTF-8";
    }
  }
  setTimeout(() => startElectronVite(), 0);
}
