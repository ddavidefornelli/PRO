# Docker development, tests and local backend

prune is a **native Tauri desktop app**, not a web app with an HTTP application server. Docker makes its frontend tooling, portable tests and local Supabase backend reproducible. It does **not** provide macOS Keychain, Windows Credential Manager, native file dialogs, a desktop window or signed Mac/Windows installers inside Linux containers. The supported desktop platforms remain macOS and Windows.

## Requirements

- Docker Desktop on macOS/Windows, or Docker Engine on Linux, with the **Compose v2 plugin (2.24+)**. Use Linux containers on Windows, preferably with the repository in the WSL filesystem.
- Both **Linux amd64 and arm64** are supported; no hard-coded platform or emulation is required. Other architectures are not tested.
- Internet for the first image/dependency download. Allow several GB of disk space and about **6 GB RAM** for the browser test image or full Supabase stack. First builds are considerably slower than cached builds.
- **No host Node, Rust, Supabase account or API keys** are needed for the three Compose services.
- Running the *native desktop* or the official local Supabase CLI additionally needs host Node.js/npm (`npm ci`). Native development also needs Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Run all commands from the repository root. Shell commands below also work in PowerShell unless noted. The root `.env.example` contains optional port/polling settings; no `.env` file is required.

## 1. Frontend development with hot reload

```sh
docker compose up --build --wait
```

Open **http://localhost:1420**. `src/`, `shared/` and frontend configuration files are mounted read-only into the container. Editing them on the host triggers Vite reloads. Linux dependencies are installed inside the image with `npm ci`; host `node_modules` is never mounted. After changing `package.json` or `package-lock.json`, rerun the command with `--build`.

This is a **browser preview only**: it intentionally refuses sign-in outside Tauri. It does not bypass native IPC or expose refresh tokens to the browser. Use the browser test suite below to exercise complete workflows with fixture IPC, or run the desktop against local Supabase for real sign-in.

```sh
docker compose logs -f dev
docker compose down
```

If file changes are not detected on Docker Desktop/WSL, copy `.env.example` to `.env` and set `PRO_DEV_POLLING=true`, then recreate the service. Polling uses more CPU. `PRO_DEV_PORT` changes the host port; keep 1420 when using the default Tauri development configuration.

## 2. Immutable static preview

```sh
docker compose --profile preview up --build --wait preview
```

Open **http://localhost:8080**; health endpoint: **http://localhost:8080/healthz**. This serves the production Vite output, not the development server. It is still a browser preview, **not a working hosted edition of prune**.

The multi-stage build keeps Node, npm, Rust, test code and build dependencies out of the final Nginx image. Nginx runs as UID 101 on an unprivileged port, with a read-only root filesystem, writable temporary storage only, dropped capabilities and `no-new-privileges`. It includes security headers, CSP, HTML revalidation, long-lived hashed-asset caching and a health check. Missing assets return 404 instead of HTML.

The image can also run without Compose:

```sh
docker build --target preview -t pro-preview:local .
docker run --rm --init --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 --cap-drop ALL --security-opt no-new-privileges=true -p 127.0.0.1:8080:8080 pro-preview:local
```

Both Compose servers bind to **loopback only**. Publishing the preview beyond the local machine requires an explicit bind-address change and a TLS reverse proxy. That still does not add browser authentication or native features. A public, fully functional web edition would require a separate authentication/storage/file-access design; do not expose the native IPC implementation as an unauthenticated HTTP API.

## 3. Reproducible test suite

```sh
docker compose --profile test run --build --rm tests
```

This builds a separate, non-root Linux runner containing pinned Node and Rust toolchains, the locked npm/Cargo dependencies, and the **exact Playwright version** used by the repository. It runs:

- Frontend/unit tests and actual SQL/Edge integration tests (PGlite).
- Portable Rust tests using injected credentials and local HTTP fixtures.
- All browser workflows in **Chromium and WebKit**, with 1 GiB shared memory.
- Production frontend build, frontend/backend TypeScript checks, rustfmt and portable Clippy with warnings denied.

No real credentials, email, paid AI requests or Docker socket are supplied to this runner. Cargo dependencies are compiled during the image build. Test sources are copied into the image rather than bind-mounted, so test results correspond to the built revision. `CI=true` prevents reusing an unrelated development server. Tests reach their own internal Vite server, even if the `dev` service is already running.

The command is `npm run test:container` inside the image. Unlike native `test:all`, it deliberately disables the Rust `desktop` feature: Linux tests do not validate OS credential integrations, WebView2, real native dialogs, macOS signing or desktop packaging. The existing macOS CI job and manual Mac/Windows release checks remain necessary.

### Keep failure reports

`--rm` removes the test container and its reports. To retain and copy them, use a named container instead:

```sh
docker compose --profile test run --build --name pro-tests tests
# These also work after the test command exits with a failure:
docker cp pro-tests:/app/playwright-report ./playwright-report
docker cp pro-tests:/app/test-results ./test-results
docker rm pro-tests
```

Remove any previous `pro-tests` container before reusing that name. Reports stay in gitignored host folders; no host UID/GID mapping or root-owned bind-mounted output is necessary. If Node is installed locally, view them with `npx playwright show-report`.

## 4. Real local Supabase in Docker

Use the **official, pinned Supabase CLI** installed by `npm ci`, not a second hand-maintained Compose implementation of Auth/PostgREST/Postgres. The CLI manages its own Docker containers, compatible image versions, health checks, database volumes, gateway, Studio, local mail capture and Edge runtime. It reads `supabase/config.toml` and applies every migration in `supabase/migrations/` when creating the local database. No hosted project, `supabase login`, `link`, production credentials or SMTP account is required.

```sh
npm ci
npm run backend:start
npm run desktop:local
```

`desktop:local` reads local CLI status, accepts only an explicit HTTP loopback API origin and a public publishable/anon key, then launches a **debug native desktop build** with those two public values. It does not print keys or forward the status command's privileged key as desktop configuration. It works in Unix shells and PowerShell and overrides any hosted `PRO_SUPABASE_*` variables for that child process only. The root `.env` is not loaded by Rust.

Default local endpoints:

| Service | URL / port |
| --- | --- |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | 127.0.0.1:54322 |
| Studio | http://127.0.0.1:54323 |
| Captured email | http://127.0.0.1:54324 |

Request a sign-in code in the native app, open the local mail viewer and enter the code. Both confirmation and returning-user templates display `{{ .Token }}`. Messages are captured locally, not sent to actual recipients. Native release builds continue to require HTTPS, and local test accounts are separate from hosted accounts.

**The CLI stack is for trusted local development, not public self-hosted production.** Do not expose its ports to untrusted networks; check your Docker/host firewall settings. CLI status/start output can contain local service-role keys and database passwords; do not share that output or put it in public desktop builds.

### Real-stack smoke check

```sh
npm run test:backend:live
```

This opt-in check refuses nonloopback API configuration. It uses the CLI's **local-only** admin key to create two disposable accounts and generate test codes, verifies them through the public email-code endpoint, exercises actual PostgREST planner/queue RPCs and cross-account RLS, then deletes the fixture users and their cascaded planner data. It makes no SMTP/provider calls and does not reset other local users. If interrupted, remove leftover `pro-smoke-…@example.test` users in local Studio. This supplements, not replaces, the PGlite suites and hosted SMTP/manual checks.

### Optional local weekly-review function

Copy `supabase/.env.example` to `supabase/.env.local`. Keep the provider key empty to avoid paid AI calls, then run:

```sh
npm run backend:functions
```

To exercise real AI, put a dedicated development OpenAI key in that **server-only** file and explicitly enable both global AI controls and account consent as described in [the backend guide](../supabase/README.md). Enabling it may incur provider charges. The Supabase runtime supplies its own Supabase credentials. Never put a service-role/OpenAI key in the root `.env`, a `VITE_*` variable, Docker build args or desktop configuration.

### Stop, migrate and reset

```sh
npm run backend:stop
```

Stopping preserves local database state. `docker compose down` manages only the prune frontend/test services; it does **not** stop or remove CLI-managed Supabase containers/volumes.

For new migrations on an existing local database, use `npm exec -- supabase migration up --local`. If you intentionally need a fresh database:

```sh
npm run backend:reset
```

**Destructive to local Supabase data.** The script explicitly passes `--local`; never append `--linked` or a remote `--db-url`. Resetting the server does not erase a desktop outbox; sign out and avoid replaying old pending changes into a reset database. No Docker workflow here deploys or resets a hosted project.

## Security, CI and maintenance

- `.dockerignore` excludes host dependencies, generated binaries, `.git`, local environment files, signing keys/certificates, linked Supabase metadata and databases **before** sending build context. Only credential-free `.env.example` files are allowed. Dockerfiles also copy only the required directories.
- No application secrets are accepted as build arguments or passed through Compose. Do not override this with `COPY . .`, broad repository mounts, `env_file: .env` or a Docker socket mount. Backend CLI operations run on the host; no prune container gets daemon/host control.
- Versioned multi-architecture base images and `npm ci` / Cargo `--locked` constrain dependency drift. Tags are version-pinned, not digest-pinned; rebuild with `docker compose build --pull` for refreshed base layers. Update images deliberately for security fixes.
- When upgrading Playwright, update the Docker image tag to match `package-lock.json`. A unit test enforces this relationship. Keep the Node version in Docker CI aligned with the Dockerfile.
- `.github/workflows/docker.yml` builds and runs the suite on native **amd64 and arm64** Linux runners, smoke-tests dev/static servers and preview filesystem restrictions, and separately starts/tests the real CLI-managed backend. Browser failure reports are uploaded. No images are published and no repository secrets are required. The macOS desktop job is retained.

Useful troubleshooting commands:

```sh
docker version
docker compose version
docker compose --profile preview --profile test config --quiet
docker compose ps -a
docker compose logs dev preview
```

If a host port is busy, stop the conflicting process/container or change the optional frontend port in `.env`. Supabase's ports are configured separately in `supabase/config.toml`. Increase Docker memory/disk limits for browser crashes or failed backend health checks. Keep Docker Desktop running and use the same Docker context for Compose and Supabase. Public release still requires real Mac/Windows sign-in, secure-store, file-access and signing smoke tests.
