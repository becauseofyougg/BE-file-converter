# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY libs ./libs
COPY apps/conversion-service ./apps/conversion-service

RUN npm run build:conversion-service && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The only image that carries converter binaries, and only the ones its family
# needs — an `image` replica must not ship LibreOffice. Set at build time:
#   --build-arg CONVERTER_PACKAGES="ffmpeg"
#   --build-arg CONVERTER_PACKAGES="libreoffice"
ARG CONVERTER_PACKAGES=""
RUN if [ -n "$CONVERTER_PACKAGES" ]; then apk add --no-cache $CONVERTER_PACKAGES; fi

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/conversion-service ./dist
COPY --from=build /app/package.json ./

# Converter binaries parse hostile input — this is where an RCE would land, so
# the process runs unprivileged and writes only to its per-job temp dir.
USER node

EXPOSE 3002
CMD ["node", "dist/apps/conversion-service/src/main"]
