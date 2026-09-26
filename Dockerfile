# build
FROM node:22-alpine AS builder

# 安装 pnpm：用 corepack（musl 兼容，避免 @pnpm/exe 原生二进制缺失）
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# skip postinstall
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# add .env.example to .env
RUN [ ! -e ".env" ] && cp .env.example .env || true

# skip native build for web deployment
ENV SKIP_NATIVE_BUILD=true
RUN npx electron-vite build

# nginx
FROM nginx:1.27-alpine-slim AS app

COPY --from=builder /app/out/renderer /usr/share/nginx/html

COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/docker-entrypoint.sh /docker-entrypoint.sh

# 网页端 UnblockAPI 服务（替代桌面端 Fastify 路由）+ 加密依赖
COPY --from=builder /app/server/unblock-server.mjs /app/server/unblock-server.mjs
COPY --from=builder /app/electron/server/unblock/kwDES.js /app/electron/server/unblock/kwDES.js

RUN apk add --no-cache npm python3 \
    && npm install -g @neteasecloudmusicapienhanced/api \
    && sed -i 's/\r$//' /docker-entrypoint.sh \
    && chmod +x /docker-entrypoint.sh

ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV UNBLOCK_API_PORT=25885
ENV UNBLOCK_API_HOST=127.0.0.1

# Railway / 容器平台识别的对外端口（nginx 监听）
EXPOSE 25884

ENTRYPOINT ["/docker-entrypoint.sh"]

# NcmAPI 钉在内部 3000 端口，避免读取 Railway 注入的 PORT 与 nginx 冲突
CMD ["sh", "-c", "PORT=3000 npx @neteasecloudmusicapienhanced/api"]
