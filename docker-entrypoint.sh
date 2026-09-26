#!/bin/sh

set -e

# 启动网页端 UnblockAPI 服务（提供 /unblock/{netease,kuwo,bodian,mediaproxy}）
# ncm-api 直连 music.163.com，不经过 UnblockNeteaseMusic 劫持
# 原因：UnblockNeteaseMusic 劫持 music.163.com 后，xeapi 公钥接口拿不到响应，
#       导致 song/url/v1 返回空 URL，所有歌曲都无法播放
node /app/server/unblock-server.mjs 2>&1 &

# 不劫持 /etc/hosts，让 ncm-api 直连网易云
# VIP 歌曲通过 /api/unblock/{netease,kuwo,bodian} 解锁源获取

# start the nginx daemon
nginx

# start the main process
exec "$@"
