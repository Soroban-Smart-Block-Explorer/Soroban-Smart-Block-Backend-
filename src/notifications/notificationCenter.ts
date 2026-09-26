import { randomUUID } from 'crypto';

export const NOTIFICATION_CATEGORIES = [
  'alert',
  'price',
  'contract',
  'security',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface InboxNotification {
  id: string;
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreferences {
  mutedCategories: NotificationCategory[];
  channels: { inbox: boolean; webhook: boolean; sse: boolean };
}

const MAX_PER_USER = 500;

const inboxes = new Map<string, InboxNotification[]>();
const preferences = new Map<string, NotificationPreferences>();

const defaultPreferences = (): NotificationPreferences => ({
  mutedCategories: [],
  channels: { inbox: true, webhook: true, sse: true },
});

export function getPreferences(userId: string): NotificationPreferences {
  return preferences.get(userId) ?? defaultPreferences();
}

export function setPreferences(
  userId: string,
  update: {
    mutedCategories?: NotificationCategory[];
    channels?: Partial<NotificationPreferences['channels']>;
  },
): NotificationPreferences {
  const current = getPreferences(userId);
  const next = {
    mutedCategories: update.mutedCategories ?? current.mutedCategories,
    channels: { ...current.channels, ...update.channels },
  };
  preferences.set(userId, next);
  return next;
}

/** Adds a notification unless the user muted its category or disabled the inbox. */
export function pushNotification(
  input: Omit<InboxNotification, 'id' | 'read' | 'createdAt'>,
): InboxNotification | null {
  const prefs = getPreferences(input.userId);
  if (!prefs.channels.inbox || prefs.mutedCategories.includes(input.category)) return null;

  const notification: InboxNotification = {
    ...input,
    id: randomUUID(),
    read: false,
    createdAt: new Date().toISOString(),
  };
  const inbox = inboxes.get(input.userId) ?? [];
  inbox.unshift(notification);
  if (inbox.length > MAX_PER_USER) inbox.length = MAX_PER_USER;
  inboxes.set(input.userId, inbox);
  return notification;
}

export function listNotifications(
  userId: string,
  opts: {
    category?: NotificationCategory;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  const all = (inboxes.get(userId) ?? []).filter(
    (n) => (!opts.category || n.category === opts.category) && (!opts.unreadOnly || !n.read),
  );
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 50;
  return {
    items: all.slice(offset, offset + limit),
    total: all.length,
    unread: unreadCount(userId),
  };
}

export function unreadCount(userId: string): number {
  return (inboxes.get(userId) ?? []).filter((n) => !n.read).length;
}

export function markRead(userId: string, ids: string[] | 'all', read = true): number {
  let changed = 0;
  for (const n of inboxes.get(userId) ?? []) {
    if ((ids === 'all' || ids.includes(n.id)) && n.read !== read) {
      n.read = read;
      changed++;
    }
  }
  return changed;
}

export function deleteNotification(userId: string, id: string): boolean {
  const inbox = inboxes.get(userId) ?? [];
  const idx = inbox.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  inbox.splice(idx, 1);
  return true;
}

/** Test helper: clears all stored notifications and preferences. */
export function resetNotificationCenter() {
  inboxes.clear();
  preferences.clear();
}
