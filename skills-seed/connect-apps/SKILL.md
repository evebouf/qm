---
name: connect-apps
description: Connect an administrator-enabled SaaS app for a user with a one-time OAuth consent link.
---

## Connecting SaaS apps

Check the live credential inventory first. When an authorized Composio credential is
available, read `skills/composio/SKILL.md` and use its discovery and consent flow instead
of the direct OAuth flow below. An empty direct OAuth list or a native
`oauth_not_configured` error does not describe Composio availability. Preserve explicit
app restrictions and account permissions; never switch credentials to evade a denial.

When `$AGENT_OAUTH_CONSENT_TOKEN` is set you can help the user connect a SaaS app via a browser
consent link they tap — you never see or enter their password. The live Connected apps block is
the direct OAuth allowlist: offer direct OAuth links only for providers configured by the admin,
and offer no direct OAuth links when that list is empty. Mint a single-use link for the selected provider, then present the returned URL as described below:
curl -sS -X POST "$AGENT_API_URL/v1/connectors/oauth/consent/mint" \
      -H "X-Agent-Capability: $AGENT_OAUTH_CONSENT_TOKEN" -H 'content-type: application/json' \
-d '{"provider":"<configured-provider>"}'

- The response has `connectUrl` — give the user THAT exact URL (it is the full public tap-through
  link). Do NOT build it yourself or prepend `$AGENT_API_URL` — that private base isn't reachable
  from a browser.
- If mint returns `oauth_not_configured`, the native provider is not configured. Do not retry that
  direct OAuth path or re-send old links; this does not establish that every access path is unavailable.
- You cannot open the link yourself; relay the URL, tell them to tap Allow, then return. After they
  connect, the app's tools/skills work in your 1:1s with them.

## Present consent links

Use standalone Markdown links with short labels, such as
`[Connect Google Workspace](<connectUrl>)` and `[Connect Slack](<connectUrl>)`.
Put each link in its own paragraph, separated by a blank line, at the end of the
message: no bullets, numbering, tables, code fences, or surrounding labels like
`Google: [Connect](...)`. Put any explanation before the links. The web UI removes
these links from the prose and displays connection chips beneath it; on other surfaces
they remain readable links. Use the exact returned URL, not the literal placeholder,
and do not repeat it as a raw URL.

Mint once per provider. A Google Workspace link covers Gmail, Google Drive, and Google
Calendar together; explain that in the introduction rather than listing the same link
three times. Skip already connected providers unless the user requests another account
or reconnection. Only describe connections as successful after checking live status.
