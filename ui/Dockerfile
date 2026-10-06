# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------- builder
FROM node:26-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts=false

COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------- runtime
# nginx-unprivileged listens on 8080 and runs as uid 101 out of the box.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime

# Where nginx should proxy /api/*. docker compose: api:8000, Kubernetes: <release>-api:8000.
ENV API_UPSTREAM=api:8000 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
