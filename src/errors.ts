/** Preserve authored messages, with a context-specific fallback for unknown failures. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : fallback;
}
