// The /docs section: hand-written pages in site/docs/ plus the repository's own
// reference docs, rendered into the site's design with a Markdown twin of every
// page, llms.txt, llms-full.txt and a sitemap for agents and answer engines.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Marked } from "marked";

const origin = "https://idiom.build";
const repository = "https://github.com/mattskilly/idiom";

export const docsGroups = [
  {
    label: "Start",
    pages: [
      { slug: "", source: "site/docs/index.md" },
      { slug: "getting-started", source: "site/docs/getting-started.md" },
      {
        slug: "update-and-roll-back",
        source: "site/docs/update-and-roll-back.md",
      },
    ],
  },
  {
    label: "Concepts",
    pages: [
      { slug: "how-it-works", source: "site/docs/how-it-works.md" },
      { slug: "findings", source: "site/docs/findings.md" },
      { slug: "memory", source: "site/docs/memory.md" },
    ],
  },
  {
    label: "Guides",
    pages: [
      {
        slug: "design-qa-for-claude-code",
        source: "site/docs/design-qa-for-claude-code.md",
      },
      {
        slug: "testing-loading-empty-error-states",
        source: "site/docs/testing-loading-empty-error-states.md",
      },
      {
        slug: "design-compare",
        source: "docs/design-compare.md",
        title: "Design comparison",
        description:
          "Compare the build against Figma, Claude Design or HTML, an image or a live site.",
      },
    ],
  },
  {
    label: "Reference",
    pages: [
      {
        slug: "commands",
        source: "docs/commands.md",
        description: "Every Idiom command, its flags and what it prints.",
      },
      {
        slug: "rules",
        source: "docs/rules.md",
        description:
          "Every check Idiom runs: why it matters, its severity and how to configure it.",
      },
      {
        slug: "configuration",
        source: "docs/configuration.md",
        description:
          "The project file, flows and states, checks, baselines, Autobuild and the GitHub Action.",
      },
      {
        slug: "mcp",
        source: "docs/mcp.md",
        title: "MCP",
        description:
          "Connect Idiom's tools to Claude Code, Codex, Cursor or any MCP client.",
      },
    ],
  },
];

const pages = docsGroups.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.label })),
);
const docPages = pages.filter((page) => page.source !== undefined);
const docBySource = new Map(
  docPages.map((page) => [page.source.split("/").pop(), page]),
);

const pagePath = (page) => (page.slug === "" ? "/docs" : `/docs/${page.slug}`);
const markdownPath = (page) => `${pagePath(page)}.md`;

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return { data: {}, body: text };
  const data = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
  return { data, body: text.slice(match[0].length) };
}

// GitHub's heading anchors, so links written for the repository still land.
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

// A relative link from a repository doc becomes a docs page when one exists,
// and the file on GitHub otherwise.
function rewriteHref(href, markdown) {
  if (/^(?:[a-z]+:|#|\/)/i.test(href)) {
    if (markdown && href.startsWith("/docs")) {
      const [path, hash] = href.split("#");
      return `${origin}${path}.md${hash ? `#${hash}` : ""}`;
    }
    if (markdown && href.startsWith("/")) return `${origin}${href}`;
    return href;
  }
  const [file, hash] = href.split("#");
  const name = file.split("/").pop();
  const page = file.startsWith("../") ? undefined : docBySource.get(name);
  const suffix = hash ? `#${hash}` : "";
  if (page !== undefined)
    return markdown
      ? `${origin}${markdownPath(page)}${suffix}`
      : `${pagePath(page)}${suffix}`;
  const path = file.startsWith("../") ? file.slice(3) : `docs/${file}`;
  return `${repository}/blob/main/${path}${suffix}`;
}

async function loadPage(root, page) {
  const { data, body } = frontMatter(
    await readFile(join(root, page.source), "utf8"),
  );
  const heading = /^# (.+)$/m.exec(body)?.[1]?.replace(/`/g, "");
  const title = page.title ?? data.title ?? heading;
  const description = page.description ?? data.description;
  if (!title || !description)
    throw new Error(`docs page ${page.source} needs a title and description`);
  return { ...page, title, description, body };
}

function render(page) {
  const slug = slugger();
  const headings = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === "link") token.href = rewriteHref(token.href, false);
    },
    renderer: {
      // A fence's info string can tag an example (```json example=project) so
      // tests can parse every copyable example against the shipped schemas.
      code({ text, lang }) {
        const [language, ...rest] = (lang ?? "").split(/\s+/);
        const example = rest
          .find((part) => part.startsWith("example="))
          ?.slice("example=".length);
        const attributes = [
          language ? ` class="language-${escapeHtml(language)}"` : "",
          example ? ` data-example="${escapeHtml(example)}"` : "",
        ].join("");
        return `<pre tabindex="0"><code${attributes}>${escapeHtml(text)}</code></pre>\n`;
      },
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        if (depth === 2 || depth === 3) headings.push({ id, html, depth });
        if (depth === 1) return `<h1>${html}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${depth}>\n`;
      },
    },
  });
  const html = marked
    .parse(page.body)
    .replace(/(<\/h1>\s*)<p>/, '$1<p class="lede">')
    .replace(
      /<p><em>(For Idiom v[^<]+)<\/em><\/p>/,
      '<p class="version">$1</p>',
    )
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, "</table></div>");
  return { html, headings };
}

function markdownTwin(page) {
  const body = page.body.replace(
    /\]\(([^)\s]+)\)/g,
    (_, href) => `](${rewriteHref(href, true)})`,
  );
  return `${body.trimEnd()}\n`;
}

const themeScript = `<script>try{var t=localStorage.getItem("idiom-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>`;
const toggle = `<button class="theme-toggle" type="button" aria-label="Switch to dark theme" title="Switch to dark theme"><svg class="moon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
const behaviour = `<script>
(function () {
  var root = document.documentElement, button = document.querySelector(".theme-toggle");
  var system = window.matchMedia("(prefers-color-scheme: dark)");
  function current() { return root.dataset.theme || (system.matches ? "dark" : "light"); }
  function label() {
    var next = current() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", "Switch to " + next + " theme");
    button.title = "Switch to " + next + " theme";
  }
  button.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("idiom-theme", next); } catch (e) {}
    label();
  });
  system.addEventListener("change", label);
  label();
  var menu = document.querySelector(".docs-menu");
  if (menu && window.matchMedia("(max-width: 900px)").matches) menu.open = false;
  // Search: titles and headings from /docs/search.json, fetched on first use.
  var box = document.querySelector(".search input"), list = document.querySelector(".search .results"), index;
  function load() { return index || (index = fetch("/docs/search.json").then(function (r) { return r.json(); })); }
  function show(query) {
    var q = query.trim().toLowerCase();
    if (!q) { list.hidden = true; list.innerHTML = ""; return; }
    load().then(function (entries) {
      var hits = entries.map(function (e) {
        var t = e.text.toLowerCase(), at = t.indexOf(q);
        return { e: e, rank: at < 0 ? -1 : (at === 0 ? 0 : 1) + (e.page === e.text ? 0 : 2) };
      }).filter(function (h) { return h.rank >= 0; }).sort(function (a, b) { return a.rank - b.rank; }).slice(0, 12);
      list.innerHTML = hits.length ? hits.map(function (h) {
        return '<li><a href="' + h.e.url + '">' + h.e.text.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }) + (h.e.page === h.e.text ? "" : '<span>' + h.e.page + "</span>") + "</a></li>";
      }).join("") : '<li class="none">No matches</li>';
      list.hidden = false;
    });
  }
  if (box) {
    box.addEventListener("focus", load);
    box.addEventListener("input", function () { show(box.value); });
    box.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { var first = list.querySelector("a"); if (first) location.href = first.href; }
      if (event.key === "Escape") { box.value = ""; show(""); }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "/" && document.activeElement !== box && !/input|textarea/i.test(document.activeElement.tagName)) { event.preventDefault(); if (menu) menu.open = true; box.focus(); }
    });
  }
  var copy = document.querySelector(".copy-md");
  if (copy) copy.addEventListener("click", function () {
    fetch(copy.dataset.src).then(function (r) { return r.text(); })
      .then(function (text) { return navigator.clipboard.writeText(text); })
      .then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy as Markdown"; }, 1600); })
      .catch(function () { location.href = copy.dataset.src; });
  });
})();
</script>`;

function sidebar(current, titles) {
  return docsGroups
    .map((group) => {
      const items = group.pages
        .map((page) => {
          const href = page.href ?? pagePath(page);
          const title = page.title ?? titles.get(page.slug);
          const here = page.source !== undefined && page.slug === current.slug;
          return `<li><a href="${href}"${here ? ' aria-current="page"' : ""}>${escapeHtml(title)}</a></li>`;
        })
        .join("");
      return `<p class="group">${group.label}</p><ul>${items}</ul>`;
    })
    .join("");
}

function documentHtml({
  page,
  html,
  headings,
  previous,
  next,
  metadata,
  titles,
}) {
  const toc =
    headings.filter((heading) => heading.depth === 2).length > 1
      ? `<p class="group">On this page</p><ul>${headings
          .filter((heading) => heading.depth === 2)
          .map(
            (heading) =>
              `<li><a href="#${heading.id}">${heading.html.replace(/<[^>]*>/g, "")}</a></li>`,
          )
          .join("")}</ul>`
      : "";
  const edit = `${repository}/blob/main/${page.source}`;
  const pager = [
    previous
      ? `<a class="prev" href="${pagePath(previous)}"><span>Previous</span>${escapeHtml(previous.title)}</a>`
      : "<span></span>",
    next
      ? `<a class="next" href="${pagePath(next)}"><span>Next</span>${escapeHtml(next.title)}</a>`
      : "<span></span>",
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
${metadata}
<title>${escapeHtml(page.title)} · Idiom docs</title>
<link rel="stylesheet" href="/docs/site.css">
<link rel="alternate" type="text/markdown" href="${markdownPath(page)}">
${themeScript}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap docs">
<header class="top"><a class="wordmark" href="/">idiom</a><a class="meta" href="/docs">Docs</a><nav aria-label="Site"><a href="/">Home</a><a href="${repository}">GitHub</a></nav>${toggle}</header>
<div class="docs-grid">
<details class="docs-menu" open><summary>Menu</summary><div class="search" role="search"><input type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd><ul class="results" hidden></ul></div><nav class="sidebar" aria-label="Docs">${sidebar(page, titles)}</nav></details>
<main id="main" class="prose">
<p class="crumb">${page.group} · ${escapeHtml(page.title)}</p>
${html}
<nav class="pager" aria-label="Pages">${pager}</nav>
</main>
<aside class="toc">${toc}<p class="group">This page</p><ul><li><button class="copy-md" type="button" data-src="${markdownPath(page)}">Copy as Markdown</button></li><li><a href="${markdownPath(page)}">View as Markdown</a></li><li><a href="${edit}">Source on GitHub</a></li></ul></aside>
</div>
<footer><span>Every state, not every page. Build in your idiom. · Apache-2.0</span><nav aria-label="More"><a href="/llms.txt">llms.txt</a><a href="${repository}">GitHub</a><a href="https://www.npmjs.com/package/@mattskilly/idiom">npm</a></nav></footer>
</div>
${behaviour}
</body>
</html>
`;
}

// Atomic, because several test files build the site at once.
async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function buildDocs({ root, outputDirectory, siteCss, meta }) {
  const loaded = [];
  for (const page of docPages) loaded.push(await loadPage(root, page));
  const titles = new Map(loaded.map((page) => [page.slug, page.title]));

  const docsCss = await readFile(join(root, "site/docs/docs.css"), "utf8");
  await write(join(outputDirectory, "docs/site.css"), `${siteCss}\n${docsCss}`);

  const twins = [];
  const search = [];
  for (const [index, page] of loaded.entries()) {
    const { html, headings } = render(page);
    search.push({ text: page.title, page: page.title, url: pagePath(page) });
    for (const heading of headings)
      search.push({
        text: heading.html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&"),
        page: page.title,
        url: `${pagePath(page)}#${heading.id}`,
      });
    const file =
      page.slug === "" ? "docs.html" : join("docs", `${page.slug}.html`);
    await write(
      join(outputDirectory, file),
      documentHtml({
        page,
        html,
        headings,
        previous: loaded[index - 1],
        next: loaded[index + 1],
        titles,
        metadata: meta({
          title: `${page.title} · Idiom docs`,
          description: page.description,
          canonical: `${origin}${pagePath(page)}`,
        }),
      }),
    );
    const twin = markdownTwin(page);
    twins.push(twin);
    await write(join(outputDirectory, `${markdownPath(page).slice(1)}`), twin);
  }

  await write(
    join(outputDirectory, "docs/search.json"),
    JSON.stringify(search),
  );

  const overview = loaded[0];
  const list = (group) =>
    group.pages
      .map((page) => {
        const found = loaded.find(
          (candidate) =>
            page.source !== undefined && candidate.slug === page.slug,
        );
        const url = found
          ? `${origin}${markdownPath(found)}`
          : `${origin}${page.href}`;
        return `- [${(found ?? page).title}](${url}): ${(found ?? page).description}`;
      })
      .join("\n");
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const llms = `# Idiom

> ${overview.description}

Install with \`npm install -g ${repository}/releases/download/v${version}/mattskilly-idiom-${version}.tgz\` (or \`npm install -g @mattskilly/idiom\` once npm serves this release), run \`idiom quick http://localhost:3000\` for a review with no setup. For Claude Code, use \`/plugin marketplace add mattskilly/idiom\` then \`/plugin install idiom@idiom\`; for Codex use \`codex plugin marketplace add mattskilly/idiom\` then \`codex plugin add idiom@idiom\`. The plugin bundles MCP and the skill, with a runtime pinned to its release. Claude also adds UI reminders. Update Claude with \`/plugin marketplace update idiom\`, \`/plugin update idiom@idiom\` and \`/reload-plugins\`; update Codex with \`codex plugin marketplace upgrade idiom\`, \`codex plugin add idiom@idiom\` and a new session. Open source under Apache-2.0: ${repository}

${docsGroups.map((group) => `## ${group.label}\n\n${list(group)}`).join("\n\n")}

## Optional

- [All docs in one file](${origin}/llms-full.txt): every page above, concatenated.
- [Source on GitHub](${repository})
`;
  await write(join(outputDirectory, "llms.txt"), llms);
  await write(
    join(outputDirectory, "llms-full.txt"),
    `${twins.join("\n---\n\n")}`,
  );

  const urls = [
    `${origin}/`,
    ...loaded.map((page) => `${origin}${pagePath(page)}`),
    ...pages
      .filter((page) => page.href !== undefined)
      .map((page) => `${origin}${page.href}`),
  ];
  await write(
    join(outputDirectory, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  await write(
    join(outputDirectory, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
  );
}
