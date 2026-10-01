// Native Pi Z.ai auth reads ZAI_API_KEY via nodejs_compat's process.env in the agent isolate.
// Keep the existing deployment secret name working without registering a custom wire protocol.
export function ensureNativeModelAuth(env: Record<string, unknown>): void {
  const nativeKey = typeof env.ZAI_API_KEY === 'string' ? env.ZAI_API_KEY : '';
  const legacyKey = typeof env.ZAI_CODING_API_KEY === 'string' ? env.ZAI_CODING_API_KEY : '';
  // Worker bindings are deployment-wide, never project snapshot data. Explicit native bindings
  // win; refresh aliases on every render so a prior isolate value cannot override current bindings.
  const key = nativeKey || legacyKey;
  if (key) process.env.ZAI_API_KEY = key;
  else delete process.env.ZAI_API_KEY;
}
