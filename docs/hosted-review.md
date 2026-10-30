# Hosted design review (idiom.build)

Paste a public URL on idiom.build, optionally add a design image or reference site, and get an unlisted design QA report. It uses the same engine as `idiom quick`: measured checks plus the strict read-only probe. There is no model critique.

**Status: shipped disabled.** `IDIOM_HOSTED_REVIEW` is unset in every environment. Default site builds contain no form, no client script, no BotID and no config request. Turning it on is Matt's step (see [Activation checklist](#activation-checklist-matt)).

## How a run works

1. `POST /api/hosted-review`. Before anything else, the Function checks the flag and configuration. Then it checks the origin, BotID and the input envelope (≤ 3 MiB multipart, image ≤ 2 MiB, PNG/JPEG/WebP sniffed, ≤ 16 MP). Next it checks target and reference DNS against the public-unicast table. Last comes **admission**: one compare-and-swap on the private Blob ledger. It checks three runs per HMAC'd IPv4 address or native IPv6 /64 prefix per UTC day and the monthly cap, and consumes both. Requests that are invalid, blocked or rejected by BotID never reach admission.
2. A fresh Sandbox is created from the clean prepared runtime snapshot with `persistent: false`, an empty env, 2 vCPU, a timeout no longer than the remaining run allowance, and a subnet firewall that allows `0.0.0.0/0`/`::/0` and denies every range in `DENIED_RANGES` (`src/hosted/ssrf.ts`).
3. The worker starts a local forward proxy. It dials only the numeric address it just validated, so DNS rebinding cannot reach a private host. It then runs `runQuick` (literal URL, deterministic only, desktop + mobile, strict probe with a 15 s budget). Every browser context gets the hosted guard before a page exists: only GET/HEAD/OPTIONS, a per-request DNS recheck, blocked service workers, WebSockets, downloads and popups, and a three-document page budget. The link checker validates each redirect hop itself.
4. The worker writes a bounded, schema-validated projection: at most five Top issues with crops, filmstrip sheets, design evidence and coverage. The limits are ≤ 24 PNG assets, ≤ 3 MiB each and ≤ 12 MiB total. If the evidence does not fit, the run fails with `report-too-large` instead of silently dropping evidence.
5. The Function stops and deletes the sandbox in `finally`, even after cancellation or late creation. It publishes the report under a random 256-bit id, writing the manifest last, and streams back the read URL and a separate delete token.

Progress events are real milestones: admitted → starting → reviewing → publishing → complete. They carry no percentages.

## Reports, expiry and deletion

- Reports live in **private** Blob objects. No Blob URL ever reaches the browser. `/r/<id>` and `/api/hosted-asset` read through the Function, which checks the manifest, expiry and tombstone **before** and **after** each content read.
- **View accounting:** a report page GET spends one of 128 page credits. Image GETs, including repeated references and direct downloads, spend image bytes and accounting work, never page credits. Slackbot-LinkExpanding, Twitterbot and facebookexternalhit follow the same rule: HEAD + page GET + images spends one page credit. User-agent strings grant no exemptions. Metadata-only report/image HEAD spends zero credits/resources and reads no report JSON, PNG or ledger state.
- Images remain eligible after the last page credit while image/work capacity remains. Every successful content claim precedes the JSON/PNG fetch; failed reads or deletion do not refund it. A quota denial serves no report content.
- Headers: `noindex, nofollow, noarchive` (meta and `X-Robots-Tag`), `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `nosniff`, and a CSP limited to the report's own assets and `/hosted/report.js`. There is no sitemap entry and no social preview.
- **Exact expiry:** access ends at `createdAt + 7 days` on every request, whether or not cleanup has run.
- **Physical deletion:** the cron `/api/hosted-cleanup` runs **daily at 03:00 UTC** (`vercel.json`). It runs once a day because Hobby crons are limited to daily; on Pro, set it hourly (for example `17 * * * *`). Each sweep purges expired prefixes, deleted reports' remaining evidence, and orphaned uploads whose run never published. It also deletes abandoned tagged sandboxes. Expired evidence is therefore gone within about 24 hours of expiry, and access was already closed at the exact expiry. Cleanup keeps running when the flag is off.
- **Delete button:** only the creator gets it. The delete token is returned once, kept in the creator's browser (localStorage and the creator link fragment), and stored server-side only as a SHA-256 hash, compared in constant time. The share link carries no token. Deletion writes a tombstone first, then removes all evidence. Repeating a delete is safe.

## Cost model

All prices are Vercel **Pro list prices for `iad1`**, checked on 2026-10-28 against [Sandbox pricing](https://vercel.com/docs/sandbox/pricing) and [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing). They are encoded in `PRICES` in `src/hosted/cost.ts`.

| Resource | Rate |
| --- | --- |
| Sandbox Active CPU | $0.128 / vCPU-hour |
| Sandbox Provisioned Memory | $0.0212 / GB-hour (2 GB per vCPU, billed in 1-minute increments) |
| Sandbox Creations | $0.60 / 1M |
| Sandbox Data Transfer (outbound) | $0.15 / GB (downloads are free) |
| Snapshot Storage | $0.08 / GB-month (one clean runtime snapshot, about 1 GB → ~$0.08/month, amortised into the reservation) |
| Blob Storage | $0.023 / GB-month |
| Blob Simple / Advanced operations | $0.40 / 1M · $5.00 / 1M (deletes are free) |
| Blob Data Transfer | $0.05 / GB |
| Fast Origin Transfer / Fast Data Transfer | $0.06 / GB · ~$0.15 / GB |
| Function Active CPU / memory | $0.128 / vCPU-hour · $0.0106 / GB-hour |

### Measured runs (observations)

`bun run measure:hosted-review` runs the **real worker**: `runQuick`, the strict probe, the hosted proxy and the context guard, against maintained local fixtures (`test/fixtures/hosted/page.html`). A test-only resolver and dialer, injected in code, map `fixture.example.com` to a local server; production cannot select them. Raw rows, machine, source commit and runtime hash are in [`hosted-review-runs.json`](hosted-review-runs.json).

These are **local** timings on an Apple M3 Pro (Node 24.4, Chromium 151). **No paid Sandbox or Blob run took place.** The USD figures apply the rates above to the local elapsed time and bytes.

| Case | Runs | Elapsed | Output (report + PNGs) | Design |
| --- | --- | --- | --- | --- |
| static | 2 | 4.6–4.7 s | 78 KiB | none |
| image-heavy (12 images) | 2 | 4.8–5.0 s | 226 KiB | none |
| interactive | 2 | 6.8–6.9 s | 71 KiB | none |
| uploaded PNG / JPEG / WebP | 3 | 9.3–9.9 s | 314–678 KiB | compared |
| reference site | 1 | 7.2 s | 217 KiB | compared |
| timeout boundary (150 ms signal) | 1 | fails in 0.16 s | — | expected failure |
| large-output boundary (1440×5000 noise canvas) | 1 | fails in 17.5 s with `report-too-large` | — | expected failure |

Over the 10 successful runs:

- Elapsed: mean **6.9 s**, p95/worst **9.9 s**, well inside the 70 s worker allowance.
- Estimated cost: mean **$0.0014**, p95/worst **$0.0018** per run. Sandbox ≈ $0.0007, Blob operations ≈ $0.0003, Function ≈ $0.0003, storage under $0.00001, one view ≈ $0.00006.
- Filmstrips: none in these runs. The engine marks the probe's filmstrip "unavailable" (no compositor coverage) in headless capture of these fixtures. Plain `idiom quick` does the same, so this is not hosted-specific. When this happens, the report says no filmstrip was available.

Assumptions not observed: cloud CPU speed relative to the M3 Pro (assume 2× slower: still ≤ 20 s typical), sandbox boot from snapshot (budgeted inside the 90 s), and the real network egress of arbitrary public sites (bounded at 32 MiB by the proxy).

### Admission reservation (what the cap charges)

Typical cost is not what the cap charges. Each admission reserves **`RUN_RESERVATION` = $0.50**, a bounded worst case with margin:

| Component | Worst-case bound |
| --- | --- |
| Sandbox: 90 s × 2 vCPU fully active, 4 GB × 2 billed minutes, creation, 32 MiB egress cap | ≈ $0.014 |
| Review Function: 120 s max duration, 1 vCPU active, 2 GB | ≈ $0.005 |
| Admission CAS: ≤ 8 attempts × read/write of the actual ≤ 4 MiB ledger | ≈ $0.004 (including origin transfer, rounded up) |
| Publication: ≤ 27 puts, ≤ 12 MiB upload, 7 days of storage | ≈ $0.002 |
| Delivery content/accounting subtotal (derived below) | ≤ $0.373316 |
| Lifecycle (delete/cleanup lists), snapshot amortisation | < $0.001 |
| Delivery Function invocations/compute and CDN request fees | Covered by the remaining reservation margin; verify on cloud smoke-check |
| **Reservation** | **$0.50**; content/accounting leaves about $0.126 for the other components and margin |

Delivery uses independent, finite per-run allowances stored in the existing admission run record:

| Allowance | Initial ceiling | Consumers |
| --- | --- | --- |
| Page credits | 128 | Page GET, including link-preview unfurlers |
| Image bytes | 384 MiB (128 × 3 MiB) | Every image GET, including repeats/direct downloads |
| Ledger bytes read | 1 GiB | Successful page/image mutations, including preceding conflicted reads |
| Ledger mutation attempts | 4,096 | Successful page/image mutations, including preceding conflicted CAS attempts |

The winning ETag mutation debits the cumulative actual ledger bytes and attempts for its invocation against fresh balances. The eight-attempt CAS retry bound is **not another multiplier**. Admission does not spend these delivery resources. No separate per-report quota objects are created. Large images, a large shared ledger, contention or repeated downloads can exhaust resources **before the 128th full view**. Zero image bytes does not itself block a page; zero page credits does not itself block an image.

New manifests record validated uploaded PNG sizes. Each image claim uses that size and bounds the store fetch to it, requiring an exact match. Legacy manifests without sizes conservatively charge 3 MiB per image GET. A present malformed size map fails closed.

Legacy version-1 run records without resources initialize them once, inside their first winning delivery mutation, from remaining old file credits R: image bytes = min(384 MiB, R × 3 MiB), ledger bytes = min(1 GiB, R × 8 × 4 MiB), attempts = min(4096, R × 8). R remains the page-credit balance; old image debits are never refunded. Partial/malformed resources fail closed. Restarts, capacity checks and UTC day/month rotation never replenish resources.

At the rates above, including the $0.06/GB Fast Origin Transfer charge documented by [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing#private-and-public-storage-delivery-costs), the resource-model subtotal is:

| Delivery component | Calculation (decimal GB for prices) | USD bound |
| --- | --- | ---: |
| Ledger reads, including retries | 1 GiB × ($0.05 + $0.06)/GB | 0.118112 |
| PNG store/browser transfer, both origin legs | 384 MiB × ($0.05 + $0.15 + 2 × $0.06)/GB | 0.128849 |
| JSON fetch + rendered HTML response | 128 × (512 KiB × $0.11 + 3 MiB × $0.21)/GB | 0.091940 |
| Manifest reads | 2 × 4096 × 8192 bytes × $0.11/GB | 0.007382 |
| CAS writes, including conflicts | 4096 × $0.000005 | 0.020480 |
| Simple reads | 4 × 4096 × $0.0000004 | 0.006554 |
| **Content/accounting subtotal** | **Unrounded sum $0.37331533824; rounded up** | **0.373316** |

HTML is conservatively bounded at 3 MiB: `escapeHtml` expands text at most fivefold, each report text field is rendered once, and fixed markup plus at most 72 images and 100 coverage entries fits within 64 KiB. `5 × 512 KiB + 64 KiB < 3 MiB`. JSON and rendered HTML are separate transfer legs. These are resource-derived bounds, not new cloud measurements or a reduction of supported report content. Delivery Function invocations/compute and CDN request fees join the other components in the remaining reservation margin; the cap does not promise a universal HTTP billing bound.

Rules (`src/hosted/ledger.ts`):

- The reservation is charged **before** any sandbox is created and is **never refunded**, including for failed, timed-out or crashed runs.
- Admission requires `charged + 0.50 ≤ IDIOM_HOSTED_MONTHLY_CAP_USD`. The comparison uses integer microdollars, so it is exact at the boundary. Concurrent admissions serialise on the ETag, and a lost race retries against fresh state.
- Months are UTC. `charged` resets on the first admission of a new month. Each run's 7-day storage and delivery cost was already reserved when it was admitted, so liabilities that cross the month boundary are already paid for.
- Lowering the cap takes effect on the next admission.
- A missing, invalid or non-positive cap, invalid prices, a store failure or exhausted CAS retries all mean **unavailable**: no paid run starts.
- Rate identity is three/day per canonical IPv4 address (including IPv4-mapped IPv6) or native IPv6 /64. Only the daily HMAC input uses the prefix; destination validation and the SSRF firewall still use full addresses. Raw IPs/prefixes are never stored. Existing native-IPv6 /128 hashes cannot be merged without original IPs, so deployment may restart that day's IPv6 allowance once; IPv4 keys, monthly charges and the secret remain unchanged.
- Each report allows 128 page GETs, subject to the independent image/work safeguards above. Exhaustion returns the existing cap message.
- **Capacity:** `floor(cap / 0.50)` runs per month. For example, $25 allows 50 runs and $100 allows 200. Once measured cloud usage confirms the bound, lowering `RUN_RESERVATION` raises capacity. It must stay a bounded worst case, never the observed mean.

When the cap is reached, `/api/hosted-config` returns `available: false, reason: "cap-reached"`. The form then says so before submission and points to `npm install -g @mattskilly/idiom`. Report reads, deletion and cleanup keep working.

**What the cap does not cover.** The cap limits the workload this feature admits. Some traffic is cheap but still billed outside it: rejected or invalid HTTP requests, BotID checks, config polls, metadata-only HEAD, unsuccessful quota claims (including conflicts preceding a rejection), and static site traffic. Vercel's account-level Spend Management is Matt's billing backstop on top of the cap.

### Cap enforcement test (observed)

`test/hosted-ledger.test.ts`, `test/hosted-reports.test.ts` and `test/hosted-api.test.ts`, run 2026-10-29 (all pass):

- `concurrent last-slot claims never exceed exact microdollar cap`: 8 concurrent admissions from 8 IPs against a cap of exactly one reservation. Exactly **1** is admitted; the next is rejected with `cap-reached`.
- `honest ordered stages, …, daily fourth and monthly cap enforced before sandbox`: with a $1.50 cap, three runs are admitted, the same IP's fourth gets 429, and a new IP gets 503 with the install command. The sandbox runner was called **3** times, never after a failed admission. Config then reports `cap-reached`.
- Sequential/concurrent native IPv6 hosts in one /64 share three admissions; different /64s and IPv4 addresses stay independent. Canonical/mapped spellings and UTC rollover retain the existing cap arithmetic and privacy.
- Real ledger/report/API composition serves 128 page-plus-image sequences for 4- and 7-asset reports, all renderer references including duplicates, seven concurrent images, final-page images and all 24 supported assets. Unfurlers cost once; HEAD reads metadata only.
- Resource tests exercise repeated large PNGs, tiny-image attempt exhaustion, a populated near-4 MiB ledger with conflicts, cumulative actual byte accounting, conservative migration and denial before content reads. The cost calculation and maximal-renderer ceiling are executable assertions.

## Configuration

The hosted SDKs (`@vercel/blob`, `@vercel/functions`, `@vercel/sandbox` and
`botid`) are development dependencies. Vercel's full
`bun install --frozen-lockfile` makes them available to the hosted worker, site
and Function builds. CLI consumers install only runtime dependencies, keeping
these hosted packages out of the global npm install.

| Variable | Where | Purpose |
| --- | --- | --- |
| `IDIOM_HOSTED_REVIEW` | build and runtime | Exactly `on` enables it; anything else is off. The build adds the form only when `on`; at runtime the form stays hidden until `/api/hosted-config` says enabled. Disabling at runtime blocks creation server-side immediately; turning it on needs a redeploy. |
| `IDIOM_HOSTED_MONTHLY_CAP_USD` | Functions | Monthly cap in USD, up to 6 decimals, > 0. Missing or invalid fails closed. |
| `IDIOM_HOSTED_SNAPSHOT_ID` | Functions | Clean runtime snapshot (`snap_…`). |
| `IDIOM_HOSTED_RUNTIME_HASH` | Functions | SHA-256 of `hosted-dist/runner.mjs`. Must equal the deployment's `hosted-dist/identity.json` and the snapshot's worker, otherwise unavailable. |
| `IDIOM_HOSTED_IP_SECRET` | Functions | ≥ 32 chars; HMAC key for daily IP counters. Raw IPs are never stored. |
| `BLOB_READ_WRITE_TOKEN` | Functions | Private Blob store credential. Lives only in Functions, never in the sandbox. |
| `CRON_SECRET` | Functions | Authenticates the cleanup cron (`Authorization: Bearer …`). |

The Sandbox SDK authenticates from the Function's Vercel OIDC token. Nothing is forwarded into the sandbox, whose env is `{}` and which runs `env -i`.

## Activation checklist (Matt)

None of this is done in the build.

1. **Provision** on the existing idiom.build project: Vercel Sandbox, a **private** Blob store (connected to the project so `BLOB_READ_WRITE_TOKEN` is set for Functions only), and BotID.
2. **Prepare the runtime.** `bun install --frozen-lockfile && bun run build:hosted-runner && node scripts/hosted/prepare-runtime.mjs` (with Vercel credentials in your own shell). It installs the pinned Playwright and Chromium into a clean, credential-free sandbox, verifies Chromium launches, sets deny-all, snapshots and prints `IDIOM_HOSTED_SNAPSHOT_ID` and `IDIOM_HOSTED_RUNTIME_HASH`. Set the snapshot's retention so it does not expire after 30 days unused.
3. **Set env** (Functions only): the snapshot id, runtime hash, `IDIOM_HOSTED_IP_SECRET` (`openssl rand -hex 32`) and `CRON_SECRET`.
4. **Choose the cap**: set `IDIOM_HOSTED_MONTHLY_CAP_USD` (capacity = cap ÷ $0.50 runs per month).
5. **Plan and cron**: on Pro, tighten the cleanup cron to hourly. Optionally set account Spend Management as a backstop.
6. **Smoke-check on a preview with the flag on**:
   - a target whose DNS rebinds to `127.0.0.1` / `169.254.169.254` is blocked, and the firewall denies a literal private IP from inside a sandbox;
   - BotID rejects a scripted `curl` POST;
   - a review completes in well under 90 s;
   - `/r/<id>` serves `noindex` and `no-store`;
   - delete works only from the creator's browser;
   - the cron (called with `CRON_SECRET`) purges a report whose expiry was set in the past;
   - no `idiom-hosted-review` sandboxes remain afterwards.
7. **Check costs**: compare the preview's actual Sandbox and Blob usage with the cost model above, and update `PRICES` or `RUN_RESERVATION` if the region or rates differ.
8. Only then set `IDIOM_HOSTED_REVIEW=on` for production and **redeploy**. Update site copy in the same release; while the flag is off, no copy may claim the feature is available.
