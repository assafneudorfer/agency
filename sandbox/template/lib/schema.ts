// Idempotent statements that create the app database schema. They run once per server process,
// in development and in production, so only use "create ... if not exists" and safe "alter ... add column if not exists".
export const schema: string[] = [];
