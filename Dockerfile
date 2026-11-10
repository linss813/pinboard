FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=18016 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server-dist ./server-dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 18016
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18016/healthz >/dev/null || exit 1
CMD ["node", "server-dist/index.cjs"]
