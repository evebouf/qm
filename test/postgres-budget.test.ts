import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresBudgetTracker } from "../src/ratelimit/postgres-budget.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres budget tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS budget_operations CASCADE");
  await p.query("DROP TABLE IF EXISTS budget_spend CASCADE");
  await p.end();
});

test(
  "pg budget: spend is shared across trackers (instances), trips at the limit, and expires out of the window",
  { skip },
  async () => {
    const a = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });
    const b = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });

    assert.equal((await a.check("U1", 1000)).allowed, true);
    await a.record("U1", 0.6, 1000);
    assert.equal((await b.check("U1", 1000)).allowed, true, "under the cap is visible from another instance");
    await b.record("U1", 0.6, 1000);

    const tripped = await a.check("U1", 1000);
    assert.equal(tripped.allowed, false, "the cap holds fleet-wide, not per instance");
    assert.equal(tripped.spentUsd > 1, true);

    assert.equal((await a.check("U2", 1000)).allowed, true, "budgets are per-principal");
    assert.equal((await a.check("U1", 1000 + 61_000)).allowed, true, "spend outside the window no longer counts");
  },
);

test("pg budget: caps are opt-in — unconfigured allows, configured refuses", { skip }, async () => {
  const unbounded = createPostgresBudgetTracker(URL!);
  await unbounded.record("U1", 9_999, 1000);
  assert.equal((await unbounded.check("U1", 1000)).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createPostgresBudgetTracker(URL!, { limitUsd: 25 });
  const c = await capped.check("U1", 1000);
  assert.equal(c.allowed, false);
  assert.equal(c.spentUsd, 9_999);
});

test("pg budget: reservation survives tracker restart and settlement refunds or increases it", { skip }, async () => {
  const first = createPostgresBudgetTracker(URL!, { limitUsd: 10, windowMs: 60_000 });
  await first.reserve({ operationId: "crash:0", principalId: "U1", model: "m", reservedUsd: 4, now: 1000 });
  const restarted = createPostgresBudgetTracker(URL!, { limitUsd: 10, windowMs: 60_000 });
  assert.equal((await restarted.check("U1", 1000)).spentUsd, 4);
  await restarted.settle({ operationId: "crash:0", principalId: "U1", model: "m", settledUsd: 1, now: 1100 });
  assert.equal((await first.check("U1", 1100)).spentUsd, 1);
  await first.reserve({ operationId: "retry:0", principalId: "U1", model: "m", reservedUsd: 1, now: 1200 });
  await first.settle({ operationId: "retry:0", principalId: "U1", model: "m", settledUsd: 5, now: 1300 });
  assert.equal((await restarted.check("U1", 1300)).spentUsd, 6);
});

test("pg budget: operation replay is idempotent and conflicting reuse or settlement fails", { skip }, async () => {
  const a = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });
  const request = { operationId: "run:attempt:0", principalId: "U1", model: "m", reservedUsd: 1 };
  assert.equal((await a.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await a.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await a.check("U1", 1000)).spentUsd, 1);
  await assert.rejects(a.reserve({ ...request, model: "other", now: 1000 }), /identity conflict/);
  await a.settle({ operationId: request.operationId, principalId: "U1", model: "m", settledUsd: 0.5 });
  await a.settle({ operationId: request.operationId, principalId: "U1", model: "m", settledUsd: 0.5 });
  await assert.rejects(
    a.settle({ operationId: request.operationId, principalId: "U1", model: "m", settledUsd: 0.6 }),
    /settlement conflict/,
  );
});

test(
  "pg budget: concurrent admissions serialize on a principal and a new attempt remains distinct",
  { skip },
  async () => {
    const a = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });
    const b = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });
    const results = await Promise.all([
      a.reserve({ operationId: "attempt-1:0", principalId: "U1", model: "m", reservedUsd: 1, now: 1000 }),
      b.reserve({ operationId: "attempt-2:0", principalId: "U1", model: "m", reservedUsd: 1, now: 1000 }),
    ]);
    assert.deepEqual(results.map((result) => result.allowed).sort(), [false, true]);
    assert.equal((await a.check("U1", 1000)).spentUsd, 1);
    assert.equal((await b.check("U1", 61_001)).allowed, true);
  },
);
