# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.** Report them
privately via **GitHub Security Advisories** on this repository
(Security tab → Advisories → Report a vulnerability).

Please include: what you found, where (file/line or reproduction steps), and
the impact you believe it has. We aim to acknowledge reports within 7 days.

Do not publish personal contact details in reports, and do not include
credentials, tokens, or secrets in any report or proof of concept.

## Supported versions

v0 is experimental and supported on a **best-effort** basis. There are no
SLAs. Security fixes land as new commits/releases when feasible; there is no
backport policy at v0.

## Scope notes

- The MCP server logs to **stderr only**; stdout is reserved for MCP protocol
  frames. Never add `console.log` or direct stdout writes (enforced by the
  stdout-purity test).
- The widget renders attribute-reflected values via `textContent`, never
  `innerHTML`. Iframe embedding requires an explicit origin allowlist
  (default deny) and `sandbox="allow-scripts"` without `allow-same-origin`.
- v0 has no auth, no persistence beyond TTL memory, and no network egress —
  keep it that way in contributions unless a reviewed design says otherwise.

## Live layer scope (binding)

The Phase 4 live layer (local JSONL event sink, `agent-progress dashboard`,
`agent-progress events`, unofficial Hermes plugin) is a deliberate,
narrowly-scoped exception to the v0 "no persistence, no network" rule. The
following are binding:

- **No data leaves the machine.** The event sink is a local file; the
  dashboard and its SSE stream are localhost-only by design.
- The dashboard binds `127.0.0.1` only (first free port 17421–17430) and
  never listens on a routable address.
- Every `/api/*` endpoint requires a bearer token minted fresh on each
  launch (128-bit, cryptographically random). The token is printed to the
  terminal for the launching user, is never written to disk or logged, and
  dies with the process.
- CORS is restricted to literal loopback hosts.
- The event log lives in a `0700` directory as `0600` files; retention is
  7 days, automatic. Full purge: `rm -rf ~/.agent-progress`.
- **Threat model: single-user localhost.** No auth system, no accounts, no
  network egress. Do not expose the dashboard beyond loopback; it is not
  designed for multi-user or internet deployment, and contributions must
  not add listening sockets or outbound calls without a reviewed design.
