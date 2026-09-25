/**
 * Write path. Reads go straight from the browser to Supabase with the anon
 * key (RLS allows select, nothing else); every write goes through admin_api,
 * which holds the service-role key server-side. The service-role key must
 * never reach this bundle.
 *
 * No auth header: admin_api dropped its shared password deliberately (see its
 * module docstring). It is guarded by reachability instead — loopback-only,
 * with CORS pinned to this origin.
 */

const BASE =
  process.env.NEXT_PUBLIC_ADMIN_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000';

/**
 * The hosted web demo (Vercel) has no admin_api: that is a Python process on
 * the operator's laptop. With NEXT_PUBLIC_DEMO_MODE=1 the laptop-only controls
 * are hidden and any write explains itself instead of failing to reach
 * localhost. (On /demo, web calls and the in-browser robot replace these.)
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === '1';

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
  body?: unknown,
): Promise<T> {
  if (DEMO_MODE) {
    throw new AdminApiError(0, 'This is the hosted web demo — staff controls run on the front-desk laptop.');
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A dead admin_api is by far the most common failure here, and the
    // native message ("Failed to fetch") tells an operator nothing.
    throw new AdminApiError(0, `Cannot reach admin_api at ${BASE}. Is it running?`);
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

export const createItem = (p: ItemPayload) =>
  call('/admin/items', 'POST', p);

export const updateItem = (id: string, p: Partial<ItemPayload>) =>
  call(`/admin/items/${id}`, 'PATCH', p);

export const deleteItem = (id: string) =>
  call(`/admin/items/${id}`, 'DELETE');

export const recallRobot = (robotId: string, reason: string) =>
  call(`/admin/robots/${robotId}/recall`, 'POST', { reason });

/**
 * The robot's own kiosk buttons, collapsed onto the fleet card.
 *
 * These mirror the two physical confirmations a person makes standing at the
 * machine: "I've loaded the bin" and "I've taken my order". admin_api exposes
 * them under /robot/* rather than /admin/* to keep that distinction legible.
 *
 * Without these the delivery FSM has no way out of COLLECTING, so the robot
 * never leaves the desk.
 */
export const completeLoading = (robotId: string) =>
  call(`/robot/${robotId}/complete_loading`, 'POST');

export const completeCollection = (robotId: string) =>
  call(`/robot/${robotId}/complete_collection`, 'POST');

export const resolveEscalation = (id: string) =>
  call(`/admin/escalations/${id}/resolve`, 'POST');

export const reopenEscalation = (id: string) =>
  call(`/admin/escalations/${id}/reopen`, 'POST');

/**
 * The front-desk line. Starting a call launches orchestrator/agent.py on the
 * machine running admin_api — it opens THAT machine's microphone, so the
 * dashboard is the switchboard, not the handset.
 */
export type CallStatus = {
  running: boolean;
  /** Guest hung up (end_call); the process lives on until the robot is done. */
  finishing?: boolean;
  room: string | null;
  pid?: number;
  started_at?: string;
  exit_code?: number | null;
  log?: string[];
};

export const startCall = (room: string | null) =>
  call<CallStatus>('/admin/call/start', 'POST', { room });

export const stopCall = () =>
  call<CallStatus>('/admin/call/stop', 'POST');

export const getCallStatus = () =>
  call<CallStatus>('/admin/call/status', 'GET');

/** Shown in dev view so an operator can see where writes are going. */
export const adminApiBase = () => BASE;
