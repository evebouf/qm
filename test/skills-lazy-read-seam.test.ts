import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext } from "../src/tools/primitives.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createSkillMaterializer } from "../src/skills/materialize.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function ctx() {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const scoped = { id: "scoped", rootDir: "/workspace" };
  const scratch = { id: "scratch", rootDir: "/workspace" };
  const named = { id: "named", rootDir: "/workspace" };
  const visible: SkillResolution[] = ["alpha", "beta"].map(
    (name) =>
      ({
        skill: {
          id: name,
          scopeId: "personal:U1",
          manifest: { name, body: `${name} instructions`, files: [{ path: "script.py", content: `${name} asset` }] },
        },
        shadowed: [],
      }) as unknown as SkillResolution,
  );
  const materializer = createSkillMaterializer();
  const sandbox = {
    async readFile(handle: SandboxHandle, path: string) {
      calls.push(`read:${handle.id}:${path}`);
      return files.get(`${handle.id}:${path}`) ?? null;
    },
    async writeFile(handle: SandboxHandle, path: string, content: string) {
      calls.push(`write:${handle.id}:${path}`);
      files.set(`${handle.id}:${path}`, content);
    },
    async removeDir(handle: SandboxHandle, path: string) {
      calls.push(`remove:${handle.id}:${path}`);
      const prefix = `${handle.id}:${path}`;
      for (const key of files.keys()) if (key === prefix || key.startsWith(`${prefix}/`)) files.delete(key);
    },
    async run(handle: SandboxHandle) {
      calls.push(`run:${handle.id}`);
      return { stdout: "ran", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const tc = createToolContext({
    sandbox,
    provision: async () => {
      calls.push("provision:scoped");
      return scoped;
    },
    provisionScratch: async () => {
      calls.push("provision:scratch");
      return scratch;
    },
    provisionResource: async () => {
      calls.push("provision:named");
      return named;
    },
    sandboxResources: {
      access: async (_actor: string, id: string) => {
        if (id !== "named") throw new Error("sandbox not accessible");
        return { ownerScopeId: "personal:U1" };
      },
    } as never,
    readSkill: async (name) => ({
      content: visible.find((r) => r.skill?.manifest.name === name)?.skill?.manifest.body ?? null,
      sourceScopeId: "personal:U1",
    }),
    prepareSkillAssets: (handle, names) =>
      materializer.stage(
        sandbox,
        handle,
        names,
        async () => visible,
        async () => [],
      ),
    backgroundBroker: {
      start: async (handle: SandboxHandle) => {
        calls.push(`start:${handle.id}`);
        return { processId: "p1", output: "ran", cursor: 0, status: { state: "running" }, reattached: false };
      },
    } as never,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  return { tc, calls, files, visible, sandbox };
}

for (const path of [
  "skills/alpha/SKILL.md",
  "./skills/alpha/SKILL.md",
  "skills//alpha/SKILL.md",
  "skills/alpha/./SKILL.md",
  "././skills/alpha/SKILL.md",
  "././/skills///alpha/././SKILL.md",
]) {
  test(`reading ${path} serves instructions with zero sandbox calls`, async () => {
    const { tc, calls, files, visible } = ctx();
    assert.equal((await tc.read(path)).content, "alpha instructions");
    visible[0]!.skill!.manifest.body = "updated instructions";
    assert.equal((await tc.read(path)).content, "updated instructions");
    assert.deepEqual(calls, []);
    assert.equal(files.size, 0);
  });

  test(`revoked instruction read ${path} never returns stale sandbox content`, async () => {
    const { tc, calls, files, visible } = ctx();
    assert.equal((await tc.read(path)).content, "alpha instructions");
    files.set("scoped:skills/alpha/SKILL.md", "stale instructions");
    files.set(`scoped:${path}`, "stale instructions");
    visible.length = 0;
    assert.equal((await tc.read(path)).content, null);
    assert.deepEqual(calls, []);
  });
}

for (const path of ["skills/../SKILL.md", "skills/alpha/../alpha/SKILL.md", "././skills/alpha/../../SKILL.md"]) {
  test(`instruction dispatch rejects traversal in ${path} without provisioning`, async () => {
    const { tc, calls } = ctx();
    await assert.rejects(() => tc.read(path), /parent traversal/);
    assert.deepEqual(calls, []);
  });
}

test("non-skill reads retain direct and fallback sandbox behavior without installing assets", async () => {
  const { tc, calls, files } = ctx();
  for (const path of ["skills/alpha/script.py", "reports/report.md"]) {
    files.set(`scoped:${path}`, "existing file");
    assert.equal((await tc.read(path)).content, "existing file");
  }
  assert.equal((await tc.read("missing.txt")).content, null);
  assert.equal(calls.filter((c) => c.startsWith("provision:")).length, 3);
  assert.equal(
    calls.some((c) => c.startsWith("write:")),
    false,
  );
});

for (const [target, opts] of [
  ["scoped", {}],
  ["scratch", { scratch: true }],
  ["named", { sandboxId: "named" }],
] as const) {
  test(`execute stages only explicit dependencies on the ${target} sandbox`, async () => {
    const { tc, calls, files } = ctx();
    await tc.execute("python script.py", { ...opts, skills: ["alpha", "alpha"] });
    assert.equal(files.get(`${target}:skills/alpha/script.py`), "alpha asset");
    assert.equal(
      [...files.keys()].some((p) => p.includes("SKILL.md") || p.includes("/beta/")),
      false,
    );
    assert.equal(
      [...files.keys()].every((p) => p.startsWith(`${target}:`)),
      true,
    );
    assert.equal(calls.at(-1), `run:${target}`);
  });
}

for (const sandboxId of [undefined, "named"]) {
  test(`background start stages explicit dependencies on ${sandboxId ?? "scoped"}`, async () => {
    const { tc, calls, files } = ctx();
    await tc.backgroundStart("python script.py", { sandboxId, skills: ["alpha"] });
    assert.equal(files.get(`${sandboxId ?? "scoped"}:skills/alpha/script.py`), "alpha asset");
    assert.equal(
      [...files.keys()].some((p) => p.includes("SKILL.md") || p.includes("/beta/")),
      false,
    );
    assert.equal(calls.at(-1), `start:${sandboxId ?? "scoped"}`);
  });
}

for (const background of [false, true]) {
  test(`${background ? "background" : "foreground"} command paths do not infer skill dependencies`, async () => {
    const { tc, files } = ctx();
    const command = "cd skills/alpha && python script.py && cat ./skills/beta/script.py";
    if (background) await tc.backgroundStart(command);
    else await tc.execute(command);
    assert.deepEqual([...files.keys()], ["scoped:skills/.index"]);
  });

  test(`${background ? "background" : "foreground"} rejects invalid or invisible dependencies before staging any`, async () => {
    for (const name of ["missing", "../alpha", "alpha/script.py", "", ".", "alpha\\bad"]) {
      const { tc, calls, files } = ctx();
      const opts = { skills: ["alpha", name] };
      await assert.rejects(() => (background ? tc.backgroundStart("true", opts) : tc.execute("true", opts)), /skill/);
      assert.deepEqual([...files.keys()], ["scoped:skills/.index"]);
      assert.equal(
        calls.some((c) => c.startsWith("run:") || c.startsWith("start:")),
        false,
      );
    }
  });

  test(`${background ? "background" : "foreground"} fails closed on copy errors`, async () => {
    const { tc, calls, sandbox } = ctx();
    sandbox.writeFile = async () => {
      throw new Error("copy failed");
    };
    await assert.rejects(
      () =>
        background ? tc.backgroundStart("true", { skills: ["alpha"] }) : tc.execute("true", { skills: ["alpha"] }),
      /copy failed/,
    );
    assert.equal(
      calls.some((c) => c.startsWith("run:") || c.startsWith("start:")),
      false,
    );
  });
}

test("explicit named staging preserves sandbox access checks", async () => {
  const { tc, files } = ctx();
  await assert.rejects(() => tc.execute("true", { sandboxId: "private", skills: ["alpha"] }), /not accessible/);
  await assert.rejects(() => tc.backgroundStart("true", { sandboxId: "private", skills: ["alpha"] }), /not accessible/);
  assert.equal(files.size, 0);
});

test("repeated explicit staging refreshes updates and removes deleted assets on the same turn", async () => {
  const { tc, files, visible, calls } = ctx();
  await tc.execute("true", { skills: ["alpha"] });
  files.set("scoped:skills/alpha/local.txt", "local copy");
  calls.length = 0;
  await tc.execute("true", { skills: ["alpha"] });
  assert.equal(
    calls.some((c) => c.startsWith("write:")),
    false,
  );
  visible[0]!.skill!.manifest.files = [{ path: "new.py", content: "new version" }];
  await tc.backgroundStart("true", { skills: ["alpha"] });
  assert.equal(files.has("scoped:skills/alpha/script.py"), false);
  assert.equal(files.get("scoped:skills/alpha/new.py"), "new version");
  assert.equal(files.get("scoped:skills/alpha/local.txt"), "local copy");
});

test("revocation cleans cached assets before a command without dependencies and blocks subsequent explicit staging", async () => {
  const { tc, files, visible } = ctx();
  await tc.execute("true", { skills: ["alpha"] });
  visible.shift();
  await tc.execute("cat skills/alpha/script.py");
  assert.equal(files.has("scoped:skills/alpha/script.py"), false);
  await assert.rejects(() => tc.backgroundStart("true", { skills: ["alpha"] }), /not visible/);
});
