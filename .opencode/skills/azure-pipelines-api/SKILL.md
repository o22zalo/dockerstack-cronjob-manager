---
name: azure-pipelines-api
description: Use this skill whenever working with Azure Pipelines YAML or the Azure DevOps REST API in this repo (dockerstackcronjob). Triggers include editing `.azure/azure-pipelines.yml`, changing which Azure DevOps org/project/repo a pipeline runs on, tuning Cache@2 / BuildKit local cache behavior, debugging a failed or skipped Azure Pipelines run, or anything involving the "azure-pats" resource type in cronjob-manager (validating an Azure DevOps Personal Access Token, calling dev.azure.com, triggering/listing pipeline runs). Always consult this skill before touching pipeline YAML or writing code that calls the Azure DevOps REST API, even if the user doesn't say "Azure Pipelines" explicitly — phrases like "sửa pipeline azure", "PAT azure không chạy được", "cache buildx bị miss", "condition azure fail" all qualify.
---

# Azure Pipelines & Azure DevOps REST API (dockerstackcronjob)

Azure Pipelines is the **second** deploy-runner backend in this repo (parallel
to GitHub Actions — same goal: keep a self-hosted-style runner alive by
redeploying the stack). Separately, cronjob-manager stores/validates **Azure
DevOps Personal Access Tokens** as a resource type. This skill covers both.

## 1. File map

| File                                                                                    | Role                                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `.azure/azure-pipelines.yml`                                                            | The whole pipeline: `trigger: none`, commented-out `schedules:`, `variables`, `pool`, one `job` with a big `condition:`, then `steps:` |
| `docker-compose/scripts/ci-build.sh`                                                    | Shared with GitHub Actions; called here with `CACHE_TYPE=local`                                                                        |
| `.github/scripts/pull-env.sh`, `detect-os.sh`, `setup-linux.sh`, `collect-artifacts.sh` | Same scripts reused verbatim from Azure steps (bash, OS-agnostic)                                                                      |

## 2. Pipeline trigger & condition structure

```yaml
trigger: none
# schedules:
#   - cron: "*/55 * * * *"
#     always: true
#     branches: { include: ["*"] }
pool:
  vmImage: "ubuntu-latest" # switch here: ubuntu-latest | windows-latest
jobs:
  - job: main
    condition: >-
      or(
        and(
          contains(variables['System.CollectionUri'], 'org-a'),
          eq(variables['System.TeamProject'], 'project-x'),
          eq(variables['Build.Repository.Name'], 'repo-a')
        ),
        and(
          contains(variables['System.CollectionUri'], 'org-b'),
          eq(variables['System.TeamProject'], 'project-y'),
          eq(variables['Build.Repository.Name'], 'repo-b')
        )
      )
```

- `trigger: none` means this pipeline is **never** auto-triggered by a push —
  it only runs via manual run, the (commented) `schedules:` block, or another
  pipeline calling it. Uncomment `schedules:` (and set a real cron) to enable
  autonomous redeploys, mirroring the GitHub Actions schedule behavior.
- The `condition:` uses Azure's `and()`/`or()` expression syntax (**not**
  shell `&&`/`||`, and **not** GitHub's `github.repository` variables) — this
  is the #1 source of copy-paste bugs when porting a rule from
  `.github/workflows/deploy.yml`.
- **To onboard a new Azure DevOps org/project/repo**, add one more `and(...)`
  block inside the top-level `or(...)`, matching on the _combination_ of
  `System.CollectionUri` + `System.TeamProject` + `Build.Repository.Name` (all
  three, not just repo name, since repo names collide across orgs/projects).

## 3. Steps (in order)

1. `checkout: self`
2. `bash .github/scripts/pull-env.sh` (env: `DOTENVRTDB_URL`) — same script as GitHub Actions
3. `dotenvrtdb -e .env -- bash .github/scripts/detect-os.sh`
4. `dotenvrtdb -e .env -- bash .github/scripts/setup-linux.sh`
5. `dotenvrtdb -e .env -- node docker-compose/scripts/validate-env.js`
6. **`Cache@2` — BuildKit layer cache**:
   ```yaml
   key: 'buildx | "$(Agent.OS)" | "$(Build.Repository.Name)" | "$(Build.BuildId)"'
   restoreKeys: |
     buildx | "$(Agent.OS)" | "$(Build.Repository.Name)"
     buildx | "$(Agent.OS)"
   path: "$(Pipeline.Workspace)/.buildx-cache"
   ```
   The `key` always includes `Build.BuildId`, so it **always misses** on save
   (guaranteeing a fresh write every run) while `restoreKeys` (broadest-first
   is wrong — Azure matches **top-down, first prefix match wins**, so keep the
   more specific `restoreKeys` line _above_ the more general one, exactly as
   shown) lets it restore the nearest previous cache.
7. **Weekly public-image cache** — `IMG_WEEK` set via `date -u +%G-%V`, then a
   second `Cache@2` keyed `pubimg | v1 | $(IMG_WEEK)` — same weekly-refresh
   trick as the GitHub Actions side.
8. **Buildx bootstrap**:
   ```bash
   docker buildx create --name ci-builder --driver docker-container --use \
     || docker buildx use ci-builder
   docker buildx inspect --bootstrap
   ```
   The `docker-container` driver is **required** for `type=local` cache
   export — the default docker driver silently ignores `--cache-to`.
9. **Build + deploy**:
   ```bash
   CACHE_TYPE=local \
   LOCAL_CACHE_DIR="$(Pipeline.Workspace)/.buildx-cache" \
   IMAGE_TAR="$(Pipeline.Workspace)/ci-public-images/images.tar" \
   dotenvrtdb -e .env -- bash docker-compose/scripts/ci-build.sh
   ```
10. Cleanup (`docker image prune -f --filter "until=72h"`) + `dotenvrtdb runner keepalive`/`set-stoprunnerid`
11. `collect-artifacts.sh` (`condition: always()`) → `PublishPipelineArtifact@1` (artifact name `docker-runtime`)

## 4. Azure DevOps REST API — the "azure-pats" resource

`services/app/backend` stores Azure DevOps PATs as a masked resource
(`ResourceRepo` over RTDB path `azure-pats`, type `azure_pat`). Same rules as
GitHub tokens: only `getRaw(id)` returns the plaintext secret, and it's
sourced by a handler if you build an integration.

Azure DevOps REST API auth is **Basic auth with an empty username and the PAT
as the password** (not a Bearer token):

```bash
# Encode PAT for Basic auth
AUTH=$(printf ':%s' "$AZURE_PAT" | base64 -w0)

# Validate PAT: list projects in the org
curl -sS -H "Authorization: Basic $AUTH" \
  "https://dev.azure.com/$ORG/_apis/projects?api-version=7.1"

# List pipeline definitions in a project
curl -sS -H "Authorization: Basic $AUTH" \
  "https://dev.azure.com/$ORG/$PROJECT/_apis/pipelines?api-version=7.1"

# Trigger a pipeline run (needs "Build (read & execute)" scope on the PAT)
curl -sS -X POST -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
  "https://dev.azure.com/$ORG/$PROJECT/_apis/pipelines/$PIPELINE_ID/runs?api-version=7.1" \
  -d '{"resources":{"repositories":{"self":{"refName":"refs/heads/main"}}}}'

# Poll a run's status
curl -sS -H "Authorization: Basic $AUTH" \
  "https://dev.azure.com/$ORG/$PROJECT/_apis/pipelines/$PIPELINE_ID/runs/$RUN_ID?api-version=7.1"
```

Notes:

- A 401 with a syntactically valid PAT almost always means either (a) the PAT
  expired, (b) it's missing the required scope for that endpoint, or (c) the
  org name in the URL doesn't match the org the PAT was issued for.
- `api-version` is mandatory on every call; omitting it can silently pick an
  old default and return unexpected shapes.
- Never persist the decoded `Authorization: Basic ...` header value in logs —
  it round-trips back to the raw PAT trivially (it's just base64).

## 5. Wiring a cron-job.org job to create / edit / run Azure Pipelines

Same goal as the GitHub side: a job scheduled through cronjob-manager, pinged
directly by **cron-job.org**, should be able to **create** a pipeline
definition, **run** an existing pipeline, or **edit** the pipeline's YAML.

### 5.1 Important constraint: same Tinyauth wall as GitHub

This app's routes (`/api/*`, `/proxy/*`) are behind Caddy `forward_auth` →
Tinyauth. cron-job.org is external and cannot pass that wall, so it can only
call **third-party hosts directly** (`dev.azure.com`), not back into this
app's own executor — same reasoning as section 5.1 of the GitHub skill.

- ✅ "Chạy" (run a pipeline) and "tạo" (create a pipeline definition) are each
  a **single** REST call → safe to point a cron-job.org job straight at
  `dev.azure.com`.
- ❌ "Chỉnh" (edit an existing pipeline's YAML, stored as a file in an Azure
  Repos Git repo) is a **read-modify-write** (GET item `objectId` → push a
  commit) → needs a backend handler, which cron-job.org cannot reach directly
  unless you carve out an unauthenticated route (same caveat as GitHub 5.3).

### 5.2 Direct mode — cron-job.org calls Azure DevOps directly (run / create)

Extend `CronjobClient`/`JobsService.create` exactly as described in the
GitHub skill (section 5.2) to forward `requestMethod` +
`extendedData.headers`/`extendedData.body` to cron-job.org's job payload.
Azure DevOps auth is **Basic** (empty username, PAT as password, base64), not
Bearer — compute the header value once and paste it into the job:

```bash
printf ':%s' "$AZURE_PAT" | base64 -w0
```

**"Chạy" — queue a run of an existing pipeline on schedule:**

```json
{
  "accountId": "<azure-pat-account-id>",
  "title": "nightly-azure-pipeline-run",
  "url": "https://dev.azure.com/ORG/PROJECT/_apis/pipelines/PIPELINE_ID/runs?api-version=7.1",
  "requestMethod": 1,
  "headers": {
    "Authorization": "Basic <base64(:PAT)>",
    "Content-Type": "application/json"
  },
  "body": "{\"resources\":{\"repositories\":{\"self\":{\"refName\":\"refs/heads/main\"}}}}"
}
```

**"Tạo" — create a new pipeline definition pointing at an existing YAML file:**

```json
{
  "title": "create-pipeline-once",
  "url": "https://dev.azure.com/ORG/PROJECT/_apis/pipelines?api-version=7.1",
  "requestMethod": 1,
  "headers": {
    "Authorization": "Basic <base64(:PAT)>",
    "Content-Type": "application/json"
  },
  "body": "{\"name\":\"cron-created-pipeline\",\"folder\":\"\\\\cron\",\"configuration\":{\"type\":\"yaml\",\"path\":\"/.azure/azure-pipelines.yml\",\"repository\":{\"id\":\"<repo-guid>\",\"name\":\"<repo-name>\",\"type\":\"azureReposGit\"}}}"
}
```

⚠️ Same caveat as GitHub: the PAT lives inside cron-job.org's own storage in
plaintext via `extendedData.headers`. Use a PAT scoped to the minimum needed
(`Build (read & execute)` for run-only jobs; add `Build (read & write)`/
`Code (read & write)` only if a job also needs to create/edit).

### 5.3 Handler mode — for "chỉnh" (edit pipeline YAML)

Editing the pipeline's YAML file (in Azure Repos Git) requires:

1. `GET https://dev.azure.com/ORG/PROJECT/_apis/git/repositories/REPO/items?path=/.azure/azure-pipelines.yml&api-version=7.1` to read current content + `objectId`.
2. `POST .../pushes?api-version=7.1` with the old `objectId` as `oldObjectId` and the new content as an `edit` change, to commit the update.

This is multi-step and needs our backend, which cron-job.org cannot reach
directly (Tinyauth wall — see 5.1). Same guidance as the GitHub skill: prefer
running this from CI or a manual command; if it truly must be
schedule-driven, add a dedicated unauthenticated webhook route (own Caddy
site, no `forward_auth`, guarded by a per-job random token) that then invokes
a handler like:

```js
// services/app/backend/handlers/azure_pipeline_yaml_update.mjs
export default async function azurePipelineYamlUpdate(data, ctx) {
  const { org, project, repoId, path, newContentUtf8, pat, comment = "chore: cron update pipeline yaml" } = data;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  const base = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoId}`;

  // 1) Read current file to get objectId (= current commit/blob ref for optimistic concurrency)
  const itemRes = await fetch(`${base}/items?path=${encodeURIComponent(path)}&api-version=7.1`, { headers: { Authorization: auth } });
  if (!itemRes.ok) throw new Error(`GET item failed: ${itemRes.status}`);
  const { objectId } = await itemRes.json();

  // 2) Push a commit that edits the file
  const pushRes = await fetch(`${base}/pushes?api-version=7.1`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      refUpdates: [{ name: "refs/heads/main", oldObjectId: objectId }],
      commits: [
        {
          comment,
          changes: [{ changeType: "edit", item: { path }, newContent: { content: newContentUtf8, contentType: "rawtext" } }],
        },
      ],
    }),
  });
  if (!pushRes.ok) throw new Error(`push failed: ${pushRes.status} ${await pushRes.text()}`);
  return { ok: true, push: await pushRes.json() };
}
```

Never log `pat`/`newContentUtf8` (`EXEC_LOG_PAYLOAD=false`), and fetch the PAT
via `resourceRepo.getRaw(id)` from the `azure-pats` resource, never the
masked `.get()`/`.list()`.

## 6. Common pitfalls

| Symptom                                                                        | Cause                                                                                                                      | Fix                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| Pipeline never runs even after a push                                          | `trigger: none` by design                                                                                                  | Use manual run / enable `schedules:` / call it from another pipeline                                 |
| Pipeline runs for the wrong repo, or not at all                                | `condition:` used `&&`/`                                                                                                   |                                                                                                      | `instead of`and()`/`or()` | Azure YAML conditions require the function syntax shown in section 2 |
| Buildx cache never hits                                                        | Missing `docker-container` driver bootstrap, or `restoreKeys` ordered broad-to-narrow                                      | Re-check step 8; put the most specific `restoreKeys` line first                                      |
| `ci-build.sh` reports `REBUILT` every time despite Cache@2 restoring something | `LOCAL_CACHE_DIR` path passed to `ci-build.sh` doesn't match the `Cache@2` `path:`                                         | Both must point at the same `$(Pipeline.Workspace)/.buildx-cache`                                    |
| Azure REST call 401 despite "correct" PAT                                      | Used `Authorization: Bearer $PAT` instead of Basic `:$PAT` base64                                                          | Azure DevOps PATs use Basic auth, not Bearer (see section 4)                                         |
| Azure REST call 203/302 redirect loop                                          | Called an org URL the PAT doesn't belong to (cross-tenant)                                                                 | Confirm `$ORG` matches the PAT's issuing organization                                                |
| Weekly public-image cache never refreshes                                      | `IMG_WEEK` step skipped or cache key hard-coded instead of using the variable                                              | Confirm `##vso[task.setvariable variable=IMG_WEEK]` step runs before the `Cache@2` task that uses it |
| cron-job.org job created but Azure never sees the call                         | `requestMethod`/`extendedData.headers`/`extendedData.body` not forwarded by `CronjobClient.createJob`/`JobsService.create` | Extend both per section 5.2 — base app only forwards `title/url/schedule/enabled` today              |
| "Create pipeline" call returns 401/403 even with a valid PAT                   | Used `Authorization: Bearer` instead of Basic `:PAT` base64, or PAT missing `Build (read & write)` scope                   | Recompute the Basic header; check PAT scopes cover the operation                                     |
| Trying to schedule a pipeline YAML _edit_ directly from cron-job.org           | cron-job.org fires one HTTP request per run — cannot GET `objectId` then push a commit in the same job                     | Move the edit into a handler (section 5.3) or run it from a manual/CI step instead                   |
| Handler-based webhook for the edit flow never gets pinged externally           | Route still sits behind Tinyauth `forward_auth` (default for every service in this stack)                                  | Give the webhook its own Caddy site without `forward_auth` labels + its own per-job secret token     |
