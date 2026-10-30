import { expect, test } from "vitest";
import { mergeText, reconstruct, skillIdentity } from "../src/skills/merge.js";
import { skill } from "./skill-support.js";

const resolveLocal = async (
  base: string,
  local: string,
  incoming: string,
  filename = "init.md",
) => {
  const merge = await mergeText(base, local, incoming);
  return reconstruct(
    merge,
    {
      decision: "resolve",
      replacements: merge.conflicts.map((hunk) => ({
        id: hunk.id,
        text: hunk.local,
      })),
      reason: "local",
    },
    filename,
    "idiom",
  );
};
test.each(["\n", "\r\n"])(
  "clean merge preserves %j line endings and independent deletions",
  async (newline) => {
    const base = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join(
      newline,
    );
    const local = base.replace("a", "local");
    const incoming = base.replace(`i${newline}`, "");
    const merged = await mergeText(base, local, incoming);
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.marked).toBe(local.replace(`i${newline}`, ""));
  },
);
test("multiple hunks, repeated clean text, independent upstream deletion and literal markers survive", async () => {
  const base =
    "one\nrepeat\n=======\nrepeat\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nend\n";
  const local = base.replace("one", "mine").replace("end", "mine-end");
  const incoming = base
    .replace("one", "theirs")
    .replace("end", "their-end")
    .replace("g\n", "");
  const merge = await mergeText(base, local, incoming);
  expect(merge.conflicts).toHaveLength(2);
  expect(await resolveLocal(base, local, incoming)).toBe(
    local.replace("g\n", ""),
  );
});
test.each([
  [
    "a\nb\nc\nd\ne\nf\ng",
    "local\na\nb\nc\nd\ne\nf\ng",
    "incoming\na\nb\nc\nd\ne\nf\ng",
  ],
  [
    "a\nb\nc\nd\ne\nf\ng",
    "a\nb\nc\nd\ne\nf\ng\nlocal\n",
    "a\nb\nc\nd\ne\nf\ng\nincoming\n",
  ],
  [
    "a\r\nb\r\nc\r\nd\r\n",
    "local\r\nb\r\nc\r\nd\r\n",
    "upstream\r\nb\r\nc\r\nd\r\n",
  ],
])(
  "boundary and CRLF overlaps reconstruct exact local hunks",
  async (base, local, incoming) => {
    expect(await resolveLocal(base, local, incoming)).toBe(local);
  },
);
test("clean merges preserve missing final newline", async () => {
  const base = "a\nb\nc\nd\ne\nf\ng";
  expect(
    (
      await mergeText(
        base,
        base.replace("a", "local"),
        base.replace("g", "upstream"),
      )
    ).marked,
  ).toBe("local\nb\nc\nd\ne\nf\nupstream");
});
test.each([
  "missing",
  "duplicate",
  "unknown",
  "wrapper",
  "markers",
  "decline",
  "extra",
  "wrong-name",
  "duplicate-name",
  "missing-name",
  "empty-body",
])("rejects %s proposals before any write", async (mode) => {
  const merge = await mergeText(
    skill("base\n"),
    skill("local\n"),
    skill("upstream\n"),
  );
  let text = "local\n";
  const replacements: { id: string; text: string }[] = [
    { id: merge.conflicts[0]?.id as string, text },
  ];
  if (mode === "missing") replacements.splice(0);
  if (mode === "duplicate")
    replacements.push({ ...(replacements[0] as { id: string; text: string }) });
  if (mode === "unknown") replacements[0] = { id: "fake", text };
  if (mode === "wrapper") text = "```markdown\nwrapped\n```";
  if (mode === "markers") text = "<<<<<<< local\n";
  // Put the identity in the actual hunk, then attempt invalid complete files.
  if (
    ["wrong-name", "duplicate-name", "missing-name", "empty-body"].includes(
      mode,
    )
  ) {
    const complete = {
      segments: [{ id: "hunk-1", local: "", base: "", incoming: "" }],
      conflicts: [{ id: "hunk-1", local: "", base: "", incoming: "" }],
      marked: "",
    };
    const invalid =
      mode === "wrong-name"
        ? skill("body", "foreign")
        : mode === "duplicate-name"
          ? skill().replace("name: idiom", "name: idiom\nname: idiom")
          : mode === "missing-name"
            ? skill().replace("name: idiom\n", "")
            : "---\nname: idiom\n---\n";
    expect(() =>
      reconstruct(
        complete,
        {
          decision: "resolve",
          replacements: [{ id: "hunk-1", text: invalid }],
          reason: "",
        },
        "SKILL.md",
        "idiom",
      ),
    ).toThrow();
    return;
  }
  if (replacements[0]) replacements[0].text = text;
  expect(() =>
    reconstruct(
      merge,
      {
        decision: mode === "decline" ? "decline" : "resolve",
        replacements,
        reason: "",
        ...(mode === "extra" ? { surprise: true } : {}),
      },
      "SKILL.md",
      "idiom",
    ),
  ).toThrow();
});
test("foreign literal marker labels cannot spoof this merge's structure", async () => {
  const base =
    "<<<<<<< local\nprose\n||||||| base\n=======\n>>>>>>> incoming\na\nb\nc\nd\ne\nf\ng\n";
  const merge = await mergeText(
    base,
    base.replace("\ng\n", "\nlocal\n"),
    base.replace("\ng\n", "\nupstream\n"),
  );
  expect(merge.conflicts).toHaveLength(1);
  expect(
    await resolveLocal(
      base,
      base.replace("\ng\n", "\nlocal\n"),
      base.replace("\ng\n", "\nupstream\n"),
    ),
  ).toContain("<<<<<<< local\nprose");
});
test("non-conflict Git failures and arbitrary output are not trusted", async () => {
  await expect(
    mergeText("a", "b", "c", async () => ({
      code: 2,
      stdout: "fake",
      stderr: "fatal",
    })),
  ).rejects.toThrow("Git merge failed");
  await expect(
    mergeText("a", "b", "c", async () => ({
      code: 1,
      stdout: "<<<<<<< local\nbad",
      stderr: "",
    })),
  ).rejects.toThrow("invalid conflict");
});
test("frontmatter supports quoted identity but rejects wrappers and duplicates", () => {
  expect(skillIdentity(skill().replace("name: idiom", "name: 'idiom'"))).toBe(
    "idiom",
  );
  expect(skillIdentity(`explanation\n${skill()}`)).toBeUndefined();
});

test("literal separator prose inside a conflict cannot spoof Git's hunk structure", async () => {
  const base = "base\n=======\nbase-end\n";
  const local = "local\nlocal-end\n";
  const incoming = "upstream\n=======\nupstream-end\n";
  const merged = await mergeText(base, local, incoming);
  expect(merged.conflicts).toHaveLength(1);
  expect(merged.conflicts[0]).toMatchObject({ local, base, incoming });
});
test("an accepted EOF overlap can preserve missing final newline", async () => {
  const merged = await mergeText("base", "local", "upstream");
  expect(
    reconstruct(
      merged,
      {
        decision: "resolve",
        replacements: [{ id: "hunk-1", text: "local" }],
        reason: "",
      },
      "init.md",
      "idiom",
    ),
  ).toBe("local");
});
