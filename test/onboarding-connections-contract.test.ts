import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROACTIVE_OPENER_PROMPT } from "../src/onboarding/onboarding.ts";

const onboarding = readFileSync("plugins/onboarding/skills/onboarding/SKILL.md", "utf8");
const composio = readFileSync("skills-seed/composio/SKILL.md", "utf8");
const connectApps = readFileSync("skills-seed/connect-apps/SKILL.md", "utf8");

test("onboarding offers the starter apps immediately, without an app-selection round trip", () => {
  assert.match(onboarding, /Gmail, Google Drive, Google Calendar, and Slack/);
  assert.match(onboarding, /first response, including the automatic greeting/);
  assert.match(onboarding, /Do not ask which apps they use/);
  assert.match(PROACTIVE_OPENER_PROMPT, /prepare the available starter connection links in this first response/);
  assert.doesNotMatch(onboarding, /ask which available services they use/);
});

test("connection offers preserve consent, existing accounts, and provider boundaries", () => {
  assert.match(onboarding, /one Google Workspace link/);
  assert.match(onboarding, /not four required connections/);
  assert.match(onboarding, /never switch credentials to evade a denial/);
  assert.match(composio, /onboarding's initial connection offer/);
  assert.match(composio, /they perform consent themselves/);
});

test("access skills specify chip-safe Markdown rather than raw URLs", () => {
  for (const skill of [composio, connectApps]) {
    assert.match(skill, /standalone Markdown links/);
    assert.match(skill, /no bullets, numbering, tables/);
    assert.match(skill, /blank line/);
  }
});
