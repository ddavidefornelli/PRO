# syntax=docker/dockerfile:1.7

# Keep Node aligned with Docker CI. No desktop or server credentials are build args.
FROM node:24.22.0-bookworm-slim AS dependencies
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci

# Browser-only development; native Tauri runs on the host.
FROM dependencies AS development
COPY --chown=node:node index.html tsconfig.json vite.config.ts ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node shared/ ./shared/
EXPOSE 1420
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1420').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM development AS build
RUN npm run build

FROM rust:1.99.1-slim-bookworm AS rust-toolchain
RUN rustup component add rustfmt clippy

# This image tag MUST match @playwright/test in package-lock.json.
# Both Chromium and WebKit, and both amd64 and arm64, are supported.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS tests
USER root
COPY --from=dependencies /usr/local/ /usr/local/
COPY --from=rust-toolchain /usr/local/cargo/ /usr/local/cargo/
COPY --from=rust-toolchain /usr/local/rustup/ /usr/local/rustup/
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/home/pwuser/.cargo \
    CARGO_TARGET_DIR=/home/pwuser/target \
    PATH="/usr/local/cargo/bin:${PATH}" \
    CI=true
# Build-only distro packages intentionally receive the distribution's security updates.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=development --chown=pwuser:pwuser /app/ /app/
COPY --chown=pwuser:pwuser tsconfig.backend.json playwright.config.ts Dockerfile ./
COPY --chown=pwuser:pwuser scripts/ ./scripts/
COPY --chown=pwuser:pwuser tests/ ./tests/
COPY --chown=pwuser:pwuser src-tauri/ ./src-tauri/
COPY --chown=pwuser:pwuser supabase/ ./supabase/
RUN mkdir -p /home/pwuser/.cargo /home/pwuser/target /app/test-results /app/playwright-report \
    && chown -R pwuser:pwuser /home/pwuser /app
USER pwuser
# Download and compile native dependencies at build time, not during an offline test run.
RUN cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features --no-run
CMD ["npm", "run", "test:container"]

# Default image: a static BROWSER PREVIEW, not a replacement for the desktop app.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24 AS preview
LABEL org.opencontainers.image.title="prune browser preview" \
      org.opencontainers.image.description="Static frontend only; authentication and native IPC require the Tauri desktop app."
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"]
# Bypass image entrypoint scripts: the configuration is immutable and needs no envsubst.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
