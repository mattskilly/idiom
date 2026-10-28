// Field Supply: a small admin SPA with a mock JSON API and fixed latency,
// used by scripts/field-test.mjs as the local feel-rule target. Every app
// route answers index.html; /api/* answers JSON after a deterministic delay.
// Binds 127.0.0.1 only.
//
//   node server.mjs --port 4410
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const ROUTES = [
  "/",
  "/catalog",
  "/orders",
  "/customers",
  "/settings",
  "/billing",
  "/team",
  "/reports",
  "/activity",
  "/inventory",
];
const SUB_ROUTES = ["/team/invitations", "/team/audit", "/reports/quarterly"];

const people = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Katherine Johnson",
  "Edsger Dijkstra",
  "Barbara Liskov",
  "Donald Knuth",
  "Frances Allen",
  "Ken Thompson",
  "Radia Perlman",
  "Margaret Hamilton",
  "John Backus",
];
const products = [
  ["Canvas tote", "Bags", 24],
  ["Field notebook", "Paper", 12],
  ["Brass pen", "Writing", 38],
  ["Wool beanie", "Apparel", 29],
  ["Enamel mug", "Kitchen", 18],
  ["Trail map", "Paper", 9],
  ["Leather strap", "Accessories", 44],
  ["Rain shell", "Apparel", 129],
  ["Camp stool", "Outdoor", 56],
  ["Water bottle", "Kitchen", 22],
  ["Pocket knife", "Outdoor", 64],
  ["Desk lamp", "Home", 89],
];
const rows = (count, offset, make) =>
  Array.from({ length: count }, (_, index) => make(index + offset));
const product = (index) => {
  const [name, category, price] = products[index % products.length];
  return {
    sku: `FS-${1040 + index}`,
    name,
    category,
    price: `$${price}.00`,
    stock: 3 + ((index * 7) % 40),
  };
};
const order = (index) => ({
  id: `#${48210 + index}`,
  customer: people[index % people.length],
  total: `$${(42 + ((index * 37) % 300)).toFixed(2)}`,
  status: ["Paid", "Shipped", "Refunded", "Pending"][index % 4],
});
const customer = (index) => ({
  name: people[index % people.length],
  email: `${people[index % people.length].split(" ")[0].toLowerCase()}@example.com`,
  orders: 1 + ((index * 5) % 17),
  since: `${2019 + (index % 6)}`,
});
const event = (index) => ({
  time: `${9 + (index % 9)}:${String((index * 13) % 60).padStart(2, "0")}`,
  actor: people[index % people.length],
  detail: [
    "Updated a price list",
    "Exported orders",
    "Changed a shipping rule",
    "Invited a teammate",
    "Rotated an API key",
  ][index % 5],
});

/**
 * Fixed latencies. The held replay starts its response-adjacency clock when it
 * forwards a request, so most endpoints answer quickly; the interaction-shift
 * cases need arrivals well after 500ms of an unheld click.
 */
export const LATENCY_MS = 150;
export const SHIFT_LATENCY_MS = 800;
/** Every endpoint: its fixed latency and JSON body. */
const API = {
  "/api/products": [
    LATENCY_MS,
    (query) => rows(4, 4 * Number(query.get("page") ?? 1), product),
  ],
  "/api/products/in-stock": [LATENCY_MS, () => rows(4, 20, product)],
  "/api/products/archived": [LATENCY_MS, () => rows(4, 30, product)],
  "/api/products/featured": [LATENCY_MS, () => rows(4, 40, product)],
  "/api/orders/refunds": [SHIFT_LATENCY_MS, () => rows(8, 2, order)],
  "/api/orders/pending": [SHIFT_LATENCY_MS, () => rows(4, 3, order)],
  "/api/orders/older": [LATENCY_MS, () => rows(4, 60, order)],
  "/api/orders/detail": [
    SHIFT_LATENCY_MS,
    () => ({
      lines: ["2 × Canvas tote", "1 × Brass pen", "1 × Trail map"],
      address: "12 Harbour Road, Leith, Edinburgh EH6 6LU",
      note: "Leave with the concierge if no one answers.",
    }),
  ],
  "/api/orders/carriers": [
    SHIFT_LATENCY_MS,
    () =>
      rows(6, 0, (index) => ({
        time: `Oct ${20 + index}`,
        detail: [
          "Label created",
          "Picked up by Royal Mail",
          "Arrived at sorting hub",
          "Out for delivery",
          "Delivery attempted",
          "Delivered to concierge",
        ][index],
      })),
  ],
  "/api/customers": [
    LATENCY_MS,
    (query) => rows(5, 5 * Number(query.get("page") ?? 1), customer),
  ],
  "/api/customers/segments": [
    SHIFT_LATENCY_MS,
    () =>
      rows(6, 0, (index) => ({
        name: [
          "Wholesale",
          "Returning",
          "First order",
          "Lapsed",
          "VIP",
          "Newsletter",
        ][index],
        size: 40 + index * 23,
      })),
  ],
  "/api/customers/tickets": [
    SHIFT_LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        subject: ["Late delivery", "Wrong size", "Invoice copy", "Gift wrap"][
          index
        ],
        status: index % 2 ? "Open" : "Closed",
      })),
  ],
  "/api/customers/lifetime": [
    SHIFT_LATENCY_MS,
    () => ({
      months: [320, 410, 380, 520, 610, 590],
      total: "$2,830.00",
    }),
  ],
  "/api/reports/revenue": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: ["North", "South", "East", "West"][index],
        value: `$${(12 + index * 3).toFixed(1)}k`,
      })),
  ],
  "/api/reports/churn": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: `Q${index + 1}`,
        value: `${(3 + index * 0.4).toFixed(1)}%`,
      })),
  ],
  "/api/reports/cohorts": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: `Cohort ${2022 + index}`,
        value: `${70 - index * 6}%`,
      })),
  ],
  "/api/reports/export": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: `orders-${index + 1}.csv`,
        value: `${120 + index * 40} rows`,
      })),
  ],
  "/api/reports/usage": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: ["Storefront", "API", "POS", "Wholesale"][index],
        value: `${40 - index * 7}%`,
      })),
  ],
  "/api/activity/audit": [LATENCY_MS, () => rows(4, 0, event)],
  "/api/activity/sync": [LATENCY_MS, () => rows(4, 4, event)],
  "/api/activity/webhooks": [LATENCY_MS, () => rows(4, 8, event)],
  "/api/activity/deploys": [LATENCY_MS, () => rows(4, 12, event)],
  "/api/activity/keys": [LATENCY_MS, () => rows(4, 16, event)],
  "/api/inventory/stock": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: product(index).name,
        value: `${product(index).stock} units`,
      })),
  ],
  "/api/inventory/reorder": [
    LATENCY_MS,
    () =>
      rows(4, 4, (index) => ({
        label: product(index).name,
        value: "Reorder 20",
      })),
  ],
  "/api/inventory/suppliers": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: ["Northwind", "Contoso", "Fabrikam", "Tailspin"][index],
        value: "Feed current",
      })),
  ],
  "/api/inventory/warehouses": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: ["Leith", "Govan", "Salford", "Bristol"][index],
        value: `${60 + index * 8}% full`,
      })),
  ],
  "/api/billing/invoices": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: `INV-${2026090 + index}`,
        value: `$${(480 + index * 15).toFixed(2)}`,
      })),
  ],
  "/api/settings/sessions": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: [
          "MacBook · Edinburgh",
          "iPhone · Edinburgh",
          "iPad · Leith",
          "Windows · Glasgow",
        ][index],
        value: index === 0 ? "This device" : `${index + 1} days ago`,
      })),
  ],
  "/api/inventory/prices": [
    LATENCY_MS,
    () =>
      rows(4, 0, (index) => ({
        label: `Week ${40 + index}`,
        value: `$${(24 + index).toFixed(2)}`,
      })),
  ],
  "/api/page/team/invitations": [
    LATENCY_MS,
    () => ({
      title: "Invitations",
      rows: rows(4, 3, (index) => ({
        label: `${people[index % people.length].split(" ")[0].toLowerCase()}@example.com`,
        value: "Sent 2 days ago",
      })),
    }),
  ],
  "/api/page/team/audit": [
    LATENCY_MS,
    () => ({
      title: "Audit log",
      rows: rows(4, 0, (index) => ({
        label: event(index).actor,
        value: event(index).detail,
      })),
    }),
  ],
  "/api/page/reports/quarterly": [
    LATENCY_MS,
    () => ({
      title: "Quarterly",
      rows: rows(4, 0, (index) => ({
        label: `Q${index + 1} 2026`,
        value: `$${180 + index * 22}k`,
      })),
    }),
  ],
};
const POST_LATENCY_MS = 600;

export async function fieldAppServer(port = 0) {
  const read = (name) => readFile(new URL(`./${name}`, import.meta.url));
  const [html, script, style] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("app.css"),
  ]);
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const send = (status, type, body) => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
      });
      response.end(body);
    };
    if (path.startsWith("/api/")) {
      requests.push({ method, path });
      if (method === "POST") {
        setTimeout(
          () => send(200, "application/json", JSON.stringify({ ok: true })),
          POST_LATENCY_MS,
        );
        return;
      }
      const endpoint = API[path];
      if (!endpoint || method !== "GET")
        return send(404, "application/json", "{}");
      const [latency, body] = endpoint;
      setTimeout(
        () =>
          send(200, "application/json", JSON.stringify(body(url.searchParams))),
        latency,
      );
      return;
    }
    if (path === "/app.js") return send(200, "text/javascript", script);
    if (path === "/app.css") return send(200, "text/css", style);
    if (path === "/favicon.ico") return send(204, "image/x-icon", "");
    if (ROUTES.includes(path) || SUB_ROUTES.includes(path))
      return send(200, "text/html; charset=utf-8", html);
    send(404, "text/plain", "Not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    address,
    requests,
    latency: (path) => API[path]?.[0],
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const flag = process.argv.indexOf("--port");
  const port = Number(
    flag === -1 ? (process.env.PORT ?? 4410) : process.argv[flag + 1],
  );
  const app = await fieldAppServer(port);
  console.error(`Field Supply ready ${app.url}`);
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
