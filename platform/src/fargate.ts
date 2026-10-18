import {
	DeregisterScalableTargetCommand,
	PutScalingPolicyCommand,
	RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";
import { BatchDeleteImageCommand, ListImagesCommand } from "@aws-sdk/client-ecr";
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
	type CreateServiceCommandInput,
	CreateServiceCommand,
	DeleteServiceCommand,
	DescribeContainerInstancesCommand,
	DescribeServicesCommand,
	type RegisterTaskDefinitionCommandInput,
	RegisterTaskDefinitionCommand,
	type Service,
	UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { type AppRuntime, removeLocalImages } from "./apps.ts";
import { appHost, config } from "./config.ts";
import { docker } from "./docker.ts";
import { query } from "./db.ts";
import { clusterEnv, clusterTasks, ec2, ecr, ecs, environment, pushImage, repositoryUri, scaling, writeRoutes } from "./ecs.ts";
import { appContainerName, getProject, type Project, publishedEnv } from "./projects.ts";

/**
 * Published apps in the ECS cluster: one ECS service per app (named after its slug), run in one of two ways.
 *
 * - "ec2": on shared apps servers. Many apps are packed onto one server, each reserving a little memory
 *   and CPU; when an app doesn't fit, ECS starts another server (the capacity provider's managed
 *   scaling) and removes it again once it's no longer needed. Each task gets a port on its server.
 * - "fargate": each task on its own, with its own network interface. Isolated, but billed per app.
 *
 * The image is built on this server as before, pushed to the apps ECR repository, and run with no IAM
 * role and no route to the builder. Traefik on this server still terminates TLS and checks sign-in: the
 * platform writes the tasks' private addresses to a file Traefik watches. Services scale between 1 and
 * AGENCY_APP_MAX_TASKS tasks on CPU.
 */

const fg = config.fargate;
const pool = config.appsServers;
const onServers = config.appRuntime === "ec2";
const cluster = config.ecs.cluster;

const serviceName = (project: Project) => project.slug;
const family = (project: Project) => `${cluster}-app-${project.slug}`;

async function describe(project: Project): Promise<Service | undefined> {
	const found = await ecs.send(new DescribeServicesCommand({ cluster, services: [serviceName(project)] }));
	const service = found.services?.[0];
	return service && service.status !== "INACTIVE" ? service : undefined;
}

async function waitUntilStable(project: Project, onLog: (line: string) => void): Promise<void> {
	const deadline = Date.now() + 10 * 60_000;
	let last = "";
	while (Date.now() < deadline) {
		const service = await describe(project);
		const rollout = service?.deployments?.find((d) => d.status === "PRIMARY");
		if (rollout?.rolloutState === "FAILED") throw new Error(`The new version did not start: ${rollout.rolloutStateReason ?? "unknown reason"}`);
		const waiting = onServers && (rollout?.pendingCount ?? 0) > 0 ? " (if no apps server has room, another one starts: a few minutes)" : "";
		const line = `Tasks running: ${rollout?.runningCount ?? 0} of ${rollout?.desiredCount ?? 1}${waiting}`;
		if (line !== last) onLog(line);
		last = line;
		if (service && rollout && (rollout.runningCount ?? 0) >= Math.max(1, rollout.desiredCount ?? 1) && service.deployments?.length === 1) return;
		await sleep(5000);
	}
	throw new Error("The new version took more than 10 minutes to start");
}

async function enableScaling(project: Project): Promise<void> {
	const resourceId = `service/${cluster}/${serviceName(project)}`;
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
				// On the apps servers an app reserves a small CPU share but may use more while the server is
				// quiet, so its utilization can pass 100%.
				TargetValue: onServers ? 150 : 60,
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

/** Private addresses of the apps servers, by container instance. Servers come and go, so this is a cache. */
const serverAddresses = new Map<string, string>();

async function serverAddress(containerInstances: string[]): Promise<Map<string, string>> {
	const missing = [...new Set(containerInstances)].filter((arn) => !serverAddresses.has(arn));
	for (let i = 0; i < missing.length; i += 100) {
		const found = await ecs.send(new DescribeContainerInstancesCommand({ cluster, containerInstances: missing.slice(i, i + 100) }));
		const byInstance = new Map((found.containerInstances ?? []).map((c) => [c.ec2InstanceId!, c.containerInstanceArn!]));
		if (byInstance.size === 0) continue;
		const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [...byInstance.keys()] }));
		for (const instance of (described.Reservations ?? []).flatMap((r) => r.Instances ?? [])) {
			const arn = byInstance.get(instance.InstanceId!);
			if (arn && instance.PrivateIpAddress) serverAddresses.set(arn, instance.PrivateIpAddress);
		}
	}
	return serverAddresses;
}

/** Published apps' services carry the group "service:<slug>". Each gets the URLs of its running tasks. */
async function runningApps(): Promise<Map<string, string[]>> {
	const tasks = (await clusterTasks()).filter((task) => task.group?.startsWith("service:") && task.lastStatus === "RUNNING");
	const servers = onServers ? await serverAddress(tasks.flatMap((task) => task.containerInstanceArn ?? [])) : new Map<string, string>();
	const found = new Map<string, string[]>();
	for (const task of tasks) {
		const slug = task.group!.slice("service:".length);
		const port = task.containers?.[0]?.networkBindings?.find((b) => b.containerPort === 3000)?.hostPort;
		const url = onServers
			? task.containerInstanceArn && servers.has(task.containerInstanceArn) && port && `http://${servers.get(task.containerInstanceArn)}:${port}`
			: task.address && `http://${task.address}:3000`;
		if (url) found.set(slug, [...(found.get(slug) ?? []), url].sort());
	}
	return found;
}

async function syncRoutes(): Promise<void> {
	const current = await runningApps();
	const same = current.size === routes.size && [...current].every(([k, v]) => routes.get(k)?.join() === v.join());
	routes = current;
	if (same) return;
	await writeRoutes(
		"apps.yml",
		[...current].map(([slug, urls]) => ({ name: `app-${slug}`, host: appHost(slug), urls })),
	);
}

/** After a switch to Fargate, apps published earlier move over with the version they had. */
async function moveExistingApps(): Promise<void> {
	const active = await query<{ project_id: string; image: string }>("select project_id, image from deployments where active");
	for (const deployment of active) {
		const project = await getProject(deployment.project_id);
		if (!project || (await describe(project))) continue;
		console.log(`[fargate] moving ${project.slug} to the cluster`);
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
		const remote = `${await repositoryUri(fg.repository)}:${project.slug}-v${version}-${Date.now().toString(36)}`;
		onLog(`Uploading the image to ${fg.repository}`);
		await pushImage(localImage, remote);
		return remote;
	},

	async run(project, image, env, onLog) {
		// A version published before the move to Fargate exists only on this server: upload it first.
		if (!image.startsWith(`${await repositoryUri(fg.repository)}:`)) {
			const version = Number(image.split(":v").pop()) || Date.now();
			image = await this.release(project, image, version, onLog);
		}
		const container = {
			name: "app",
			image,
			essential: true,
			environment: environment(clusterEnv(env)),
			logConfiguration: {
				logDriver: "awslogs" as const,
				options: { "awslogs-group": config.ecs.logGroup, "awslogs-region": config.awsRegion, "awslogs-stream-prefix": `app-${project.slug}` },
			},
		};
		const shape: Partial<RegisterTaskDefinitionCommandInput> = onServers
			? {
					// Port 0: ECS picks a free port on the server, so many apps share one.
					networkMode: "bridge",
					requiresCompatibilities: ["EC2"],
					containerDefinitions: [
						{
							...container,
							portMappings: [{ containerPort: 3000, hostPort: 0, protocol: "tcp" }],
							cpu: pool.cpu,
							memoryReservation: pool.memoryReservationMb,
							memory: Number(fg.memoryMb),
						},
					],
				}
			: {
					networkMode: "awsvpc",
					requiresCompatibilities: ["FARGATE"],
					cpu: fg.cpu,
					memory: fg.memoryMb,
					containerDefinitions: [{ ...container, portMappings: [{ containerPort: 3000, protocol: "tcp" }] }],
				};
		const definition = await ecs.send(
			new RegisterTaskDefinitionCommand({
				family: family(project),
				executionRoleArn: config.ecs.executionRoleArn,
				...shape,
				containerDefinitions: shape.containerDefinitions!,
				tags: [{ key: "agency.project", value: project.id }],
			}),
		);
		const taskDefinition = definition.taskDefinition!.taskDefinitionArn!;
		const existing = await describe(project);
		const where = onServers ? "the apps servers" : "Fargate";
		onLog(existing ? `Rolling out the new version on ${where}` : `Creating the app's service on ${where}`);
		if (existing) {
			await ecs.send(new UpdateServiceCommand({ cluster, service: serviceName(project), taskDefinition, desiredCount: Math.max(1, existing.desiredCount ?? 1) }));
		} else {
			const placement: Partial<CreateServiceCommandInput> = onServers
				? {
						capacityProviderStrategy: [{ capacityProvider: pool.capacityProvider, weight: 1 }],
						// Fill a server before using the next, so empty servers can be removed.
						placementStrategy: [{ type: "binpack", field: "memory" }],
					}
				: {
						launchType: "FARGATE",
						networkConfiguration: { awsvpcConfiguration: { subnets: config.ecs.subnets, securityGroups: [fg.securityGroup], assignPublicIp: "ENABLED" } },
					};
			await ecs.send(
				new CreateServiceCommand({
					cluster,
					serviceName: serviceName(project),
					taskDefinition,
					desiredCount: 1,
					...placement,
					deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200, deploymentCircuitBreaker: { enable: true, rollback: true } },
					tags: [{ key: "agency.project", value: project.id }],
					propagateTags: "SERVICE",
				}),
			);
		}
		await enableScaling(project);
		await waitUntilStable(project, onLog);
		await syncRoutes();
		// Apps published before the move ran here; the route to the cluster replaces it.
		await docker(["rm", "-f", appContainerName(project)], { allowFailure: true });
	},

	async stop(project) {
		await scaling
			.send(new DeregisterScalableTargetCommand({ ServiceNamespace: "ecs", ResourceId: `service/${cluster}/${serviceName(project)}`, ScalableDimension: "ecs:service:DesiredCount" }))
			.catch(() => {});
		if (await describe(project)) await ecs.send(new DeleteServiceCommand({ cluster, service: serviceName(project), force: true }));
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
