import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appHost, config } from "./config.ts";
import { containerState, docker, envArgs, labelArgs, routeLabels } from "./docker.ts";
import { fargateRuntime } from "./fargate.ts";
import { appContainerName, type Project } from "./projects.ts";

/**
 * Where published apps run. Publishing always builds the app's image on this server; the runtime
 * then runs it: as a container next to the platform (the default), or on AWS Fargate, where each
 * app is its own ECS service that scales with traffic and is isolated from the builder.
 */
export interface AppRuntime {
	/** Makes a locally built image available to the runtime and returns the reference to store. */
	release(project: Project, localImage: string, version: number, onLog: (line: string) => void): Promise<string>;
	/** Runs (or replaces) the app's published version. */
	run(project: Project, image: string, env: Record<string, string>, onLog: (line: string) => void): Promise<void>;
	/** Takes the app offline. */
	stop(project: Project): Promise<void>;
	running(project: Project): Promise<boolean>;
	/** Removes everything the runtime holds for a deleted app. */
	remove(project: Project): Promise<void>;
	/** Background work the runtime needs while the platform runs. */
	start(): void;
}

const dockerRuntime: AppRuntime = {
	async release(_project, localImage) {
		return localImage;
	},

	async run(project, image, env) {
		const name = appContainerName(project);
		await docker(["rm", "-f", name], { allowFailure: true });
		await docker([
			"run",
			"-d",
			"--name",
			name,
			"--network",
			config.dockerNetwork,
			"--restart",
			"unless-stopped",
			"--memory",
			config.appMemory,
			...envArgs(env),
			...labelArgs({
				"agency.project": project.id,
				"agency.role": "app",
				...routeLabels(`app-${project.slug}`, appHost(project.slug), 3000),
			}),
			image,
		]);
	},

	async stop(project) {
		await docker(["rm", "-f", appContainerName(project)], { allowFailure: true });
	},

	async running(project) {
		return (await containerState(appContainerName(project))) === "running";
	},

	async remove(project) {
		await this.stop(project);
		await removeLocalImages(project);
	},

	// A routes file left from running apps on Fargate would send their hosts to tasks that are gone.
	start() {
		rm(join(config.fargate.routesDir, "apps.yml"), { force: true }).catch(() => {});
	},
};

/** Deletes the app's images on this server; publishing builds them here whatever the runtime. */
export async function removeLocalImages(project: Project): Promise<void> {
	const images = await docker(["images", "-q", `agency-app-${project.slug}`], { allowFailure: true });
	const ids = [...new Set(images.stdout.split("\n").filter(Boolean))];
	if (ids.length > 0) await docker(["rmi", "-f", ...ids], { allowFailure: true });
}

export const appRuntime: AppRuntime = config.appRuntime === "fargate" ? fargateRuntime : dockerRuntime;
