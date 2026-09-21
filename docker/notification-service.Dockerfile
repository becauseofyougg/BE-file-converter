# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY libs ./libs
COPY apps/notification-service ./apps/notification-service

RUN npm run build:notification-service && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/notification-service ./dist
COPY --from=build /app/package.json ./

USER node

# HTTP is exposed for /health only; the work arrives over AMQP.
EXPOSE 3003
CMD ["node", "dist/apps/notification-service/src/main"]
