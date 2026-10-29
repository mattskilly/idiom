import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { HostedError } from "./errors.js";

// Conservative public-unicast boundary, IANA special-purpose registries, 2026-10-28.
// The same table supplies the independent Sandbox subnet firewall.
export const DENIED_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/3",
  "4000::/2",
  "8000::/1", // Only IPv6 global unicast 2000::/3 is eligible.
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
] as const;
const denied = DENIED_RANGES.map((range) => ipaddr.parseCIDR(range));
export const firewall = () => ({
  subnets: { allow: ["0.0.0.0/0", "::/0"], deny: [...DENIED_RANGES] },
});
export function canonicalIp(input: string): string {
  if (input.includes("%")) throw new HostedError("blocked-url");
  try {
    return ipaddr.process(input.replace(/^\[|\]$/g, "")).toString();
  } catch {
    throw new HostedError("blocked-url");
  }
}
export function publicIp(input: string): boolean {
  try {
    const address = ipaddr.parse(canonicalIp(input));
    return !denied.some(([network, bits]) => {
      if (address instanceof ipaddr.IPv4 && network instanceof ipaddr.IPv4)
        return address.match(network, bits);
      if (address instanceof ipaddr.IPv6 && network instanceof ipaddr.IPv6)
        return address.match(network, bits);
      return false;
    });
  } catch {
    return false;
  }
}
export function publicUrl(input: string): URL {
  if (
    input.length > 2048 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
    /[\s\\\u0000-\u001f\u007f]/.test(input) ||
    !/^https?:\/\//i.test(input)
  )
    throw new HostedError("blocked-url");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HostedError("blocked-url");
  }
  const authority = input.split("/")[2] ?? "";
  if (
    authority.endsWith(":") ||
    url.username ||
    url.password ||
    authority.includes("@") ||
    url.hostname.includes("%")
  )
    throw new HostedError("blocked-url");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !host ||
    /(^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)
  )
    throw new HostedError("blocked-url");
  if (ipaddr.isValid(host)) {
    if (!publicIp(host)) throw new HostedError("blocked-url");
  } else if (
    !host.includes(".") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)
  )
    throw new HostedError("blocked-url");
  if (
    url.port &&
    (!/^\d+$/.test(url.port) ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535)
  )
    throw new HostedError("blocked-url");
  url.hash = "";
  return url;
}
export type Resolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;
export const systemResolver: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });
export async function resolvePublic(
  input: string,
  resolver: Resolver = systemResolver,
  signal?: AbortSignal,
): Promise<{ url: URL; address: string; family: number }> {
  const url = publicUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const abort = AbortSignal.any([
    AbortSignal.timeout(2000),
    ...(signal ? [signal] : []),
  ]);
  let timer: (() => void) | undefined;
  try {
    const answers = ipaddr.isValid(host)
      ? [
          {
            address: canonicalIp(host),
            family: ipaddr.process(host).kind() === "ipv4" ? 4 : 6,
          },
        ]
      : await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timer = () => reject(new HostedError("blocked-url"));
            abort.addEventListener("abort", timer, { once: true });
            if (abort.aborted) timer();
          }),
        ]);
    if (
      !answers.length ||
      answers.some(
        (a) =>
          !publicIp(a.address) ||
          ![4, 6].includes(a.family) ||
          (ipaddr.parse(canonicalIp(a.address)).kind() === "ipv4" ? 4 : 6) !==
            a.family,
      )
    )
      throw new HostedError("blocked-url");
    const first = answers[0];
    if (!first) throw new HostedError("blocked-url");
    return { url, address: canonicalIp(first.address), family: first.family };
  } catch {
    throw new HostedError("blocked-url");
  } finally {
    if (timer) abort.removeEventListener("abort", timer);
  }
}
