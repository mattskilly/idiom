Run `PORT=3000 node server.mjs` from a temporary copy of this directory. The
fixture has linked, sitemap-only, unlinked, canonical and protected pages.
`/http-private` and `/client-private` initially redirect to login. Add
`{ "run": "node setup.mjs" }` to a generated flow's `setup` array to enable their
own content before the capture server starts. The HTTP-protected page uses
`/http-private/` as its canonical path, exercising trailing-slash normalization. Remove `.fixture-auth` to reset.
The setup command is fixture seeding, not a general authentication recipe.
