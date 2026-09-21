# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
# `--ignore-scripts` because the `postinstall` hook generates the Prisma
# clients, and no schema is in this build context — the gateway owns no data.
RUN npm ci --ignore-scripts

COPY tsconfig*.json nest-cli.json ./
COPY libs ./libs
COPY apps/api-gateway ./apps/api-gateway

RUN npm run build:api-gateway && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/api-gateway ./dist
COPY --from=build /app/package.json ./

# Never root: this process is the one exposed to the internet.
USER node

EXPOSE 3000
CMD ["node", "dist/apps/api-gateway/src/main"]
