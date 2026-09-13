export const MONO = 'ui-monospace,Menlo,monospace';

/** Hazard hatch — the alert treatment. Never used for live/active state. */
export const HATCH = 'repeating-linear-gradient(45deg,#201e1d 0 5px,#7d7979 5px 10px)';

/** Inverted ink chip — urgency. Red is reserved for live motion only. */
export const ALERT_CHIP =
  'display:inline-block;padding:3px 7px;background:var(--color-text);color:var(--color-bg);' +
  'font-family:' + MONO + ';font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase';

export const PRIMARY_BTN =
  'padding:8px 14px;min-height:38px;cursor:pointer;font-family:var(--font-heading);font-weight:700;' +
  'font-size:13px;background:var(--color-text);color:var(--color-bg);border:1px solid var(--color-text)';

export const EDIT_BTN =
  'padding:5px 10px;min-height:32px;cursor:pointer;font-family:var(--font-heading);font-weight:700;' +
  'font-size:12px;background:transparent;border:1px solid var(--color-divider);color:var(--color-text)';

export const DELETE_BTN =
  'padding:5px 10px;min-height:32px;cursor:pointer;font-family:var(--font-heading);font-weight:700;' +
  'font-size:12px;background:transparent;border:1px solid var(--color-text);color:var(--color-text);' +
  'box-shadow:inset 0 -4px 0 0 var(--color-text)';

export function tabStyle(active: boolean, side: boolean): string {
  return 'display:flex;align-items:center;gap:10px;justify-content:flex-start;text-align:left;' +
    (side ? 'width:100%;' : '') +
    'padding:12px 15px;border:0;border-bottom:1px solid var(--color-divider);cursor:pointer;' +
    'font-family:var(--font-heading);font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;' +
    (active ? 'background:var(--color-text);color:var(--color-bg)' : 'background:transparent;color:var(--color-text)');
}

export function chip(active: boolean): string {
  return 'padding:7px 12px;border:1px solid var(--color-divider);cursor:pointer;font-family:var(--font-body);' +
    'font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;' +
    (active ? 'background:var(--color-text);color:var(--color-bg)' : 'background:var(--color-surface);color:var(--color-text)');
}

export function tag(kind: 'alert' | 'ink' | 'ghost' | 'neutral'): string {
  if (kind === 'alert') return 'background:var(--color-text);color:var(--color-bg);font-weight:700;letter-spacing:.06em;text-transform:uppercase';
  if (kind === 'ink') return 'background:var(--color-text);color:var(--color-bg);font-weight:600';
  if (kind === 'ghost') return 'border:1px solid var(--color-neutral-500);color:var(--color-neutral-800)';
  return 'background:var(--color-neutral-200);color:var(--color-neutral-800)';
}
