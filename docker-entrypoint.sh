#!/bin/sh

set -e

# start unblock service in the background
npx unblockneteasemusic -p 80:443 -s -f ${NETEASE_SERVER_IP:-220.197.30.65} -o ${UNBLOCK_SOURCES:-kugou bodian pyncmd} 2>&1 &

# 启动网页端 UnblockAPI 服务（替代桌面端 Fastify 路由）
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

# start the nginx daemon
nginx

# start the main process
exec "$@"
