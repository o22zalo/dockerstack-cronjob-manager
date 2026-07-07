---
name: cronjob-api
description: cron-job.org REST API reference — create, update, delete, list cron jobs and folders via API. Use when working with cron-job.org integration, API calls, or debugging cron job issues.
---

## Endpoint

```
https://api.cron-job.org/
```

## Auth

Bearer token in `Authorization` header. Get API key from console.cron-job.org → Settings.

```
Authorization: Bearer <API_KEY>
```

IP restriction may apply (403 if not allowlisted).

## Content-Type

`Content-Type: application/json` required for requests with body. Missing header → body silently ignored.

## Rate Limits

- Daily: 100 req/day (default), 5000/day for sustaining members
- Per-method limits noted below

## HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 400 | Bad request / invalid input |
| 401 | Invalid API key |
| 403 | IP restriction |
| 404 | Resource not found |
| 409 | Conflict (e.g. duplicate) |
| 429 | Quota / rate limit exceeded |
| 500 | Internal server error |

---

## Jobs

### List Jobs
`GET /jobs` — 5 req/s
Output: `{ jobs: Job[], someFailed: boolean }`

### Get Job Details
`GET /jobs/<jobId>` — 5 req/s
Output: `{ jobDetails: DetailedJob }`

### Create Job
`PUT /jobs` — 1 req/s AND 5 req/min
Input: `{ job: DetailedJob }` — only `url` mandatory
Output: `{ jobId: int }`

### Update Job
`PATCH /jobs/<jobId>` — 5 req/s
Input: `{ job: DetailedJob }` — delta only
Output: `{}`

### Delete Job
`DELETE /jobs/<jobId>` — 5 req/s
Output: `{}`

### Job History
`GET /jobs/<jobId>/history` — 5 req/s
Output: `{ history: HistoryItem[], predictions: int[] }`

### History Item Details
`GET /jobs/<jobId>/history/<identifier>` — 5 req/s
Output: `{ jobHistoryDetails: HistoryItem }` (with headers/body populated)

---

## Folders

### List Folders
`GET /folders` — 5 req/s
Output: `{ folders: Folder[] }`

### Get Folder Details
`GET /folders/<folderId>` — 5 req/s
Output: `{ folderDetails: Folder }`

### Create Folder
`PUT /folders` — 1 req/s AND 10 req/min
Input: `{ folder: Folder }` — only `title` mandatory
Output: `{ folderId: int }`
Duplicate title → 409

### Update Folder
`PATCH /folders/<folderId>` — 1 req/s
Input: `{ folder: Folder }` delta
Duplicate title → 409

### Delete Folder
`DELETE /folders/<folderId>` — 1 req/s
Jobs move to root folder (folderId: 0), not deleted.

---

## Data Types

### Job

| Key | Type | Default on create |
|---|---|---|
| jobId | int | auto |
| enabled | boolean | false |
| title | string | "" |
| saveResponses | boolean | false |
| url | string | **mandatory** |
| lastStatus | JobStatus | 0 |
| lastDuration | int | - |
| lastExecution | int | - |
| sslCertExpiry | int | - |
| nextExecution | int/null | - |
| type | JobType | 0 |
| requestTimeout | int | -1 (default) |
| redirectSuccess | boolean | false |
| folderId | int | 0 |
| schedule | JobSchedule | {} |
| requestMethod | RequestMethod | 0 (GET) |

### DetailedJob = Job + auth, notification, extendedData

### JobAuth

| Key | Type | Default |
|---|---|---|
| enable | boolean | false |
| user | string | "" |
| password | string | "" |

### JobNotificationSettings

| Key | Type | Default |
|---|---|---|
| onFailure | boolean | false |
| onFailureCount | int | 1 |
| onSuccess | boolean | false |
| onDisable | boolean | false |
| onSslCertExpiry | boolean | false |
| onSslCertExpirySeconds | int | 604800 (7d) |

### JobExtendedData

| Key | Type | Default |
|---|---|---|
| headers | dict | {} |
| body | string | "" |

### Folder

| Key | Type | Default |
|---|---|---|
| folderId | int | auto |
| title | string | **mandatory** (max 128, unique) |

### JobSchedule

**Always populate all 6 sub-fields explicitly** — incomplete schedule is the most common cause of 500.

| Key | Type | Default |
|---|---|---|
| timezone | string | "UTC" |
| expiresAt | int | 0 (never) |
| hours | int[] | [-1] (every hour) |
| mdays | int[] | [-1] (every day) |
| minutes | int[] | [-1] (every minute) |
| months | int[] | [-1] (every month) |
| wdays | int[] | [-1] (every day) |

## Enums

### JobStatus
0=Unknown, 1=OK, 2=DNS error, 3=Connect fail, 4=HTTP error, 5=Timeout, 6=Too much data, 7=Invalid URL, 8=Internal error, 9=Unknown error

### JobType
0=Default, 1=Monitoring

### RequestMethod
0=GET, 1=POST, 2=OPTIONS, 3=HEAD, 4=PUT, 5=DELETE, 6=TRACE, 7=CONNECT, 8=PATCH

### HistoryItem

| Key | Type |
|---|---|
| jobId | int |
| identifier | string |
| date | int (unix ts) |
| datePlanned | int |
| jitter | int (ms) |
| url | string |
| duration | int (ms) |
| status | JobStatus |
| statusText | string |
| httpStatus | int |
| headers | string/null |
| body | string/null |
| stats | HistoryItemStats |
| sslCertExpiry | int |

### HistoryItemStats

| Key | Type |
|---|---|
| nameLookup | int (µs) |
| connect | int (µs) |
| appConnect | int (µs) |
| preTransfer | int (µs) |
| startTransfer | int (µs) |
| total | int (µs) |
