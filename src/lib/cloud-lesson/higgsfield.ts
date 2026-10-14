import 'server-only';
import { z } from 'zod';

export const HIGGSFIELD_MODEL = 'kling-video/v2.5-turbo/pro/image-to-video';
const API = 'https://api.higgsfield.ai';
export const HiggsfieldResultSchema = z.object({
  request_id: z.string().uuid(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled']),
  status_url: z.string().url().optional(), cancel_url: z.string().url().optional(),
  video: z.object({ url: z.string().url() }).optional(),
});
export type HiggsfieldResult = z.infer<typeof HiggsfieldResultSchema>;
export interface HiggsfieldProvider {
  submit(input: { prompt: string; image_url: string; negative_prompt: string }, key: string): Promise<HiggsfieldResult>;
  status(id: string): Promise<HiggsfieldResult>;
  cancel(id: string): Promise<void>;
}
export class HiggsfieldError extends Error {
  constructor(readonly status?: number) { super('Higgsfield request could not finish.'); }
}

/** Fixed origin and validated response URLs keep credentials away from arbitrary hosts. */
export function createHiggsfieldProvider(credentials: string, fetcher: typeof fetch = fetch): HiggsfieldProvider {
  const request = async (path: string, method: string, body?: unknown, key?: string) => {
    const response = await fetcher(`${API}${path}`, { method, redirect: 'error',
      signal: AbortSignal.timeout(60_000), headers: { Authorization: `Key ${credentials}`,
        'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new HiggsfieldError(response.status);
    if (method === 'POST' && path.endsWith('/cancel')) return undefined;
    const result = HiggsfieldResultSchema.parse(await response.json());
    for (const [field, suffix] of [['status_url', 'status'], ['cancel_url', 'cancel']] as const) {
      if (result[field] && result[field] !== `${API}/requests/${result.request_id}/${suffix}`) {
        throw new HiggsfieldError();
      }
    }
    return result;
  };
  return {
    async submit(input, key) {
      return (await request(`/${HIGGSFIELD_MODEL}`, 'POST', { ...input, duration: 5, cfg_scale: 0.5 }, key))!;
    },
    async status(id) {
      const requestId = z.string().uuid().parse(id);
      const result = (await request(`/requests/${requestId}/status`, 'GET'))!;
      if (result.request_id !== requestId) throw new HiggsfieldError();
      return result;
    },
    async cancel(id) { await request(`/requests/${z.string().uuid().parse(id)}/cancel`, 'POST'); },
  };
}
