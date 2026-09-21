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
COPY apps/conversion-service ./apps/conversion-service

# Generated twice on purpose: once so `tsc` can see the client's types, and
# again after `npm prune`, which deletes `node_modules/@prisma-clients` along
# with everything else it cannot find in package.json.
RUN npm run prisma:generate:conversion \
    && npm run build:conversion-service \
    && npm prune --omit=dev \
    && npm run prisma:generate:conversion

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
# The schema and its migration history, so `migrate deploy` can run below.
COPY --from=build /app/apps/conversion-service/prisma ./apps/conversion-service/prisma

# Converter binaries parse hostile input — this is where an RCE would land, so
# the process runs unprivileged and writes only to its per-job temp dir.
USER node

EXPOSE 3002

# See the note in identity-service.Dockerfile: fine for the local stack, but
# production should migrate as a deploy step rather than per container.
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/conversion-service/prisma/schema.prisma && node dist/apps/conversion-service/src/main"]
