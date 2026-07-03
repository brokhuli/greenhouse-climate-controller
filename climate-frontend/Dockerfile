# syntax=docker/dockerfile:1
# Two stages: build the SPA to static assets, then serve them with nginx. The same nginx is the
# platform's single entry point — it also reverse-proxies /api (Go API) and /auth (Keycloak); the
# server config is supplied by deploy/proxy/nginx.conf (platform architecture §4). There is no Node
# runtime at request time (frontend architecture §6).
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Vite bakes these at build time. Defaults assume the whole stack is reached at localhost:8080 behind
# the proxy: the API is same-origin (empty base) and Keycloak is served under /auth.
ARG VITE_API_BASE=""
ARG VITE_OIDC_AUTHORITY="http://localhost:8080/auth/realms/greenhouse"
ARG VITE_OIDC_CLIENT_ID="climate-frontend"
ARG VITE_OIDC_REDIRECT_URI="http://localhost:8080/login/callback"
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_OIDC_AUTHORITY=$VITE_OIDC_AUTHORITY \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_OIDC_REDIRECT_URI=$VITE_OIDC_REDIRECT_URI
RUN npm run build

FROM nginx:stable
# Static SPA assets; the server block (SPA fallback + /api + /auth proxy) is mounted by compose at
# /etc/nginx/conf.d/default.conf.
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
