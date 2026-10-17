import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
	path: string;
	data: Buffer;
}

/**
 * Reads the files of a zip archive (stored or deflated entries; no zip64, no encryption).
 * Enough for skill bundles, which are small; sizes come from the central directory so archives
 * written with data descriptors work too.
 */
export function readZip(zip: Buffer, limits: { maxFiles: number; maxBytes: number }): ZipEntry[] {
	// The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
	let end = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error("Not a zip file");
	const count = zip.readUInt16LE(end + 10);
	let offset = zip.readUInt32LE(end + 16);
	const entries: ZipEntry[] = [];
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Damaged zip file");
		const flags = zip.readUInt16LE(offset + 8);
		const method = zip.readUInt16LE(offset + 10);
		const compressed = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const local = zip.readUInt32LE(offset + 42);
		const path = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;
		if (path.endsWith("/")) continue;
		if (flags & 1) throw new Error("Encrypted zip files are not supported");
		if (entries.length >= limits.maxFiles) throw new Error(`The archive has more than ${limits.maxFiles} files`);
		total += size;
		if (total > limits.maxBytes) throw new Error(`The archive is larger than ${Math.round(limits.maxBytes / 1_000_000)} MB unpacked`);
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const raw = zip.subarray(start, start + compressed);
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
		else throw new Error(`Unsupported compression in ${path}`);
		entries.push({ path, data });
	}
	return entries;
}
