FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# ffmpeg: thumbnails, replays, clips. Fonts: titles burnt into highlight clips.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
RUN mkdir -p /data/thumbs /data/media && chown -R node:node /data
# Unprivileged. For cloud engines, docker-compose adds the host's docker group (group_add).
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
