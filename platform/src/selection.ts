/**
 * "Change this": the person picked an element or an area in the preview (platform/web/preview-select.js)
 * and typed what to change. The pick arrives as JSON next to the message and is turned into text the
 * agent can act on. Everything in it comes from the browser, so it is cut to size and never trusted
 * as anything but a hint.
 */

/** First words of the block appended to a prompt; the builder parses the line back to draw a chip. */
export const SELECTION_HEADING = "Selected in the preview at";

interface Described {
	tag: string;
	selector: string;
	text: string;
	html?: string;
	components?: string[];
}

const str = (value: unknown, max: number): string => {
	const text = typeof value === "string" ? value : "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
};
const num = (value: unknown): number => (Number.isFinite(value) ? Math.round(value as number) : 0);
const line = (value: unknown, max: number): string => str(value, max).replace(/\s+/g, " ").trim();

function described(value: unknown): Described | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const tag = line(v.tag, 40).replace(/[^\w-]/g, "");
	if (!tag) return null;
	return {
		tag,
		selector: line(v.selector, 400),
		text: line(v.text, 200),
		html: str(v.html, 3000).replace(/```/g, "``​`"),
		components: Array.isArray(v.components) ? v.components.slice(0, 8).map((c) => line(c, 60).replace(/[^\w$.]/g, "")).filter(Boolean) : [],
	};
}

/** The text appended to the person's message for a pick, or "" when `raw` isn't one. */
export function selectionContext(raw: unknown): string {
	let value = raw;
	if (typeof value === "string") {
		if (value.length > 20_000) return "";
		try {
			value = JSON.parse(value);
		} catch {
			return "";
		}
	}
	if (!value || typeof value !== "object") return "";
	const v = value as Record<string, unknown>;
	const target = described(v.target);
	if (!target) return "";
	const area = v.kind === "area";
	const page = line(v.page, 200).replace(/:/g, "") || "/";
	const rect = (v.rect ?? {}) as Record<string, unknown>;
	const viewport = (v.viewport ?? {}) as Record<string, unknown>;
	const summary = area ? `an area inside <${target.tag}>` : `<${target.tag}>${target.text ? ` "${line(target.text, 60)}"` : ""}`;
	const out = [`${SELECTION_HEADING} ${page}: ${summary}`];
	if (area) out.push(`- The person dragged over an area of ${num(rect.width)}×${num(rect.height)} px. The smallest element around it:`);
	out.push(`- Element: <${target.tag}>${target.text ? ` with the text "${target.text}"` : ""}`);
	if (target.selector) out.push(`- CSS selector: ${target.selector}`);
	if (target.components?.length) out.push(`- React components (innermost first): ${target.components.join(" < ")}`);
	out.push(
		`- On screen: ${num(rect.width)}×${num(rect.height)} px at (${num(rect.x)}, ${num(rect.y)}) in a ${num(viewport.width)}×${num(viewport.height)} px viewport`,
	);
	if (area && Array.isArray(v.inside)) {
		const inside = v.inside.map(described).filter((d): d is Described => d !== null).slice(0, 12);
		if (inside.length) {
			out.push("- Elements inside the area:");
			for (const d of inside) out.push(`  - <${d.tag}>${d.text ? ` "${line(d.text, 80)}"` : ""} (${d.selector})`);
		}
	}
	if (target.html) out.push("- HTML:", "```html", target.html, "```");
	return out.join("\n");
}

/** The person's message with the pick appended. */
export function promptWithSelection(message: string, context: string): string {
	return context ? `${message}\n\n${context}` : message;
}
