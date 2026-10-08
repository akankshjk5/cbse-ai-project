import type { CreateMediaJobInput, MediaJob } from './contracts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Media request failed (${response.status})`);
  return body;
}

export async function createMediaJob(input: CreateMediaJobInput): Promise<MediaJob> {
  return (await request<{ job: MediaJob }>('/api/media/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  })).job;
}

export async function getMediaJob(id: string): Promise<MediaJob> {
  return (await request<{ job: MediaJob }>(`/api/media/jobs/${id}`)).job;
}

export async function cancelMediaJob(id: string): Promise<MediaJob> {
  return (await request<{ job: MediaJob }>(`/api/media/jobs/${id}`, { method: 'DELETE' })).job;
}

export async function retryMediaJob(id: string): Promise<MediaJob> {
  return (await request<{ job: MediaJob }>(`/api/media/jobs/${id}/retry`, { method: 'POST' })).job;
}

export async function waitForMediaJob(
  id: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onUpdate?: (job: MediaJob) => void;
  } = {},
): Promise<MediaJob> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const job = await getMediaJob(id);
    options.onUpdate?.(job);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = window.setTimeout(() => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, options.intervalMs ?? 2000);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw new Error('Media generation timed out');
}
