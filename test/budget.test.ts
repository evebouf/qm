import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBudgetTracker,
  createModelUsageMeter,
  estimateCostUsd,
  priceModelUsage,
} from "../src/ratelimit/budget.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../src/model/pi-models.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("budget tracker accumulates per-principal and trips at the limit", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 60_000 });
  assert.equal((await b.check("U1")).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U2", 1000)).allowed, true);
  assert.equal((await b.check("U1", 1000 + 61_000)).allowed, true);
});

test("caps are opt-in: an unconfigured tracker never refuses, a configured one does", async () => {
  const unbounded = createBudgetTracker();
  await unbounded.record("U1", 1_000_000);
  assert.equal((await unbounded.check("U1")).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createBudgetTracker({ limitUsd: 25 });
  await capped.record("U1", 26);
  assert.equal((await capped.check("U1")).allowed, false);
  assert.equal(estimateCostUsd(1000) > 0, true);
  assert.equal(estimateCostUsd(1_000_000), DEFAULT_AGENT_INPUT_USD_PER_MTOK);
});

test("the org cap holds across principals", async () => {
  const b = createBudgetTracker({ limitUsd: 100, orgLimitUsd: 1, windowMs: 60_000 });
  await b.record("U1", 0.6, 1000);
  await b.record("U2", 0.6, 1000);
  assert.equal((await b.check("U3", 1000)).allowed, false);
});

test("pricing includes output and cache rates and rejects invalid or unknown inputs", () => {
  const priced = priceModelUsage("claude-haiku-4-5", {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  });
  assert.equal(priced.priced, true);
  assert.equal(priced.priced && priced.costUsd > estimateCostUsd(1_000_000), true);
  assert.deepEqual(priceModelUsage("missing-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), {
    priced: false,
    reason: "pricing is unavailable for model missing-model",
  });
  assert.equal(
    priceModelUsage("claude-haiku-4-5", { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }).priced,
    false,
  );
  assert.deepEqual(priceModelUsage("missing-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0), {
    priced: true,
    costUsd: 0,
    basis: "provider_reported",
  });
});

test("reservations settle both upward and downward exactly once", async () => {
  const b = createBudgetTracker({ limitUsd: 10, windowMs: 60_000 });
  await b.reserve({ operationId: "down", principalId: "U1", model: "m", reservedUsd: 4, now: 1000 });
  await b.settle({ operationId: "down", principalId: "U1", model: "m", settledUsd: 1, now: 1100 });
  assert.equal((await b.check("U1", 1100)).spentUsd, 1);
  await b.settle({ operationId: "down", principalId: "U1", model: "m", settledUsd: 1, now: 1200 });
  await b.reserve({ operationId: "up", principalId: "U1", model: "m", reservedUsd: 1, now: 1200 });
  await b.settle({ operationId: "up", principalId: "U1", model: "m", settledUsd: 5, now: 1300 });
  assert.equal((await b.check("U1", 1300)).spentUsd, 6);
  await assert.rejects(
    b.settle({ operationId: "up", principalId: "U1", model: "m", settledUsd: 6 }),
    /settlement conflict/,
  );
});

test("reservation identity is idempotent while crash residue expires at its original window", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 1000 });
  const request = { operationId: "attempt-1:0", principalId: "U1", model: "m", reservedUsd: 1 };
  assert.equal((await b.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await b.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await b.check("U1", 1000)).spentUsd, 1);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U1", 2001)).allowed, true);
  await assert.rejects(b.reserve({ ...request, model: "other", now: 1000 }), /identity conflict/);
});

test("scoped meter refuses unknown pricing before recording a free guess", async () => {
  const b = createBudgetTracker({ limitUsd: 1 });
  const meter = createModelUsageMeter(b, "U1", "attempt")!;
  await assert.rejects(meter.reserve("missing-model", 100), /unpriced model request/);
  assert.equal((await b.check("U1")).spentUsd, 0);
});

test("a principal over budget is refused by the app", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-bud-")),
    budgetUsdPerWindow: 0.00001,
  });
  const { app } = buildApp(config);
  const dm = (text: string): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
  });

  const first = await app.turn(dm("hello"));
  assert.equal(first.status, "ok");
  const second = await app.turn(dm("again"));
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /budget exceeded/);
});
