import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { clientValidateUrl } from "../lib/crawler/net/url"

const PRIVATE_IP_REASON = "Private or reserved IP ranges aren't allowed"

describe("clientValidateUrl", () => {
  describe("scheme", () => {
    test("http accepted", () =>
      assert.deepEqual(clientValidateUrl("http://example.com/"), { ok: true }))
    test("https accepted", () =>
      assert.deepEqual(clientValidateUrl("https://example.com/"), { ok: true }))
    test("ftp rejected", () =>
      assert.deepEqual(clientValidateUrl("ftp://example.com/"), {
        ok: false, reason: "URL must start with http:// or https://",
      }))
    test("file rejected", () =>
      assert.deepEqual(clientValidateUrl("file:///etc/passwd"), {
        ok: false, reason: "URL must start with http:// or https://",
      }))
    test("garbage input rejected", () =>
      assert.deepEqual(clientValidateUrl("not a url"), {
        ok: false, reason: "Enter a valid URL",
      }))
  })

  describe("ports", () => {
    test("custom port rejected", () =>
      assert.deepEqual(clientValidateUrl("http://example.com:8080/"), {
        ok: false, reason: "Custom ports aren't allowed",
      }))
    test("default port (80) normalised away and accepted", () =>
      assert.deepEqual(clientValidateUrl("http://example.com:80/"), { ok: true }))
  })

  describe("hostname shape", () => {
    test("single-word rejected (no dot)", () =>
      assert.deepEqual(clientValidateUrl("http://notadomain/"), {
        ok: false, reason: "Enter a full domain (e.g. example.com)",
      }))
    test("localhost rejected", () =>
      assert.deepEqual(clientValidateUrl("http://localhost/"), {
        ok: false, reason: "localhost URLs aren't allowed",
      }))
    test("subdomain.localhost rejected", () =>
      assert.deepEqual(clientValidateUrl("http://foo.localhost/"), {
        ok: false, reason: "localhost URLs aren't allowed",
      }))
  })

  describe("IPv4 literals", () => {
    test("loopback rejected", () =>
      assert.deepEqual(clientValidateUrl("http://127.0.0.1/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("RFC 1918 rejected", () =>
      assert.deepEqual(clientValidateUrl("http://192.168.1.1/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("AWS/GCP metadata rejected", () =>
      assert.deepEqual(clientValidateUrl("http://169.254.169.254/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("Azure IMDS rejected", () =>
      assert.deepEqual(clientValidateUrl("http://168.63.129.16/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("public IPv4 accepted", () =>
      assert.deepEqual(clientValidateUrl("http://1.1.1.1/"), { ok: true }))
  })

  describe("IPv6 literals (bracketed, as entered by users)", () => {
    test("[::1] loopback rejected", () =>
      assert.deepEqual(clientValidateUrl("http://[::1]/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("[fe80::1] link-local rejected", () =>
      assert.deepEqual(clientValidateUrl("http://[fe80::1]/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("[fc00::1] unique-local rejected", () =>
      assert.deepEqual(clientValidateUrl("http://[fc00::1]/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("[::ffff:10.0.0.1] mapped private rejected — dotted input, hex-normalised hostname", () =>
      assert.deepEqual(clientValidateUrl("http://[::ffff:10.0.0.1]/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("[::ffff:169.254.169.254] mapped AWS IMDS rejected", () =>
      assert.deepEqual(clientValidateUrl("http://[::ffff:169.254.169.254]/"), {
        ok: false, reason: PRIVATE_IP_REASON,
      }))
    test("[2001:db8::1] public v6 accepted", () =>
      assert.deepEqual(clientValidateUrl("http://[2001:db8::1]/"), { ok: true }))
  })
})
