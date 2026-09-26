# Cloudflare 域名接入 Railway

## 思路

Cloudflare 继续做 DNS 托管（不迁走），只把 Apex 或子域名的 CNAME 指向 Railway 生成的域名。这样你保留 Cloudflare 的 CDN、防火墙、SSL 等所有功能，只是流量回源到 Railway。

---

## 前置条件

- 你的域名已经在 Cloudflare 托管（DNS 在 Cloudflare 管理）
- 你已经在 Railway 部署好 SPlayer 并生成了 `<random>.railway.app` 域名
- 你要绑定到 SPlayer 的子域名（推荐 `splayer.你的域名.com`，比 Apex 更简单）

---

## 方案 A：CNAME 子域名（推荐，最简单）

### 1. 在 Railway 添加自定义域名

1. 进入 Railway 项目 → **Settings** → **Networking**
2. 点 **Custom Domain** → 输入 `splayer.你的域名.com`
3. Railway 会显示一条 CNAME 记录让你添加，类似：
   ```
   Name:  splayer
   Type:  CNAME
   Target: xxxxx.railway.app
   ```

### 2. 在 Cloudflare 添加 CNAME

1. 登录 Cloudflare → 选你的域名 → **DNS** → **Records**
2. 点 **Add record**：
   - **Type**: `CNAME`
   - **Name**: `splayer`（如果是子域名就填子域名前缀）
   - **Target**: `xxxxx.railway.app`（从 Railway 复制）
   - **Proxy status**: ⚠️ **DNS only（灰云）**
     - **原因：** Cloudflare 代理（橙云）会改写 origin 响应头，可能导致 Railway 的 SSL 校验失败 + cookie 域名问题
     - 如果你坚持要用 Cloudflare 代理（为了 CDN/WAF），看下面方案 B
   - **TTL**: Auto
3. 保存

### 3. 等 SSL 证书签发

Railway 会自动用 Let's Encrypt 给你的自定义域名签证书。状态从 `Provisioning` 变成 `Active` 通常需要 2-5 分钟。

### 4. 验证

- 浏览器访问 `https://splayer.你的域名.com`
- 检查证书是 Let's Encrypt 签发的（点浏览器地址栏小锁）
- 如果还是 Railway 默认域名，可能是 DNS 还没生效，等 5-10 分钟

---

## 方案 B：保留 Cloudflare 代理（橙云）

如果你需要 Cloudflare 的 CDN/WAF，必须用橙云代理，需要额外配置：

### 1. Railway 端

Railway 的 Custom Domain 不支持 Cloudflare 代理模式，因为它要求直接 CNAME 解析。变通方案：

- **方法 1**：用 Railway CLI / API 拿到容器的真实出口 IP（不稳定，Railway 不保证 IP 固定）
- **方法 2**：用 Cloudflare 的 **Origin Server** + Cloudflare Tunnel（推荐但复杂）
- **方法 3**（最实用）：DNS only + 你自己在 Cloudflare 开 Page Rules 把流量绕过代理

### 2. 简化方案（推荐）

实际上 Cloudflare 灰云（DNS only）对 SPlayer 这种纯 web 应用来说完全够用：
- Railway 自带 Let's Encrypt SSL 证书
- Railway 自带 CDN 缓存（静态资源）
- 灰云解析延迟几乎为 0

唯一损失的是 Cloudflare WAF 和 DDoS 防护。如果你不需要这些（个人用足够），就用方案 A。

---

## 方案 C：Apex 域名（如果一定要用根域名）

Cloudflare 支持 CNAME Flattening，可以把 Apex 当 CNAME 用：

1. Cloudflare → DNS → 添加记录：
   - **Type**: `CNAME`（不是 A 记录！）
   - **Name**: `@`（或你的域名本身）
   - **Target**: `xxxxx.railway.app`
   - **Proxy**: 灰云
2. Cloudflare 会自动把 CNAME 拍平成 A 记录返回给客户端
3. Railway 那边按方案 A 步骤 1 添加 `你的域名.com` 作为 Custom Domain

---

## 常见问题

### Q: Cloudflare 显示 "DNS check failed" ？

A: 等 5-10 分钟让 DNS 全球生效。可以用 `dig splayer.你的域名.com` 或 https://dnschecker.org 查全球 DNS 解析状态。

### Q: 访问显示 "ERR_SSL_PROTOCOL_ERROR" ？

A: 两种可能：
1. Cloudflare SSL 模式设了 `Full (Strict)` 但 Railway 还没签好证书 → 等 5 分钟或改 SSL 模式为 `Flexible` 临时调试
2. 用了橙云代理 → 改成灰云

### Q: 解锁功能在自定义域名下不工作？

A: 看浏览器 DevTools Network 面板：
- `/api/unblock/netease?id=xxx` 返回 200 但 `url` 为 null → 第三方解锁源服务问题，过几分钟重试
- 返回 404 → nginx 配置没生效，确认 `nginx.conf` 里有 `/api/unblock/` location
- 返回 CORS 错误 → 不应该发生，因为同源；如果发生说明 nginx 把请求路由错了

### Q: 子路径访问 404（比如 `https://splayer.x.com/playlist`）？

A: nginx 配置的 `try_files $uri $uri/ /index.html;` 是 SPA 兜底，应该工作。如果不工作，可能是 Cloudflare 的 SSL/Cache 改写了路径。检查 Cloudflare **Rules → Page Rules** 没有干扰。
