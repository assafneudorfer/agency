import { bedrockEnabled } from "./bedrock.ts";
import { config } from "./config.ts";
import { getSetting, putSetting } from "./settings.ts";

/**
 * Which Claude models the coding agent may use.
 *
 * The catalog is every Claude model pi 1.3.0 knows for the deploy's provider: the Claude API, or
 * Amazon Bedrock in the all-AWS setup. An admin picks the models members may choose and the
 * organization's default; members pick from those in the builder chat. Until an admin saves a
 * choice, only the model the deploy was set up with (AGENCY_MODEL, or pi's default) is allowed.
 */

export type Provider = "anthropic" | "bedrock";

interface CatalogEntry {
	key: string;
	name: string;
	note: string;
	// Claude API model ID, and the Bedrock model ID without its inference profile prefix (us., eu., ...).
	bedrock: string;
	// Bedrock inference profiles (us, eu, au, global) that don't offer the model, per pi's catalog.
	notOn?: string[];
	// List price in USD per million tokens, input and output. Usage is charged at what pi reports.
	price: [number, number];
}

const CATALOG: CatalogEntry[] = [
	{ key: "claude-fable-5-1", name: "Claude Fable 5.1", note: "Most capable, highest cost", bedrock: "claude-fable-5-1", notOn: ["eu", "au"], price: [10, 50] },
	{ key: "claude-fable-5", name: "Claude Fable 5", note: "Most capable, highest cost", bedrock: "claude-fable-5", notOn: ["au"], price: [10, 50] },
	{ key: "claude-opus-5-5", name: "Claude Opus 5.5", note: "Best for building apps", bedrock: "claude-opus-5-5", price: [4, 20] },
	{ key: "claude-opus-5", name: "Claude Opus 5", note: "Strong at building apps", bedrock: "claude-opus-5", price: [5, 25] },
	{ key: "claude-opus-4-8", name: "Claude Opus 4.8", note: "Strong at building apps", bedrock: "claude-opus-4-8", price: [5, 25] },
	{ key: "claude-opus-4-7", name: "Claude Opus 4.7", note: "Earlier Opus", bedrock: "claude-opus-4-7", price: [5, 25] },
	{ key: "claude-opus-4-6", name: "Claude Opus 4.6", note: "Earlier Opus", bedrock: "claude-opus-4-6-v1", price: [5, 25] },
	{ key: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "Fast and capable, lower cost", bedrock: "claude-sonnet-5-5", notOn: ["au"], price: [2, 10] },
	{ key: "claude-sonnet-5", name: "Claude Sonnet 5", note: "Fast and capable, lower cost", bedrock: "claude-sonnet-5", price: [2, 10] },
	{ key: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", note: "Earlier Sonnet", bedrock: "claude-sonnet-4-6", price: [3, 15] },
	{ key: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "Fastest and cheapest, for small edits and questions", bedrock: "claude-haiku-5-5", price: [0.1, 0.5] },
	{ key: "claude-haiku-4-5", name: "Claude Haiku 4.5", note: "Earlier Haiku", bedrock: "claude-haiku-4-5-20251001-v1:0", price: [1, 5] },
];

// pi's own default when AGENCY_MODEL is empty (defaultModelPerProvider in pi 1.3.0).
const PI_DEFAULT = "claude-opus-4-8";

export const provider: Provider = bedrockEnabled ? "bedrock" : "anthropic";

/** Bedrock inference profile prefix: the one in AGENCY_MODEL, else the one deploy.sh picks for the region. */
function bedrockPrefix(): string {
	const configured = /^amazon-bedrock\/([a-z]+)\.anthropic\./.exec(config.model)?.[1];
	if (configured) return configured;
	const region = config.awsRegion;
	if (region.startsWith("us-")) return "us";
	if (region.startsWith("eu-")) return "eu";
	if (region === "ap-southeast-2" || region === "ap-southeast-4") return "au";
	return "global";
}

/** The model pattern pi takes with --model, as provider/id. */
function piModel(entry: CatalogEntry): string {
	return provider === "bedrock" ? `amazon-bedrock/${bedrockPrefix()}.anthropic.${entry.bedrock}` : `anthropic/${entry.key}`;
}

// The deploy's own model (AGENCY_MODEL) when it is not a Claude model in the catalog, for example an
// OpenAI model; it is then the only choice.
const custom: CatalogEntry | undefined = config.model && !catalogKey(config.model)
	? { key: config.model, name: config.model.split("/").pop() ?? config.model, note: "Set with AGENCY_MODEL", bedrock: "", price: [0, 0] }
	: undefined;

function catalogKey(model: string): string | undefined {
	const id = model.split("/").pop() ?? "";
	return CATALOG.find((entry) => id === entry.key || id.endsWith(`.anthropic.${entry.bedrock}`))?.key;
}

function catalog(): CatalogEntry[] {
	if (custom) return [custom];
	return provider === "bedrock" ? CATALOG.filter((entry) => !entry.notOn?.includes(bedrockPrefix())) : CATALOG;
}

/** The model the deploy was set up with: what every app used before models could be chosen. */
const setupModel = custom?.key ?? (config.model ? catalogKey(config.model)! : PI_DEFAULT);

interface Saved {
	allowed: string[];
	default: string;
}

export class ModelError extends Error {}

async function saved(): Promise<Saved> {
	const value = await getSetting<Saved>("models");
	const keys = new Set(catalog().map((entry) => entry.key));
	const allowed = (value?.allowed ?? []).filter((key) => keys.has(key));
	if (allowed.length === 0) return { allowed: [setupModel], default: setupModel };
	return { allowed, default: allowed.includes(value!.default) ? value!.default : allowed[0] };
}

function view(entry: CatalogEntry) {
	return { key: entry.key, name: entry.name, note: entry.note, price: entry.price[0] ? entry.price : null };
}

/** What members may pick in the chat, and the default. */
export async function allowedModels() {
	const { allowed, default: fallback } = await saved();
	return { models: catalog().filter((entry) => allowed.includes(entry.key)).map(view), default: fallback };
}

/** The full catalog for the admin's Models settings. */
export async function modelSettings() {
	const { allowed, default: fallback } = await saved();
	return { provider, models: catalog().map(view), allowed, default: fallback, setupModel };
}

export async function saveModelSettings(input: { allowed?: unknown; default?: unknown }) {
	const keys = new Set(catalog().map((entry) => entry.key));
	const allowed = [...new Set(Array.isArray(input.allowed) ? input.allowed.map(String) : [])].filter((key) => keys.has(key));
	if (allowed.length === 0) throw new ModelError("Allow at least one model");
	const fallback = String(input.default ?? "");
	if (!allowed.includes(fallback)) throw new ModelError("The default model must be one of the allowed models");
	await putSetting("models", { allowed, default: fallback } satisfies Saved);
	return modelSettings();
}

/** pi's --model value for a member's choice: the chosen model if it is allowed, else the organization default. */
export async function resolveModel(requested?: string): Promise<string> {
	const { allowed, default: fallback } = await saved();
	const key = requested && allowed.includes(requested) ? requested : fallback;
	const entry = catalog().find((e) => e.key === key)!;
	return entry === custom ? entry.key : piModel(entry);
}
