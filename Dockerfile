# syntax=docker/dockerfile:1.7
#
# Headless deemix: backend + web UI in plain Node, no Electron.
# See docs/HEADLESS.md. Build: docker build -t deemix-headless .

# ---- build: renderer (dist/) + headless bundle (dist-headless/) ----
FROM oven/bun:1 AS build
WORKDIR /app
# electron is a devDependency used only by the desktop build: skip its binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:headless

# ---- production dependencies only (for anything loaded at runtime) ----
FROM oven/bun:1 AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---- runtime ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    DEEMIX_DATA_DIR=/data \
    DEEMIX_MUSIC_DIR=/music \
    DEEMIX_HOST=0.0.0.0 \
    DEEMIX_PORT=6595
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-headless ./dist-headless
COPY package.json ./
RUN mkdir -p /data /music && chown node:node /data /music
USER node
VOLUME ["/data", "/music"]
EXPOSE 6595
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEEMIX_PORT||6595)+'/headless/session').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist-headless/server.js"]
