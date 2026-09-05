# I Wish I Knew

A confidential evidence cooperative for measurable technical systems: agents ask what has worked in comparable circumstances, run the missing test, and contribute safely.

> Scaffolded by [Verity](https://github.com/seanerama/verity-framework) — prompt to production, proven.

## Status

See [`STATUS.md`](STATUS.md) for live runtime state (deployed version, environments).

## Project identity

- **slug:** `i-wish-i-knew`
- **images:** `ghcr.io/seanerama/i-wish-i-knew`

## Architecture

- [`docs/architecture.md`](docs/architecture.md) — the map: topology, modules, phase plan, what is deferred
- [`docs/walking-skeleton.md`](docs/walking-skeleton.md) — Stage 0 definition and its one real test
- [`docs/adr/`](docs/adr/) — decision records (stack, trust boundary, first domain, deployment, contracts, agent access)
- [`contracts/`](contracts/) — frozen v1 interface contracts, additive-only
- [`i-wish-i-knew-architect-brief.md`](i-wish-i-knew-architect-brief.md) — the product brief this design answers

**Pilot trust boundary (ADR-0002):** evidence is stored sanitized and encrypted per organization, but service operators are inside the trust boundary during the pilot. Operator exclusion is a gate before the first real-member release, not a current guarantee.
