/**
 * Debug script: test cron-job.org API directly to find what causes 422.
 * Usage: CRONJOB_API_KEY=<key> npx tsx services/app/backend/src/cronjob/debug422.ts
 */
import { request } from "undici";

const API_KEY = process.env.CRONJOB_API_KEY;
if (!API_KEY) {
  console.error("Set CRONJOB_API_KEY env var");
  process.exit(1);
}

const BASE = "https://api.cron-job.org";

async function test(label: string, method: string, path: string, body?: unknown) {
  const url = `${BASE}${path}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${url}`);
  if (bodyStr) console.log(`Body: ${bodyStr}`);

  const res = await request(url, {
    method: method as any,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: bodyStr,
  });
  const text = await res.body.text();
  console.log(`Status: ${res.statusCode}`);
  console.log(`Response: ${text.slice(0, 500)}`);
  return { status: res.statusCode, body: text };
}

async function main() {
  // 1. Test auth
  await test("List jobs (auth check)", "GET", "/jobs");

  // 2. Minimal create - URL + schedule only
  const r2 = await test("Minimal create", "PUT", "/jobs", {
    job: {
      url: "https://example.com",
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        wdays: [-1],
      },
    },
  });

  // 3. With title
  const r3 = await test("With title", "PUT", "/jobs", {
    job: {
      title: "test-debug",
      url: "https://example.com",
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        wdays: [-1],
      },
    },
  });

  // 4. With requestMethod=1 (POST)
  const r4 = await test("With requestMethod=1", "PUT", "/jobs", {
    job: {
      title: "test-debug-post",
      url: "https://example.com",
      requestMethod: 1,
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        wdays: [-1],
      },
    },
  });

  // 5. With extendedData
  const r5 = await test("With extendedData", "PUT", "/jobs", {
    job: {
      title: "test-debug-ext",
      url: "https://example.com",
      requestMethod: 1,
      extendedData: {
        headers: { accept: "application/json" },
        body: '{"ref":"main"}',
      },
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        wdays: [-1],
      },
    },
  });

  // 6. GitHub URL (the actual failing case)
  const r6 = await test("GitHub dispatch URL", "PUT", "/jobs", {
    job: {
      title: "[GitHub] test",
      url: "https://api.github.com/repos/octocat/Hello-World/actions/workflows/ci.yml/dispatches",
      requestMethod: 1,
      extendedData: {
        headers: {
          accept: "application/vnd.github.v3+json",
          authorization: "Bearer fake-token",
        },
        body: '{"ref":"main"}',
      },
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [0],
        months: [-1],
        wdays: [-1],
      },
    },
  });

  // Cleanup: delete test jobs
  for (const r of [r2, r3, r4, r5, r6]) {
    try {
      const parsed = JSON.parse(r.body);
      if (parsed.jobId) {
        await test(`Cleanup job ${parsed.jobId}`, "DELETE", `/jobs/${parsed.jobId}`);
      }
    } catch {}
  }
}

main().catch(console.error);
