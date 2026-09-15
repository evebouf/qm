import { randomUUID } from "node:crypto";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { customModelPricingKnown } from "../model/custom-providers.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK, resolveModel } from "../model/pi-models.ts";

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
  reason?: "limit" | "unknown_pricing";
}

export interface BudgetReservationInput {
  operationId: string;
  principalId: string;
  model: string;
  reservedUsd: number;
  now?: number;
}

export interface BudgetSettlementInput {
  operationId: string;
  principalId: string;
  model: string;
  settledUsd: number;
  now?: number;
}

export interface BudgetTracker {
  readonly enabled: boolean;
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
  reserve(input: BudgetReservationInput): Promise<BudgetCheck>;
  settle(input: BudgetSettlementInput): Promise<void>;
}

export interface MeteredModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

export type ModelUsagePrice =
  { priced: true; costUsd: number; basis: "provider_reported" | "api_equivalent" } | { priced: false; reason: string };

export interface ModelUsageMeter {
  reserve(model: string, estimatedInputTokens: number): Promise<string>;
  settle(operationId: string, model: string, usage: MeteredModelUsage, reportedCostUsd?: number): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validUsage(usage: MeteredModelUsage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cacheWrite1h ?? 0].every(
    finiteNonnegative,
  );
}

function priceableModel(modelId: string): Model<Api> | undefined {
  const model = resolveModel(modelId);
  if (!model || !customModelPricingKnown(modelId)) return undefined;
  const tiers = model.cost.tiers ?? [];
  const values = [
    model.cost.input,
    model.cost.output,
    model.cost.cacheRead,
    model.cost.cacheWrite,
    ...tiers.flatMap((tier) => [tier.inputTokensAbove, tier.input, tier.output, tier.cacheRead, tier.cacheWrite]),
  ];
  return values.every(finiteNonnegative) ? model : undefined;
}

export function priceModelUsage(modelId: string, usage: MeteredModelUsage, reportedCostUsd?: number): ModelUsagePrice {
  if (!validUsage(usage)) return { priced: false, reason: "usage is not finite and nonnegative" };
  if (reportedCostUsd !== undefined) {
    return finiteNonnegative(reportedCostUsd)
      ? { priced: true, costUsd: reportedCostUsd, basis: "provider_reported" }
      : { priced: false, reason: "provider-reported cost is not finite and nonnegative" };
  }
  if (modelId === "mock" || modelId === "mock-security") {
    const costUsd =
      ((usage.input + usage.cacheRead + usage.cacheWrite) * DEFAULT_AGENT_INPUT_USD_PER_MTOK +
        usage.output * DEFAULT_AGENT_INPUT_USD_PER_MTOK) /
      1_000_000;
    return { priced: true, costUsd, basis: "api_equivalent" };
  }
  const model = priceableModel(modelId);
  if (!model) return { priced: false, reason: `pricing is unavailable for model ${modelId}` };
  const sdkUsage: Usage = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const costUsd = calculateCost(model, sdkUsage).total;
  return finiteNonnegative(costUsd)
    ? { priced: true, costUsd, basis: "api_equivalent" }
    : { priced: false, reason: `pricing produced an invalid cost for model ${modelId}` };
}

export function createModelUsageMeter(
  tracker: BudgetTracker | undefined,
  principalId: string,
  attemptId: string,
): ModelUsageMeter | undefined {
  if (!tracker?.enabled) return undefined;
  let ordinal = 0;
  return {
    async reserve(model, estimatedInputTokens) {
      const operationId = `${attemptId}:${ordinal++}`;
      const priced = priceModelUsage(model, {
        input: Math.max(0, estimatedInputTokens),
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      if (!priced.priced) throw new Error(`budget refused unpriced model request: ${priced.reason}`);
      const result = await tracker.reserve({ operationId, principalId, model, reservedUsd: priced.costUsd });
      if (!result.allowed)
        throw new Error(`budget exceeded ($${result.spentUsd.toFixed(2)} of $${result.limitUsd}); try again later`);
      return operationId;
    },
    async settle(operationId, model, usage, reportedCostUsd) {
      const priced = priceModelUsage(model, usage, reportedCostUsd);
      if (!priced.priced) throw new Error(`budget could not settle model request: ${priced.reason}`);
      await tracker.settle({ operationId, principalId, model, settledUsd: priced.costUsd });
    },
  };
}

interface MemoryOperation {
  principalId: string;
  model: string;
  reservedAt: number;
  reservedUsd: number;
  settledUsd?: number;
}

function assertAmount(value: number, name: string): void {
  if (!finiteNonnegative(value)) throw new Error(`${name} must be finite and nonnegative`);
}

export function createBudgetTracker(
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const operations = new Map<string, MemoryOperation>();
  const orgKey = "@org";
  const enabled = Number.isFinite(limitUsd) || Number.isFinite(orgLimitUsd);

  function operationSpend(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    let total = 0;
    for (const op of operations.values()) {
      if (op.reservedAt >= cutoff && (principalId === orgKey || op.principalId === principalId))
        total += op.settledUsd ?? op.reservedUsd;
    }
    return total;
  }

  function legacySpend(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((entry) => entry.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((sum, entry) => sum + entry.usd, 0);
  }

  function spentIn(principalId: string, now: number): number {
    return legacySpend(principalId, now) + operationSpend(principalId, now);
  }

  function checkAt(principalId: string, now: number, additionalUsd = 0): BudgetCheck {
    const spentUsd = spentIn(principalId, now);
    if (spentUsd + additionalUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd, reason: "limit" };
    const orgSpent = spentIn(orgKey, now);
    return orgSpent + additionalUsd >= orgLimitUsd
      ? { allowed: false, spentUsd: orgSpent, limitUsd: orgLimitUsd, reason: "limit" }
      : { allowed: true, spentUsd, limitUsd };
  }

  return {
    enabled,
    async check(principalId, now = Date.now()) {
      return checkAt(principalId, now);
    },
    async record(principalId, costUsd, now = Date.now()) {
      assertAmount(costUsd, "costUsd");
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
    async reserve(input) {
      assertAmount(input.reservedUsd, "reservedUsd");
      const existing = operations.get(input.operationId);
      if (existing) {
        if (
          existing.principalId !== input.principalId ||
          existing.model !== input.model ||
          existing.reservedUsd !== input.reservedUsd
        )
          throw new Error(`budget operation identity conflict: ${input.operationId}`);
        return { allowed: true, spentUsd: spentIn(input.principalId, input.now ?? Date.now()), limitUsd };
      }
      const now = input.now ?? Date.now();
      const admitted = checkAt(input.principalId, now);
      if (!admitted.allowed) return admitted;
      operations.set(input.operationId, {
        principalId: input.principalId,
        model: input.model,
        reservedAt: now,
        reservedUsd: input.reservedUsd,
      });
      return { allowed: true, spentUsd: admitted.spentUsd + input.reservedUsd, limitUsd: admitted.limitUsd };
    },
    async settle(input) {
      assertAmount(input.settledUsd, "settledUsd");
      const existing = operations.get(input.operationId);
      if (!existing) throw new Error(`budget reservation not found: ${input.operationId}`);
      if (existing.principalId !== input.principalId || existing.model !== input.model)
        throw new Error(`budget operation identity conflict: ${input.operationId}`);
      if (existing.settledUsd !== undefined && existing.settledUsd !== input.settledUsd)
        throw new Error(`budget operation settlement conflict: ${input.operationId}`);
      existing.settledUsd = input.settledUsd;
    },
  };
}

export function budgetInvocationId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
