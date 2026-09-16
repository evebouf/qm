import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createExecFileOps } from "../src/sandbox/exec-file-ops.ts";
import type { SkillFile, SkillResolution } from "../src/skills/skill-store.ts";
import {
  createSkillMaterializer,
  materializeSkillIndex,
  materializeSkillTree,
  safeSkillDirName,
  skillInstructions,
} from "../src/skills/materialize.ts";
import { computeBundleHash, type SkillBundle } from "../src/skills/skill-bundle-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function res(name: string, body: string, files: SkillFile[] = [], packId?: string): SkillResolution {
  return {
    skill: {
      manifest: { name, body, files },
      ...(packId ? { pack: { packId, commit: "c", upstreamName: name } } : {}),
    },
    shadowed: [],
  } as unknown as SkillResolution;
}

function bundle(packId: string, files: SkillFile[]): SkillBundle {
  return { packId, commit: "c", files, hash: computeBundleHash(files) };
}

function fakeSandbox() {
  const files = new Map<string, string>();
  const calls = { reads: 0, writes: 0, removes: 0 };
  const sandbox = {
    async readFile(_h: SandboxHandle, rel: string) {
      calls.reads++;
      return files.has(rel) ? files.get(rel)! : null;
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      calls.writes++;
      files.set(rel, data);
    },
    async removeDir(_h: SandboxHandle, rel: string) {
      calls.removes++;
      for (const k of files.keys()) if (k === rel || k.startsWith(`${rel}/`)) files.delete(k);
    },
  } as unknown as Sandbox;
  return { sandbox, files, calls };
}

async function filesystemSandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "qm-skills-'"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handle = { id: root, rootDir: join(root, "workspace") };
  const checkout = join(root, "checkout");
  await mkdir(handle.rootDir);
  await mkdir(checkout);
  const exec = promisify(execFile);
  const sandbox = {
    ...createExecFileOps({
      label: "test",
      exec: async (_id, script) => ({ ...(await exec("sh", ["-c", script])), code: 0 }),
      writeInline: async (_id, path, data) => writeFile(path, data),
    }),
    async readFile(handle: SandboxHandle, path: string) {
      try {
        return await readFile(join(handle.rootDir, path), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeFile(handle: SandboxHandle, path: string, data: string) {
      const absolute = join(handle.rootDir, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, data);
    },
  } as unknown as Sandbox;
  return { sandbox, handle, checkout };
}

for (const link of ["skills/alpha", "skills/alpha/nested", "skills/.packs/p", "skills/.packs/p/other"]) {
  test(`reconciliation refuses cleanup through ${link} and preserves the checkout`, async (t) => {
    const { sandbox, handle, checkout } = await filesystemSandbox(t);
    const materializer = createSkillMaterializer();
    const alpha = res("alpha", "body", [{ path: "nested/asset.txt", content: "asset" }], "p");
    const bundles = [bundle("p", [{ path: "other/asset.txt", content: "shared asset" }])];
    await materializer.stage(
      sandbox,
      handle,
      ["alpha"],
      async () => [alpha],
      async () => bundles,
    );
    const marker = JSON.parse((await sandbox.readFile(handle, "skills/alpha/.tree"))!);
    marker.skillPaths.push("skills/alpha/nested/SKILL.md");
    marker.bundlePaths.push("skills/.packs/p/other/SKILL.md");
    await sandbox.writeFile(handle, "skills/alpha/.tree", JSON.stringify(marker));
    await writeFile(join(checkout, "SKILL.md"), "checkout instructions");
    await mkdir(join(checkout, "other"));
    await writeFile(join(checkout, "other/SKILL.md"), "nested checkout instructions");
    const index = await sandbox.readFile(handle, "skills/.index");
    await rm(join(handle.rootDir, link), { recursive: true });
    await symlink(checkout, join(handle.rootDir, link));
    alpha.skill!.manifest.body = "updated body";

    await assert.rejects(
      () =>
        materializer.stage(
          sandbox,
          handle,
          [],
          async () => [alpha],
          async () => bundles,
        ),
      /refusing to remove through symlink/,
    );
    assert.equal(await readFile(join(checkout, "SKILL.md"), "utf8"), "checkout instructions");
    assert.equal(await readFile(join(checkout, "other/SKILL.md"), "utf8"), "nested checkout instructions");
    assert.equal(await sandbox.readFile(handle, "skills/.index"), index);
  });
}

test("materialized skill directory names are validated and never lossy", () => {
  assert.equal(safeSkillDirName("foo-bar_v1.2"), "foo-bar_v1.2");
  assert.throws(() => safeSkillDirName("foo/bar"), /skill name must/);
  assert.throws(() => safeSkillDirName(".."), /skill name must/);
});

test("materializeSkillIndex writes only metadata, without instructions or assets", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A"), res("beta", "B")]);

  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  assert.equal(files.has("skills/beta/SKILL.md"), false);
  assert.ok(files.has("skills/.index"), "an index marker is written");
  assert.equal(calls.writes, 1, "only metadata is written");
});

test("materializeSkillIndex does NOT lay a skill's asset tree", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [
    res("gamma", "G", [{ path: "scripts/hello.py", content: "print('hi')" }]),
  ]);

  assert.equal(files.has("skills/gamma/SKILL.md"), false);
  assert.equal(
    files.has("skills/gamma/scripts/hello.py"),
    false,
    "the asset is NOT laid without an explicit dependency",
  );
});

test("materializeSkillIndex SKIPS when the body set is unchanged (order-independent)", async () => {
  const { sandbox, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A"), res("beta", "B")]);
  const writes = calls.writes;

  await materializeSkillIndex(sandbox, handle, [res("beta", "B"), res("alpha", "A")]);
  assert.equal(calls.writes, writes, "no rewrite on a matching body set");
});

test("materializeSkillIndex re-lays when a body changes", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A")]);
  const writes = calls.writes;
  await materializeSkillIndex(sandbox, handle, [res("alpha", "A2")]);
  assert.ok(calls.writes > writes, "a changed body busts the index marker");
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
});

test("materializeSkillIndex does NOT re-lay when only an asset changes (asset is not in the index hash)", async () => {
  const { sandbox, calls } = fakeSandbox();
  await materializeSkillIndex(sandbox, handle, [res("gamma", "G", [{ path: "s.py", content: "v1" }])]);
  const writes = calls.writes;
  await materializeSkillIndex(sandbox, handle, [res("gamma", "G", [{ path: "s.py", content: "v2" }])]);
  assert.equal(calls.writes, writes, "asset-only change doesn't touch the visibility index");
});

test("materializeSkillIndex removes an archived skill's materialized tree", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const alpha = res("alpha", "A", [{ path: "asset.txt", content: "asset" }]);
  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [bundle("p", [{ path: "lib/alpha.mjs", content: "shared" }])]);

  await materializeSkillIndex(sandbox, handle, []);
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  assert.equal(files.has("skills/alpha/asset.txt"), false);
  assert.equal(files.has("lib/alpha.mjs"), false);

  const removes = calls.removes;
  await materializeSkillIndex(sandbox, handle, []);
  assert.equal(calls.removes, removes, "the reconciled marker makes the next pass idempotent");
});

test("materializeSkillIndex migrates a legacy hash marker without retaining old skill paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  await materializeSkillIndex(sandbox, handle, [alpha]);
  const state = JSON.parse(files.get("skills/.index")!) as { hash: string };
  files.set("skills/.index", state.hash);
  files.set("skills/removed/SKILL.md", "removed");
  files.set("skills/removed/asset.txt", "stale");

  await materializeSkillIndex(sandbox, handle, [alpha]);
  assert.equal(files.has("skills/removed/SKILL.md"), false);
  assert.equal(files.has("skills/removed/asset.txt"), false);
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  const migrated = JSON.parse(files.get("skills/.index")!);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.legacyExternalPathsPreserved, true);
});

test("legacy migration cleans the managed skills namespace but preserves unknown external files", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const currentBundle = bundle("p", [{ path: "lib/current.mjs", content: "current" }]);
  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [currentBundle]);
  const index = JSON.parse(files.get("skills/.index")!) as { hash: string };
  files.set("skills/.index", index.hash);
  files.set("skills/removed/stale.txt", "provably managed");
  files.set("skills/.packs/p/lib/current.mjs", "stale known content");
  files.set("lib/unknown-pre-v1.mjs", "ownership unknowable");

  await materializeSkillIndex(sandbox, handle, [alpha]);
  await materializeSkillTree(sandbox, handle, alpha, [currentBundle]);
  assert.equal(files.has("skills/removed/stale.txt"), false);
  assert.equal(
    files.get("skills/.packs/p/lib/current.mjs"),
    "current",
    "the current bundle proves ownership and is reconciled",
  );
  assert.equal(files.get("lib/unknown-pre-v1.mjs"), "ownership unknowable");
  assert.equal(JSON.parse(files.get("skills/.index")!).legacyExternalPathsPreserved, true);

  await materializeSkillIndex(sandbox, handle, [res("alpha", "A2")]);
  assert.equal(
    JSON.parse(files.get("skills/.index")!).legacyExternalPathsPreserved,
    true,
    "the incomplete legacy inventory is never silently declared complete",
  );
});

test("materializeSkillTree lays the asset tree + a per-skill marker", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "scripts/hello.py", content: "print('hi')", executable: true },
      { path: "references/notes.md", content: "# notes" },
    ]),
  );

  assert.equal(files.has("skills/gamma/SKILL.md"), false);
  assert.equal(files.get("skills/gamma/scripts/hello.py"), "print('hi')");
  assert.equal(files.get("skills/gamma/references/notes.md"), "# notes");
  assert.ok(files.has("skills/gamma/.tree"), "a per-skill tree marker is written");
});

test("materializeSkillTree records and skips a clean body-only tree", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("alpha", "A"));
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  assert.equal(files.has("skills/alpha/.tree"), true);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("alpha", "A"));
  assert.equal(calls.writes, writes);
});

test("materializeSkillTree SKIPS when the tree is unchanged", async () => {
  const { sandbox, calls } = fakeSandbox();
  const skill = res("gamma", "G", [{ path: "s.py", content: "v1" }]);
  await materializeSkillTree(sandbox, handle, skill);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));
  assert.equal(calls.writes, writes, "no rewrite when the tree is identical");
});

test("materializeSkillTree re-lays when an asset changes, and clears a removed asset", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  const writes = calls.writes;

  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "a.py", content: "A2" }]));
  assert.ok(calls.writes > writes, "a changed tree re-lays");
  assert.equal(files.get("skills/gamma/a.py"), "A2");
  assert.equal(files.has("skills/gamma/b.py"), false, "a removed asset is cleared (dir cleared before re-lay)");
});

test("materializeSkillTree migrates a legacy hash marker by clearing stale pre-upgrade assets", async () => {
  const { sandbox, files } = fakeSandbox();
  const before = res("gamma", "G", [{ path: "old.py", content: "old" }]);
  await materializeSkillTree(sandbox, handle, before);
  const state = JSON.parse(files.get("skills/gamma/.tree")!) as { hash: string };
  files.set("skills/gamma/.tree", state.hash);
  files.set("skills/gamma/untracked.py", "stale");

  await materializeSkillTree(sandbox, handle, res("gamma", "G2", [{ path: "new.py", content: "new" }]));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.has("skills/gamma/untracked.py"), false);
  assert.equal(files.get("skills/gamma/new.py"), "new");
  assert.equal(JSON.parse(files.get("skills/gamma/.tree")!).version, 2);
});

test("materializeSkillTree clears stale assets when its marker was deleted", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "old.py", content: "old" }]));
  files.delete("skills/gamma/.tree");

  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "new.py", content: "new" }]));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.get("skills/gamma/new.py"), "new");
});

test("materializeSkillTree clears stale assets after marker deletion when the skill becomes body-only", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "old.py", content: "old" }]));
  files.delete("skills/gamma/.tree");

  await materializeSkillTree(sandbox, handle, res("gamma", "G"));
  assert.equal(files.has("skills/gamma/old.py"), false);
  assert.equal(files.has("skills/gamma/SKILL.md"), false);
  assert.equal(files.has("skills/gamma/.tree"), true);
});

test("materializeSkillTree SKIPS when only file ordering differs", async () => {
  const { sandbox, calls } = fakeSandbox();
  const a: SkillFile = { path: "a.py", content: "A" };
  const b: SkillFile = { path: "b.py", content: "B" };
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [a, b]));
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [b, a]));
  assert.equal(calls.writes, writes, "reordered files are the same set — no rewrite");
});

test("materialization serializes concurrent mutations for the same sandbox handle", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));
  const originalWrite = sandbox.writeFile.bind(sandbox);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  sandbox.writeFile = async (h, path, data) => {
    if (path === "skills/gamma/s.py" && data === "v2") {
      entered();
      await unblocked;
    }
    await originalWrite(h, path, data);
  };

  const second = materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v2" }]));
  await blocked;
  const readsWhileBlocked = calls.reads;
  const third = materializeSkillTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v3" }]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    calls.reads,
    readsWhileBlocked,
    "the later mutation has not probed stale state while the first is in flight",
  );
  release();
  await Promise.all([second, third]);
  assert.equal(files.get("skills/gamma/s.py"), "v3", "invocation order determines the final tree");
});

test("fleet lock serializes materializers from separate process instances", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const fleetLock = createMemoryAdvisoryLock();
  const instanceA = createSkillMaterializer(fleetLock);
  const instanceB = createSkillMaterializer(fleetLock);
  await instanceA.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v1" }]));

  const originalWrite = sandbox.writeFile.bind(sandbox);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  sandbox.writeFile = async (h, path, data) => {
    if (path === "skills/gamma/s.py" && data === "v2") {
      entered();
      await unblocked;
    }
    await originalWrite(h, path, data);
  };

  const oldLay = instanceA.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v2" }]));
  await blocked;
  const readsWhileBlocked = calls.reads;
  const newLay = instanceB.materializeTree(sandbox, handle, res("gamma", "G", [{ path: "s.py", content: "v3" }]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    calls.reads,
    readsWhileBlocked,
    "the second process cannot probe while the first process mutates the projection",
  );

  release();
  await Promise.all([oldLay, newLay]);
  assert.equal(files.get("skills/gamma/s.py"), "v3");
});

test("fresh reconciliation prevents an older turn from regressing a newer projection", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const fleetLock = createMemoryAdvisoryLock();
  const newerTurn = createSkillMaterializer(fleetLock);
  const olderTurn = createSkillMaterializer(fleetLock);
  const current = res("gamma", "G3", [{ path: "s.py", content: "v3" }]);

  await newerTurn.materializeIndex(sandbox, handle, [current], async () => [current]);
  await newerTurn.materializeTree(sandbox, handle, current, [], async () => ({ resolution: current, bundles: [] }));
  const removes = calls.removes;

  await olderTurn.materializeIndex(sandbox, handle, [], async () => [current]);
  await olderTurn.materializeTree(
    sandbox,
    handle,
    res("gamma", "G2", [{ path: "s.py", content: "v2" }]),
    [],
    async () => ({ resolution: current, bundles: [] }),
  );

  assert.equal(files.has("skills/gamma/SKILL.md"), false);
  assert.equal(files.get("skills/gamma/s.py"), "v3");
  assert.equal(calls.removes, removes, "the stale empty index does not delete the current skill tree");
});

test("materializeSkillTree confines a pack's shared bundle below its pack root", async () => {
  const { sandbox, files } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gmail", "G", [], "s1"), [
    bundle("s1", [
      { path: "lib/cite.mjs", content: "cite" },
      { path: "skills/conventions/quality.md", content: "q" },
    ]),
  ]);
  assert.equal(files.has("skills/gmail/SKILL.md"), false);
  assert.match(skillInstructions(res("gmail", "G", [], "s1")), /skills\/\.packs\/s1/);
  assert.equal(files.get("skills/.packs/s1/lib/cite.mjs"), "cite");
  assert.equal(files.get("skills/.packs/s1/skills/conventions/quality.md"), "q");
  assert.equal(files.get("lib/cite.mjs"), undefined, "pack bytes never overwrite the workspace root");
});

test("materializeSkillTree never lays bundle content over core marker paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const beta = res("beta", "B");
  await materializeSkillIndex(sandbox, handle, [alpha, beta]);
  files.set("keep.txt", "valuable");
  const forged = JSON.stringify({
    version: 1,
    hash: "forged",
    skillPaths: ["skills/alpha/SKILL.md"],
    bundlePaths: ["keep.txt"],
  });

  await materializeSkillTree(sandbox, handle, beta, [
    bundle("evil", [
      { path: "skills/.index", content: forged },
      { path: "skills/alpha/.tree", content: forged },
    ]),
  ]);
  await materializeSkillTree(sandbox, handle, alpha);

  assert.equal(files.get("keep.txt"), "valuable");
  assert.notEqual(files.get("skills/.index"), forged);
  assert.notEqual(files.get("skills/alpha/.tree"), forged);
});

test("materializeSkillTree never trusts a pre-hardening JSON delete manifest", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  await materializeSkillIndex(sandbox, handle, [alpha]);
  files.set("keep.txt", "valuable");
  files.set(
    "skills/alpha/.tree",
    JSON.stringify({
      version: 1,
      hash: "forged",
      skillPaths: ["skills/alpha/SKILL.md"],
      bundlePaths: ["keep.txt"],
    }),
  );

  await materializeSkillTree(sandbox, handle, alpha);

  assert.equal(files.get("keep.txt"), "valuable");
  assert.equal(JSON.parse(files.get("skills/alpha/.tree")!).version, 2);
});

test("materializeSkillTree re-lays when only a shared bundle file changes", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("gmail", "G"), [
    bundle("s1", [{ path: "lib/cite.mjs", content: "v1" }]),
  ]);
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("gmail", "G"), [
    bundle("s1", [{ path: "lib/cite.mjs", content: "v2" }]),
  ]);
  assert.ok(calls.writes > writes, "a changed shared file busts the tree key even when no asset changed");
  assert.equal(files.get("skills/.packs/s1/lib/cite.mjs"), "v2");
});

test("materializeSkillTree removes stale bundle paths but preserves another current owner's paths", async () => {
  const { sandbox, files } = fakeSandbox();
  const alpha = res("alpha", "A");
  const beta = res("beta", "B");
  await materializeSkillIndex(sandbox, handle, [alpha, beta]);
  await materializeSkillTree(sandbox, handle, beta, [
    bundle("shared-pack", [{ path: "lib/shared.mjs", content: "shared" }]),
  ]);
  await materializeSkillTree(sandbox, handle, alpha, [
    bundle("shared-pack", [
      { path: "lib/shared.mjs", content: "shared" },
      { path: "lib/stale.mjs", content: "stale" },
    ]),
  ]);

  await materializeSkillTree(sandbox, handle, alpha);
  assert.equal(
    files.get("skills/.packs/shared-pack/lib/shared.mjs"),
    "shared",
    "a current owner's claim protects the shared path",
  );
  assert.equal(files.has("skills/.packs/shared-pack/lib/stale.mjs"), false, "an unclaimed old bundle path is removed");
  assert.equal(files.has("skills/alpha/SKILL.md"), false);
  assert.equal(files.has("skills/alpha/.tree"), true, "the clean body-only projection remains idempotent");
});

test("a router-advertised importFiles the handle's backend refuses falls back to per-file writes", async () => {
  const { sandbox, files } = fakeSandbox();
  (sandbox as unknown as { importFiles: Sandbox["importFiles"] }).importFiles = async () => {
    throw new CapabilityUnsupportedError("local", "importFiles");
  };
  await materializeSkillTree(
    sandbox,
    handle,
    res("delta", "D", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  assert.equal(files.get("skills/delta/a.py"), "A");
  assert.equal(files.get("skills/delta/b.py"), "B");
});

test("materializeSkillTree uses importFiles (one batch) when the backend offers it", async () => {
  const { sandbox, files } = fakeSandbox();
  let batches = 0;
  (sandbox as unknown as { importFiles: Sandbox["importFiles"] }).importFiles = async (_h, entries) => {
    batches++;
    for (const e of entries) files.set(e.path, Buffer.from(e.data).toString("utf8"));
  };
  await materializeSkillTree(
    sandbox,
    handle,
    res("gamma", "G", [
      { path: "a.py", content: "A" },
      { path: "b.py", content: "B" },
    ]),
  );
  assert.equal(batches, 1, "the whole tree is laid in a single round-trip");
  assert.equal(files.get("skills/gamma/a.py"), "A");
  assert.equal(files.get("skills/gamma/b.py"), "B");
});

test("switching a same-named skill source removes prior private assets before any command", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  const privateSkill = res(
    "deploy",
    "Same instructions",
    [{ path: "private.txt", content: "PRIVATE_ASSET" }],
    "private-pack",
  );
  Object.assign(privateSkill.skill!, { id: "private", scopeId: "personal:U1" });
  const orgSkill = res("deploy", "Same instructions");
  Object.assign(orgSkill.skill!, { id: "public", scopeId: "org:acme" });
  await materializeSkillIndex(sandbox, handle, [privateSkill]);
  await materializeSkillTree(sandbox, handle, privateSkill, [
    bundle("private-pack", [{ path: "private-lib.txt", content: "PRIVATE_PACK" }]),
  ]);
  assert.ok([...files.values()].some((body) => body.includes("PRIVATE_ASSET")));
  assert.ok([...files.values()].some((body) => body.includes("PRIVATE_PACK")));
  await materializeSkillIndex(sandbox, handle, [orgSkill]);
  assert.equal(files.has("skills/deploy/SKILL.md"), false);
  assert.equal(
    [...files.values()].some((body) => body.includes("PRIVATE_ASSET") || body.includes("PRIVATE_PACK")),
    false,
  );
  const writes = calls.writes;
  await materializeSkillIndex(sandbox, handle, [orgSkill]);
  assert.equal(calls.writes, writes);
});

for (const [name, packId] of [
  ["alpha", "p"],
  ["SKILL.md", "SKILL.md"],
] as const) {
  test(`upgrading a version 2 inventory for ${name} removes all tracked instructions without dependencies`, async (t) => {
    const { sandbox, handle } = await filesystemSandbox(t);
    const materializer = createSkillMaterializer();
    const alpha = res(name, "new instructions", [{ path: "script.py", content: "new" }], packId);
    const beta = res("beta", "other instructions", [], packId);
    const dir = `skills/${name}`;
    const pack = `skills/.packs/${packId}`;
    const skillPaths = [
      `${dir}/SKILL.md`,
      `${dir}/nested/SKILL.md`,
      `${dir}/other/SKILL.md/child.txt`,
      `${dir}/script.py`,
    ];
    const bundlePaths = [`${pack}/SKILL.md`, `${pack}/other/SKILL.md`, `${pack}/other/asset.txt`];
    const index = {
      version: 2,
      hash: "pre-decoupling",
      names: [name, "beta", "revoked"],
      identities: Object.fromEntries(
        [alpha, beta].map((r) => [r.skill!.manifest.name, JSON.stringify([r.skill!.scopeId, r.skill!.id])]),
      ),
    };
    await sandbox.writeFile(handle, "skills/.index", JSON.stringify(index));
    await sandbox.writeFile(
      handle,
      `${dir}/.tree`,
      JSON.stringify({ version: 2, hash: "legacy-tree", skillPaths, bundlePaths }),
    );
    await sandbox.writeFile(
      handle,
      "skills/beta/.tree",
      JSON.stringify({ version: 2, hash: "legacy-tree", skillPaths: [], bundlePaths }),
    );
    const instructions = [
      `${dir}/SKILL.md`,
      `${dir}/nested/SKILL.md`,
      `${dir}/other/SKILL.md/child.txt`,
      `${pack}/SKILL.md`,
      `${pack}/other/SKILL.md`,
      "skills/beta/SKILL.md",
      "skills/revoked/SKILL.md",
    ];
    for (const path of instructions) await sandbox.writeFile(handle, path, "old instructions");
    await sandbox.writeFile(handle, `${dir}/script.py`, "cached copy");
    await sandbox.writeFile(handle, `${pack}/other/asset.txt`, "cached shared copy");
    await sandbox.writeFile(handle, "skills/revoked/script.py", "private asset");
    await sandbox.writeFile(handle, "untracked/SKILL.md", "unmanaged instructions");
    const reconcile = () =>
      materializer.stage(
        sandbox,
        handle,
        [],
        async () => [alpha, beta],
        async () => {
          throw new Error("no dependencies requested");
        },
      );
    await reconcile();
    const reconciledIndex = await sandbox.readFile(handle, "skills/.index");
    assert.notEqual(reconciledIndex, JSON.stringify(index));
    for (const path of [...instructions, `${dir}/SKILL.md`, "skills/revoked"])
      await assert.rejects(access(join(handle.rootDir, path)));
    assert.equal(await sandbox.readFile(handle, `${dir}/script.py`), "cached copy");
    assert.equal(await sandbox.readFile(handle, `${pack}/other/asset.txt`), "cached shared copy");
    assert.equal(await sandbox.readFile(handle, "untracked/SKILL.md"), "unmanaged instructions");
    const tree = JSON.parse((await sandbox.readFile(handle, `${dir}/.tree`))!);
    assert.deepEqual(tree.skillPaths, [`${dir}/script.py`]);
    assert.deepEqual(tree.bundlePaths, [`${pack}/other/asset.txt`]);
    assert.deepEqual(JSON.parse((await sandbox.readFile(handle, "skills/beta/.tree"))!).bundlePaths, tree.bundlePaths);
    const before = await sandbox.listDir(handle, "skills");
    await reconcile();
    assert.deepEqual(await sandbox.listDir(handle, "skills"), before);
    assert.equal(await sandbox.readFile(handle, "skills/.index"), reconciledIndex);
    await materializer.stage(
      sandbox,
      handle,
      [name],
      async () => [alpha, beta],
      async () => [],
    );
    assert.equal(await sandbox.readFile(handle, `${dir}/script.py`), "new");
  });
}

for (const [name, packId] of [
  ["alpha", "p"],
  ["SKILL.md", "p"],
  ["alpha", "SKILL.md"],
] as const) {
  test(`staging skill ${name} and pack ${packId} retains assets and excludes instruction paths`, async () => {
    const { sandbox, files, calls } = fakeSandbox();
    const assets = [
      { path: "SKILL.md", content: "forged instructions" },
      { path: "nested/SKILL.md", content: "nested instructions" },
      { path: "SKILL.md/child.txt", content: "instruction directory" },
      { path: "nested/SKILL.md/child.txt", content: "nested instruction directory" },
      { path: "asset.txt", content: "asset" },
      { path: "nested/asset.txt", content: "nested asset" },
      { path: "../escape", content: "unsafe" },
    ];
    const materializer = createSkillMaterializer();
    const alpha = res(name, "core body", assets, packId);
    const stage = () =>
      materializer.stage(
        sandbox,
        handle,
        [name],
        async () => [alpha],
        async () => [bundle(packId, assets)],
      );
    await stage();
    const skillPaths = [`skills/${name}/asset.txt`, `skills/${name}/nested/asset.txt`];
    const bundlePaths = [`skills/.packs/${packId}/asset.txt`, `skills/.packs/${packId}/nested/asset.txt`];
    assert.deepEqual(
      [...files.keys()].sort(),
      ["skills/.index", `skills/${name}/.tree`, ...skillPaths, ...bundlePaths].sort(),
    );
    for (const path of [...skillPaths, ...bundlePaths])
      assert.equal(files.get(path), path.endsWith("nested/asset.txt") ? "nested asset" : "asset");
    const marker = JSON.parse(files.get(`skills/${name}/.tree`)!);
    assert.deepEqual(marker.skillPaths, skillPaths);
    assert.deepEqual(marker.bundlePaths, bundlePaths);
    const writes = calls.writes;
    await stage();
    assert.equal(calls.writes, writes);
  });
}

test("an instruction-only edit preserves cached asset copies", async () => {
  const { sandbox, files, calls } = fakeSandbox();
  await materializeSkillTree(sandbox, handle, res("alpha", "body 1", [{ path: "template", content: "original" }]));
  files.set("skills/alpha/template", "edited copy");
  const writes = calls.writes;
  await materializeSkillTree(sandbox, handle, res("alpha", "body 2", [{ path: "template", content: "original" }]));
  assert.equal(files.get("skills/alpha/template"), "edited copy");
  assert.equal(calls.writes, writes);
});
