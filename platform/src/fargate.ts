import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApplicationAutoScalingClient,
	DeregisterScalableTargetCommand,
	PutScalingPolicyCommand,
	RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";
import { BatchDeleteImageCommand, DescribeRepositoriesCommand, ECRClient, GetAuthorizationTokenCommand, ListImagesCommand } from "@aws-sdk/client-ecr";
import {
	CreateServiceCommand,
	DeleteServiceCommand,
	DescribeServicesCommand,
	DescribeTasksCommand,
	ECSClient,
	ListTasksCommand,
	RegisterTaskDefinitionCommand,
	type Service,
	UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { type AppRuntime, removeLocalImages } from "./apps.ts";
import { appHost, config } from "./config.ts";
import { docker } from "./docker.ts";
import { query } from "./db.ts";
import { appContainerName, getProject, type Project, publishedEnv } from "./projects.ts";

/**
 * Published apps on AWS Fargate: one ECS service per app (named after its slug) in the apps cluster.
 *
 * The image is built on this server as before, pushed to the apps ECR repository, and run as a task
 * with its own network interface and security group, no IAM role, and no route to the builder. Traefik
 * on this server still terminates TLS and checks sign-in: the platform writes the tasks' private
 * addresses to a file Traefik watches. Services scale between 1 and AGENCY_APP_MAX_TASKS tasks on CPU.
 *
 * AWS access comes from a narrow role the host assumes and refreshes (no stored keys): it can push to
 * the one repository and manage services in the one cluster, nothing else.
 */

const fg = config.fargate;

async function credentials() {
	const data = JSON.parse(await readFile(fg.credentialsFile, "utf8")) as {
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
const ecs = new ECSClient(clientConfig);
const ecr = new ECRClient(clientConfig);
const scaling = new ApplicationAutoScalingClient(clientConfig);

let repositoryUri: string | undefined;

async function repository(): Promise<string> {
	if (!repositoryUri) {
		const found = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [fg.repository] }));
		repositoryUri = found.repositories?.[0]?.repositoryUri;
		if (!repositoryUri) throw new Error(`ECR repository ${fg.repository} not found`);
	}
	return repositoryUri;
}

/** Pushes a local image with a throwaway docker config holding ECR's 12-hour token, so nothing is logged in for good. */
async function push(localImage: string, remote: string): Promise<void> {
	const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
	const token = auth.authorizationData?.[0];
	if (!token?.authorizationToken || !token.proxyEndpoint) throw new Error("ECR did not return a push token");
	const dir = await mkdtemp(join(tmpdir(), "agency-ecr-"));
	try {
		const registry = new URL(token.proxyEndpoint).host;
		await writeFile(join(dir, "config.json"), JSON.stringify({ auths: { [registry]: { auth: token.authorizationToken } } }), { mode: 0o600 });
		await docker(["tag", localImage, remote]);
		await docker(["--config", dir, "push", remote], { timeoutMs: 15 * 60_000 });
		await docker(["rmi", remote], { allowFailure: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const serviceName = (project: Project) => project.slug;
const family = (project: Project) => `${fg.cluster}-${project.slug}`;

async function describe(project: Project): Promise<Service | undefined> {
	const found = await ecs.send(new DescribeServicesCommand({ cluster: fg.cluster, services: [serviceName(project)] }));
	const service = found.services?.[0];
	return service && service.status !== "INACTIVE" ? service : undefined;
}

/** Inside a task the database is this server's private address, not the compose service name. */
function taskEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = { ...env, AGENCY_GATEWAY_URL: `${config.publicUrl}/gateway` };
	if (out.DATABASE_URL) {
		const url = new URL(out.DATABASE_URL);
		url.hostname = fg.databaseHost;
		out.DATABASE_URL = url.toString();
	}
	return out;
}

async function waitUntilStable(project: Project, onLog: (line: string) => void): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	let last = "";
	while (Date.now() < deadline) {
		const service = await describe(project);
		const rollout = service?.deployments?.find((d) => d.status === "PRIMARY");
		if (rollout?.rolloutState === "FAILED") throw new Error(`The new version did not start: ${rollout.rolloutStateReason ?? "unknown reason"}`);
		const line = `Tasks running: ${rollout?.runningCount ?? 0} of ${rollout?.desiredCount ?? 1}`;
		if (line !== last) onLog(line);
		last = line;
		if (service && rollout && (rollout.runningCount ?? 0) >= Math.max(1, rollout.desiredCount ?? 1) && service.deployments?.length === 1) return;
		await sleep(5000);
	}
	throw new Error("The new version took more than 10 minutes to start");
}

async function enableScaling(project: Project): Promise<void> {
	const resourceId = `service/${fg.cluster}/${serviceName(project)}`;
	const dimension = "ecs:service:DesiredCount";
	await scaling.send(
		new RegisterScalableTargetCommand({ ServiceNamespace: "ecs", ResourceId: resourceId, ScalableDimension: dimension, MinCapacity: 1, MaxCapacity: fg.maxTasks }),
	);
	await scaling.send(
		new PutScalingPolicyCommand({
			PolicyName: "cpu",
			ServiceNamespace: "ecs",
			ResourceId: resourceId,
			ScalableDimension: dimension,
			PolicyType: "TargetTrackingScaling",
			TargetTrackingScalingPolicyConfiguration: {
				TargetValue: 60,
				PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" },
				ScaleOutCooldown: 60,
				ScaleInCooldown: 300,
			},
		}),
	);
}

// ---------------------------------------------------------------------------
// Routes: Traefik's file provider reads the running tasks' addresses from here.

let routes = new Map<string, string[]>();

async function runningTasks(): Promise<Map<string, string[]>> {
	const arns: string[] = [];
	let next: string | undefined;
	do {
		const page = await ecs.send(new ListTasksCommand({ cluster: fg.cluster, desiredStatus: "RUNNING", nextToken: next }));
		arns.push(...(page.taskArns ?? []));
		next = page.nextToken;
	} while (next);
	const found = new Map<string, string[]>();
	for (let i = 0; i < arns.length; i += 100) {
		const described = await ecs.send(new DescribeTasksCommand({ cluster: fg.cluster, tasks: arns.slice(i, i + 100) }));
		for (const task of described.tasks ?? []) {
			// A service's tasks carry the group "service:<name>"; the service is named after the app.
			const slug = task.group?.startsWith("service:") ? task.group.slice("service:".length) : undefined;
			if (!slug || task.lastStatus !== "RUNNING") continue;
			const address = task.attachments?.flatMap((a) => a.details ?? []).find((d) => d.name === "privateIPv4Address")?.value;
			if (address) found.set(slug, [...(found.get(slug) ?? []), address].sort());
		}
	}
	return found;
}

function routesYaml(current: Map<string, string[]>): string {
	const header = "# Written by the Agency platform: published apps on AWS Fargate. Do not edit.";
	// Traefik rejects empty routers or services maps, so no apps means a file with no configuration.
	if (current.size === 0) return `${header}\n`;
	const lines = [header, "http:", "  routers:"];
	for (const slug of current.keys()) {
		lines.push(
			`    app-${slug}:`,
			`      rule: "Host(\`${appHost(slug)}\`)"`,
			"      entryPoints: [app]",
			"      middlewares: [agency-auth@docker]",
			`      service: app-${slug}`,
		);
	}
	lines.push("  services:");
	for (const [slug, addresses] of current) {
		lines.push(`    app-${slug}:`, "      loadBalancer:", "        servers:");
		for (const address of addresses) lines.push(`          - url: "http://${address}:3000"`);
	}
	return `${lines.join("\n")}\n`;
}

async function syncRoutes(): Promise<void> {
	const current = await runningTasks();
	const same = current.size === routes.size && [...current].every(([k, v]) => routes.get(k)?.join() === v.join());
	routes = current;
	if (same) return;
	const file = join(fg.routesDir, "apps.yml");
	await writeFile(`${file}.partial`, routesYaml(current));
	await rename(`${file}.partial`, file);
}

/** After a switch to Fargate, apps published earlier move over with the version they had. */
async function moveExistingApps(): Promise<void> {
	const active = await query<{ project_id: string; image: string }>("select project_id, image from deployments where active");
	for (const deployment of active) {
		const project = await getProject(deployment.project_id);
		if (!project || (await describe(project))) continue;
		console.log(`[fargate] moving ${project.slug} to Fargate`);
		await fargateRuntime
			.run(project, deployment.image, await publishedEnv(project), (line) => console.log(`[fargate] ${project.slug}: ${line}`))
			.catch((error) => console.error(`[fargate] ${project.slug}: ${error instanceof Error ? error.message : error}`));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

export const fargateRuntime: AppRuntime = {
	async release(project, localImage, version, onLog) {
		// Tags can't be overwritten, and a publish that failed after the upload reuses its version number.
		const remote = `${await repository()}:${project.slug}-v${version}-${Date.now().toString(36)}`;
		onLog(`Uploading the image to ${fg.repository}`);
		await push(localImage, remote);
		return remote;
	},

	async run(project, image, env, onLog) {
		// A version published before the move to Fargate exists only on this server: upload it first.
		if (!image.startsWith(`${await repository()}:`)) {
			const version = Number(image.split(":v").pop()) || Date.now();
			image = await this.release(project, image, version, onLog);
		}
		const definition = await ecs.send(
			new RegisterTaskDefinitionCommand({
				family: family(project),
				networkMode: "awsvpc",
				requiresCompatibilities: ["FARGATE"],
				cpu: fg.cpu,
				memory: fg.memoryMb,
				executionRoleArn: fg.executionRoleArn,
				containerDefinitions: [
					{
						name: "app",
						image,
						essential: true,
						portMappings: [{ containerPort: 3000, protocol: "tcp" }],
						environment: Object.entries(taskEnv(env)).map(([name, value]) => ({ name, value })),
						logConfiguration: {
							logDriver: "awslogs",
							options: { "awslogs-group": fg.logGroup, "awslogs-region": config.awsRegion, "awslogs-stream-prefix": project.slug },
						},
					},
				],
				tags: [{ key: "agency.project", value: project.id }],
			}),
		);
		const taskDefinition = definition.taskDefinition!.taskDefinitionArn!;
		const existing = await describe(project);
		onLog(existing ? "Rolling out the new version on Fargate" : "Creating the app's service on Fargate");
		if (existing) {
			await ecs.send(new UpdateServiceCommand({ cluster: fg.cluster, service: serviceName(project), taskDefinition, desiredCount: Math.max(1, existing.desiredCount ?? 1) }));
		} else {
			await ecs.send(
				new CreateServiceCommand({
					cluster: fg.cluster,
					serviceName: serviceName(project),
					taskDefinition,
					desiredCount: 1,
					launchType: "FARGATE",
					networkConfiguration: { awsvpcConfiguration: { subnets: fg.subnets, securityGroups: [fg.securityGroup], assignPublicIp: "ENABLED" } },
					deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200, deploymentCircuitBreaker: { enable: true, rollback: true } },
					tags: [{ key: "agency.project", value: project.id }],
					propagateTags: "SERVICE",
				}),
			);
		}
		await enableScaling(project);
		await waitUntilStable(project, onLog);
		await syncRoutes();
		// Apps published before the move ran here; the Fargate route replaces it.
		await docker(["rm", "-f", appContainerName(project)], { allowFailure: true });
	},

	async stop(project) {
		await scaling
			.send(new DeregisterScalableTargetCommand({ ServiceNamespace: "ecs", ResourceId: `service/${fg.cluster}/${serviceName(project)}`, ScalableDimension: "ecs:service:DesiredCount" }))
			.catch(() => {});
		if (await describe(project)) await ecs.send(new DeleteServiceCommand({ cluster: fg.cluster, service: serviceName(project), force: true }));
		await docker(["rm", "-f", appContainerName(project)], { allowFailure: true });
		await syncRoutes();
	},

	async running(project) {
		return routes.has(serviceName(project));
	},

	async remove(project) {
		await this.stop(project);
		const ours = new RegExp(`^${project.slug}-v\\d+-[a-z0-9]+$`);
		const imageIds = [];
		let next: string | undefined;
		do {
			const page = await ecr.send(new ListImagesCommand({ repositoryName: fg.repository, filter: { tagStatus: "TAGGED" }, nextToken: next }));
			imageIds.push(...(page.imageIds ?? []).filter((id) => ours.test(id.imageTag ?? "")));
			next = page.nextToken;
		} while (next);
		for (let i = 0; i < imageIds.length; i += 100) {
			await ecr.send(new BatchDeleteImageCommand({ repositoryName: fg.repository, imageIds: imageIds.slice(i, i + 100) }));
		}
		await removeLocalImages(project);
	},

	start() {
		void moveExistingApps().catch((error) => console.error(`[fargate] could not move published apps: ${error instanceof Error ? error.message : error}`));
		// Tasks get new addresses when they restart or scale, so the routes are refreshed every 15 seconds.
		const tick = () =>
			syncRoutes()
				.catch((error) => console.error(`[fargate] could not refresh routes: ${error instanceof Error ? error.message : error}`))
				.finally(() => setTimeout(tick, 15_000).unref());
		tick();
	},
};
