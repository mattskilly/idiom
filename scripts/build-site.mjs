import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { buildDocs } from "./site-docs.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDirectory = join(repositoryRoot, "site");
const sourcePath = join(siteDirectory, "index.html");
const imagePath = join(siteDirectory, "social-preview.png");
const outputDirectory =
  process.env.IDIOM_SITE_OUTPUT ?? join(siteDirectory, "dist");
const outputPath = join(outputDirectory, "index.html");
const outputImagePath = join(outputDirectory, "social-preview.png");

const canonicalUrl = "https://idiom.build/";
const imageUrl = "https://idiom.build/social-preview.png";

function fail(message) {
  throw new Error(`Cannot build standalone site: ${message}`);
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function elementWithClass(value, className, label) {
  const elements = [];
  const pattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;

  for (const match of value.matchAll(pattern)) {
    const classAttribute = match[2].match(
      /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
    );
    const classes = (classAttribute?.[1] ?? classAttribute?.[2] ?? "")
      .trim()
      .split(/\s+/);
    if (!classes.includes(className)) continue;

    const contentStart = (match.index ?? 0) + match[0].length;
    const closingTag = new RegExp(`<\\/${match[1]}\\s*>`, "i").exec(
      value.slice(contentStart),
    );
    if (closingTag === null) fail(`${label} has no closing tag`);
    elements.push(value.slice(contentStart, contentStart + closingTag.index));
  }

  if (elements.length !== 1) {
    fail(`expected exactly one ${label}; found ${elements.length}`);
  }
  return elements[0];
}

function decodeEntities(value, label) {
  const namedEntities = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["nbsp", "\u00a0"],
    ["quot", '"'],
  ]);

  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi,
    (_, entity) => {
      if (entity.startsWith("#")) {
        const hexadecimal = entity[1]?.toLowerCase() === "x";
        const digits = entity.slice(hexadecimal ? 2 : 1);
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
        if (
          !Number.isInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          fail(`invalid character reference in ${label}`);
        }
        return String.fromCodePoint(codePoint);
      }

      const decoded = namedEntities.get(entity.toLowerCase());
      if (decoded === undefined) {
        fail(`unsupported named entity &${entity}; in ${label}`);
      }
      return decoded;
    },
  );
}

function normalizedText(markup, label) {
  return decodeEntities(markup.replace(/<[^>]*>/g, " "), label)
    .replace(/\s+/g, " ")
    .trim();
}

function escapeAttribute(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function splitSource(source) {
  if (/<\s*(?:!doctype|html|head|body)\b/i.test(source)) {
    fail("site sources must remain wrapper-free fragments");
  }
  if (countMatches(source, /<title\b/gi) !== 1) {
    fail("expected exactly one title element");
  }
  if (countMatches(source, /<style\b/gi) !== 1) {
    fail("expected exactly one style element");
  }

  const headMatch = source.match(
    /^(<title\b[^>]*>[\s\S]*?<\/title>\s*<style\b[^>]*>[\s\S]*?<\/style>)/i,
  );
  if (headMatch === null) {
    fail(
      "expected the fragment to begin with one title followed by one style block",
    );
  }

  return {
    head: headMatch[1],
    body: source.slice(headMatch[1].length),
  };
}

function assertSocialImage(image) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.length < 24 || !image.subarray(0, 8).equals(signature)) {
    fail("site/social-preview.png is not a PNG image");
  }
  if (image.readUInt32BE(16) !== 1200 || image.readUInt32BE(20) !== 630) {
    fail("site/social-preview.png must be exactly 1200x630 pixels");
  }
}

function metadataMarkup({ title, description, canonical = canonicalUrl }) {
  const escapedTitle = escapeAttribute(title);
  const escapedDescription = escapeAttribute(description);
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="description" content="${escapedDescription}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:title" content="${escapedTitle}">`,
    `<meta property="og:description" content="${escapedDescription}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${escapedTitle}">`,
    '<meta property="og:type" content="website">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapedTitle}">`,
    `<meta name="twitter:description" content="${escapedDescription}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<meta name="twitter:image:alt" content="${escapedTitle}">`,
  ].join("\n");
}

// What the page says, restated for search and answer engines: the product and
// its FAQ, read from the visible copy so the two can never disagree.
function structuredData(source, description) {
  const faq = [
    ...source.matchAll(
      /<div class="qa"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div>/g,
    ),
  ].map(([, question, answer]) => ({
    "@type": "Question",
    name: normalizedText(question.replace(/<\/?code>/g, ""), "FAQ question"),
    acceptedAnswer: {
      "@type": "Answer",
      text: normalizedText(answer.replace(/<\/?code>/g, ""), "FAQ answer"),
    },
  }));
  if (faq.length === 0) fail("expected FAQ entries in .qa blocks");
  const graph = [
    {
      "@type": "SoftwareApplication",
      name: "Idiom",
      url: canonicalUrl,
      description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      sameAs: ["https://github.com/mattskilly/idiom"],
    },
    { "@type": "FAQPage", mainEntity: faq },
  ];
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": graph,
  });
  return `<script type="application/ld+json">${json.replace(/</g, "\\u003c")}</script>`;
}

async function build() {
  const [source, image] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(imagePath),
  ]);
  assertSocialImage(image);

  let { head, body } = splitSource(source);
  if (process.env.IDIOM_HOSTED_REVIEW === "on") {
    const form = await readFile(
      join(siteDirectory, "hosted-form.html"),
      "utf8",
    );
    body = body.replace('<section id="how">', `${form}\n<section id="how">`);
    head +=
      '\n<link rel="stylesheet" href="/hosted/form.css">\n<script src="/hosted/client.js" defer></script>';
    await mkdir(join(outputDirectory, "hosted"), { recursive: true });
    await writeFile(
      join(outputDirectory, "hosted/form.css"),
      await readFile(join(siteDirectory, "hosted.css")),
    );
    await bundle({
      entryPoints: [join(siteDirectory, "hosted-client.ts")],
      outfile: join(outputDirectory, "hosted/client.js"),
      bundle: true,
      platform: "browser",
      target: "es2022",
    });
  } else {
    await rm(join(outputDirectory, "hosted/client.js"), { force: true });
    await rm(join(outputDirectory, "hosted/form.css"), { force: true });
  }
  // Retained report creator controls still work after admissions are disabled.
  await bundle({
    entryPoints: [join(siteDirectory, "hosted-report.ts")],
    outfile: join(outputDirectory, "hosted/report.js"),
    bundle: true,
    platform: "browser",
    target: "es2022",
  });
  const masthead = elementWithClass(source, "masthead", ".masthead element");
  const wordmark = normalizedText(
    elementWithClass(source, "wordmark", ".wordmark copy hook"),
    ".wordmark",
  );
  const mastheadMeta = normalizedText(
    elementWithClass(masthead, "meta", ".masthead .meta copy hook"),
    ".masthead .meta",
  );
  const description = normalizedText(
    elementWithClass(source, "standfirst", ".standfirst copy hook"),
    ".standfirst",
  );
  if (wordmark === "" || mastheadMeta === "" || description === "") {
    fail("metadata copy hooks must contain text");
  }

  const title = `${wordmark} · ${mastheadMeta}`;
  const output = `<!doctype html>\n<html lang="en">\n<head>\n${metadataMarkup({ title, description })}\n${structuredData(source, description)}\n${head}\n</head>\n<body>${body}</body>\n</html>\n`;

  await mkdir(outputDirectory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const temporaryOutput = `${outputPath}.${nonce}.tmp`;
  const temporaryImage = `${outputImagePath}.${nonce}.tmp`;
  try {
    await Promise.all([
      writeFile(temporaryOutput, output, "utf8"),
      writeFile(temporaryImage, image),
    ]);
    await rename(temporaryImage, outputImagePath);
    await rename(temporaryOutput, outputPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryOutput, { force: true }),
      rm(temporaryImage, { force: true }),
    ]);
    throw error;
  }
}

await build();
// Pages that moved into /docs; vercel.json redirects their old paths.
for (const moved of [
  "guide.html",
  "design-qa-for-claude-code.html",
  "testing-loading-empty-error-states.html",
])
  await rm(join(outputDirectory, moved), { force: true });
await buildDocs({
  root: repositoryRoot,
  outputDirectory,
  siteCss: /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(
    await readFile(sourcePath, "utf8"),
  )[1],
  meta: metadataMarkup,
});
