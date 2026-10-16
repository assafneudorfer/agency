// Code editor for the code view: CodeMirror 6, loaded only when someone opens the Code tab.
// Modules come from the platform's node_modules through /vendor/esm (see the import map in index.html).

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";

function languageFor(path) {
	const ext = path.split(".").pop().toLowerCase();
	if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
	if (ext === "tsx") return javascript({ typescript: true, jsx: true });
	if (["js", "mjs", "cjs"].includes(ext)) return javascript();
	if (ext === "jsx") return javascript({ jsx: true });
	if (ext === "css") return css();
	if (ext === "html" || ext === "htm") return html();
	if (ext === "json") return json();
	if (ext === "md" || ext === "mdx") return markdown();
	return [];
}

// Colors come from CSS variables, so the editor follows the app's light and dark themes.
const highlight = HighlightStyle.define([
	{ tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
	{ tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
	{ tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
	{ tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
	{ tag: [t.tagName, t.angleBracket], color: "var(--syn-tag)" },
	{ tag: [t.attributeName], color: "var(--syn-attr)" },
	{ tag: [t.propertyName], color: "var(--syn-property)" },
	{ tag: [t.heading], fontWeight: "600" },
	{ tag: [t.link, t.url], color: "var(--accent)" },
	{ tag: t.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
	"&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--surface)", color: "var(--text)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65" },
	".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
	".cm-line": { padding: "0 16px 0 12px" },
	".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-3)", border: "none", paddingLeft: "8px" },
	".cm-lineNumbers .cm-gutterElement": { minWidth: "32px" },
	".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surface-2) 70%, transparent)" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
	".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
	".cm-matchingBracket": { backgroundColor: "var(--surface-3)", outline: "none" },
	".cm-searchMatch": { backgroundColor: "rgb(240 180 40 / 0.25)" },
	".cm-foldGutter .cm-gutterElement": { color: "var(--text-3)" },
	".cm-tooltip": { border: "1px solid var(--border)", borderRadius: "8px", backgroundColor: "var(--surface)", boxShadow: "var(--shadow-lg)", overflow: "hidden" },
	".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
	".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)", borderColor: "var(--border)" },
	".cm-panel input, .cm-panel button": { fontFamily: "var(--font)", fontSize: "12px" },
	".cm-textfield": { borderRadius: "6px", border: "1px solid var(--border-strong)", backgroundColor: "var(--surface)" },
	".cm-button": { borderRadius: "6px", backgroundImage: "none", backgroundColor: "var(--surface)", border: "1px solid var(--border-strong)" },
});

/**
 * Creates an editor in `parent`. `onChange(text)` fires on every edit, `onSave()` on Cmd/Ctrl+S.
 * Returns open(path, text) to show another file, setReadOnly(flag) and destroy().
 */
export function createEditor(parent, { onChange, onSave }) {
	const language = new Compartment();
	const readOnly = new Compartment();

	const extensions = (path, locked) => [
		// Saving runs first so the browser never opens its own save dialog.
		keymap.of([
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					onSave();
					return true;
				},
			},
		]),
		basicSetup,
		theme,
		syntaxHighlighting(highlight),
		language.of(languageFor(path)),
		readOnly.of([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) onChange(update.state.doc.toString());
		}),
	];

	let locked = false;
	const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions("", false) }) });

	return {
		open(path, text) {
			// A fresh state per file, so undo history never crosses files.
			view.setState(EditorState.create({ doc: text, extensions: extensions(path, locked) }));
			view.scrollDOM.scrollTop = 0;
		},
		setReadOnly(flag) {
			locked = flag;
			view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(flag), EditorView.editable.of(!flag)]) });
		},
		focus() {
			view.focus();
		},
		destroy() {
			view.destroy();
		},
	};
}
