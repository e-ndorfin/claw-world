import { randomBytes } from "node:crypto";

const sessions = new Map<string, { createdAt: number }>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createAdminSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function validateAdminSession(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}
