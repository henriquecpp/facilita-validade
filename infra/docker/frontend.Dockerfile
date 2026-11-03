FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /workspace
RUN npm install --global pnpm@12.6.0
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile

# Desenvolvimento: Vite com HMR; o Compose monta src/ e contracts/.
FROM deps AS dev
COPY --chown=node:node frontend ./frontend
COPY contracts ./contracts
RUN mkdir -p frontend/node_modules/.vite && chown node:node frontend frontend/node_modules/.vite
WORKDIR /workspace/frontend
USER node
EXPOSE 5174
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0"]

FROM deps AS build
COPY frontend ./frontend
COPY contracts ./contracts
RUN pnpm --filter @controle-estoque/frontend build

FROM nginxinc/nginx-unprivileged:1.28.2-alpine AS runtime
COPY --from=build --chown=101:101 /workspace/frontend/dist /usr/share/nginx/html
COPY --chown=101:101 infra/proxy/nginx.conf /etc/nginx/nginx.conf
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
