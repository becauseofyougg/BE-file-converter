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
COPY apps/identity-service ./apps/identity-service

# Generated twice on purpose: once so `tsc` can see the client's types, and
# again after `npm prune`, which deletes `node_modules/@prisma-clients` along
# with everything else it cannot find in package.json.
RUN npm run prisma:generate:identity \
    && npm run build:identity-service \
    && npm prune --omit=dev \
    && npm run prisma:generate:identity

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/identity-service ./dist
COPY --from=build /app/package.json ./
# The schema and its migration history, so `migrate deploy` can run below.
COPY --from=build /app/apps/identity-service/prisma ./apps/identity-service/prisma

USER node

# HTTP is exposed for /health only; the work arrives over AMQP.
EXPOSE 3001

# Migrations run at start-up for the local stack, matching how the boilerplate
# behaved. Prisma takes an advisory lock, so several replicas starting at once
# is safe — but in production this belongs in a deploy step that finishes
# before any new container is admitted, not in the container's own CMD.
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/identity-service/prisma/schema.prisma && node dist/apps/identity-service/src/main"]
