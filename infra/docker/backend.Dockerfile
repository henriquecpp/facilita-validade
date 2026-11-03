FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /workspace
RUN npm install --global pnpm@12.6.0
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile

# Desenvolvimento: o Compose monta src/ e migrations/; tsc --watch recompila e o node reinicia.
FROM deps AS dev
ENV NODE_ENV=development PORT=3000
COPY scripts/dev-server.mjs ./scripts/dev-server.mjs
COPY --chown=node:node backend ./backend
RUN mkdir -p backend/dist && chown node:node backend backend/dist
WORKDIR /workspace/backend
USER node
EXPOSE 3000
CMD ["node", "../scripts/dev-server.mjs", "api"]

FROM deps AS build
COPY backend ./backend
RUN pnpm --filter @controle-estoque/backend build \
    && pnpm --filter @controle-estoque/backend deploy --legacy --prod /opt/backend

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /opt/backend/package.json ./package.json
COPY --from=build --chown=node:node /opt/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/backend/dist ./dist
COPY --from=build --chown=node:node /workspace/backend/migrations ./migrations
COPY --chown=node:node infra/docker/entrypoint.mjs infra/docker/bootstrap-roles.mjs ./
USER node
EXPOSE 3000
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
CMD ["dist/bootstrap/main-api.js"]
