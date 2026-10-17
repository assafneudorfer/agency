import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { config } from "./config.ts";

/**
 * Amazon Bedrock credentials for the coding agent, when Agency runs all on AWS.
 *
 * The host assumes a Bedrock-only IAM role every few minutes and writes the short-lived keys to a
 * file mounted into this server (AGENCY_AWS_CREDENTIALS_FILE). pi gets no keys: its AWS profile
 * runs /opt/agency/aws-credentials, which fetches them from here with a per-project agent token.
 * Only the pi process holds that token; published apps never see it.
 */

export const bedrockEnabled = Boolean(config.awsCredentialsFile);

function sign(projectId: string): string {
	return createHmac("sha256", config.secretKey).update(`bedrock:${projectId}`).digest("base64url");
}

/** Environment for pi's `docker exec` so it signs Bedrock requests with the host's role. */
export function bedrockAgentEnv(projectId: string): Record<string, string> {
	if (!bedrockEnabled) return {};
	return {
		AWS_REGION: config.awsRegion,
		AWS_PROFILE: "agency",
		AWS_CONFIG_FILE: "/opt/agency/aws-config",
		AGENCY_AWS_CREDENTIALS_URL: `${config.internalUrl}/internal/aws-credentials`,
		AGENCY_AWS_CREDENTIALS_TOKEN: `${projectId}.${sign(projectId)}`,
	};
}

function validToken(token: string): boolean {
	const [projectId, signature] = token.split(".");
	if (!projectId || !signature) return false;
	const expected = Buffer.from(sign(projectId));
	const actual = Buffer.from(signature);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const bedrockApp = new Hono();

// Answers in the credential_process format: {Version, AccessKeyId, SecretAccessKey, SessionToken, Expiration}.
bedrockApp.get("/aws-credentials", async (c) => {
	if (!bedrockEnabled) return c.json({ error: "Bedrock is not configured" }, 404);
	const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	if (!validToken(token)) return c.json({ error: "Invalid agent token" }, 401);
	try {
		return c.json(JSON.parse(await readFile(config.awsCredentialsFile, "utf8")));
	} catch {
		return c.json({ error: "Bedrock credentials are not ready yet" }, 503);
	}
});
