// visitorId -> set of socket ids. In-memory is fine for one server instance.
// Move this to Redis if you ever run multiple instances.
const sessions = new Map<string, Set<string>>();

export function addPresence(visitorId: string, socketId: string) {
  const set = sessions.get(visitorId) ?? new Set<string>();
  set.add(socketId);
  sessions.set(visitorId, set);
}

export function removePresence(visitorId: string, socketId: string) {
  const set = sessions.get(visitorId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) sessions.delete(visitorId);
}

export const liveCount = () => sessions.size;