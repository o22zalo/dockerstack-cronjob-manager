---
name: github-actions-pipeline
description: Use this skill whenever working with GitHub Actions workflows, composite actions, or the GitHub REST API in this repo (dockerstackcronjob). Triggers include editing `.github/workflows/*.yml`, `.github/runs/action.yml`, any `.github/scripts/*.sh`, adding/removing scheduled cron triggers, changing which repositories/forks a workflow runs on, tuning BuildKit/GHA cache behavior, debugging a failed CI run, or anything involving the "github-tokens" resource type in cronjob-manager (validating a GitHub PAT, calling api.github.com, listing/triggering workflow runs). Always consult this skill before touching workflow YAML or writing code that calls the GitHub REST API, even if the user doesn't say "GitHub Actions" explicitly — phrases like "thêm lịch chạy", "sửa workflow", "token GitHub không hoạt động", "pipeline CI fail" all qualify.
---

# GitHub Actions & GitHub REST API (dockerstackcronjob)

This repo uses GitHub Actions purely as a **self-hosted-style deploy runner** (it
redeploys the Docker stack on a schedule to keep a long-lived runner "alive"),
and separately the app (cronjob-manager) stores/validates **GitHub Personal
Access Tokens** as a resource type. This skill covers both surfaces.

## 1. File map (read these, in this order, before editing)

| File                                   | Role                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy.yml`         | Top-level workflow: triggers (`workflow_dispatch`, `push`, 24× `schedule`), the big `if:` gate, `runs-on`, calls the composite action        |
| `.github/runs/action.yml`              | Composite action = the actual step-by-step pipeline body                                                                                     |
| `.github/scripts/pull-env.sh`          | Installs `dotenvrtdb` CLI, pulls `.env` + cloudflared credentials from Firebase RTDB                                                         |
| `.github/scripts/detect-os.sh`         | Detects real OS via `uname` (not `RUNNER_OS`), appends `CUR_OS`, `DOCKER_SOCK`, `COMPOSE_PROJECT_NAME` etc. to `.env`                        |
| `.github/scripts/setup-linux.sh`       | Generates SSH keypair for WebSSH, restarts `sshd` on the runner                                                                              |
| `.github/scripts/collect-artifacts.sh` | Dumps `compose ps/logs`, `docker inspect/logs` per container into `artifacts/docker-runtime`                                                 |
| `docker-compose/scripts/ci-build.sh`   | Shared by both GitHub Actions and Azure Pipelines: builds each service with BuildKit `--cache-from/--cache-to`, then `compose up --no-build` |

## 2. Workflow trigger structure (`deploy.yml`)

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
  schedule:
    - cron: "3 0 * * *"   # 07:03 ICT
    - cron: "3 1 * * *"   # 08:03 ICT
    ... # 24 entries total, one per hour, offset by :03
```

- The 24 schedules exist to keep **different forks/orgs** deploying at a
  staggered hourly cadence (GitHub free-tier scheduling isn't precise, so each
  entry is claimed by exactly one `github.repository` via the `if:` below).
- **Never remove or renumber existing cron entries** without checking the
  matching `if:` condition — the hour offset (`0`..`23`) is the join key
  between a schedule line and its repository condition.

### The `if:` gate

```yaml
if: >-
  (github.event_name == 'workflow_dispatch')
  ||
  (github.event_name == 'push' && github.repository == 'org/repo-a')
  ||
  (github.event_name == 'schedule' && github.event.schedule == '3 0 * * *' && github.repository == 'org/repo-b')
  ...
```

**To onboard a new fork/clone of this repo to the schedule:**

1. Pick an unused `cron:` line (or add a new one at the next free hour).
2. Add one `or` clause: `(github.event_name == 'schedule' && github.event.schedule == '<the exact cron string>' && github.repository == '<owner>/<repo>')`.
3. Keep the exact cron string identical between the `schedule:` block and the `if:` clause (string match, not semantic match).
4. `workflow_dispatch` and `push` conditions are usually left permissive (any repo) or scoped per-repo the same way — check existing patterns before adding a new repo-specific branch.

## 3. Composite action steps (`.github/runs/action.yml`)

Order matters — each step assumes the previous one succeeded:

1. **Pull `.env` & credentials** — `bash .github/scripts/pull-env.sh` (needs secret `DOTENVRTDB_URL`)
2. **Detect OS** — `dotenvrtdb -e .env -- bash .github/scripts/detect-os.sh`
3. **OS-specific setup** — Linux: `setup-linux.sh` (SSH+sshd for WebSSH) / Windows: `setup-windows.ps1`
4. **Validate env** — `dotenvrtdb -e .env -- node docker-compose/scripts/validate-env.js` (hard-stops the whole job on `.env` errors)
5. **BuildKit GHA cache setup** (Linux only):
   - `crazy-max/ghaction-github-runtime@v3` — exposes `ACTIONS_CACHE_URL`/`ACTIONS_RUNTIME_TOKEN` so `type=gha` cache works
   - `docker/setup-buildx-action@v3`
   - `actions/cache@v4` keyed by **ISO week** (`date -u +%G-%V`) for the public-image tarball — this means public base images auto-refresh weekly instead of caching forever
6. **Build + deploy** — `CACHE_TYPE=gha bash docker-compose/scripts/ci-build.sh` (builds each `compose` service individually with `--cache-from/--cache-to type=gha,scope=<service>`, then `compose up --no-build`)
7. **Windows path**: no cache, just `wsl -d Ubuntu -- bash -c "... dc.sh up -d --build --remove-orphans"`
8. **Cleanup** — `docker image prune -f --filter "until=72h"` (keep recent layers for cache hits, don't let disk fill up)
9. **Keepalive** — `dotenvrtdb runner set-stoprunnerid` + `dotenvrtdb runner keepalive` (lets the remote stop-listener know this runner is alive)
10. **Collect + upload artifacts** — always runs (`if: always()`), uploads `docker-runtime` artifact for 7 days

**Common edits:**

- New env var needed by build → add to `.env.example` first, then `docker-compose/scripts/validate-env.js`, the value flows through automatically via `dotenvrtdb -e .env --`.
- New scheduled maintenance step → add it between step 8 (cleanup) and step 9 (keepalive), keep `if: always()` only on steps that must run even on failure (artifact collection).
- Slow builds → check the BUILD SUMMARY table `ci-build.sh` prints (`CACHED` / `PARTIAL` / `REBUILT` per service + time) before assuming cache is broken.

## 4. GitHub REST API — the "github-tokens" resource

`services/app/backend` stores GitHub PATs as a masked resource
(`ResourceRepo` over RTDB path `github-tokens`, type `github_token`). The app
itself does **not** call the GitHub API on the user's behalf today — tokens
are stored so _the user_ can use them elsewhere — but validating a stored
token, or building an integration against it, always goes through
`https://api.github.com` with `Authorization: Bearer <token>` (or legacy
`token <PAT>`).

Reference calls (curl, for manual validation / for handlers under
`services/app/backend/handlers/`):

```bash
# Confirm token identity + scopes (scopes come back in a response header)
curl -sS -i -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user | grep -i 'x-oauth-scopes\|login'

# Confirm repo access
curl -sS -H "Authorization: Bearer $GH_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO

# List workflow runs (to check CI health programmatically)
curl -sS -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/runs?per_page=5"

# Trigger workflow_dispatch remotely (needs 'workflow' scope on the PAT)
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$OWNER/$REPO/actions/workflows/deploy.yml/dispatches \
  -d '{"ref":"main"}'
```

If adding a real handler (`services/app/backend/handlers/*.mjs`) that calls
GitHub on behalf of a stored token:

- Fetch the raw secret via `resourceRepo.getRaw(id)` (never the masked
  `.get()`/`.list()` variants) — see `services/app/backend/src/lib/resourceRepo.ts`.
- Respect `EXEC_TIMEOUT_MS` — GitHub API calls should fail fast, not hang the
  executor.
- Never log the raw token; `EXEC_LOG_PAYLOAD=false` is the default for a reason.

## 5. Wiring a cron-job.org job to create / edit / run GitHub Actions

The goal: a job scheduled through cronjob-manager (i.e. pinged on schedule by
**cron-job.org itself**, not by our own backend) should be able to hit
`api.github.com` to **create** a workflow run (`repository_dispatch`), **run**
an existing workflow (`workflow_dispatch`), or **edit** a workflow file. These
three verbs need two different integration modes.

### 5.1 Important constraint: the app sits behind Tinyauth

Every route in this stack (`/api/*` via the backend, `/proxy/*` via the
frontend) is protected by Caddy `forward_auth` → Tinyauth (see
`compose.apps.yml` labels). **cron-job.org is an external caller and cannot
pass Tinyauth's login wall.** So:

- ✅ A cron-job.org job **can** call `api.github.com` (or any other external
  host) directly — that's just an HTTP ping to a third party, no auth wall in
  the way.
- ❌ A cron-job.org job **cannot** call back into this app's own
  `/api/exec/...` or `/proxy/...` to run a local handler, unless you add a
  dedicated unauthenticated route (see 5.3).

This means: **"chạy" (run) and simple "tạo" (create) map cleanly to direct
cron-job.org → GitHub calls. "Chỉnh" (edit) of a workflow file is a
read-modify-write (GET current SHA → PUT new content) that cron-job.org
cannot do in one ping — it needs a backend handler.**

### 5.2 Direct mode — cron-job.org calls GitHub directly (run / simple create)

Today `CronjobClient.createJob` (`services/app/backend/src/cronjob/client.ts`)
only forwards `{ title, url, schedule, enabled }` to cron-job.org's `PUT
/jobs`. cron-job.org's own API additionally accepts `requestMethod` and
`extendedData.headers` / `extendedData.body` on the same call — extend the
type and pass-through so a job can carry a `Bearer` header + JSON body:

```ts
// services/app/backend/src/cronjob/client.ts
export interface RawCronJob {
  jobId: number | string;
  title: string;
  url: string;
  enabled: boolean;
  schedule?: unknown;
  nextExecution?: number | null;
  lastStatus?: number;
  requestMethod?: 0 | 1 | 2 | 3; // cron-job.org enum: 0=GET 1=POST 2=OPTIONS 3=HEAD (check current API docs)
  extendedData?: { headers?: Record<string, string>; body?: string };
}

async createJob(job: Partial<RawCronJob> & { url: string; title: string }): Promise<RawCronJob> {
  const res = await this.call<{ jobId: number | string; jobDetails?: RawCronJob }>(
    "PUT",
    "/jobs",
    { job }, // job.requestMethod / job.extendedData now flow straight through
  );
  return res.jobDetails ?? ({ ...job, jobId: res.jobId, enabled: job.enabled ?? true } as RawCronJob);
}
```

```ts
// services/app/backend/src/cronjob/jobsService.ts — extend create() input
async create(input: {
  accountId: string;
  title: string;
  url: string;
  schedule?: unknown;
  enabled?: boolean;
  requestMethod?: number;
  headers?: Record<string, string>;
  body?: string;
  tags?: string[]; project?: string; collection?: string;
}): Promise<CronJobMeta> {
  const client = await this.clientFor(input.accountId);
  const raw = await client.createJob({
    title: input.title,
    url: input.url,
    enabled: input.enabled ?? true,
    schedule: input.schedule,
    requestMethod: input.requestMethod,
    extendedData: { headers: input.headers, body: input.body },
  });
  // ...unchanged mirroring into RTDB
}
```

Then create the job (via `POST /api/jobs`, or the Resources UI) with:

**"Chạy" — trigger `workflow_dispatch` on schedule:**

```json
{
  "accountId": "<cronjob-account-id>",
  "title": "nightly-deploy-workflow-dispatch",
  "url": "https://api.github.com/repos/OWNER/REPO/actions/workflows/deploy.yml/dispatches",
  "requestMethod": 1,
  "headers": {
    "Authorization": "Bearer <GITHUB_PAT_WITH_workflow_SCOPE>",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  },
  "body": "{\"ref\":\"main\"}"
}
```

**"Tạo" — fire a `repository_dispatch` event (lets a workflow's `on:
repository_dispatch` trigger react and, e.g., create a downstream run/PR):**

```json
{
  "title": "nightly-repo-dispatch",
  "url": "https://api.github.com/repos/OWNER/REPO/dispatches",
  "requestMethod": 1,
  "headers": {
    "Authorization": "Bearer <GITHUB_PAT>",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  },
  "body": "{\"event_type\":\"scheduled-build\",\"client_payload\":{\"source\":\"cronjob-manager\"}}"
}
```

⚠️ The PAT and body sit in `extendedData` **in plaintext inside cron-job.org's
own systems**, not just in our RTDB — treat this like any other secret export
and prefer a fine-grained PAT scoped to only `actions:write` on that one repo.

### 5.3 Handler mode — for "chỉnh" (edit) and anything needing a read-then-write

Editing a workflow YAML file means: `GET` the file to obtain its current
`sha`, then `PUT` the new content with that `sha`. This is two calls with
data flowing between them — cron-job.org can't do it, so it must run inside
our own executor. Since cron-job.org can't reach `/api/*` (Tinyauth wall), use
one of:

- **Preferred**: don't have cron-job.org call this at all — run the edit from
  CI (the GitHub Actions workflow itself, or a manual `dockerapp-exec:*`
  command) since it's an infrequent, deliberate change, not a real "cron" need.
- **If it must be schedule-driven**: add a narrow, unauthenticated route
  (e.g. `frontend` `app/webhooks/cron/[token]/route.ts`) that is **excluded**
  from Tinyauth by giving it its own Caddy site block without
  `forward_auth` labels, and instead validates a long random per-job token
  in the URL path before calling `c.queue.enqueue(...)` or a handler directly.
  Never reuse `API_SECRET` for this — it's a different trust boundary.

Example handler once reachable (`services/app/backend/handlers/github_workflow_file_update.mjs`):

```js
export default async function githubWorkflowFileUpdate(data, ctx) {
  const { owner, repo, path, newContentBase64, token, message = "chore: cron update workflow" } = data;
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

  // 1) GET current sha (required by the Contents API for updates)
  const getRes = await fetch(base, { headers });
  if (!getRes.ok) throw new Error(`GET contents failed: ${getRes.status}`);
  const { sha } = await getRes.json();

  // 2) PUT new content with that sha
  const putRes = await fetch(base, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: newContentBase64, sha }),
  });
  if (!putRes.ok) throw new Error(`PUT contents failed: ${putRes.status} ${await putRes.text()}`);
  return { ok: true, commit: (await putRes.json()).commit?.sha };
}
```

Register it via `EXEC_ALLOWED` (or leave `[]` to allow all files in
`EXEC_HANDLERS_DIR`) and never log `token`/`newContentBase64`
(`EXEC_LOG_PAYLOAD=false`).

## 6. Common pitfalls

| Symptom                                                              | Cause                                                                                                                        | Fix                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| New fork never deploys on schedule                                   | `if:` clause missing for that `github.repository`                                                                            | Add the `or` branch (section 2)                                                                        |
| Two forks silently deploy at the same time / one never fires         | Two `if:` branches reused the same cron string                                                                               | Cron string in `if:` must uniquely match one `schedule:` line                                          |
| `ci-build.sh` always shows `REBUILT`, never `CACHED`                 | `ACTIONS_CACHE_URL`/`ACTIONS_RUNTIME_TOKEN` missing → `ghaction-github-runtime` step skipped or removed                      | Keep that step before `docker/setup-buildx-action` on Linux                                            |
| Weekly image cache never refreshes / grows unbounded                 | Cache key not actually keyed by week, or `actions/cache@v4` restore key too broad                                            | Confirm `IMG_WEEK`/`date -u +%G-%V` step still runs before the cache step                              |
| `validate-env.js` fails in CI but passes locally                     | `.env` pulled by `pull-env.sh` differs from local `.env` (RTDB is the source of truth in CI)                                 | Update the RTDB-stored `.env`, not just the local file, then re-run `env-push`                         |
| GitHub API calls return 403 with a valid-looking token               | Fine-grained PAT missing the specific scope (e.g. `workflow`, `repo`)                                                        | Re-check scopes via the `x-oauth-scopes` header trick above                                            |
| Workflow runs on `push` for a repo you didn't expect                 | `push` condition branch is too permissive (no repo check)                                                                    | Scope the `push` `or` clause with `&& github.repository == '...'` like the schedule branches           |
| cron-job.org job created but GitHub never sees the call              | `requestMethod`/`extendedData.headers`/`extendedData.body` not passed through `CronjobClient.createJob`/`JobsService.create` | Extend both per section 5.2 — the base app only forwards `title/url/schedule/enabled` today            |
| Job hits GitHub but gets 404/422 on `workflow_dispatch`              | `ref` missing/wrong, or workflow file doesn't define `workflow_dispatch` as a trigger                                        | Body must include `{"ref":"<branch>"}`; workflow YAML needs `on: workflow_dispatch`                    |
| Trying to schedule a workflow-file _edit_ directly from cron-job.org | cron-job.org fires exactly one HTTP request per run — it cannot GET a sha then PUT with it                                   | Move the edit into a handler (section 5.3) or run it from CI instead of a schedule                     |
| Handler-based webhook never gets pinged externally                   | Route still sits behind Tinyauth `forward_auth` (default for every service in this stack)                                    | Give the webhook route its own Caddy site without `forward_auth` labels + its own per-job secret token |
