import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationAutoScalingClient } from "@aws-sdk/client-application-auto-scaling";
import { EC2Client } from "@aws-sdk/client-ec2";
import { DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { DescribeTasksCommand, ECSClient, ListTasksCommand, type Task } from "@aws-sdk/client-ecs";
import { config } from "./config.ts";
import { docker } from "./docker.ts";

/**
 * What published apps and sandboxes in the ECS cluster share: AWS clients signed with the cluster
 * role's short-lived keys (the host assumes and refreshes the role; nothing is stored), image uploads to
 * ECR, and the Traefik routes file that points host names at tasks' private addresses.
 */

async function credentials() {
	const data = JSON.parse(await readFile(config.ecs.credentialsFile, "utf8")) as {
		AccessKeyId: string;
		SecretAccessKey: string;
		SessionToken: string;
		Expiration: string;
	};
	return {
		accessKeyId: data.AccessKeyId,
		secretAccessKey: data.SecretAccessKey,
		sessionToken: data.SessionToken,
		expiration: new Date(data.Expiration),
	};
}

const clientConfig = { region: config.awsRegion, credentials };
export const ecs = new ECSClient(clientConfig);
export const ecr = new ECRClient(clientConfig);
export const scaling = new ApplicationAutoScalingClient(clientConfig);
export const ec2 = new EC2Client(clientConfig);

const repositoryUris = new Map<string, string>();

export async function repositoryUri(name: string): Promise<string> {
	let uri = repositoryUris.get(name);
	if (!uri) {
		const found = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
		uri = found.repositories?.[0]?.repositoryUri;
		if (!uri) throw new Error(`ECR repository ${name} not found`);
		repositoryUris.set(name, uri);
	}
	return uri;
}

export async function imageExists(repository: string, tag: string): Promise<boolean> {
	try {
		await ecr.send(new DescribeImagesCommand({ repositoryName: repository, imageIds: [{ imageTag: tag }] }));
		return true;
	} catch (error) {
		if ((error as { name?: string }).name === "ImageNotFoundException") return false;
		throw error;
	}
}

/** Pushes a local image with a throwaway docker config holding ECR's 12-hour token, so nothing is logged in for good. */
export async function pushImage(localImage: string, remote: string): Promise<void> {
	const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
	const token = auth.authorizationData?.[0];
	if (!token?.authorizationToken || !token.proxyEndpoint) throw new Error("ECR did not return a push token");
	const dir = await mkdtemp(join(tmpdir(), "agency-ecr-"));
	try {
		const registry = new URL(token.proxyEndpoint).host;
		await writeFile(join(dir, "config.json"), JSON.stringify({ auths: { [registry]: { auth: token.authorizationToken } } }), { mode: 0o600 });
		await docker(["tag", localImage, remote]);
		await docker(["--config", dir, "push", remote], { timeoutMs: 30 * 60_000 });
		await docker(["rmi", remote], { allowFailure: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Environment for a task. Containers on this server reach the platform and Postgres by their compose
 * names; a task reaches the platform at its public address and Postgres at this server's private one.
 */
export function clusterEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		out[name] = value.startsWith(config.internalUrl) ? config.publicUrl + value.slice(config.internalUrl.length) : value;
	}
	if (out.DATABASE_URL) {
		const url = new URL(out.DATABASE_URL);
		url.hostname = config.ecs.hostPrivateIp;
		out.DATABASE_URL = url.toString();
	}
	return out;
}

export const environment = (env: Record<string, string>) => Object.entries(env).map(([name, value]) => ({ name, value }));

/** Every task in the cluster that should be running, with its private address once it has one. */
export async function clusterTasks(): Promise<Array<Task & { address?: string }>> {
	const arns: string[] = [];
	let next: string | undefined;
	do {
		const page = await ecs.send(new ListTasksCommand({ cluster: config.ecs.cluster, desiredStatus: "RUNNING", nextToken: next }));
		arns.push(...(page.taskArns ?? []));
		next = page.nextToken;
	} while (next);
	const tasks: Array<Task & { address?: string }> = [];
	for (let i = 0; i < arns.length; i += 100) {
		const described = await ecs.send(new DescribeTasksCommand({ cluster: config.ecs.cluster, tasks: arns.slice(i, i + 100), include: ["TAGS"] }));
		for (const task of described.tasks ?? []) {
			const address = task.attachments?.flatMap((a) => a.details ?? []).find((d) => d.name === "privateIPv4Address")?.value;
			tasks.push({ ...task, address });
		}
	}
	return tasks;
}

export interface Route {
	name: string;
	host: string;
	urls: string[];
}

/** Writes a Traefik file-provider config, replacing the file at once so Traefik never reads half of it. */
export async function writeRoutes(file: string, routes: Route[]): Promise<void> {
	const header = "# Written by the Agency platform: routes to tasks in the ECS cluster. Do not edit.";
	const lines = [header];
	// Traefik rejects empty routers or services maps, so no routes means a file with no configuration.
	if (routes.length > 0) {
		lines.push("http:", "  routers:");
		for (const route of routes) {
			lines.push(
				`    ${route.name}:`,
				`      rule: "Host(\`${route.host}\`)"`,
				"      entryPoints: [app]",
				"      middlewares: [agency-auth@docker]",
				`      service: ${route.name}`,
			);
		}
		lines.push("  services:");
		for (const route of routes) {
			lines.push(`    ${route.name}:`, "      loadBalancer:", "        servers:");
			for (const url of route.urls) lines.push(`          - url: "${url}"`);
		}
	}
	const path = join(config.ecs.routesDir, file);
	await writeFile(`${path}.partial`, `${lines.join("\n")}\n`);
	await rename(`${path}.partial`, path);
}

/** Removes a routes file left from running in the cluster, so its host names don't point at tasks that are gone. */
export async function removeRoutes(file: string): Promise<void> {
	await rm(join(config.ecs.routesDir, file), { force: true }).catch(() => {});
}
