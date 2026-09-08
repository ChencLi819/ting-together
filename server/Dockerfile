# 服务端容器镜像（微信云托管 / 任意容器平台通用）
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

# 健康检查：容器平台可直接探测 /healthz
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "src/index.js"]
