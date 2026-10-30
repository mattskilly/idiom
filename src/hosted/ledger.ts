import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { Conflict, type PrivateStore } from "./blob.js";
import { LIMITS } from "./config.js";
import { RUN_RESERVATION, validPrices } from "./cost.js";
import { HostedError } from "./errors.js";
import { canonicalIp } from "./ssrf.js";

const resources = z
  .object({
    imageBytes: z.number().int().nonnegative().max(LIMITS.deliveryImageBytes),
    ledgerBytes: z.number().int().nonnegative().max(LIMITS.deliveryLedgerBytes),
    attempts: z.number().int().nonnegative().max(LIMITS.deliveryAttempts),
  })
  .strict();
const record = z
  .object({
    id: z.string(),
    expires: z.number(),
    deliveries: z.number().int().nonnegative(),
    amount: z.number().int().positive(),
    resources: resources.optional(),
  })
  .strict();
const ledgerSchema = z
  .object({
    version: z.literal(1),
    month: z.string(),
    day: z.string(),
    charged: z.number().int().nonnegative(),
    admissions: z.number().int().nonnegative(),
    ips: z.record(z.string(), z.number().int().nonnegative()),
    runs: z.array(record).max(LIMITS.maxAdmissions * 2),
  })
  .strict();
type Ledger = z.infer<typeof ledgerSchema>;
/** Admission identity only: destination validation always retains the full IP. */
function rateIdentity(ip: string): string {
  const normalized = canonicalIp(ip);
  const address = ipaddr.parse(normalized);
  if (address instanceof ipaddr.IPv4) return normalized;
  const bytes = address.toByteArray();
  bytes.fill(0, 8);
  return `${ipaddr.fromByteArray(bytes).toString()}/64`;
}
type Work = { attempts: number; ledgerBytes: number };
export const LEDGER_PATH = "hosted/private/admission.json";
export class AdmissionLedger {
  constructor(
    readonly store: PrivateStore,
    readonly secret: string,
    readonly now: () => number = Date.now,
  ) {}
  async mutate<T>(
    change: (ledger: Ledger, now: number, work: Work) => T,
  ): Promise<T> {
    const work: Work = { attempts: 0, ledgerBytes: 0 };
    for (let attempt = 0; attempt < LIMITS.casAttempts; attempt++) {
      try {
        const current = await this.store.get(LEDGER_PATH, LIMITS.ledgerBytes);
        work.attempts++;
        work.ledgerBytes += current?.bytes.length ?? 0;
        const now = this.now();
        const date = new Date(now).toISOString();
        const month = date.slice(0, 7);
        const day = date.slice(0, 10);
        const ledger: Ledger = current
          ? ledgerSchema.parse(JSON.parse(current.bytes.toString()))
          : {
              version: 1,
              month,
              day,
              charged: 0,
              admissions: 0,
              ips: {},
              runs: [],
            };
        if (ledger.month !== month) {
          ledger.month = month;
          ledger.charged = 0;
          ledger.admissions = 0;
        }
        if (ledger.day !== day) {
          ledger.day = day;
          ledger.ips = {};
        }
        ledger.runs = ledger.runs.filter((run) => run.expires > now);
        const result = change(ledger, now, work);
        const bytes = Buffer.from(JSON.stringify(ledger));
        if (bytes.length > LIMITS.ledgerBytes)
          throw new HostedError("unavailable");
        await this.store.put(
          LEDGER_PATH,
          bytes,
          current ? { etag: current.etag } : undefined,
        );
        return result;
      } catch (error) {
        if (error instanceof Conflict) continue;
        if (error instanceof HostedError) throw error;
        throw new HostedError("unavailable");
      }
    }
    throw new HostedError("unavailable");
  }
  async admit(ip: string | undefined, id: string, cap: number) {
    if (
      !ip ||
      this.secret.length < 32 ||
      !Number.isSafeInteger(cap) ||
      cap <= 0 ||
      !validPrices()
    )
      throw new HostedError("unavailable");
    let normalized: string;
    try {
      normalized = rateIdentity(ip);
    } catch {
      throw new HostedError("unavailable");
    }
    return this.mutate((ledger, now) => {
      const key = createHmac("sha256", this.secret)
        .update(`${ledger.day}:${normalized}`)
        .digest("hex");
      if ((ledger.ips[key] ?? 0) >= 3) throw new HostedError("rate-limit");
      if (
        ledger.charged + RUN_RESERVATION > cap ||
        ledger.admissions >= LIMITS.maxAdmissions ||
        ledger.runs.length >= LIMITS.maxAdmissions * 2
      )
        throw new HostedError("cap-reached");
      ledger.ips[key] = (ledger.ips[key] ?? 0) + 1;
      ledger.charged += RUN_RESERVATION;
      ledger.admissions++;
      ledger.runs.push({
        id,
        expires: now + LIMITS.retentionMs + LIMITS.runMs,
        deliveries: LIMITS.deliveries,
        amount: RUN_RESERVATION,
        resources: {
          imageBytes: LIMITS.deliveryImageBytes,
          ledgerBytes: LIMITS.deliveryLedgerBytes,
          attempts: LIMITS.deliveryAttempts,
        },
      });
      return { id, admittedAt: now, reserved: RUN_RESERVATION };
    });
  }
  /** Read-only: whether one more run fits under the cap this UTC month. */
  async capacity(cap: number): Promise<boolean> {
    const current = await this.store.get(LEDGER_PATH, LIMITS.ledgerBytes);
    if (!current) return RUN_RESERVATION <= cap;
    const ledger = ledgerSchema.parse(JSON.parse(current.bytes.toString()));
    const charged =
      ledger.month === new Date(this.now()).toISOString().slice(0, 7)
        ? ledger.charged
        : 0;
    return charged + RUN_RESERVATION <= cap;
  }
  async delivery(id: string) {
    await this.claim(id);
  }
  async assetDelivery(id: string, byteLength: number) {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > LIMITS.assetBytes
    )
      throw new HostedError("unavailable");
    await this.claim(id, byteLength);
  }
  private async claim(id: string, imageBytes?: number) {
    await this.mutate((ledger, _now, work) => {
      const run = ledger.runs.find((entry) => entry.id === id);
      if (!run) throw new HostedError("cap-reached");
      // Old file credits are not refunded. Initialize inside the winning CAS only.
      run.resources ??= {
        imageBytes: Math.min(
          LIMITS.deliveryImageBytes,
          run.deliveries * LIMITS.assetBytes,
        ),
        ledgerBytes: Math.min(
          LIMITS.deliveryLedgerBytes,
          run.deliveries * LIMITS.casAttempts * LIMITS.ledgerBytes,
        ),
        attempts: Math.min(
          LIMITS.deliveryAttempts,
          run.deliveries * LIMITS.casAttempts,
        ),
      };
      const remaining = run.resources;
      if (
        (imageBytes === undefined && run.deliveries <= 0) ||
        (imageBytes !== undefined && remaining.imageBytes < imageBytes) ||
        remaining.ledgerBytes < work.ledgerBytes ||
        remaining.attempts < work.attempts
      )
        throw new HostedError("cap-reached");
      if (imageBytes === undefined) run.deliveries--;
      else remaining.imageBytes -= imageBytes;
      remaining.ledgerBytes -= work.ledgerBytes;
      remaining.attempts -= work.attempts;
    });
  }
}
