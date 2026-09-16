import { CapabilityUnsupportedError, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { createHash } from "node:crypto";
import { safeSkillFilePath, type SkillFile, type SkillResolution } from "./skill-store.ts";
import type { SkillBundle } from "./skill-bundle-store.ts";
import { swallow } from "../util/errors.ts";
import { assertSafeSkillName, isSafeSkillName } from "./skill-name.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ScopeId } from "../types.ts";
import {
  isSkillMaterializationControlPath,
  SKILLS_DIR,
  SKILLS_INDEX_MARKER as INDEX_MARKER,
  SKILL_TREE_MARKER as TREE_MARKER,
} from "./materialization-paths.ts";

const SKILL_PACKS_DIR = `${SKILLS_DIR}/.packs`;
export { SKILLS_DIR } from "./materialization-paths.ts";

export interface SkillMaterializer {
  stage(
    sandbox: Sandbox,
    handle: SandboxHandle,
    names: string[],
    current: () => Promise<SkillResolution[]>,
    bundlesFor: (resolution: SkillResolution) => Promise<SkillBundle[]>,
  ): Promise<void>;
  materializeIndex(
    sandbox: Sandbox,
    handle: SandboxHandle,
    resolved: SkillResolution[],
    current?: () => Promise<SkillResolution[]>,
  ): Promise<void>;
  materializeTree(
    sandbox: Sandbox,
    handle: SandboxHandle,
    resolution: SkillResolution,
    bundles?: SkillBundle[],
    current?: () => Promise<{ resolution: SkillResolution; bundles: SkillBundle[] } | null>,
  ): Promise<void>;
}

function materializationKey(handle: SandboxHandle): string {
  const sandboxId = createHash("sha256").update(handle.id).update("\0").update(handle.rootDir).digest("hex");
  return `skills:projection:${sandboxId}`;
}

export function safeSkillDirName(name: string): string {
  return assertSafeSkillName(name);
}

function indexHash(resolved: SkillResolution[]): string {
  const h = createHash("sha256").update("assets-only\0");
  const entries = resolved
    .filter((r) => r.skill)
    .map((r) => `${r.skill!.manifest.name}\0${r.skill!.scopeId}\0${r.skill!.id}\0${skillInstructions(r)}`)
    .sort();
  for (const e of entries) {
    h.update(e);
    h.update("\n");
  }
  return h.digest("hex");
}

function treeHash(resolution: SkillResolution, bundles: SkillBundle[]): string {
  const m = resolution.skill!.manifest;
  const files = [...(m.files ?? [])]
    .map((f) => `${f.path}\0${f.content}\0${f.executable === true ? "1" : "0"}`)
    .sort()
    .join("\0");
  const folded = [...bundles]
    .map((b) => b.hash)
    .sort()
    .join("\0");
  return createHash("sha256").update("assets-only\0").update(files).update("\0").update(folded).digest("hex");
}

function packRoot(resolution: SkillResolution): string | null {
  return resolution.skill?.pack ? `${SKILL_PACKS_DIR}/${safeSkillDirName(resolution.skill.pack.packId)}` : null;
}

export function skillInstructions(resolution: SkillResolution): string {
  const body = resolution.skill!.manifest.body;
  const root = packRoot(resolution);
  return root
    ? `${body}\n\n## Pack files\nResolve repository-relative shared-file paths against \`${root}/\`; pack files never overwrite the workspace root.`
    : body;
}

interface LayEntry {
  path: string;
  content: string;
}

interface IndexMarkerState {
  version: 2;
  hash: string;
  names: string[];
  identities?: Record<string, string>;
  legacyExternalPathsPreserved?: true;
}

interface TreeMarkerState {
  version: 2;
  hash: string;
  skillPaths: string[];
  bundlePaths: string[];
}

function parsedMarker(raw: string | null): Record<string, unknown> | null {
  if (!raw?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.version === 2 && typeof parsed.hash === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function indexMarkerState(raw: string | null): IndexMarkerState | null {
  const parsed = parsedMarker(raw);
  if (
    !parsed ||
    !Array.isArray(parsed.names) ||
    !parsed.names.every((name) => typeof name === "string" && isSafeSkillName(name))
  )
    return null;
  return parsed as unknown as IndexMarkerState;
}

function isSafeMaterializedPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  try {
    return safeSkillFilePath(path) === path;
  } catch {
    return false;
  }
}

function treeMarkerState(raw: string | null, dir: string): TreeMarkerState | null {
  const parsed = parsedMarker(raw);
  if (!parsed || !Array.isArray(parsed.skillPaths) || !Array.isArray(parsed.bundlePaths)) return null;
  if (
    !parsed.skillPaths.every(
      (path) => isSafeMaterializedPath(path) && path.startsWith(`${dir}/`) && !isSkillMaterializationControlPath(path),
    )
  )
    return null;
  if (!parsed.bundlePaths.every((path) => isSafeMaterializedPath(path) && !isSkillMaterializationControlPath(path)))
    return null;
  return parsed as unknown as TreeMarkerState;
}

function samePaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

async function readMarker(
  sandbox: Sandbox,
  handle: SandboxHandle,
  path: string,
  label: string,
): Promise<string | null> {
  try {
    return await sandbox.readFile(handle, path);
  } catch (error) {
    swallow(label, error);
    return null;
  }
}

function isSkillInstructionPath(path: string): boolean {
  const parts = path.split("/");
  let namespaceLength = 0;
  if (parts[0] === SKILLS_DIR) namespaceLength = parts[1] === ".packs" ? 3 : 2;
  return parts.slice(namespaceLength).includes("SKILL.md");
}

function guardedAssetEntries(root: string, files: SkillFile[]): LayEntry[] {
  const entries: LayEntry[] = [];
  for (const file of files) {
    try {
      const path = `${root}/${safeSkillFilePath(file.path)}`;
      if (!isSkillMaterializationControlPath(path) && !isSkillInstructionPath(path))
        entries.push({ path, content: file.content });
    } catch (error) {
      swallow(`skills: bad asset path ${file.path}`, error);
    }
  }
  return entries;
}

async function layFiles(sandbox: Sandbox, handle: SandboxHandle, entries: LayEntry[]): Promise<void> {
  if (!entries.length) return;
  if (sandbox.importFiles) {
    try {
      await sandbox.importFiles(
        handle,
        entries.map((e) => ({ path: e.path, data: Buffer.from(e.content, "utf8") })),
      );
      return;
    } catch (err) {
      if (!(err instanceof CapabilityUnsupportedError)) throw err;
    }
  }
  for (const e of entries) await sandbox.writeFile(handle, e.path, e.content);
}

async function materializeSkillIndexUnlocked(
  sandbox: Sandbox,
  handle: SandboxHandle,
  resolved: SkillResolution[],
): Promise<void> {
  const want = indexHash(resolved);
  const names = resolved.flatMap((r) => (r.skill ? [safeSkillDirName(r.skill.manifest.name)] : [])).sort();
  const identities = Object.fromEntries(
    resolved.flatMap((r) =>
      r.skill ? [[safeSkillDirName(r.skill.manifest.name), JSON.stringify([r.skill.scopeId, r.skill.id])]] : [],
    ),
  );
  const raw = await readMarker(sandbox, handle, INDEX_MARKER, "skills: index probe");
  const prev = indexMarkerState(raw);
  if (prev?.hash === want && samePaths(prev.names, names)) return;
  const legacyExternalPathsPreserved = prev?.legacyExternalPathsPreserved === true || Boolean(raw && !prev);
  const entries: LayEntry[] = [];

  if (raw && !prev) {
    await sandbox.removeDir(handle, SKILLS_DIR);
  } else if (prev) {
    const unchangedNames = new Set(names.filter((name) => prev.identities?.[name] === identities[name]));
    const activeBundlePaths = new Set<string>();
    for (const name of unchangedNames) {
      const dir = `${SKILLS_DIR}/${name}`;
      const marker = `${dir}/${TREE_MARKER}`;
      const currentRaw = await readMarker(sandbox, handle, marker, `skills: tree probe ${name}`);
      const current = treeMarkerState(currentRaw, dir);
      const instructionPaths = new Set([
        `${dir}/SKILL.md`,
        ...[...(current?.skillPaths ?? []), ...(current?.bundlePaths ?? [])].filter(isSkillInstructionPath),
      ]);
      for (const path of instructionPaths) await sandbox.removeDir(handle, path);
      if (current) {
        const skillPaths = current.skillPaths.filter((path) => !isSkillInstructionPath(path));
        const bundlePaths = current.bundlePaths.filter((path) => !isSkillInstructionPath(path));
        for (const path of bundlePaths) activeBundlePaths.add(path);
        if (skillPaths.length !== current.skillPaths.length || bundlePaths.length !== current.bundlePaths.length)
          entries.push({ path: marker, content: JSON.stringify({ ...current, skillPaths, bundlePaths }) });
      }
    }
    for (const name of prev.names) {
      if (unchangedNames.has(name)) continue;
      const dir = `${SKILLS_DIR}/${name}`;
      const staleRaw = await readMarker(sandbox, handle, `${dir}/${TREE_MARKER}`, `skills: tree probe ${name}`);
      const stale = treeMarkerState(staleRaw, dir);
      const paths = new Set([`${dir}/SKILL.md`, ...(stale?.skillPaths ?? []), ...(stale?.bundlePaths ?? [])]);
      for (const path of paths) {
        if (!activeBundlePaths.has(path)) await sandbox.removeDir(handle, path);
      }
      const protectsDirectory = [...activeBundlePaths].some((path) => path.startsWith(`${dir}/`));
      if (protectsDirectory) await sandbox.removeDir(handle, `${dir}/${TREE_MARKER}`);
      else await sandbox.removeDir(handle, dir);
    }
  }

  entries.push({
    path: INDEX_MARKER,
    content: JSON.stringify({
      version: 2,
      hash: want,
      names,
      identities,
      ...(legacyExternalPathsPreserved ? { legacyExternalPathsPreserved: true as const } : {}),
    } satisfies IndexMarkerState),
  });
  await layFiles(sandbox, handle, entries);
}

async function materializeSkillTreeUnlocked(
  sandbox: Sandbox,
  handle: SandboxHandle,
  resolution: SkillResolution,
  bundles: SkillBundle[] = [],
): Promise<void> {
  if (!resolution.skill) return;
  const m = resolution.skill.manifest;
  const files = m.files ?? [];

  const dir = `${SKILLS_DIR}/${safeSkillDirName(m.name)}`;
  const marker = `${dir}/${TREE_MARKER}`;
  const want = treeHash(resolution, bundles);
  const skillEntries = guardedAssetEntries(dir, files);
  const bundleEntries = bundles.flatMap((bundle) =>
    guardedAssetEntries(`${SKILL_PACKS_DIR}/${safeSkillDirName(bundle.packId)}`, bundle.files),
  );
  const skillPaths = [...new Set(skillEntries.map((entry) => entry.path))].sort();
  const bundlePaths = [...new Set(bundleEntries.map((entry) => entry.path))].sort();
  const raw = await readMarker(sandbox, handle, marker, "skills: tree probe");
  const prev = treeMarkerState(raw, dir);
  if (prev?.hash === want && samePaths(prev.skillPaths, skillPaths) && samePaths(prev.bundlePaths, bundlePaths)) return;

  const otherBundlePaths = new Set<string>();
  const indexRaw = await readMarker(sandbox, handle, INDEX_MARKER, "skills: index probe");
  const index = indexMarkerState(indexRaw);
  for (const name of index?.names ?? []) {
    if (name === safeSkillDirName(m.name)) continue;
    const otherRaw = await readMarker(
      sandbox,
      handle,
      `${SKILLS_DIR}/${name}/${TREE_MARKER}`,
      `skills: tree probe ${name}`,
    );
    const other = treeMarkerState(otherRaw, `${SKILLS_DIR}/${name}`);
    for (const path of other?.bundlePaths ?? []) otherBundlePaths.add(path);
  }

  if (prev) {
    const currentSkillPaths = new Set(skillPaths);
    const currentBundlePaths = new Set(bundlePaths);
    for (const path of prev.skillPaths) {
      if (!currentSkillPaths.has(path) && !otherBundlePaths.has(path)) await sandbox.removeDir(handle, path);
    }
    for (const path of prev.bundlePaths) {
      if (!currentBundlePaths.has(path) && !otherBundlePaths.has(path)) await sandbox.removeDir(handle, path);
    }
  } else if (![...otherBundlePaths].some((path) => path.startsWith(`${dir}/`))) {
    await sandbox.removeDir(handle, dir);
  }

  const entries = [...skillEntries, ...bundleEntries];
  entries.push({
    path: marker,
    content: JSON.stringify({ version: 2, hash: want, skillPaths, bundlePaths } satisfies TreeMarkerState),
  });
  await layFiles(sandbox, handle, entries);
}

export function createSkillMaterializer(advisoryLock?: AdvisoryLock): SkillMaterializer {
  const queue = createKeyedQueue<string>();
  const locked = <T>(handle: SandboxHandle, fn: () => Promise<T>): Promise<T> => {
    const key = materializationKey(handle);
    return queue(key, () => advisoryLock?.withLock(key, fn) ?? fn());
  };
  return {
    stage(sandbox, handle, names, current, bundlesFor) {
      return locked(handle, async () => {
        if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
          throw new Error("skills must be an array of skill names");
        const resolved = await current();
        await materializeSkillIndexUnlocked(sandbox, handle, resolved);
        const requested = [...new Set(names)].map((name) => {
          assertSafeSkillName(name);
          const resolution = resolved.find((entry) => entry.skill?.manifest.name === name);
          if (!resolution) throw new Error(`skill is not visible on this turn: ${name}`);
          return resolution;
        });
        for (const resolution of requested)
          await materializeSkillTreeUnlocked(sandbox, handle, resolution, await bundlesFor(resolution));
      });
    },
    materializeIndex(sandbox, handle, resolved, current) {
      return locked(handle, async () => {
        const latest = current ? await current() : resolved;
        await materializeSkillIndexUnlocked(sandbox, handle, latest);
      });
    },
    materializeTree(sandbox, handle, resolution, bundles = [], current) {
      return locked(handle, async () => {
        const latest = current ? await current() : { resolution, bundles };
        if (latest) await materializeSkillTreeUnlocked(sandbox, handle, latest.resolution, latest.bundles);
      });
    },
  };
}

const localMaterializer = createSkillMaterializer();

export function materializeSkillIndex(
  sandbox: Sandbox,
  handle: SandboxHandle,
  resolved: SkillResolution[],
): Promise<void> {
  return localMaterializer.materializeIndex(sandbox, handle, resolved);
}

export function materializeSkillTree(
  sandbox: Sandbox,
  handle: SandboxHandle,
  resolution: SkillResolution,
  bundles: SkillBundle[] = [],
): Promise<void> {
  return localMaterializer.materializeTree(sandbox, handle, resolution, bundles);
}

export function skillsIndex(resolved: SkillResolution[], provenanceScopes: readonly ScopeId[] = []): string {
  const provenance = new Set(provenanceScopes);
  const items = resolved
    .filter((r) => r.skill)
    .sort((a, b) => {
      const [x, y] = [a.skill!.manifest.name, b.skill!.manifest.name];
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    });
  if (!items.length) return "";
  const lines = items.map((r) => {
    const m = r.skill!.manifest;
    const shadow = r.shadowed.length ? " (shadows a broader-scope skill of the same name)" : "";
    const source = provenance.has(r.skill!.scopeId) ? ` [from ${r.skill!.scopeId}]` : "";
    return `- **${m.name}**${source} — ${m.description}${shadow}  → read \`${SKILLS_DIR}/${safeSkillDirName(m.name)}/SKILL.md\``;
  });
  return [
    "## Skills",
    "Read a skill's SKILL.md first; core serves instructions without a sandbox. To use its scripts, templates, or assets, name it in the `skills` array on execute or start_process (sandbox actions exec or start_process). Only named skills are staged on the selected sandbox; reading instructions and mentioning paths in commands do not install files:",
    ...lines,
  ].join("\n");
}
