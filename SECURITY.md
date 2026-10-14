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
