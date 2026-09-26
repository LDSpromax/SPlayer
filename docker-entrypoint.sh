#!/bin/sh
# 容器启动入口
# 启动顺序：
#   1. 启动 UnblockNeteaseMusic (DNS 劫持模式，监听 80/443，劫持 music.163.com 流量)
#   2. 启动 UnblockAPI (Node.js HTTP 服务，端口 25885，给前端 unlockSongUrl 用)
#   3. 改写 /etc/hosts 把 music.163.com 等域名指向 127.0.0.1
#   4. 启动 nginx (端口 25884)
#   5. 启动 NeteaseCloudMusicApi (端口 3000) - 前台运行

set -e

# ============== 关键：让 ncm-api 监听 3000（nginx 反代 3000） ==============
# ncm-api 默认读 process.env.PORT，没设则用 3000
# Railway 可能注入 PORT=<动态值>，导致监听非 3000 端口
# 这里强制覆盖为 3000，让 nginx 反代 3000 能命中
export PORT=3000
export HOST=0.0.0.0

# ============== 启动 UnblockNeteaseMusic ==============
# 注意：-p 80:443 需要 root；本镜像默认以 root 启动，nginx 后续会降权
# 用 nohup + & 放后台
echo "[entrypoint] starting UnblockNeteaseMusic..."
nohup unblockneteasemusic \
  -p 80:443 \
  -s \
  -f ${NETEASE_SERVER_IP:-220.197.30.65} \
  -o ${UNBLOCK_SOURCES:-kugou bodian pyncmd} \
  > /var/log/unblockneteasemusic.log 2>&1 &

# ============== 启动 UnblockAPI ==============
echo "[entrypoint] starting UnblockAPI (Node.js, port 25885)..."
nohup node /app/server/unblock-server.mjs > /var/log/unblock-api.log 2>&1 &

# ============== 写 /etc/hosts 劫持网易云域名 ==============
# 让 music.163.com 等域名指向本机 UnblockNeteaseMusic
for domain in music.163.com interface.music.163.com interface3.music.163.com \
              interface.music.163.com.163jiasu.com interface3.music.163.com.163jiasu.com; do
  if ! grep -q "$domain" /etc/hosts; then
    echo "127.0.0.1 $domain" >> /etc/hosts
  fi
done

# ============== 等 UnblockNeteaseMusic 就绪 ==============
# 用 nginx:alpine 自带的 wget（不是 curl），避免依赖问题
echo "[entrypoint] waiting for UnblockNeteaseMusic to be ready..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if wget -q -O /dev/null http://127.0.0.1:80/ 2>&1; then
    echo "[entrypoint] UnblockNeteaseMusic is ready (after ${i}s)"
    break
  fi
  sleep 2
done

# ============== 启动 nginx ==============
echo "[entrypoint] starting nginx on port 25884..."
nginx

# ============== 启动 NcmAPI（前台，PID 1） ==============
# ncm-api 默认端口 3000（server.js: Number(options.port || process.env.PORT || '3000')）
# 上面已经 export PORT=3000，强制 ncm-api 走 3000
# nginx 反代 /api/netease/* → 127.0.0.1:3000
# 注意：app.js 不解析命令行参数（写死 serveNcmApi({checkVersion: true})），只能通过环境变量控制端口
echo "[entrypoint] === 环境变量诊断 ==="
echo "[entrypoint] PORT=$PORT"
echo "[entrypoint] HOST=$HOST"
echo "[entrypoint] which npx: $(which npx)"
echo "[entrypoint] which node: $(which node)"
echo "[entrypoint] node version: $(node -v)"
echo "[entrypoint] ncm-api 包位置: $(ls /usr/local/lib/node_modules/@neteasecloudmusicapienhanced/api/app.js 2>&1)"
echo "[entrypoint] starting NeteaseCloudMusicApi on port 3000..."
exec npx @neteasecloudmusicapienhanced/api
