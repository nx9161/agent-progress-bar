# Contributing

Thanks for considering a contribution. This is a small, experimental,
open-source project — the bar is "clear, honest, and safe".

## Ground rules

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, …). One logical change per commit.
- **Pull requests, not direct pushes.** Keep PRs focused; describe what changed and why. A maintainer reviews every PR.
- **No credentials, ever.** None are needed for this project. Do not commit API keys, tokens, passwords, or any secrets — in code, config, docs, or examples.
- **No personal identifiers.** Don't add anyone's email, phone number, address, or other PII to the repo.
- **Honesty labels stay — and extend to every new surface.** The demo's
  "Concept demo — simulated run" labels and the README's hard truth are
  load-bearing. Any new user-visible surface (dashboard, Hermes plugin,
  future viewers) MUST carry the honesty substance in always-visible
  copy: "self-reported thinking", "estimates move", `null` ETA renders as
  "estimating…", and values are never fabricated. PRs that weaken any of
  these will not be merged.
- **Tests for behavior changes.** The MCP server has a stdout-purity test (`npm test`); keep it green and extend coverage when you change server behavior.

## DCO-lite

By submitting a pull request, you agree your contribution is licensed under
this repository's MIT license. You represent that you have the rights to make
the contribution and that it does not infringe any third-party IP, and you
grant users a royalty-free license to any patent claims necessarily infringed
by your contribution.

## Release checklist (maintainers)

1. Bump `CONTRACT_VERSION` in `packages/mcp-server/src/tools.ts` on any breaking tool/schema change.
2. Re-run `node scripts/build-demo.js` so `dist/index.html` matches the sources.
3. `npm audit --audit-level=high` runs in CI on every push/PR for both packages (see `.github/workflows/ci.yml`); do not merge with audit failures.
