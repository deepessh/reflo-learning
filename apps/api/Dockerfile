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
RUN pnpm --filter @reflo/api... build
RUN pnpm --filter @reflo/api --prod deploy /opt/reflo/api
RUN REFLO_DATEFORMAT_IDE_DATABASE=/opt/reflo/api/node_modules/.pnpm/dateformat@2.2.0/node_modules/dateformat/.vs/slnx.sqlite \
    && test "$(sha256sum "$REFLO_DATEFORMAT_IDE_DATABASE" | cut -d ' ' -f 1)" = "f040b8c3e684e348e5532b413181d4d1fe0226c33fcec341a80cc259b0fbecac" \
    && rm -- "$REFLO_DATEFORMAT_IDE_DATABASE"
RUN test -z "$(find /opt/reflo/api -type f \( -name '.env' -o -name '.env.*' -o -name '*.db' -o -name '*.key' -o -name '*.pem' -o -name '*.sqlite' \) -print -quit)"

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

LABEL org.opencontainers.image.title="Reflo API" \
      org.opencontainers.image.description="Connected development API and session orchestrator" \
      org.opencontainers.image.source="https://github.com/deepessh/reflo-learning"

ENV API_HOST=0.0.0.0 \
    API_PORT=3001 \
    NODE_ENV=production \
    PATH=/opt/reflo/api/node_modules/@reflo/db/node_modules/.bin:${PATH} \
    REFLO_ENV=dev

WORKDIR /opt/reflo/api

COPY --from=build --chown=node:node /opt/reflo/api ./

RUN mkdir -p /var/lib/reflo/artifacts \
    && chown node:node /var/lib/reflo/artifacts

USER node

EXPOSE 3001

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=24 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
