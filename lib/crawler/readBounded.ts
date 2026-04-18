// Read a `Response` body while enforcing a hard byte cap.
//
// `res.arrayBuffer()` / `res.text()` buffer the entire body in memory
// before returning — a server that lies about (or omits) Content-Length
// can send us unbounded data and OOM the function before any post-hoc
// size check fires. These helpers pull chunks off the stream and abort
// the body as soon as the cumulative size crosses `maxBytes`.

/**
 * Returns the decoded UTF-8 text up to `maxBytes`, or `null` when the
 * body exceeds the cap / can't be read.
 */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(res, maxBytes)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/**
 * Returns the raw bytes up to `maxBytes`, or `null` when the body
 * exceeds the cap / can't be read.
 */
export async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        // `cancel()` releases the lock and closes the stream — no
        // explicit releaseLock() required (it would throw after cancel).
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return null
  }
  const out = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
