import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import type { Config } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp(extra: Partial<Config> = {}) {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-skill-")),
    ...extra,
  });
  return buildApp(config);
}

const actor = { externalId: "U1" };

async function publishPersonalSkill(skills: ReturnType<typeof buildApp>["skills"]) {
  const sk = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: {
      name: "make-digest",
      description: "assemble a morning digest",
      requiredCapabilities: [],
      body: "# make-digest\nStep 1: gather. Step 2: summarize.",
      files: [{ path: "template.txt", content: "digest template" }],
    },
    createdBy: "U1",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
}

test("a published personal skill is advertised and read directly in the owner's DM", async () => {
  const { app, skills, sandbox } = freshApp();
  const skill = await publishPersonalSkill(skills);
  const calls: string[] = [];
  sandbox.profileFor = undefined;
  Object.assign(
    sandbox,
    Object.fromEntries(
      Object.entries(sandbox)
        .filter(([, value]) => typeof value === "function")
        .map(([key]) => [
          key,
          async () => {
            calls.push(key);
            throw new Error(`unexpected sandbox call: ${key}`);
          },
        ]),
    ),
  );

  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(sys.reply ?? "", /## Skills/);
  assert.match(sys.reply ?? "", /make-digest/);

  const paths = [
    "skills/make-digest/SKILL.md",
    "./skills/make-digest/SKILL.md",
    "skills//make-digest/SKILL.md",
    "skills/make-digest/./SKILL.md",
    "././skills/make-digest/SKILL.md",
  ];
  const read = (path: string) =>
    app.turn({
      surface: "test",
      actor,
      conversation: { kind: "dm", threadRef: "dm:U1:t2" },
      text: `!read ${path}`,
    } as TurnRequest);
  for (const path of paths) assert.match((await read(path)).reply ?? "", /Step 1: gather/);
  await skills.update(skill.id, { ...skill.manifest, body: "Updated digest instructions" });
  await skills.review(skill.id, "U1", []);
  await skills.publish(skill.id);
  for (const path of paths) assert.equal((await read(path)).reply, "Updated digest instructions");
  await skills.archive(skill.id);
  for (const path of paths) assert.match((await read(path)).reply ?? "", /no file/);
  assert.deepEqual(calls, []);
  assert.ok((await skills.list()).find((skill) => skill.manifest.name === "make-digest")?.lastUsedAt);
});

test("a channel session does NOT see a personal skill (scope boundary)", async () => {
  const { app, skills } = freshApp();
  await publishPersonalSkill(skills);
  const sys = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);
  assert.doesNotMatch(sys.reply ?? "", /make-digest/);
});

test("the next provision reconciles the index after the last visible skill is archived", async () => {
  const { app, skills, sandbox } = freshApp();
  const skill = await publishPersonalSkill(skills);
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cleanup-1" },
    text: '!run {"command":"cat skills/make-digest/template.txt","skills":["make-digest"]}',
  } as TurnRequest);

  const removed: string[] = [];
  const originalRemove = sandbox.removeDir.bind(sandbox);
  sandbox.removeDir = async (handle, path) => {
    removed.push(path);
    await originalRemove(handle, path);
  };
  await skills.archive(skill.id);
  await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cleanup-2" },
    text: "!read missing.txt",
  } as TurnRequest);

  assert.ok(removed.some((path) => path === "skills/make-digest" || path.startsWith("skills/make-digest/")));
});

test("sandbox setup materializes neither skill instructions nor unrequested assets", async () => {
  const { app, skills, sandbox } = freshApp();
  await publishPersonalSkill(skills);
  const written: string[] = [];
  const write = sandbox.writeFile.bind(sandbox);
  sandbox.writeFile = async (handle, path, data) => {
    written.push(path);
    await write(handle, path, data);
  };
  const imported = sandbox.importFiles?.bind(sandbox);
  if (imported)
    sandbox.importFiles = async (handle, files) => {
      written.push(...files.map((file) => file.path));
      await imported(handle, files);
    };
  const result = await app.turn({
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:empty-box" },
    text: "!run echo ready",
  } as TurnRequest);
  assert.equal(result.reply, "ready");
  assert.equal(
    written.some((path) => path.startsWith("skills/make-digest/")),
    false,
  );
  assert.ok(written.includes("skills/.index"));
});

for (const target of ["scratch", "named"] as const) {
  test(`the full turn stages requested assets on its ${target} sandbox`, async () => {
    const { app, skills, sandbox, sandboxResources } = freshApp({ sandboxResourcesEnabled: target === "named" });
    await publishPersonalSkill(skills);
    const conversation = { kind: "dm" as const, threadRef: `dm:U1:${target}-assets` };
    const read = await app.turn({
      surface: "test",
      actor,
      conversation,
      text: "!read skills/make-digest/SKILL.md",
    } as TurnRequest);
    assert.match(read.reply ?? "", /Step 1: gather/);
    const resource =
      target === "named" ? await sandboxResources.create("U1", "personal:U1", "sprites", "skill-assets") : undefined;
    const handles: Array<{ scratch?: boolean; resourceId?: string }> = [];
    const run = sandbox.run.bind(sandbox);
    sandbox.run = async (handle, command, opts) => {
      if (command.includes("cat skills/make-digest/template.txt")) handles.push(handle);
      return run(handle, command, opts);
    };
    const request = {
      command: "cat skills/make-digest/template.txt",
      skills: ["make-digest"],
      ...(resource ? { sandboxId: resource.id } : {}),
    };
    const result = await app.turn({
      surface: "test",
      actor,
      conversation,
      text: `${target === "scratch" ? "!scratch" : "!run"} ${JSON.stringify(request)}`,
    } as TurnRequest);
    assert.equal(result.reply, "digest template");
    assert.equal(handles.length, 1);
    if (target === "scratch") assert.equal(handles[0]!.scratch, true);
    else assert.equal(handles[0]!.resourceId, resource!.id);
  });
}
