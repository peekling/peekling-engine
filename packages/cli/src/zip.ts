import { inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 128;
const MAX_TOTAL = 64 * 1024 * 1024;

function safeEntry(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 256 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !/[\u0000-\u001f\u007f:]/.test(name) &&
    name
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function readZipEntries(archive: Buffer): Map<string, Buffer> {
  if (archive.length < 22)
    throw new Error(".codex-pet is not a supported ZIP archive");
  let eocd = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65_557);
    offset--
  ) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(".codex-pet is not a supported ZIP archive");
  if (
    archive.readUInt16LE(eocd + 4) !== 0 ||
    archive.readUInt16LE(eocd + 6) !== 0 ||
    archive.readUInt16LE(eocd + 8) !== archive.readUInt16LE(eocd + 10)
  )
    throw new Error("Multi-disk and ZIP64 .codex-pet archives are unsupported");
  const entries = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  if (
    entries > MAX_ENTRIES ||
    offset + directorySize > eocd ||
    offset + directorySize > archive.length
  ) {
    throw new Error(".codex-pet archive exceeds safe directory limits");
  }

  const result = new Map<string, Buffer>();
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > archive.length)
      throw new Error("ZIP directory is truncated");
    if (archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("ZIP directory is malformed");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const uncompressed = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > archive.length) throw new Error("ZIP directory is truncated");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        archive.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch {
      throw new Error("ZIP entry name is not valid UTF-8");
    }
    offset = next;
    if (name.endsWith("/")) continue;
    if (!safeEntry(name)) throw new Error(`Unsafe ZIP entry path: ${name}`);
    if ((flags & 1) !== 0)
      throw new Error(`Encrypted ZIP entry is unsupported: ${name}`);
    if (result.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (
      uncompressed > 32 * 1024 * 1024 ||
      (total += uncompressed) > MAX_TOTAL
    ) {
      throw new Error(
        ".codex-pet archive exceeds safe uncompressed size limits",
      );
    }
    if (
      localOffset + 30 > archive.length ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("ZIP local header is malformed");
    if (
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt16LE(localOffset + 6) !== flags
    )
      throw new Error(`ZIP headers disagree for ${name}`);
    const localName = archive.readUInt16LE(localOffset + 26);
    const localExtra = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    if (start + compressed > archive.length || start + compressed > eocd)
      throw new Error(`ZIP entry data is truncated: ${name}`);
    const localPath = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(localOffset + 30, localOffset + 30 + localName),
    );
    if (localPath !== name) throw new Error(`ZIP headers disagree for ${name}`);
    if (
      compressed > 0 &&
      uncompressed > 1024 * 1024 &&
      uncompressed / compressed > 1000
    )
      throw new Error(`ZIP compression ratio is unsafe for ${name}`);
    const bytes = archive.subarray(start, start + compressed);
    let value: Buffer;
    if (method === 0) value = Buffer.from(bytes);
    else if (method === 8)
      value = inflateRawSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
    else throw new Error(`Unsupported ZIP compression method for ${name}`);
    if (value.length !== uncompressed)
      throw new Error(`ZIP size mismatch for ${name}`);
    if (
      crc32(value) !==
      archive.readUInt32LE(
        offset - commentLength - extraLength - nameLength - 46 + 16,
      )
    )
      throw new Error(`ZIP checksum mismatch for ${name}`);
    result.set(name, value);
  }
  return result;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
