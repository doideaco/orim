# Licensing

Orim uses a split licence, on purpose: **your data must be portable by
construction, not by promise.**

| What | Where | Licence |
|---|---|---|
| The board format, its zod schema and published JSON Schema | [`packages/schema`](packages/schema) | **MIT** |
| All converters — Markdown, Mermaid, SVG, JSON, CSV/XLSX import, templates | [`packages/convert`](packages/convert) | **MIT** |
| The format specification | [`docs/`](docs) | **MIT** (same grant as the schema it documents) |
| Everything else — editor, renderer, sync server, web app, MCP server, layout | repo root | **[FSL-1.1-MIT](LICENSE.md)** |

## What that means in practice

- **You can always read, write and convert Orim files** — in your own
  tools, commercial or not, forever. The MIT parts are the interop
  surface, and they will never be re-licensed.
- **The application is source-available** under the
  [Functional Source License](LICENSE.md): use it freely for anything
  except offering a competing product, and each version becomes plain
  MIT two years after its release.
- **Never gated, in any edition:** viewing boards, commenting, and
  exporting your own data.

Enterprise features (OIDC SSO, the audit log, the admin console) are
licensed per server — see the [site](site/index.html) for the model.

Questions: alex@thedoidea.co
