// Lets the Agency builder point at parts of this app's preview ("change this"). The script comes from
// the platform and runs only in the dev server's preview inside the builder, never in the published app.
if (process.env.NODE_ENV === "development" && window.parent !== window) {
	const script = document.createElement("script");
	script.src = `${location.protocol}//${location.host.replace(/^[^.]+\./, "")}/static/preview-select.js`;
	script.async = true;
	document.head.append(script);
}
