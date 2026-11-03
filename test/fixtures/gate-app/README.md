# Gate fixture

A five-route app for measuring `idiom check --gate` (`scripts/measure-gate.mjs`).

The `.tsx` files exist only for Idiom's import graph: Next-style routes under
`app/`, a `Nav` every page imports, and a `Card` that only `app/orders` imports
with its `Card.module.css`. `server.mjs` does not execute them; it serves real
HTML per route and inlines `components/Card.module.css`, read on each request,
into `/orders` only, so editing that stylesheet changes what one route renders.
