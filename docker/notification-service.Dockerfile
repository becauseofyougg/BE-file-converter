# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
# `--ignore-scripts` because the `postinstall` hook generates all three Prisma
# clients, and only this service's schema is in the build context. Generation
# happens explicitly below, once the schema has been copied.
RUN npm ci --ignore-scripts

COPY tsconfig*.json nest-cli.json ./
COPY libs ./libs
COPY apps/notification-service ./apps/notification-service

# Generated twice on purpose: once so `tsc` can see the client's types, and
# again after `npm prune`, which deletes `node_modules/@prisma-clients` along
# with everything else it cannot find in package.json.
RUN npm run prisma:generate:notification \
    && npm run build:notification-service \
    && npm prune --omit=dev \
    && npm run prisma:generate:notification

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/notification-service ./dist
COPY --from=build /app/package.json ./
# The schema and its migration history, so `migrate deploy` can run below.
COPY --from=build /app/apps/notification-service/prisma ./apps/notification-service/prisma

USER node

# HTTP is exposed for /health only; the work arrives over AMQP.
EXPOSE 3003

# See the note in identity-service.Dockerfile: fine for the local stack, but
# production should migrate as a deploy step rather than per container.
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/notification-service/prisma/schema.prisma && node dist/apps/notification-service/src/main"]
