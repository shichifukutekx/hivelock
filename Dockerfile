# Builds the web app, then a small image with production packages only.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY web ./web
COPY src ./src
RUN npx vite build web

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p data/workspaces && chown -R node:node data
USER node
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4320/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/platform/server.ts"]
