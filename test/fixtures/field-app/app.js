// Field Supply: a vanilla history-API admin app. Every case control carries
// data-case="<id>" matching cases.json; its pending, render and failure
// behaviour lives in CASES below. Good and bad implementations sit side by
// side on purpose (see cases.json for the ground truth).

const people = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Katherine Johnson",
  "Edsger Dijkstra",
  "Barbara Liskov",
  "Donald Knuth",
  "Frances Allen",
];
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

const table = (columns, items) =>
  `<table><thead><tr>${columns.map(([label]) => `<th scope="col">${label}</th>`).join("")}</tr></thead><tbody>${items.map((item) => row(columns, item)).join("")}</tbody></table>`;
const row = (columns, item) =>
  `<tr>${columns.map(([, key]) => `<td>${escapeHtml(item[key])}</td>`).join("")}</tr>`;
const PRODUCT = [
  ["SKU", "sku"],
  ["Product", "name"],
  ["Category", "category"],
  ["Price", "price"],
  ["Stock", "stock"],
];
const ORDER = [
  ["Order", "id"],
  ["Customer", "customer"],
  ["Total", "total"],
  ["Status", "status"],
];
const CUSTOMER = [
  ["Name", "name"],
  ["Email", "email"],
  ["Orders", "orders"],
  ["Customer since", "since"],
];
const EVENT = [
  ["Time", "time"],
  ["Who", "actor"],
  ["What", "detail"],
];
const pairs = (items) =>
  `<dl class="pairs">${items.map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}</dl>`;
const skeleton = (count) =>
  `<div class="skeleton-list" aria-hidden="true">${'<div class="skeleton-row"></div>'.repeat(count)}</div>`;
const spinner = (label) =>
  `<div class="spinner-row" role="status"><span class="spinner" aria-hidden="true"></span>${label}</div>`;

const seedProducts = [
  ["FS-1040", "Canvas tote", "Bags", "$24.00", 3],
  ["FS-1041", "Field notebook", "Paper", "$12.00", 10],
  ["FS-1042", "Brass pen", "Writing", "$38.00", 17],
  ["FS-1043", "Wool beanie", "Apparel", "$29.00", 24],
].map(([sku, name, category, price, stock]) => ({
  sku,
  name,
  category,
  price,
  stock,
}));
const seedOrders = [0, 1, 2, 3].map((index) => ({
  id: `#${48300 + index}`,
  customer: people[index],
  total: `$${(58 + index * 31).toFixed(2)}`,
  status: "Paid",
}));
const seedCustomers = [0, 1, 2, 3, 4].map((index) => ({
  name: people[index],
  email: `${people[index].split(" ")[0].toLowerCase()}@example.com`,
  orders: 2 + index * 3,
  since: `${2019 + index}`,
}));

/**
 * GET cases. pending: what shows while the request runs. render: how the
 * result lands. failure: what the page does when the request fails.
 */
const CASES = {
  "catalog-load-more": {
    url: "/api/products?page=2",
    into: "products-body",
    pending: [],
    render: (body, items) =>
      body
        .querySelector("tbody")
        .insertAdjacentHTML(
          "beforeend",
          items.map((item) => row(PRODUCT, item)).join(""),
        ),
    failure: "silent",
  },
  "catalog-next-page": {
    url: "/api/products?page=3",
    into: "products-body",
    pending: ["busy-region", "spinner-overlay"],
    render: (body, items) => {
      body.innerHTML = table(PRODUCT, items);
    },
    animate: true,
    failure: "alert-retry",
  },
  "catalog-in-stock": {
    url: "/api/products/in-stock",
    into: "products-body",
    pending: ["trigger-disabled", "skeleton:5"],
    pressed: true,
    render: (body, items) => {
      body.innerHTML = table(PRODUCT, items);
    },
    animate: true,
    failure: "alert-retry",
  },
  "catalog-archived": {
    url: "/api/products/archived",
    into: "collections-body",
    tab: true,
    pending: [],
    render: (body, items) => {
      body.innerHTML = table(PRODUCT, items);
    },
    failure: "silent",
  },
  "catalog-featured": {
    url: "/api/products/featured",
    into: "collections-body",
    tab: true,
    pending: ["busy-region", "spinner-overlay"],
    render: (body, items) => {
      body.innerHTML = table(PRODUCT, items);
    },
    animate: true,
    failure: "alert-retry",
  },
  "orders-refunds": {
    url: "/api/orders/refunds",
    into: "orders-body",
    tab: true,
    pending: ["skeleton:2"],
    render: (body, items) => {
      body.innerHTML = table(ORDER, items);
    },
    failure: "alert-retry",
  },
  "orders-pending": {
    url: "/api/orders/pending",
    into: "orders-body",
    tab: true,
    pending: ["skeleton:5"],
    render: (body, items) => {
      body.innerHTML = table(ORDER, items);
    },
    animate: true,
    failure: "alert-retry",
  },
  "orders-details": {
    url: "/api/orders/detail",
    into: "detail-slot",
    pending: ["trigger-disabled", "trigger-text:Loading details…"],
    render: (body, detail) => {
      body.innerHTML = `<div class="detail"><h3>Order #48300</h3><ul>${detail.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>${escapeHtml(detail.address)}</p><p class="muted">${escapeHtml(detail.note)}</p></div>`;
    },
    failure: "alert-retry",
  },
  "orders-older": {
    url: "/api/orders/older",
    into: "older-body",
    pending: ["busy-region", "spinner-overlay"],
    render: (body, items) => {
      body.innerHTML = table(ORDER, items);
    },
    animate: true,
    failure: "alert-retry",
  },
  "orders-carriers": {
    url: "/api/orders/carriers",
    into: "carriers-body",
    pending: ["spinner-inline:Checking carriers…"],
    render: (body, items) => {
      body.innerHTML = `<ol class="timeline">${items.map((item) => `<li><span class="muted">${escapeHtml(item.time)}</span> ${escapeHtml(item.detail)}</li>`).join("")}</ol>`;
    },
    failure: "alert-retry",
  },
  "customers-page-2": {
    url: "/api/customers?page=2",
    into: "customers-body",
    pending: [],
    render: (body, items) => {
      body.innerHTML = table(CUSTOMER, items);
    },
    failure: "silent",
  },
  "customers-page-3": {
    url: "/api/customers?page=3",
    into: "customers-body",
    pending: ["busy-region", "spinner-overlay"],
    render: (body, items) => {
      body.innerHTML = table(CUSTOMER, items);
    },
    failure: "alert-retry",
  },
  "customers-segments": {
    url: "/api/customers/segments",
    into: "segments-body",
    pending: ["skeleton:2"],
    render: (body, items) => {
      body.innerHTML = pairs(
        items.map((item) => ({
          label: item.name,
          value: `${item.size} customers`,
        })),
      );
    },
    failure: "alert-retry",
  },
  "customers-tickets": {
    url: "/api/customers/tickets",
    into: "tickets-body",
    pending: ["skeleton:4"],
    render: (body, items) => {
      body.innerHTML = pairs(
        items.map((item) => ({ label: item.subject, value: item.status })),
      );
    },
    animate: true,
    failure: "alert-retry",
  },
  "customers-lifetime": {
    url: "/api/customers/lifetime",
    into: "lifetime-body",
    pending: ["spinner-inline:Calculating…"],
    render: (body, value) => {
      const max = Math.max(...value.months);
      body.innerHTML = `<p class="figure">${escapeHtml(value.total)}</p><div class="bars">${value.months.map((month) => `<span style="height:${Math.round((month / max) * 120)}px"></span>`).join("")}</div>`;
    },
    failure: "alert-retry",
  },
  ...failureCases("reports", [
    ["revenue", "alert-retry", ["spinner-inline:Running report…"]],
    ["churn", "silent", []],
    [
      "cohorts",
      "stuck",
      ["trigger-disabled", "spinner-inline:Running report…"],
    ],
    ["export", "clear-main", ["spinner-inline:Preparing preview…"]],
    ["usage", "console", []],
  ]),
  ...failureCases("activity", [
    ["audit", "alert-retry", ["spinner-inline:Loading…"]],
    ["sync", "silent", []],
    [
      "webhooks",
      "stuck",
      ["trigger-disabled", "spinner-inline:Loading deliveries…"],
    ],
    ["deploys", "clear-main", ["spinner-inline:Loading…"]],
    ["keys", "console", []],
  ]),
  ...failureCases("inventory", [
    ["stock", "alert-retry", ["spinner-inline:Refreshing…"]],
    ["reorder", "silent", []],
    ["suppliers", "stuck", ["trigger-busy", "spinner-inline:Refreshing feed…"]],
    ["warehouses", "hide-trigger", ["spinner-inline:Loading map…"]],
    ["prices", "alert-retry", ["trigger-disabled", "spinner-inline:Loading…"]],
  ]),
  ...failureCases("billing", [
    [
      "invoices",
      "stuck",
      ["trigger-disabled", "spinner-inline:Loading invoices…"],
    ],
  ]),
  ...failureCases("settings", [
    ["sessions", "hide-trigger", ["spinner-inline:Loading sessions…"]],
  ]),
};

function failureCases(route, list) {
  return Object.fromEntries(
    list.map(([name, failure, pending]) => [
      `${route}-${name}`,
      {
        url: `/api/${route}/${name}`,
        into: `${name}-body`,
        pending,
        render: (body, items) => {
          body.innerHTML =
            route === "activity" ? table(EVENT, items) : pairs(items);
        },
        animate: true,
        failure,
      },
    ]),
  );
}

/** POST forms. pending: what the submit button does while saving. */
const FORMS = {
  "settings-profile": {
    url: "/api/profile",
    pending: ["disable", "text:Saving…"],
    done: "Profile saved.",
  },
  "settings-address": {
    url: "/api/address",
    pending: [],
    done: "Address saved.",
  },
  "settings-password": {
    url: "/api/password",
    pending: ["text:Saving…"],
    done: "Password updated.",
  },
  "settings-notifications": {
    url: "/api/notifications",
    pending: ["disable"],
    done: "Notification settings saved.",
  },
  "settings-preferences": {
    url: "/api/preferences",
    pending: ["disable", "busy", "spinner"],
    done: "Preferences saved.",
  },
  "billing-coupon": {
    url: "/api/coupon",
    pending: [],
    done: "Coupon applied: 10% off your next invoice.",
  },
  "billing-card": {
    url: "/api/card",
    pending: ["text:Saving…"],
    done: "Card updated.",
  },
  "billing-seat": {
    url: "/api/seats",
    pending: ["disable", "busy", "spinner"],
    done: "Seat added. You now have 6 seats.",
  },
  "orders-note": {
    url: "/api/orders/note",
    pending: [],
    done: "Note added to order #48300.",
  },
  "customers-tag": {
    url: "/api/customers/tag",
    pending: ["text:Saving…"],
    done: "Tag saved.",
  },
  "team-invite": {
    url: "/api/invites",
    pending: [],
    done: "Invitation on its way.",
  },
  "team-reinvite": {
    url: "/api/invites/again",
    pending: ["guard", "text:Inviting…"],
    done: "Invitation sent again.",
  },
  "team-role": {
    url: "/api/roles",
    pending: ["text:Saving…"],
    done: "Role changed.",
  },
};

/** Route changes inside a section: pushState, then fetch the view. */
const VIEWS = {
  "team-invitations": { path: "/team/invitations", pending: [] },
  "team-audit": { path: "/team/audit", pending: [] },
  "reports-quarterly": {
    path: "/reports/quarterly",
    pending: ["skeleton"],
    animate: true,
  },
};

const card = (id, title, actions, body, extra = "") =>
  `<section class="card card--${id}" aria-labelledby="${id}-title"><header class="card-head card-head--${id}"><h2 id="${id}-title">${title}</h2><div class="card-actions card-actions--${id}">${actions}</div></header><div class="card-body card-body--${id}" id="${id}-body">${body}</div>${extra}</section>`;
const action = (id, label, classes = "") =>
  `<button type="button" class="button button--${id} ${classes}" data-case="${id}">${label}</button>`;
const note = (id, text) =>
  `<section class="card card--${id}"><h2>${id === "notes" ? "Order notes" : "Good to know"}</h2><p class="muted">${text}</p></section>`;

const reportCard = (route, name, title, label, intro) =>
  card(
    name,
    title,
    action(`${route}-${name}`, label),
    `<p class="muted">${intro}</p>`,
  );

const PAGES = {
  "/": () => ({
    title: "Overview",
    body: `<div class="kpis"><div><span>Revenue this week</span><strong>$18,420</strong></div><div><span>Open orders</span><strong>37</strong></div><div><span>Low stock</span><strong>6 items</strong></div></div>
<section class="card card--welcome"><h2>Welcome back</h2><p>Use the navigation to manage the catalog, orders, customers, billing and your team. Reports refresh on demand.</p></section>`,
  }),
  "/catalog": () => ({
    title: "Catalog",
    body: `${card(
      "products",
      "Products",
      `${action("catalog-in-stock", "In stock", "chip")}`,
      table(PRODUCT, seedProducts),
      `<footer class="card-foot card-foot--products">${action("catalog-load-more", "Load more products")}${action("catalog-next-page", "Next page")}</footer>`,
    )}
${card(
  "collections",
  "Collections",
  `<div role="tablist" aria-label="Collection" class="tabs tabs--collections"><button type="button" role="tab" aria-selected="true" class="tab tab--current">Current</button><button type="button" role="tab" aria-selected="false" class="tab tab--featured" data-case="catalog-featured">Featured</button><button type="button" role="tab" aria-selected="false" class="tab tab--archived" data-case="catalog-archived">Archived</button></div>`,
  table(PRODUCT, seedProducts.slice(0, 3)),
)}`,
  }),
  "/orders": () => ({
    title: "Orders",
    body: `${card(
      "orders",
      "Orders",
      `<div role="tablist" aria-label="Order status" class="tabs tabs--orders"><button type="button" role="tab" aria-selected="true" class="tab tab--paid">Paid</button><button type="button" role="tab" aria-selected="false" class="tab tab--pending" data-case="orders-pending">Pending</button><button type="button" role="tab" aria-selected="false" class="tab tab--refunds" data-case="orders-refunds">Refunds</button></div>`,
      table(ORDER, seedOrders),
    )}
${card("detail", "Order #48300", action("orders-details", "Show details"), "<p>Ada Lovelace · 4 items · $58.00 · Paid</p>", '<div id="detail-slot"></div>')}
${card("carriers", "Carrier updates", action("orders-carriers", "Check carrier updates"), '<p class="muted">Tracking for order #48301.</p>')}
${card("older", "Archive of past orders", action("orders-older", "Older orders"), table(ORDER, seedOrders.slice(0, 2)))}
${note("notes", "Orders placed before 2 p.m. ship the same day. Refunds take 3–5 working days to reach the customer.")}
${form("orders-note", "Add a note to order #48300", [["Note", "note", "Customer asked for gift wrap."]], "Add note")}`,
  }),
  "/customers": () => ({
    title: "Customers",
    body: `${card(
      "customers",
      "Customers",
      "",
      table(CUSTOMER, seedCustomers),
      `<footer class="card-foot card-foot--customers"><span class="muted">Page 1 of 3</span>${action("customers-page-2", "Page 2")}${action("customers-page-3", "Page 3")}</footer>`,
    )}
${card("segments", "Segments", action("customers-segments", "Show segments"), '<p class="muted">Group customers by behaviour.</p>')}
${card("tickets", "Recent support tickets", action("customers-tickets", "Load tickets"), '<p class="muted">The four most recent tickets.</p>', "")}
${card("lifetime", "Lifetime value", action("customers-lifetime", "Calculate lifetime value"), '<p class="muted">Six-month revenue per customer.</p>')}
${note("tips", "Customer data syncs from the storefront every 15 minutes.")}
${form(
  "customers-tag",
  "Tag a customer",
  [
    ["Customer", "customer", "Grace Hopper"],
    ["Tag", "tag", "Wholesale"],
  ],
  "Save tag",
)}`,
  }),
  "/settings": () => ({
    title: "Settings",
    body: [
      form(
        "settings-profile",
        "Profile",
        [
          ["Name", "name", "Ada Lovelace"],
          ["Email", "email", "ada@example.com"],
        ],
        "Save profile",
      ),
      form(
        "settings-address",
        "Shipping address",
        [
          ["Street", "street", "12 Harbour Road"],
          ["City", "city", "Edinburgh"],
          ["Postcode", "postcode", "EH6 6LU"],
        ],
        "Save address",
      ),
      form(
        "settings-password",
        "Password",
        [
          ["Current password", "current", "hunter2hunter2", "password"],
          ["New password", "next", "correct-horse-battery", "password"],
        ],
        "Update password",
      ),
      form(
        "settings-notifications",
        "Notifications",
        [["Digest email", "digest", "Weekly"]],
        "Save notifications",
      ),
      form(
        "settings-preferences",
        "Preferences",
        [
          ["Language", "language", "English (UK)"],
          ["Time zone", "zone", "Europe/London"],
        ],
        "Save preferences",
      ),
      '<div class="reports">',
      reportCard(
        "settings",
        "sessions",
        "Active sessions",
        "Load active sessions",
        "Devices signed in to this account.",
      ),
      "</div>",
    ].join("\n"),
  }),
  "/billing": () => ({
    title: "Billing",
    body: [
      form(
        "billing-coupon",
        "Coupon",
        [["Coupon code", "code", "FIELD10"]],
        "Apply coupon",
      ),
      form(
        "billing-card",
        "Card on file",
        [
          ["Card number", "card", "4242 4242 4242 4242"],
          ["Expiry", "expiry", "12/29"],
        ],
        "Update card",
      ),
      form(
        "billing-seat",
        "Seats",
        [["Seats to add", "seats", "1"]],
        "Add seat",
      ),
      '<div class="reports">',
      reportCard(
        "billing",
        "invoices",
        "Invoices",
        "Load invoices",
        "Invoices from the last twelve months.",
      ),
      "</div>",
    ].join("\n"),
  }),
  "/team": () => ({
    title: "Team",
    views: [
      "Members",
      "team-invitations",
      "Invitations",
      "team-audit",
      "Audit log",
    ],
    body: [
      form(
        "team-invite",
        "Invite a teammate",
        [["Email", "email", "ken@example.com"]],
        "Invite teammate",
      ),
      form(
        "team-reinvite",
        "Pending invitation",
        [["Email", "email", "radia@example.com"]],
        "Invite again",
      ),
      form(
        "team-role",
        "Change role",
        [
          ["Teammate", "who", "Grace Hopper"],
          ["Role", "role", "Admin"],
        ],
        "Save role",
      ),
    ].join("\n"),
  }),
  "/reports": () => ({
    title: "Reports",
    views: ["Monthly", "reports-quarterly", "Quarterly"],
    body: [
      '<div class="reports">',
      reportCard(
        "reports",
        "revenue",
        "Revenue by region",
        "Run revenue report",
        "Latest revenue split across regions.",
      ),
      reportCard(
        "reports",
        "churn",
        "Churn",
        "Run churn report",
        "Customers lost per quarter.",
      ),
      reportCard(
        "reports",
        "cohorts",
        "Cohorts",
        "Run cohort report",
        "Retention by signup year.",
      ),
      reportCard(
        "reports",
        "export",
        "Export",
        "Preview export",
        "Check the files before exporting.",
      ),
      reportCard(
        "reports",
        "usage",
        "Channel usage",
        "Run usage summary",
        "Share of orders by sales channel.",
      ),
      "</div>",
    ].join("\n"),
  }),
  "/activity": () => ({
    title: "Activity",
    body: [
      '<div class="reports reports--activity">',
      reportCard(
        "activity",
        "audit",
        "Audit events",
        "Load audit events",
        "Who changed what today.",
      ),
      reportCard(
        "activity",
        "sync",
        "Storefront sync",
        "Check sync status",
        "Last runs of the storefront sync.",
      ),
      reportCard(
        "activity",
        "webhooks",
        "Webhooks",
        "Load webhook deliveries",
        "Recent deliveries to your endpoints.",
      ),
      reportCard(
        "activity",
        "deploys",
        "Deploys",
        "Load deploy log",
        "Theme and checkout deploys.",
      ),
      reportCard(
        "activity",
        "keys",
        "API keys",
        "Load API key usage",
        "Requests per key today.",
      ),
      "</div>",
    ].join("\n"),
  }),
  "/inventory": () => ({
    title: "Inventory",
    body: [
      '<div class="reports">',
      reportCard(
        "inventory",
        "stock",
        "Stock levels",
        "Refresh stock levels",
        "Units on hand per product.",
      ),
      reportCard(
        "inventory",
        "reorder",
        "Reorder suggestions",
        "Get reorder suggestions",
        "Products likely to run out this month.",
      ),
      reportCard(
        "inventory",
        "suppliers",
        "Supplier feed",
        "Refresh supplier feed",
        "Availability reported by suppliers.",
      ),
      reportCard(
        "inventory",
        "warehouses",
        "Warehouses",
        "Open warehouse map",
        "Capacity by warehouse.",
      ),
      reportCard(
        "inventory",
        "prices",
        "Price history",
        "Load price history",
        "Average sale price per week.",
      ),
      "</div>",
    ].join("\n"),
  }),
};

function form(id, title, fields, submit) {
  return `<form class="card card--${id} form" data-form="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${fields
    .map(
      ([label, name, value, type = "text"]) =>
        `<label class="field field--${id}-${name}"><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="off"></label>`,
    )
    .join(
      "",
    )}<div class="form-actions form-actions--${id}"><button type="submit" class="button button--primary button--${id}">${submit}</button><p class="form-status form-status--${id}" aria-live="polite"></p></div></form>`;
}

const main = () => document.querySelector("main");

function renderRoute(path) {
  const base = PAGES[path] ? path : `/${path.split("/")[1] ?? ""}`;
  const page = (PAGES[base] ?? PAGES["/"])();
  document.title = `${page.title} · Field Supply`;
  for (const link of document.querySelectorAll("nav.primary a")) {
    if (link.getAttribute("href") === base)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const views = document.querySelector("#views");
  if (page.views) {
    const [current, ...rest] = page.views;
    const buttons = [];
    for (let index = 0; index < rest.length; index += 2)
      buttons.push(
        `<button type="button" class="view view--${rest[index]}" data-view="${rest[index]}">${rest[index + 1]}</button>`,
      );
    views.innerHTML = `<div class="views-inner" role="toolbar" aria-label="${page.title} views"><button type="button" class="view view--current" aria-current="page">${current}</button>${buttons.join("")}</div>`;
    views.hidden = false;
  } else {
    views.innerHTML = "";
    views.hidden = true;
  }
  main().classList.remove("enter");
  main().innerHTML = `<h1>${page.title}</h1>${page.body}`;
}

function setPending(trigger, body, pending) {
  for (const item of pending) {
    if (item === "trigger-disabled") trigger.disabled = true;
    else if (item === "trigger-busy") trigger.setAttribute("aria-busy", "true");
    else if (item.startsWith("trigger-text:"))
      trigger.textContent = item.slice(13);
    else if (item === "busy-region") body.setAttribute("aria-busy", "true");
    else if (item === "spinner-overlay")
      body.insertAdjacentHTML(
        "afterbegin",
        `<div class="overlay" role="status"><span class="spinner" aria-hidden="true"></span><span class="visually-hidden">Loading</span></div>`,
      );
    else if (item.startsWith("spinner-inline:"))
      body.innerHTML = spinner(item.slice(15));
    else if (item.startsWith("skeleton:"))
      body.innerHTML = skeleton(Number(item.slice(9)));
  }
}

function restore(trigger, label, body) {
  trigger.disabled = false;
  trigger.removeAttribute("aria-busy");
  trigger.textContent = label;
  body.removeAttribute("aria-busy");
  body.querySelector(":scope > .overlay")?.remove();
}

async function runCase(trigger) {
  const id = trigger.dataset.case;
  const spec = CASES[id];
  const body = document.getElementById(spec.into);
  const label = trigger.textContent;
  if (spec.tab)
    for (const tab of trigger.parentElement.querySelectorAll("[role=tab]"))
      tab.setAttribute("aria-selected", String(tab === trigger));
  if (spec.pressed) trigger.setAttribute("aria-pressed", "true");
  setPending(trigger, body, spec.pending);
  try {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    restore(trigger, label, body);
    spec.render(body, data);
    if (spec.animate) {
      body.classList.remove("enter");
      void body.offsetWidth;
      body.classList.add("enter");
    }
  } catch (error) {
    if (spec.failure === "alert-retry") {
      restore(trigger, label, body);
      body.innerHTML = `<div class="alert" role="alert"><p>We couldn’t load this. Check your connection and try again.</p><button type="button" class="button button--retry-${id}" data-retry="${id}">Try again</button></div>`;
    } else if (spec.failure === "silent") restore(trigger, label, body);
    else if (spec.failure === "console") console.error(`${id} failed`, error);
    else if (spec.failure === "clear-main") main().replaceChildren();
    else if (spec.failure === "hide-trigger") trigger.hidden = true;
    // "stuck": the pending state stays up and the trigger stays as it is.
  }
}

async function runForm(form) {
  const id = form.dataset.form;
  const spec = FORMS[id];
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector(".form-status");
  if (spec.pending.includes("guard")) {
    if (form.dataset.inFlight === "true") return;
    form.dataset.inFlight = "true";
  }
  const label = button.textContent;
  status.textContent = "";
  for (const item of spec.pending) {
    if (item === "disable") button.disabled = true;
    else if (item === "busy") button.setAttribute("aria-busy", "true");
    else if (item === "spinner")
      button.insertAdjacentHTML(
        "afterbegin",
        '<span class="spinner spinner--small" aria-hidden="true"></span>',
      );
    else if (item.startsWith("text:")) button.textContent = item.slice(5);
  }
  try {
    const response = await fetch(spec.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    status.textContent = spec.done;
    status.className = `form-status form-status--${id} ok`;
  } catch {
    status.textContent = "Couldn’t save. Check your connection and try again.";
    status.className = `form-status form-status--${id} error`;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
    delete form.dataset.inFlight;
  }
}

async function runView(button) {
  const spec = VIEWS[button.dataset.view];
  history.pushState({}, "", spec.path);
  for (const view of document.querySelectorAll("#views .view")) {
    if (view === button) view.setAttribute("aria-current", "page");
    else view.removeAttribute("aria-current");
  }
  if (spec.pending.includes("skeleton"))
    main().innerHTML = `<div class="page-skeleton" aria-busy="true" aria-label="Loading">${'<div class="skeleton-row skeleton-row--title"></div>'}${skeleton(4)}</div>`;
  try {
    const response = await fetch(`/api/page${spec.path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = await response.json();
    main().innerHTML = `<h1>${escapeHtml(page.title)}</h1><section class="card card--view">${pairs(page.rows)}</section>`;
    if (spec.animate) main().classList.add("enter");
  } catch {
    main().innerHTML = `<h1>${escapeHtml(button.textContent)}</h1><div class="alert" role="alert"><p>We couldn’t load this view.</p><button type="button" class="button" data-reload>Try again</button></div>`;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest("a[href]");
  if (
    link &&
    link.origin === location.origin &&
    !event.metaKey &&
    !event.ctrlKey
  ) {
    event.preventDefault();
    history.pushState({}, "", link.pathname);
    renderRoute(link.pathname);
    return;
  }
  const trigger = target?.closest("[data-case]");
  if (trigger) {
    if (!trigger.disabled) void runCase(trigger);
    return;
  }
  const retry = target?.closest("[data-retry]");
  if (retry) {
    const original = document.querySelector(
      `[data-case="${retry.dataset.retry}"]`,
    );
    if (original) void runCase(original);
    return;
  }
  const view = target?.closest("[data-view]");
  if (view) {
    void runView(view);
    return;
  }
  if (target?.closest("[data-reload]")) location.reload();
});
document.addEventListener("submit", (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form?.dataset.form) return;
  event.preventDefault();
  void runForm(form);
});
window.addEventListener("popstate", () => renderRoute(location.pathname));
renderRoute(location.pathname);
