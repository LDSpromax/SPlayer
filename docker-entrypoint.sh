#!/bin/sh

set -e

# start unblock service in the background
npx unblockneteasemusic -p 80:443 -s -f ${NETEASE_SERVER_IP:-220.197.30.65} -o ${UNBLOCK_SOURCES:-kugou bodian pyncmd} 2>&1 &

# 启动网页端 UnblockAPI 服务（替代桌面端 Fastify 路由，提供 /unblock/{netease,kuwo,bodian,mediaproxy}）
node /app/server/unblock-server.mjs 2>&1 &

# point the neteasemusic address to the unblock service
if ! grep -q "music.163.com" /etc/hosts; then
    echo "127.0.0.1 music.163.com" >> /etc/hosts
fi
if ! grep -q "interface.music.163.com" /etc/hosts; then
    echo "127.0.0.1 interface.music.163.com" >> /etc/hosts
fi
if ! grep -q "interface3.music.163.com" /etc/hosts; then
    echo "127.0.0.1 interface3.music.163.com" >> /etc/hosts
fi
if ! grep -q "interface.music.163.com.163jiasu.com" /etc/hosts; then
    echo "127.0.0.1 interface.music.163.com.163jiasu.com" >> /etc/hosts
fi
if ! grep -q "interface3.music.163.com.163jiasu.com" /etc/hosts; then
    echo "127.0.0.1 interface3.music.163.com.163jiasu.com" >> /etc/hosts
fi

# 注意：不动 nginx.conf 的 25884 监听端口
# Railway service domain targetPort=25884，nginx 必须监听 25884 才能接到外部请求
# Railway 注入的 PORT 环境变量只影响 ncm-api（CMD 里已用 PORT=3000 覆盖）

# start the nginx daemon
nginx

# start the main process
exec "$@"
