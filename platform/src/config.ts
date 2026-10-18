function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function optional(name: string, fallback: string): string {
	return process.env[name] || fallback;
}

const baseDomain = required("AGENCY_BASE_DOMAIN");
const scheme = optional("AGENCY_PUBLIC_SCHEME", "https");

export const config = {
	port: Number(optional("PORT", "8080")),
	baseDomain,
	scheme,
	publicUrl: `${scheme}://${baseDomain}`,
	secureCookies: scheme === "https",
	databaseUrl: required("DATABASE_URL"),
	secretKey: required("AGENCY_SECRET_KEY"),
	adminEmail: process.env.AGENCY_ADMIN_EMAIL,
	adminPassword: process.env.AGENCY_ADMIN_PASSWORD,
	sandboxImage: optional("AGENCY_SANDBOX_IMAGE", "agency-sandbox:latest"),
	dockerNetwork: optional("AGENCY_DOCKER_NETWORK", "agency"),
	// Host name and port at which containers on the docker network reach this server and Postgres.
	internalUrl: optional("AGENCY_INTERNAL_URL", "http://platform:8080"),
	projectDbHost: optional("AGENCY_PROJECT_DB_HOST", "postgres"),
	// Image with pg_dump and psql, used to copy an app's preview data into its first live database.
	postgresImage: optional("AGENCY_POSTGRES_IMAGE", "postgres:17.6"),
	// pi model pattern, for example "anthropic/claude-sonnet-4-5". Empty lets pi choose from available keys.
	model: process.env.AGENCY_MODEL ?? "",
	// Names of environment variables forwarded to the coding agent (LLM provider keys).
	agentEnv: optional("AGENCY_AGENT_ENV", "ANTHROPIC_API_KEY,OPENAI_API_KEY,GEMINI_API_KEY,OPENROUTER_API_KEY")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
	// All-AWS setup: file with short-lived Bedrock credentials written by the host, and the Bedrock region.
	awsCredentialsFile: process.env.AGENCY_AWS_CREDENTIALS_FILE ?? "",
	awsRegion: optional("AGENCY_AWS_REGION", "us-east-1"),
	// Monthly agent budget in US dollars for newly added members. Admins can change it per user.
	defaultBudgetUsd: Number(optional("AGENCY_DEFAULT_BUDGET_USD", "20")),
	sandboxMemory: optional("AGENCY_SANDBOX_MEMORY", "3g"),
	sandboxCpus: optional("AGENCY_SANDBOX_CPUS", "2"),
	appMemory: optional("AGENCY_APP_MEMORY", "512m"),
	// Where published apps run: "docker" (containers on this server), "ec2" (an ECS service per app, packed
	// onto shared apps servers that scale out when full) or "fargate" (an ECS service per app, each on its own).
	appRuntime: optional("AGENCY_APP_RUNTIME", "docker") as "docker" | "ec2" | "fargate",
	// Where sandboxes run: "docker" (containers on this server) or "fargate" (an ECS task per app that
	// runs while someone builds, with its workspace on EFS).
	sandboxRuntime: optional("AGENCY_SANDBOX_RUNTIME", "docker") as "docker" | "fargate",
	// The ECS cluster both use when they run on AWS.
	ecs: {
		cluster: process.env.AGENCY_ECS_CLUSTER ?? "",
		subnets: (process.env.AGENCY_ECS_SUBNETS ?? "").split(",").filter(Boolean),
		executionRoleArn: process.env.AGENCY_ECS_EXECUTION_ROLE_ARN ?? "",
		logGroup: process.env.AGENCY_ECS_LOG_GROUP ?? "",
		// Short-lived keys for the cluster role, refreshed by the host (infra/aws/host/agency-aws-credentials).
		credentialsFile: optional("AGENCY_CLUSTER_CREDENTIALS_FILE", "/aws-cluster/credentials.json"),
		// This server's private address: tasks reach Postgres here.
		hostPrivateIp: process.env.AGENCY_HOST_PRIVATE_IP ?? "",
		// Where Traefik reads routes to tasks (its file provider watches this directory).
		routesDir: optional("AGENCY_TRAEFIK_DYNAMIC_DIR", "/traefik-dynamic"),
	},
	fargate: {
		repository: process.env.AGENCY_APPS_ECR_REPOSITORY ?? "",
		securityGroup: process.env.AGENCY_APPS_SECURITY_GROUP ?? "",
		cpu: optional("AGENCY_APP_CPU", "256"),
		memoryMb: optional("AGENCY_APP_MEMORY_MB", "512"),
		maxTasks: Number(optional("AGENCY_APP_MAX_TASKS", "3")),
	},
	// Published apps on the shared apps servers: what each app reserves decides how many fit on a server.
	appsServers: {
		capacityProvider: process.env.AGENCY_APPS_CAPACITY_PROVIDER ?? "",
		cpu: Number(optional("AGENCY_APP_SERVER_CPU", "128")),
		memoryReservationMb: Number(optional("AGENCY_APP_SERVER_MEMORY_MB", "256")),
	},
	sandboxFargate: {
		repository: process.env.AGENCY_SANDBOX_ECR_REPOSITORY ?? "",
		securityGroup: process.env.AGENCY_SANDBOX_SECURITY_GROUP ?? "",
		cpu: optional("AGENCY_SANDBOX_TASK_CPU", "1024"),
		memoryMb: optional("AGENCY_SANDBOX_TASK_MEMORY_MB", "3072"),
		// Fargate Spot costs about 70% less; AWS may stop a task with two minutes' notice (the workspace stays).
		spot: optional("AGENCY_SANDBOX_SPOT", "true") === "true",
		efsId: process.env.AGENCY_EFS_ID ?? "",
		// The EFS file system mounted on this server, at the same path inside the platform container.
		efsDir: optional("AGENCY_EFS_DIR", "/mnt/agency-efs"),
	},
	// Minutes without use before an app's agent process ends, and before its sandbox container stops. 0 keeps them running.
	piIdleMinutes: Number(optional("AGENCY_PI_IDLE_MINUTES", "10")),
	sandboxIdleMinutes: Number(optional("AGENCY_SANDBOX_IDLE_MINUTES", "30")),
	// Days a published app may go without a visit before it is taken down and its owner gets an email. 0 keeps apps up.
	appIdleDays: Number(optional("AGENCY_APP_IDLE_DAYS", "7")),
	// Email from the platform. All-AWS setups send through Amazon SES with a send-only role whose short-lived
	// keys the host refreshes; an admin can set an SMTP server in Settings instead (mail.ts).
	mail: {
		sesCredentialsFile: process.env.AGENCY_MAIL_CREDENTIALS_FILE ?? "",
		from: process.env.AGENCY_MAIL_FROM ?? "",
	},
	webRoot: new URL("../web/", import.meta.url).pathname,
	nodeModules: new URL("../node_modules/", import.meta.url).pathname,
};

export function previewHost(slug: string): string {
	return `${slug}-preview.${config.baseDomain}`;
}

export function appHost(slug: string): string {
	return `${slug}.${config.baseDomain}`;
}
