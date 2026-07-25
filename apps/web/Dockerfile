# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS toolchain

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:${PATH}

RUN corepack enable \
    && corepack prepare pnpm@10.34.5 --activate \
    && test "$(node --version)" = "v24.18.0" \
    && test "$(pnpm --version)" = "10.34.5"

WORKDIR /workspace

FROM toolchain AS build

ARG NEXT_PUBLIC_REFLO_API_ORIGIN
ARG NEXT_PUBLIC_REFLO_ENV=dev

ENV NEXT_PUBLIC_REFLO_API_ORIGIN=${NEXT_PUBLIC_REFLO_API_ORIGIN} \
    NEXT_PUBLIC_REFLO_ENV=${NEXT_PUBLIC_REFLO_ENV}

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @reflo/web... build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

LABEL org.opencontainers.image.title="Reflo Web" \
      org.opencontainers.image.description="Connected development static web runtime" \
      org.opencontainers.image.source="https://github.com/deepessh/reflo-learning"

ENV NODE_ENV=production \
    REFLO_WEB_HOST=0.0.0.0 \
    REFLO_WEB_PORT=3000

WORKDIR /opt/reflo/web

COPY --from=build --chown=node:node /workspace/apps/web/out ./out
COPY --chown=node:node apps/web/server.mjs ./server.mjs

USER node

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=24 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
