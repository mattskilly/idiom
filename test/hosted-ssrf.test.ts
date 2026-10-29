import { describe, expect, test, vi } from "vitest";
import {
  DENIED_RANGES,
  firewall,
  publicIp,
  publicUrl,
  resolvePublic,
} from "../src/hosted/ssrf.js";

describe("hosted public destination boundary", () => {
  test.each(DENIED_RANGES)("rejects range %s in URL and DNS", async (range) => {
    const address = range.split("/")[0] as string;
    expect(publicIp(address)).toBe(false);
    const host = address.includes(":") ? `[${address}]` : address;
    expect(() => publicUrl(`http://${host}/`)).toThrow();
    await expect(
      resolvePublic("https://example.com/", async () => [
        { address, family: address.includes(":") ? 6 : 4 },
      ]),
    ).rejects.toMatchObject({ code: "blocked-url" });
  });
  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("allows global unicast %s", (address) =>
    expect(publicIp(address)).toBe(true),
  );
  test.each([
    "http://2130706433",
    "http://0x7f000001",
    "http://0177.0.0.1",
    "http://[::ffff:127.0.0.1]",
    "http://[64:ff9b::a00:1]",
    "http://[2002:a00:1::]",
    "http://[fe80::1%25en0]",
    "https://localhost",
    "http://printer",
    "http://metadata.google.internal",
    "http://user:pass@example.com",
    "ftp://example.com",
    "file:///tmp/a",
    "http://example.com:",
    "http://example.com:0",
    "http://example.com:65536",
    "http://example.com\\@8.8.8.8/",
  ])("rejects ambiguous or non-public %s", (url) =>
    expect(() => publicUrl(url)).toThrow(),
  );
  test("validates every DNS answer, including mixed and malformed answers", async () => {
    for (const answers of [
      [],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      [{ address: "::1", family: 6 }],
      [{ address: "bad", family: 4 }],
      [{ address: "8.8.8.8", family: 6 }],
    ])
      await expect(
        resolvePublic("https://example.com", async () => answers),
      ).rejects.toMatchObject({ code: "blocked-url" });
  });
  test("rechecks DNS after admission rather than caching", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await resolvePublic("https://example.com:8443/", resolver);
    await expect(
      resolvePublic("https://example.com:8443/", resolver),
    ).rejects.toThrow();
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  test("DNS timeout fails closed", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const result = resolvePublic(
        "https://example.com",
        () => new Promise(() => {}),
        abort.signal,
      );
      abort.abort();
      await expect(result).rejects.toMatchObject({ code: "blocked-url" });
    } finally {
      vi.useRealTimers();
    }
  });
  test("firewall independently denies the identical IPv4/IPv6 table with explicit allows", () => {
    expect(firewall().subnets).toEqual({
      allow: ["0.0.0.0/0", "::/0"],
      deny: [...DENIED_RANGES],
    });
    expect(publicUrl("http://example.com:8080/path#fragment").href).toBe(
      "http://example.com:8080/path",
    );
  });
});
