import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The tracker is an ESM-only package. Resolve its own ip dependency, rather
// than accidentally testing a different hoisted copy from this test directory.
const trackerEntry = import.meta.resolve("bittorrent-tracker");
const trackerRequire = createRequire(trackerEntry);
const commonJS = trackerRequire("ip");
let packageDirectory = dirname(trackerRequire.resolve("ip"));
while (!existsSync(join(packageDirectory, "package.json"))) {
  const parent = dirname(packageDirectory);
  assert.notEqual(parent, packageDirectory, "ip package metadata must exist");
  packageDirectory = parent;
}
const packageMetadata = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);

// @webpod/ip documents ip@2.0.1 API compatibility and fixes CVE-2024-29415
// and CVE-2023-42282: https://github.com/webpod/ip . Its stricter rejection of
// ambiguous addresses is intentional. Test behavior, not just the audit name.
test("the tracker resolves the maintained ip replacement in both module formats", async () => {
  assert.equal(packageMetadata.name, "@webpod/ip");
  const importEntry = packageMetadata.exports["."].import;
  assert.equal(typeof importEntry, "string");
  const { default: esm } = await import(pathToFileURL(join(packageDirectory, importEntry)));

  for (const ip of [commonJS, esm]) {
    for (const address of ["8.8.8.8", "127.0.0.1", "192.168.1.15", "2001:4860:4860::8888"]) {
      assert.equal(ip.toString(ip.toBuffer(address)), address);
    }
    const buffer = Buffer.alloc(8, 0xaa);
    ip.toBuffer("192.168.1.15", buffer, 2);
    assert.equal(ip.toString(buffer, 2, 4), "192.168.1.15");
    assert.equal(buffer[0], 0xaa);
    assert.equal(buffer[7], 0xaa);
    // bittorrent-tracker's UDP parser passes a UInt32, not only a Buffer.
    assert.equal(ip.toString(0x08080808), "8.8.8.8");
    assert.equal(ip.fromLong(ip.toLong("127.0.0.1")), "127.0.0.1");
  }
});

test("CVE address forms cannot be classified as public", () => {
  for (const address of [
    "127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1",
  ]) {
    assert.equal(commonJS.isPublic(address), false, address);
  }
  const noncanonicalAddresses = [
    "127.1", "127.0.1", "2130706433",
    "0x7f000001", "0177.0.0.1", "01200034567", "012.1.2.3",
    "::ffff:127.1",
  ];
  for (const address of noncanonicalAddresses) {
    let result;
    try {
      result = commonJS.isPublic(address);
    } catch (error) {
      // Rejecting a noncanonical representation is a safe, documented change.
      assert(error instanceof Error);
      continue;
    }
    assert.equal(result, false, `${address} must not be public`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
    assert.equal(commonJS.isPublic(address), true, address);
  }
  // isPublic is a private-range classifier, not a complete SSRF egress policy.
  // The application does not use it as a network authorization boundary.
});

test("tracker server imports and UDP parsing remain compatible without listening", async () => {
  const { default: TrackerServer } = await import("bittorrent-tracker/server");
  assert.equal(typeof TrackerServer, "function");
  const { default: parseUDP } = await import(new URL("./lib/server/parse-udp.js", trackerEntry));

  // BEP 15 announce packet. Only exercise the parser: no server is constructed,
  // no socket is opened, and no public tracker or peer receives test traffic.
  const packet = Buffer.alloc(98);
  Buffer.from("0000041727101980", "hex").copy(packet);
  packet.writeUInt32BE(1, 8); // announce action
  packet.writeUInt32BE(42, 12); // transaction ID
  packet.fill(0x11, 16, 36); // info hash
  packet.fill(0x22, 36, 56); // peer ID
  packet.writeUInt32BE(0x08080808, 84); // explicit IPv4
  packet.writeUInt32BE(1, 92); // numwant
  packet.writeUInt16BE(6881, 96);
  const sender = { address: "127.0.0.1", port: 6881 };
  const announce = parseUDP(packet, sender);
  assert.equal(announce.ip, "8.8.8.8");
  assert.equal(announce.port, 6881);
  assert.equal(announce.transactionId, 42);

  packet.writeUInt32BE(0, 84);
  assert.equal(parseUDP(packet, sender).ip, sender.address);
});
