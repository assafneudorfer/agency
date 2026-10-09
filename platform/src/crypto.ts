import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

const key = scryptSync(config.secretKey, "agency-config-encryption", 32);

/** Encrypts a JSON value with AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptJson(value: unknown): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptJson<T>(encoded: string): T {
	const data = Buffer.from(encoded, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
	decipher.setAuthTag(data.subarray(12, 28));
	const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
	return JSON.parse(plain.toString("utf8")) as T;
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [algorithm, salt, hash] = stored.split("$");
	if (algorithm !== "scrypt" || !salt || !hash) return false;
	const expected = Buffer.from(hash, "base64");
	const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
	return timingSafeEqual(actual, expected);
}
