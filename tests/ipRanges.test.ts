import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { isForbiddenIpv4, isForbiddenIpv6 } from "../lib/crawler/net/ipRanges"

describe("isForbiddenIpv4", () => {
  describe("private + reserved ranges", () => {
    const blocked = [
      ["0.0.0.0",          "unspecified"],
      ["10.0.0.1",         "RFC 1918 10/8"],
      ["100.100.100.200",  "CGNAT 100.64/10 (Alibaba metadata)"],
      ["127.0.0.1",        "loopback"],
      ["172.16.0.1",       "RFC 1918 172.16/12"],
      ["172.31.255.255",   "RFC 1918 172.16/12 upper edge"],
      ["192.168.1.1",      "RFC 1918 192.168/16"],
      ["192.0.0.192",      "IETF 192.0.0/24 (Oracle metadata)"],
      ["198.18.0.1",       "benchmark 198.18/15"],
      ["198.19.0.1",       "benchmark 198.18/15"],
      ["224.0.0.1",        "multicast"],
      ["239.255.255.255",  "multicast upper edge"],
      ["255.255.255.255",  "reserved"],
    ] as const
    for (const [ip, label] of blocked) {
      test(`${ip} — ${label}`, () => assert.equal(isForbiddenIpv4(ip), true))
    }
  })

  describe("cloud metadata IPs", () => {
    test("AWS / GCP / DigitalOcean 169.254.169.254", () =>
      assert.equal(isForbiddenIpv4("169.254.169.254"), true))
    test("Azure IMDS 168.63.129.16", () =>
      assert.equal(isForbiddenIpv4("168.63.129.16"), true))
  })

  describe("Azure IMDS rule is precise (doesn't over-block)", () => {
    const publicAdjacent = [
      "168.63.129.15",
      "168.63.129.17",
      "168.63.130.16",
      "168.62.129.16",
      "168.0.0.1",
    ]
    for (const ip of publicAdjacent) {
      test(`${ip} is public`, () => assert.equal(isForbiddenIpv4(ip), false))
    }
  })

  describe("public IPs pass", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
      test(ip, () => assert.equal(isForbiddenIpv4(ip), false))
    }
  })

  test("unparsable input is treated as forbidden", () => {
    assert.equal(isForbiddenIpv4("not.an.ip"), true)
    assert.equal(isForbiddenIpv4(""), true)
  })
})

describe("isForbiddenIpv6", () => {
  describe("reserved ranges", () => {
    const blocked = [
      ["::",       "unspecified"],
      ["::1",      "loopback"],
      ["fe80::1",  "link-local"],
      ["fc00::1",  "unique-local"],
      ["fd00::1",  "unique-local"],
      ["ff02::1",  "multicast"],
    ] as const
    for (const [ip, label] of blocked) {
      test(`${ip} — ${label}`, () => assert.equal(isForbiddenIpv6(ip), true))
    }
  })

  describe("IPv4-mapped IPv6 (dotted form)", () => {
    test("::ffff:10.0.0.1 routes to v4 check", () =>
      assert.equal(isForbiddenIpv6("::ffff:10.0.0.1"), true))
    test("::ffff:127.0.0.1 is loopback", () =>
      assert.equal(isForbiddenIpv6("::ffff:127.0.0.1"), true))
    test("::ffff:169.254.169.254 is AWS IMDS", () =>
      assert.equal(isForbiddenIpv6("::ffff:169.254.169.254"), true))
    test("::ffff:8.8.8.8 is public", () =>
      assert.equal(isForbiddenIpv6("::ffff:8.8.8.8"), false))
  })

  describe("IPv4-mapped IPv6 (hex-pair form, as emitted by WHATWG URL)", () => {
    test("::ffff:a00:1 → 10.0.0.1 blocked", () =>
      assert.equal(isForbiddenIpv6("::ffff:a00:1"), true))
    test("::ffff:7f00:1 → 127.0.0.1 blocked", () =>
      assert.equal(isForbiddenIpv6("::ffff:7f00:1"), true))
    test("::ffff:a9fe:a9fe → 169.254.169.254 blocked", () =>
      assert.equal(isForbiddenIpv6("::ffff:a9fe:a9fe"), true))
    test("::ffff:a83f:8110 → 168.63.129.16 (Azure IMDS) blocked", () =>
      assert.equal(isForbiddenIpv6("::ffff:a83f:8110"), true))
    test("::ffff:808:808 → 8.8.8.8 public", () =>
      assert.equal(isForbiddenIpv6("::ffff:808:808"), false))
  })

  describe("public IPv6 passes", () => {
    for (const ip of ["2001:db8::1", "2606:4700:4700::1111"]) {
      test(ip, () => assert.equal(isForbiddenIpv6(ip), false))
    }
  })
})
