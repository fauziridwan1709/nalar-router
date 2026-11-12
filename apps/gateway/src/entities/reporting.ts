/** Dashboard time ranges: how far back each one looks and how wide its buckets are. */
export const RANGES = {
  "15m": { spanMs: 15 * 60_000, bucketMs: 60_000 },
  "1h": { spanMs: 60 * 60_000, bucketMs: 5 * 60_000 },
  "24h": { spanMs: 24 * 3_600_000, bucketMs: 3_600_000 },
  "7d": { spanMs: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
  "30d": { spanMs: 30 * 86_400_000, bucketMs: 86_400_000 },
} as const;
export type RangeKey = keyof typeof RANGES;
export const isRangeKey = (r: string): r is RangeKey => r in RANGES;
