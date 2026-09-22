/**
 * Write path. Reads go straight from the browser to Supabase with the anon
 * key (RLS allows select, nothing else); every write goes through admin_api,
 * which holds the service-role key server-side and gates on a shared
 * password header. The service-role key must never reach this bundle.
 */

const BASE =
  process.env.NEXT_PUBLIC_ADMIN_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000';

/** Thrown for any non-2xx, carrying the status so callers can spot a 401. */
export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

async function call<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  password: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': password,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A dead admin_api is by far the most common failure here, and the
    // native message ("Failed to fetch") tells an operator nothing.
    throw new AdminApiError(0, `Cannot reach admin_api at ${BASE}. Is it running?`);
  }

  if (res.status === 401) {
    throw new AdminApiError(401, 'Wrong admin password.');
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new AdminApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ItemPayload = {
  name: string;
  category: string;
  price: number | null;
  dietary_tags: string[];
  available: boolean;
  stock_count: number | null;
};

export const createItem = (p: ItemPayload, password: string) =>
  call('/admin/items', 'POST', password, p);

export const updateItem = (id: string, p: Partial<ItemPayload>, password: string) =>
  call(`/admin/items/${id}`, 'PATCH', password, p);

export const deleteItem = (id: string, password: string) =>
  call(`/admin/items/${id}`, 'DELETE', password);

export const recallRobot = (robotId: string, reason: string, password: string) =>
  call(`/admin/robots/${robotId}/recall`, 'POST', password, { reason });

export const resolveEscalation = (id: string, password: string) =>
  call(`/admin/escalations/${id}/resolve`, 'POST', password);

export const reopenEscalation = (id: string, password: string) =>
  call(`/admin/escalations/${id}/reopen`, 'POST', password);

/**
 * The front-desk line. Starting a call launches orchestrator/agent.py on the
 * machine running admin_api — it opens THAT machine's microphone, so the
 * dashboard is the switchboard, not the handset.
 */
export type CallStatus = {
  running: boolean;
  room: string | null;
  pid?: number;
  started_at?: string;
  exit_code?: number | null;
  log?: string[];
};

export const startCall = (room: string | null, password: string) =>
  call<CallStatus>('/admin/call/start', 'POST', password, { room });

export const stopCall = (password: string) =>
  call<CallStatus>('/admin/call/stop', 'POST', password);

export const getCallStatus = (password: string) =>
  call<CallStatus>('/admin/call/status', 'GET', password);

/** Shown in dev view so an operator can see where writes are going. */
export const adminApiBase = () => BASE;
