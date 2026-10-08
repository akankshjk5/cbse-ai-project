const RAW_API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";

export const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface ApiNotification {
  seq: number;
  text: string;
}

export interface StartJobInput {
  message: string;
  styleName?: string | null;
  imageFile?: File | null;
  imageUrl?: string | null;
  notificationIntervalSeconds?: number;
}

export interface StartJobResponse {
  job_id: string;
  status: JobStatus;
}

export interface JobResponse {
  id: string;
  status: JobStatus;
  message: string;
  selected_style_name: string | null;
  generated_style_name: string | null;
  image_path: string | null;
  has_result: boolean;
  result_path: string | null;
  archive_dir: string | null;
  notification_interval_seconds: number;
  result_endpoint: string | null;
  agent_response: string | null;
  langfuse_trace_id: string | null;
  langfuse_trace_url: string | null;
  error: string | null;
}

export interface NotificationsResponse {
  job_id: string;
  notifications: ApiNotification[];
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.detail === "string") {
      return data.detail;
    }
    if (typeof data?.message === "string") {
      return data.message;
    }
    return `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    throw new ApiError(await parseError(response), response.status);
  }
  return response.json() as Promise<T>;
}

export async function startJob(input: StartJobInput): Promise<StartJobResponse> {
  const body = new FormData();
  body.append("message", input.message);
  if (input.styleName) {
    body.append("style_name", input.styleName);
  }
  if (input.imageFile) {
    body.append("image", input.imageFile);
  }
  if (input.imageUrl) {
    body.append("image_url", input.imageUrl);
  }
  if (typeof input.notificationIntervalSeconds === "number") {
    body.append("notification_interval_seconds", String(input.notificationIntervalSeconds));
  }

  return requestJson<StartJobResponse>("/start", {
    method: "POST",
    body,
  });
}

export async function getJob(jobId: string): Promise<JobResponse> {
  return requestJson<JobResponse>(`/jobs/${jobId}`);
}

export async function getNotifications(jobId: string, after = 0): Promise<NotificationsResponse> {
  return requestJson<NotificationsResponse>(`/notifications/${jobId}?after=${after}`);
}

export function buildResultUrl(jobId: string): string {
  return `${API_BASE_URL}/result/${jobId}`;
}
