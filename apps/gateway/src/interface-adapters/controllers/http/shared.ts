/** Request schemas used by both the admin-token routes and the console routes. */
import { z } from "zod";

export const ChaosBody = z
  .object({
    failRate: z.number().min(0).max(1).optional(),
    mode: z.enum(["error", "hang", "garbage", "slow_first_token"]).optional(),
    addedLatencyMs: z.number().int().min(0).max(120_000).optional(),
  })
  .strict();
