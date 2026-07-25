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

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @reflo/jobs... build
RUN pnpm --filter @reflo/jobs --prod deploy /opt/reflo/jobs

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

LABEL org.opencontainers.image.title="Reflo Jobs" \
      org.opencontainers.image.description="Connected development jobs readiness runtime" \
      org.opencontainers.image.source="https://github.com/deepessh/reflo-learning"

ENV JOBS_HOST=0.0.0.0 \
    JOBS_PORT=3002 \
    NODE_ENV=production \
    REFLO_ENV=dev

WORKDIR /opt/reflo/jobs

COPY --from=build --chown=node:node /opt/reflo/jobs ./

USER node

EXPOSE 3002

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=24 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "dist/container.js"]
