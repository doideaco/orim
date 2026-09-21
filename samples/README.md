# Sample data

Drag any of these onto an Orim board to see import inference at work.
`packages/convert/scripts/check-samples.mjs` asserts each CSV infers the
intended diagram (run it from `packages/convert` with
`node --import tsx scripts/check-samples.mjs`).

| File | Infers | Why |
|---|---|---|
| `team.csv` / `team.xlsx` | Org chart | `Manager` values reference `Name` values |
| `service-deps.csv` | Dependency graph | `From`/`To` columns, `Label` → edge labels |
| `sprint.csv` | Kanban | `Status` is a low-cardinality grouping column |
| `roadmap-eu.csv` | Kanban | semicolon-delimited; groups by `Quarter` |
| `messy-quotes.csv` | Kanban | stress test: quoted commas, escaped quotes, embedded newlines |
| `customers.csv` | Table | all columns high-cardinality — no diagram signal |
| `q3-revenue.xlsx` | Kanban | real Excel file; groups by `Region`, labels by `Product` |
