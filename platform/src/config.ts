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
	// Minutes without use before an app's agent process ends, and before its sandbox container stops. 0 keeps them running.
	piIdleMinutes: Number(optional("AGENCY_PI_IDLE_MINUTES", "10")),
	sandboxIdleMinutes: Number(optional("AGENCY_SANDBOX_IDLE_MINUTES", "30")),
	webRoot: new URL("../web/", import.meta.url).pathname,
	nodeModules: new URL("../node_modules/", import.meta.url).pathname,
};

export function previewHost(slug: string): string {
	return `${slug}-preview.${config.baseDomain}`;
}

export function appHost(slug: string): string {
	return `${slug}.${config.baseDomain}`;
}
