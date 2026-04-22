import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { readBoundedBytes, readBoundedText } from "../lib/crawler/net/readBounded"

const enc = new TextEncoder()
const dec = new TextDecoder()

function bodyFromChunks(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(stream)
}

describe("readBoundedBytes (memory-DoS protection)", () => {
  test("body within cap — returns all bytes", async () => {
    const out = await readBoundedBytes(bodyFromChunks([enc.encode("hello")]), 100)
    assert.ok(out)
    assert.equal(dec.decode(out!), "hello")
  })

  test("body exceeds cap in a single chunk — returns null", async () => {
    const out = await readBoundedBytes(bodyFromChunks([enc.encode("x".repeat(200))]), 100)
    assert.equal(out, null)
  })

  test("cap tripped mid-stream (first chunk fits, second overflows) — returns null", async () => {
    // 60 + 60 = 120 > 100; first chunk alone would not trip but cumulative does.
    const out = await readBoundedBytes(
      bodyFromChunks([enc.encode("x".repeat(60)), enc.encode("x".repeat(60))]),
      100,
    )
    assert.equal(out, null)
  })

  test("body at exactly the cap — allowed", async () => {
    const out = await readBoundedBytes(bodyFromChunks([enc.encode("x".repeat(100))]), 100)
    assert.ok(out)
    assert.equal(out!.byteLength, 100)
  })

  test("Response with null body — returns null", async () => {
    const out = await readBoundedBytes(new Response(null), 100)
    assert.equal(out, null)
  })

  test("stream errors mid-read — returns null (catch path, no unhandled rejection)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("boom"))
      },
    })
    const out = await readBoundedBytes(new Response(stream), 100)
    assert.equal(out, null)
  })

  test("empty body (no chunks) — returns empty Uint8Array", async () => {
    const out = await readBoundedBytes(bodyFromChunks([]), 100)
    assert.ok(out)
    assert.equal(out!.byteLength, 0)
  })

  test("multi-chunk body is assembled in order", async () => {
    const out = await readBoundedBytes(
      bodyFromChunks([enc.encode("foo"), enc.encode("bar"), enc.encode("baz")]),
      100,
    )
    assert.equal(dec.decode(out!), "foobarbaz")
  })
})

describe("readBoundedText", () => {
  test("decodes UTF-8 within cap", async () => {
    const out = await readBoundedText(bodyFromChunks([enc.encode("héllo 🌐")]), 100)
    assert.equal(out, "héllo 🌐")
  })

  test("body exceeds cap — returns null", async () => {
    const out = await readBoundedText(bodyFromChunks([enc.encode("x".repeat(200))]), 100)
    assert.equal(out, null)
  })

  test("null body — returns null", async () => {
    assert.equal(await readBoundedText(new Response(null), 100), null)
  })
})
