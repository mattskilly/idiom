import type { ActionTimeline } from "../checks/types.js";

/** Process-only routing keys. Queries and origins never enter artifacts. */
export type ReplayRequest = {
  method: string;
  url: string;
  resourceType: "fetch" | "xhr";
};
const identities = new WeakMap<object, ReplayRequest>();
export function rememberRequest(record: object, identity: ReplayRequest): void {
  identities.set(record, identity);
}
export function requestIdentity(record: object): ReplayRequest | undefined {
  return identities.get(record);
}
export function replayRequests(action: ActionTimeline): ReplayRequest[] {
  return action.requests.flatMap((record) => identities.get(record) ?? []);
}

const responseTimes = new WeakMap<object, number>();
export function rememberResponse(record: object, epoch: number): void {
  if (Number.isFinite(epoch)) responseTimes.set(record, epoch);
}
export function responseAt(
  record: ActionTimeline["requests"][number],
  action: ActionTimeline,
): number | null {
  const epoch = responseTimes.get(record);
  if (epoch !== undefined && action.clockOrigin !== undefined)
    return epoch - action.clockOrigin;
  return record.endTime === null
    ? null
    : record.endTime +
        (action.clockOrigin === undefined
          ? 0
          : action.startedAt - action.clockOrigin);
}
