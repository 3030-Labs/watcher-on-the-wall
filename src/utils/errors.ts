/**
 * Safe error message extraction. Replaces unsafe `(err as Error).message` casts.
 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
