import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { TokenUsage } from '@asc/translation-engine';
import type { AiProviderId } from './types.js';

const priceSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
});
const pricingSchema = z.object({
  updated: z.string().optional(),
  currency: z.string().default('USD'),
  note: z.string().optional(),
  models: z.record(z.string(), z.record(z.string(), priceSchema)).default({}),
});

export type ModelPrice = z.infer<typeof priceSchema>;
export type PricingTable = z.infer<typeof pricingSchema>;

export const EMPTY_PRICING: PricingTable = { currency: 'USD', models: {} };

export class PricingError extends Error {
  override name = 'PricingError';
}

export function parsePricing(data: unknown): PricingTable {
  const parsed = pricingSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PricingError(
      `Invalid pricing data at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/** Load the pricing file. A missing file is not an error: costs are simply unknown. */
export function loadPricing(file: string): PricingTable {
  if (!existsSync(file)) return EMPTY_PRICING;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new PricingError(`Pricing file is not valid JSON: ${file}`);
  }
  return parsePricing(data);
}

export function findPrice(
  pricing: PricingTable,
  provider: AiProviderId,
  model: string,
): ModelPrice | undefined {
  return pricing.models[provider]?.[model];
}

/**
 * Estimated cost in USD, or undefined when the model has no configured price.
 * An estimate only: provider-side discounts (prompt caching, batch) and
 * surcharges (long-context tiers) are not modelled.
 */
export function estimateCost(
  pricing: PricingTable,
  provider: AiProviderId,
  model: string,
  usage: TokenUsage | undefined,
): number | undefined {
  const price = findPrice(pricing, provider, model);
  if (!price || !usage) return undefined;
  const cost =
    (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
