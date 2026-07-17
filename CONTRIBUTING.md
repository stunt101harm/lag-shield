# Contributing

## Prerequisites

- Node.js 24 LTS (Node.js 20.19+ is supported)
- pnpm 11
- Docker with Compose for local PostgreSQL

## Local checks

Run `pnpm check` before opening a pull request. It enforces formatting, linting,
typechecking, tests, and production builds across every workspace.

Keep strategy logic deterministic: inject clocks and identifiers, version formulas and
thresholds, and add replay fixtures for behavior changes. Never include secrets or wallet
material in tests.
