# One image per process: the API never gets FFmpeg, and the worker never gets the web app.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:26-slim AS api
ENV NODE_ENV=production WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 4000
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]

FROM node:26-slim AS worker
# Debian's FFmpeg includes libass, which burning in captions needs.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WORK_DIR=/work
WORKDIR /app
COPY --from=build /app ./
RUN mkdir /work && chown node:node /work
USER node
VOLUME /work
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
