/**
 * Read a required environment variable, throwing a clear error when
 * missing. Replaces scattered `process.env.X!` non-null assertions
 * that crash with cryptic "Cannot read properties of undefined"
 * stacks at runtime.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
