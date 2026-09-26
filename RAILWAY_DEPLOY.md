# Railway 部署指南

## 改动概览

本次部署基于 SPlayer 主分支 + 以下定制改动：

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 网页端解锁闸门移除 | `src/core/player/SongManager.ts` | 去掉 `prefetchNextSong` 与 `getAudioSource` 中的 `isElectron &&`，让 web 端也走解锁流程 |
| 独立 UnblockAPI 服务 | `server/unblock-server.mjs` | 复刻桌面端 `electron/server/unblock/` 的 Fastify 路由，作为独立 Node.js HTTP 服务跑在 127.0.0.1:25885 |
| nginx 反代解锁接口 | `nginx.conf` | 新增 `location /api/unblock/` → `http://127.0.0.1:25885/unblock/` |
| 容器启动 unblock 服务 | `docker-entrypoint.sh` | `node /app/server/unblock-server.mjs &` |
| Dockerfile 拷贝新文件 | `Dockerfile` | 把 `server/unblock-server.mjs` 和 `electron/server/unblock/kwDES.js` 带进运行镜像，并 `EXPOSE 25884` |
| 移动端 safe-area 适配 | `index.html` / `AppLayout.vue` / `MainPlayer.vue` | 加 `viewport-fit=cover`、`env(safe-area-inset-*)`、扩大播放栏触摸目标 |
| Railway 配置 | `railway.toml` / `.env.example` | 健康检查 + 重启策略 + 环境变量清单 |

---

## 步骤 1：清理 Railway 旧项目

为了腾出额度，先删掉旧的 `perceptive-wisdom` 项目（**不可逆操作，请先确认无重要数据**）：

1. 打开 https://railway.com/dashboard
2. 找到 `perceptive-wisdom` 项目卡片
3. 点击右上角 ⋮ → **Settings**
4. 滚动到底部 **Danger Zone** → **Delete Project**
5. 在弹窗中输入项目名确认

---

## 步骤 2：把改动推到你的 GitHub Fork

我没有你的 GitHub 凭据，需要你本地 push：

```bash
# 在你本地的 SPlayer 仓库
git add -A
git commit -m "feat: web unlock + mobile safe-area + railway deploy"
git push origin main
```

如果还没 fork 仓库：
1. 去 https://github.com/imsyy/SPlayer 点 Fork
2. `git clone https://github.com/<你的用户名>/SPlayer.git`
3. 把我修改的文件覆盖过去（或者直接用我修改后的整个项目目录）
4. push

---

## 步骤 3：在 Railway 新建项目部署

1. 打开 https://railway.com → 右上角 **New Project**
2. 选 **Deploy from GitHub repo**
3. 授权 Railway 访问你 fork 的 SPlayer 仓库
4. Railway 会自动检测 `Dockerfile` 并开始构建

构建期间保持默认配置即可。Railway 会自动用 `Dockerfile` 构建。

---

## 步骤 4：配置环境变量（可选）

Railway 项目的 **Variables** 标签里，添加以下变量（都是可选的，不设就用默认值）：

| Key | Value | 说明 |
| --- | --- | --- |
| `NETEASE_SERVER_IP` | `220.197.30.65` | 网易云 IP（默认值可改） |
| `UNBLOCK_SOURCES` | `kugou kuwo bodian pyncmd` | 解锁音源 |
| `UNBLOCK_API_PORT` | `25885` | UnblockAPI 端口 |
| `UNBLOCK_API_HOST` | `127.0.0.1` | UnblockAPI 监听地址 |

**注意：** `PORT` 不要手动设置，Railway 会自动识别 Dockerfile 的 `EXPOSE 25884`。

---

## 步骤 5：生成域名

1. 进入 Railway 项目 → **Settings** 标签
2. 找到 **Networking** 区域
3. 点 **Generate Domain**（Railway 会自动给你一个 `<random>.railway.app` 子域名）
4. 等待 1-2 分钟，访问该域名测试是否能打开 SPlayer

验证清单：
- [ ] 首页能加载
- [ ] 搜索歌曲能出结果
- [ ] 播放 VIP 歌曲（默认开启了 netease 解锁源）能听到声音
- [ ] 手机访问，底部播放栏不被 home indicator 遮挡

如果解锁没生效：进入设置 → 音源管理，确认 `netease` / `bodian` / `kuwo` 至少有一个开关是开的。

---

## 步骤 6：绑定自定义域名（Cloudflare）

参见 `CLOUDFLARE_DOMAIN.md`。

---

## 常见问题

### Q: 构建失败提示 `electron-vite: not found`？

A: Dockerfile 里用 `npx electron-vite build`，不需要全局安装。如果还是失败，确认 `pnpm install --frozen-lockfile --ignore-scripts` 这一步成功了（看构建日志）。

### Q: 部署成功但访问 502？

A: 检查 Railway **Deployments** 标签里的日志，看 nginx 是否启动成功。常见原因：
- 端口冲突（确认 `EXPOSE 25884` 没被改）
- ncm-api 启动失败（看日志里有没有 `@neteasecloudmusicapienhanced/api` 的输出）

### Q: 解锁不工作，歌曲放不出来？

A: 三步排查：
1. 浏览器开发者工具 Network 面板，看 `/api/unblock/netease?id=xxx` 请求是 200 还是 404
2. 如果 404：检查 nginx 容器内是否有 `location /api/unblock/` 配置（容器内执行 `cat /etc/nginx/conf.d/default.conf`）
3. 如果 200 但 url 为 null：检查 `server/unblock-server.mjs` 是否在跑（容器内执行 `curl http://127.0.0.1:25885/`）

### Q: Railway 免费额度够用吗？

A: 删掉 `perceptive-wisdom` 后， Hobby Plan 5 美元/月 给 500 小时执行时间 + 5GB 出站流量。SPlayer 这种轻量应用足够。
