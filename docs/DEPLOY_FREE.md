# Deploying KaziOS for $0 (production-like testing)

This is the free hosting stack for the whole project. Once it is set up, your loop is:
**edit locally -> `npm run dev` to test -> commit -> push to GitHub -> tests + migrations + deploy happen by themselves.**

## Architecture

| Piece | Service | Cost | Why |
| --- | --- | --- | --- |
| `apps/web` | Cloudflare Pages | Free | Static Vite build on a global CDN, deploys from GitHub |
| `apps/api` | Render (free web service) | Free | Long running Express + Prisma API |
| Database | Neon Postgres | Free | 0.5 GB, auto suspends when idle |
| Sessions/cache | Upstash Redis | Free | 10,000 commands/day, enough for testing |
| `apps/worker` | *Not deployed on the free tier* | - | See [Known limits](#known-limits) |

The web app and the API live on different domains, so the API needs `CORS_ORIGIN` set to the web origin.

---

## 1. Create the database (Neon)

1. Sign up at <https://neon.tech> and create a project named `kazios`.
2. Open **Connection Details** and copy the **direct** connection string (not the pooled one). Prisma gives it to you in a ready made form:

   ```
   postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/kazios?sslmode=require
   ```

Use the direct URL everywhere. The pooled URL will not run migrations.

## 2. Create Redis (Upstash)

1. Sign up at <https://console.upstash.com> and create a database.
2. Copy the **Redis (TLS)** connection string, it looks like:

   ```
   rediss://default:YOUR_PASSWORD@xxx.upstash.io:6379
   ```

Copy the TLS/TCP URL. Do **not** copy the REST URL, `ioredis` and `connect-redis` need a real Redis connection.

## 3. Generate your secrets

Run this twice and keep both outputs somewhere safe (a password manager):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

One becomes `SESSION_SECRET`, the other `JWT_SECRET`. The API refuses to start in production without them.

## 4. Deploy the API (Render)

1. Render dashboard -> **New** -> **Web Service** -> connect `MathewTech254/KaziOs` -> branch `master`.
2. Fill in the build settings (repo root, no subdirectory):

   | Setting | Value |
   | --- | --- |
   | Runtime | Node |
   | Build command | `npm ci && npm run build:packages && npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build --workspace=@kazios/api` |
   | Start command | `npm run start --workspace=@kazios/api` |
   | Plan | Free |
   | Health check path | `/health` |
   | Auto deploy | Yes |

3. Add the environment variables:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `20` (pins the runtime so a platform default change cannot break the build) |
   | `DATABASE_URL` | Neon direct URL from step 1 |
   | `REDIS_URL` | Upstash TLS URL from step 2 |
   | `SESSION_SECRET` | generated in step 3 |
   | `JWT_SECRET` | generated in step 3 |
   | `CORS_ORIGIN` | add this in step 6, once you have the web URL |
   | `BCRYPT_ROUNDS` | `10` (lower than the dev default, friendlier to a small free instance) |

4. Create the service. The first build compiles every workspace and takes several minutes.
5. When it finishes you get a URL like `https://kazios-api.onrender.com`.
   Open `https://kazios-api.onrender.com/health` and expect `{"status":"ok"}`.
   The first request after idle takes 30-50 seconds while the free instance wakes up.

## 5. Apply database migrations

Migrations are applied out of band so the API image stays small. Pick one:

**Option A (recommended, automatic):** in the GitHub repository go to
**Settings -> Secrets and variables -> Actions** and add a secret named
`PRODUCTION_DATABASE_URL` with the Neon direct URL.
The workflow `.github/workflows/migrate-production.yml` then applies pending
migrations on every push to `master`, and you can also run it manually from the
**Actions** tab.

**Option B (from your machine):**

```bash
# Windows PowerShell
$env:DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx.aws.neon.tech/kazios?sslmode=require"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Seed the demo account once (optional, otherwise just register from the sign up page):

```bash
npm run db:seed --workspace=@kazios/api
```

That creates `admin@kazios.dev` / `admin123`. Change the password before sharing the URL with anyone.

## 6. Deploy the web app (Cloudflare Pages)

1. Cloudflare dashboard -> **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git** -> select `MathewTech254/KaziOs` -> production branch `master`.
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | None (the build command is explicit) |
   | Build command | `npm ci && npm run build:packages && npm run build --workspace=@kazios/web` |
   | Build output directory | `apps/web/dist` |
   | Root directory | leave empty (repo root) |

3. Environment variables (both under **Settings -> Environment variables**):

   | Key | Value |
   | --- | --- |
   | `NODE_VERSION` | `20` |
   | `VITE_API_URL` | `https://kazios-api.onrender.com/api/v1` (your API URL + `/api/v1`) |
   | `VITE_API_TIMEOUT_MS` | `90000` (covers a cold start) |

   `VITE_API_URL` is compiled into the JavaScript bundle by Vite, so changing it requires a
   **new build**: after editing it, use **Retry deployment** on the latest deployment.

4. Deploy. You get a URL like `https://kazios.pages.dev`.
5. Go back to Render and set `CORS_ORIGIN` to the exact Pages URL (no trailing slash), then save.
   Render restarts the API when its environment changes.
6. Open the Pages URL, sign in, and check `/inventory`, `/pos` and `/dashboard` work.

`apps/web/public/_redirects` tells Cloudflare Pages to serve `index.html` for unknown paths,
so refreshing on `/inventory` or `/pos` does not 404. If you ever host the web app elsewhere
(Vercel, Netlify, nginx), the same pattern applies: SPA fallback to `index.html`.

## 7. Branch and deploy workflow (keeps hosting boring as you develop)

`master` is the **only deploy branch**. Both Render and Cloudflare Pages must watch `master`, and
nothing else. That is what keeps a half-finished branch from reaching production.

From now on, work like this instead of committing straight to `master`:

```bash
git checkout -b feature/inventory-bulk-upload   # new branch
# ... edit, npm run dev, test ...
git add -A && git commit -m "..." && git push -u origin feature/inventory-bulk-upload
```

Then open a pull request on GitHub. CI runs on the pull request, and only when it is green do you
merge to `master`, which is what triggers the production deploy.

Three settings make this durable, all on GitHub (not in the repo):

1. **Protect `master`**: Settings -> Branches -> Add rule. Require status checks to pass
   (the `CI / lint-and-typecheck` and `CI / build` jobs) and disallow direct pushes.
2. **Keep secrets in the host dashboards only.** Never commit `.env`; it is already gitignored, and
   the deploy templates come from `.env.example`.
3. **Keep both hosts on the same branch.** If Render and Cloudflare ever point at different branches,
   the web app and the API versions drift apart, which is the classic "works on my deploy" bug.

### Writing migrations so deploys never break

Migrations run automatically on every push to `master`, and `prisma migrate deploy` only applies
migrations that are already committed. Two rules keep this safe:

- **Expand, then contract.** Add new columns/tables first and deploy. Only in a *later* release
  remove what the old code no longer uses. Renaming or dropping a column in the same push that stops
  using it breaks the still-running previous version.
- **Never edit a migration that has already been applied.** Add a new one instead. If a migration
  fails, the workflow log shows the error: fix it locally against Neon
  (`DATABASE_URL=<neon direct url> npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`),
  and if the database is already half migrated, reset it with `prisma migrate reset` (development
  databases only).

## 8. Your everyday loop

```bash
# 1. work and test locally (API :4000, web :3000, worker)
npm run dev

# 2. commit and push
git add -A
git commit -m "Inventory: transfer notes"
git push origin master
```

After the push, without you doing anything else:

1. **CI** runs lint, typecheck, tests, full build and Docker build (`.github/workflows/ci.yml`).
2. **Migrations** are applied to Neon (`.github/workflows/migrate-production.yml`).
3. **Render** rebuilds and restarts the API.
4. **Cloudflare Pages** rebuilds and swaps the web bundle.

Allow 3-6 minutes, then test on the Pages URL. If a deploy misbehaves, roll back without
rebuilding: Render -> **Deploys** -> pick an earlier build -> **Rollback**; Cloudflare Pages ->
**Deployments** -> redeploy a previous commit.

## Known limits

- **The API sleeps when idle.** After ~15 minutes with no traffic the free instance shuts
  down and the next visitor waits 30-50 seconds. The web client timeout is set to 90 seconds
  so this shows as a slow page load rather than an error. Only the first request is slow.
- **The worker is not deployed.** BullMQ needs blocking Redis commands (`BRPOPLPUSH`) that
  Upstash's TLS endpoint does not support, so these jobs stay queued and never run:
  notifications, automations, scheduled reports, overdue invoice reminders, stock checks.
  Everything interactive still works (POS, invoices, payments, inventory, transfers).
  To enable them later, point `REDIS_URL` at a normal Redis (a $5-12/month VPS running Redis,
  Render's paid Key Value, or Aiven's free tier), then deploy `Dockerfile.worker`.
- **Upstash free tier is 10,000 commands/day.** Fine for testing, not for real users.
- **Neon free tier is 0.5 GB** and suspends when idle. Prisma reconnects transparently.
- **No staging environment.** You are testing on production data, so keep testing locally first.
- **Render may ask for a card**, even for the free plan. If it does, Koyeb is a drop-in alternative:
  same repo, same branch, same build/start commands, same `/health` check path, and it serves on an
  injected `PORT` too (the API reads `PORT` first, then `API_PORT`). Cloudflare Pages, Neon and
  Upstash stay exactly as they are.
- **Prisma Studio is not available** on Render free. Use the local Studio against Neon:
  `DATABASE_URL=<neon direct url> npx prisma studio --schema apps/api/prisma/schema.prisma`

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Blank page, 404 on `/inventory` | Build output directory must be `apps/web/dist`, and `apps/web/public/_redirects` must exist. |
| Every API call fails in the browser | `VITE_API_URL` is missing or wrong. It is build time only, so rebuild the web app after changing it. |
| `CORS` error in the console | `CORS_ORIGIN` must exactly equal the web origin, no trailing slash, and must not be `*`. Save it in Render, then retry. |
| API returns 503 or hangs on the first request | The free instance is waking up. Wait 30-50 seconds and retry. |
| `Missing required production environment variables` | `DATABASE_URL`, `SESSION_SECRET`, `JWT_SECRET` or `CORS_ORIGIN` is not set in Render. |
| `JWT_SECRET is not configured` | Same, for `JWT_SECRET`. The API will not boot with the public dev secret. |
| Prisma `P1001` / `Can't reach database` | `DATABASE_URL` is wrong, or Neon suspended the database. Retry, then verify the URL. |
| `P2028` transaction timeout | Neon woke up mid request, or the direct URL is being used behind a pooler. Retry; Neon usually resumes on the first call. |
| Migration workflow fails | Run it locally (option B in step 5) to read the real error, fix, and push again. |

## Moving up later

When real users arrive, the same code runs on a single cheap VPS
(Hetzner CX22 ~EUR 4, DigitalOcean 1 GB $6) using the Dockerfiles in this repo:
`Dockerfile.web` (nginx with SPA fallback and an `/api` proxy), `Dockerfile.api`,
`Dockerfile.worker`, plus Postgres and Redis containers. Or stay on Render and upgrade to a
paid instance for a managed database, Redis and no sleep. No application code changes either way.

