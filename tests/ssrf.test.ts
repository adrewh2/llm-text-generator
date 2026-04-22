import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { assertSafeUrl, isForbiddenIp, UnsafeUrlError } from "../lib/crawler/net/ssrf"

// assertSafeUrl is async because regular hostnames need a DNS lookup.
// The sync paths — literal IPv4, localhost, non-http schemes, invalid
// URLs, non-default ports — reject before any DNS call. These tests
// cover those paths so no network is touched.

describe("assertSafeUrl — scheme rejection", () => {
  test("rejects ftp", async () => {
    await assert.rejects(() => assertSafeUrl("ftp://example.com/"), UnsafeUrlError)
  })
  test("rejects javascript:", async () => {
    await assert.rejects(() => assertSafeUrl("javascript:alert(1)"), UnsafeUrlError)
  })
  test("rejects file:", async () => {
    await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), UnsafeUrlError)
  })
  test("rejection message labels the scheme failure", async () => {
    await assert.rejects(
      () => assertSafeUrl("ftp://example.com/"),
      /only http\(s\) URLs are allowed/,
    )
  })
})

describe("assertSafeUrl — malformed input", () => {
  test("rejects garbage", async () => {
    await assert.rejects(() => assertSafeUrl("not a url"), UnsafeUrlError)
  })
  test("rejects empty string", async () => {
    await assert.rejects(() => assertSafeUrl(""), UnsafeUrlError)
  })
})

describe("assertSafeUrl — port restriction", () => {
  test("rejects custom http port", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://1.1.1.1:8080/"),
      /non-default port/,
    )
  })
  test("rejects Redis default port 6379", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://1.1.1.1:6379/"),
      /non-default port/,
    )
  })
  test("rejects 22 (SSH banner-probe guard)", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://1.1.1.1:22/"),
      /non-default port/,
    )
  })
  test("accepts implicit default http port", async () => {
    await assert.doesNotReject(() => assertSafeUrl("http://1.1.1.1/"))
  })
  test("accepts implicit default https port", async () => {
    await assert.doesNotReject(() => assertSafeUrl("https://1.1.1.1/"))
  })
})

describe("assertSafeUrl — literal IPv4 (sync path)", () => {
  test("rejects loopback", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://127.0.0.1/"),
      /forbidden IP range/,
    )
  })
  test("rejects RFC 1918", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://10.0.0.1/"),
      /forbidden IP range/,
    )
  })
  test("rejects AWS / GCP / DigitalOcean metadata (169.254.169.254)", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://169.254.169.254/"),
      /forbidden IP range/,
    )
  })
  test("rejects Azure IMDS (168.63.129.16)", async () => {
    await assert.rejects(
      () => assertSafeUrl("http://168.63.129.16/"),
      /forbidden IP range/,
    )
  })
  test("accepts public IPv4 (no DNS, sync path)", async () => {
    await assert.doesNotReject(() => assertSafeUrl("http://1.1.1.1/"))
  })
})

describe("assertSafeUrl — localhost hostnames (sync path)", () => {
  test("rejects bare 'localhost'", async () => {
    await assert.rejects(() => assertSafeUrl("http://localhost/"), /loopback host/)
  })
  test("rejects subdomains of localhost", async () => {
    await assert.rejects(() => assertSafeUrl("http://foo.localhost/"), /loopback host/)
  })
  test("case-insensitive match", async () => {
    await assert.rejects(() => assertSafeUrl("http://LOCALHOST/"), /loopback host/)
  })
})

describe("isForbiddenIp (dispatcher)", () => {
  test("dispatches IPv4 to isForbiddenIpv4", () => {
    assert.equal(isForbiddenIp("127.0.0.1"), true)
    assert.equal(isForbiddenIp("8.8.8.8"), false)
  })
  test("dispatches IPv6 to isForbiddenIpv6", () => {
    assert.equal(isForbiddenIp("::1"), true)
    assert.equal(isForbiddenIp("2001:db8::1"), false)
  })
  test("unparseable input — treated as forbidden (conservative default)", () => {
    assert.equal(isForbiddenIp("not an ip"), true)
    assert.equal(isForbiddenIp(""), true)
  })
})
