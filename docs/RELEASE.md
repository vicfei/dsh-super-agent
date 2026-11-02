# Release process

Lessons absorbed from the dsh-weknora-ops publish postmortem (2026-11):
**verify the package offline, verify the account ahead of time, eliminate the
credential need** — OIDC where possible, config files over env vars, and when a
human must type a code, the human faces the terminal.

## One-time setup

1. First release of this package: publish manually from a local terminal
   (`npm publish --access public` → browser device-auth). The account+2FA chain
   is the risky part; the interactive path is the one that works.
2. Bind **Trusted Publishing (OIDC)** on npmjs.com: package settings →
   Trusted Publisher → repository `vicfei/dsh-super-agent`, workflow
   `publish.yml`. From then on, tags publish themselves — no tokens anywhere.
   The runner needs **node ≥ 22.14 and npm ≥ 11.5.1** (the workflow pins
   node 24 + npm@11): older npm silently publishes anonymously, which fails
   with a misleading E404 on the scoped PUT.
3. Keep 2FA at "require for write actions" (neither OIDC nor interactive
   local publish is affected).

## Every release

```
[pre-flight — offline, automatable]
 □ version bump in package.json + CHANGELOG note in the PR body
 □ CI green (tsc --noEmit + vitest, Node 20/22)
 □ npm pack --dry-run — review the file list for surprises
 □ clean-install smoke: npm i -g <tgz> in a temp dir, run the bin
 □ (first release on a new machine/account) npm publish --dry-run proves the
   credential chain before release day

[publish]
 ▶ default: git tag vX.Y.Z && git push origin vX.Y.Z → OIDC workflow publishes
 ▶ fallback: local interactive npm publish (browser device-auth + TOTP on site)

[verify — allow ~5 min; npm view showing 0.0.0-stage means processing, not failure]
 □ npm view @vicfei/dsh-super-agent version == expected
 □ npx -y -p @vicfei/dsh-super-agent dsh-super-agent tickets (clean dir)
 □ update external links (install lines in posts/READMEs move from
   "publishing" to the real version)

[security closeout]
 □ no token ever appeared in chat/logs — if one did, revoke and rotate
 □ 2FA settings are in the intended state
```

## npm-facts half-life

Token kinds, 2FA interactions, and classic-token availability change roughly
every six months. Spend five minutes re-testing the current reality before any
release; do not trust memory (the postmortem's most expensive lesson).
