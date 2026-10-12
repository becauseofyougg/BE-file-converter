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

# Where STORAGE_DRIVER=local keeps files. Created here, owned by `node`, so a
# fresh named volume mounted on it starts with that owner — Docker copies the
# image's directory into an empty volume — instead of root's.
RUN mkdir -p /var/lib/file-converter/storage \
    && chown -R node:node /var/lib/file-converter

# Never root: this process is the one exposed to the internet.
USER node

EXPOSE 3000
CMD ["node", "dist/apps/api-gateway/src/main"]
