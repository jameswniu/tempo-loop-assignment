# The frontend is built first and copied into the runtime image, so the API
# serves it from its own origin and the reviewer needs one port and one command.
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# Production dependencies only. better-sqlite3 ships prebuilt binaries for
# linux/amd64 and linux/arm64, so no compiler is needed in the final image.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=api /build/dist ./dist
COPY --from=frontend /build/dist ./public

# The cache lives on a volume so it survives a container restart.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_ROOT=/app/public \
    CACHE_PATH=/app/data/cache.db

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
