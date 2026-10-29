# Official MCP Registry schema fixture

Unmodified JSON Schema draft-07 from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json.
Retrieved 2026-10-28. SHA-256: `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.

Refresh deliberately, compare the schema and update this digest:

```sh
curl -fsSL https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json -o test/fixtures/mcp-registry/server.schema.json
shasum -a 256 test/fixtures/mcp-registry/server.schema.json
```

Tests use this pinned fixture offline; the publisher checks the live contract before publication.
