// Runs inside an app's preview, inside the builder. The app's instrumentation-client.ts loads it from
// the platform, so it updates with the platform rather than with each app. It lets the person point
// at part of the page: hovering outlines an element, a click picks it and a mouse drag picks an area.
// What was picked (a selector, the HTML, the React components that render it and a screenshot) goes
// to the builder with postMessage, which asks for the change and sends it all to the agent.
(() => {
	if (window.__agencySelect || window.parent === window) return;
	window.__agencySelect = true;

	// The preview is <app>-preview.<domain>; the builder is <domain>. Only it may drive this script.
	const builder = `${location.protocol}//${location.host.replace(/^[^.]+\./, "")}`;
	const post = (message, transfer) => window.parent.postMessage({ source: "agency-preview", ...message }, builder, transfer);

	const ACCENT = "#5b5bf0";
	let active = false;
	let hovered = null;
	let press = null; // { x, y, pointer, dragging }
	let picked = null; // { el?, rect (page coordinates) }
	let pickId = 0;
	// The click (or tap) that picked something still arrives after the pick; it must not reach the page.
	let swallowUntil = 0;
	let host;
	let parts;

	function overlay() {
		if (host?.isConnected) return parts;
		host = document.createElement("agency-select");
		host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
		const root = host.attachShadow({ mode: "open" });
		root.innerHTML = `<style>
			.box{position:fixed;display:none;box-sizing:border-box;border-radius:4px;pointer-events:none}
			.hover{border:1.5px solid ${ACCENT};background:rgb(91 91 240 / .08)}
			.picked{border:2px solid ${ACCENT};background:rgb(91 91 240 / .12);box-shadow:0 0 0 4px rgb(91 91 240 / .18)}
			.drag{border:1.5px dashed ${ACCENT};background:rgb(91 91 240 / .1)}
			.label{position:fixed;display:none;max-width:280px;padding:3px 7px;border-radius:5px;background:${ACCENT};color:#fff;
				font:500 11px/16px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		</style><div class="box hover"></div><div class="box drag"></div><div class="box picked"></div><div class="label"></div>`;
		parts = {
			hover: root.querySelector(".hover"),
			drag: root.querySelector(".drag"),
			picked: root.querySelector(".picked"),
			label: root.querySelector(".label"),
		};
		document.documentElement.append(host);
		return parts;
	}

	function place(box, rect) {
		if (!rect) {
			box.style.display = "none";
			return;
		}
		Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
	}

	function showLabel(text, rect) {
		const { label } = overlay();
		if (!text || !rect) {
			label.style.display = "none";
			return;
		}
		label.textContent = text;
		label.style.display = "block";
		const above = rect.top - 22;
		label.style.left = `${Math.max(2, Math.min(rect.left, innerWidth - label.offsetWidth - 2))}px`;
		label.style.top = `${above >= 2 ? above : Math.min(rect.bottom + 4, innerHeight - 20)}px`;
	}

	// Elements of the page itself: not this overlay, and not the page's root when something smaller is there.
	function elementAt(x, y) {
		const el = document.elementFromPoint(x, y);
		if (!el || el === host) return null;
		return el;
	}

	// ---- What the agent learns about the pick ---------------------------------------------------

	// Next.js and React wrappers that every page has; they say nothing about the app's own code.
	const FRAMEWORK =
		/^(?:Anonymous|Fragment|Suspense|StrictMode|Root|ServerRoot|AppRouter|Router|HotReload|ReactDevOverlay|DevRoot.*|.*Boundary.*|.*LayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|.*ScrollHandler|LoadingBoundary|SegmentViewNode|SegmentStateProvider|.*Provider|.*Context|Head|MetadataOutlet|OutletBoundary|ViewportBoundary|MetadataBoundary|AsyncMetadata.*|__next_.*|ClientPageRoot|ClientSegmentRoot|AppDevOverlay.*|Link|LinkComponent|Image|Script)$/;

	function fiberOf(el) {
		for (const key in el) if (key.startsWith("__reactFiber$")) return el[key];
		return null;
	}

	/** Names of the app's React components that render `el`, innermost first: client components and, in development, server components. */
	function components(el) {
		const names = [];
		const add = (name) => {
			if (typeof name !== "string" || !name || FRAMEWORK.test(name) || names.at(-1) === name) return;
			names.push(name);
		};
		try {
			let fiber = fiberOf(el);
			for (let depth = 0; fiber && depth < 400 && names.length < 8; depth++, fiber = fiber.return) {
				const type = fiber.type;
				if (typeof type === "function" || (type && typeof type === "object")) add(type.displayName || type.name || type.render?.name || type.type?.name);
				for (const info of fiber._debugInfo ?? []) add(info?.name);
			}
		} catch {}
		return names.filter((name) => /^[A-Z]/.test(name));
	}

	function cssPath(el) {
		const steps = [];
		for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
			if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
				steps.unshift(`#${CSS.escape(node.id)}`);
				break;
			}
			let step = node.localName;
			const classes = [...node.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
			if (classes.length) step += classes.map((c) => `.${c}`).join("");
			const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
			if (same.length > 1) step += `:nth-of-type(${same.indexOf(node) + 1})`;
			steps.unshift(step);
			if (node === document.body) break;
		}
		return steps.join(" > ");
	}

	const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
	const textOf = (el) => clip((el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim(), 200);

	function htmlOf(el) {
		const html = el.outerHTML
			.replace(/(src|href|srcset)="data:[^"]{60,}"/g, '$1="data:…"')
			.replace(/="([^"]{300})[^"]+"/g, '="$1…"')
			.replace(/<!--[\s\S]*?-->/g, "");
		return clip(html, 2500);
	}

	function describe(el) {
		return { tag: el.localName, selector: cssPath(el), text: textOf(el), html: htmlOf(el), components: components(el) };
	}

	function labelFor(el) {
		const name = components(el)[0];
		return name ? `${el.localName} · ${name}` : el.localName;
	}

	const pageRect = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height });
	const viewRect = (r) => ({ left: r.left - scrollX, top: r.top - scrollY, width: r.width, height: r.height, bottom: r.top - scrollY + r.height });
	const rounded = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });

	/** The elements a dragged area covers: the smallest element around all of it, and the outermost elements fully inside. */
	function areaContents(rect) {
		const inside = (r) => r.width > 0 && r.height > 0 && r.left >= rect.left - 2 && r.top >= rect.top - 2 && r.right <= rect.right + 2 && r.bottom <= rect.bottom + 2;
		let container = elementAt(rect.left + rect.width / 2, rect.top + rect.height / 2) ?? document.body;
		while (container.parentElement && container !== document.body) {
			const r = container.getBoundingClientRect();
			if (r.left <= rect.left + 1 && r.top <= rect.top + 1 && r.right >= rect.right - 1 && r.bottom >= rect.bottom - 1) break;
			container = container.parentElement;
		}
		const found = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (found.length >= 12 || child === host) continue;
				const style = getComputedStyle(child);
				if (style.display === "none" || style.visibility === "hidden") continue;
				if (inside(child.getBoundingClientRect())) found.push(child);
				else walk(child);
			}
		};
		walk(container);
		return { container, found };
	}

	// ---- Screenshot of the pick -------------------------------------------------------------------
	// The page is copied with its computed styles into an SVG foreignObject and drawn on a canvas. Images
	// and fonts are inlined from the app's own origin; anything that would taint the canvas is left out.

	const MAX_NODES = 2500;

	async function dataUrl(url) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(String(response.status));
		const blob = await response.blob();
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	async function fontFaces() {
		const rules = [];
		for (const sheet of document.styleSheets) {
			let list;
			try {
				list = sheet.cssRules;
			} catch {
				continue;
			}
			for (const rule of list) if (rule instanceof CSSFontFaceRule) rules.push({ css: rule.cssText, base: sheet.href ?? location.href });
		}
		const out = [];
		for (const { css, base } of rules.slice(0, 12)) {
			let text = css;
			for (const [, raw] of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
				if (raw.startsWith("data:")) continue;
				const url = new URL(raw, base);
				if (url.origin !== location.origin) continue;
				try {
					text = text.replace(raw, await dataUrl(url.href));
				} catch {}
			}
			out.push(text);
		}
		return out.join("\n");
	}

	function copyStyle(from, to) {
		const cs = getComputedStyle(from);
		let css = "";
		for (let i = 0; i < cs.length; i++) {
			const name = cs[i];
			css += `${name}:${cs.getPropertyValue(name)};`;
		}
		to.setAttribute("style", css);
	}

	function cloneTree(node, images, count) {
		if (node.nodeType === 3) return node.cloneNode();
		if (node.nodeType !== 1 || node === host || ++count.n > MAX_NODES) return null;
		const tag = node.localName;
		if (tag === "script" || tag === "noscript" || tag === "template" || tag === "link" || tag === "style") return null;
		if (tag === "iframe" || tag === "video" || tag === "canvas") {
			const box = document.createElement("div");
			copyStyle(node, box);
			if (tag === "canvas") {
				try {
					const img = document.createElement("img");
					img.src = node.toDataURL();
					img.setAttribute("style", box.getAttribute("style"));
					return img;
				} catch {}
			}
			return box;
		}
		const copy = node.cloneNode(false);
		copyStyle(node, copy);
		copy.removeAttribute("class");
		if (tag === "img") {
			copy.removeAttribute("srcset");
			copy.removeAttribute("loading");
			images.push([node, copy]);
		}
		if (tag === "input" || tag === "textarea") copy.setAttribute("value", node.value);
		if (tag === "textarea") copy.textContent = node.value;
		for (const child of node.childNodes) {
			const c = cloneTree(child, images, count);
			if (c) copy.append(c);
		}
		return copy;
	}

	function inlineImage([source, copy]) {
		try {
			if (!source.complete || !source.naturalWidth) throw new Error("not loaded");
			const canvas = document.createElement("canvas");
			canvas.width = source.naturalWidth;
			canvas.height = source.naturalHeight;
			canvas.getContext("2d").drawImage(source, 0, 0);
			copy.src = canvas.toDataURL();
		} catch {
			copy.removeAttribute("src");
		}
	}

	function backgroundOf(el) {
		for (let node = el; node; node = node.parentElement) {
			const bg = getComputedStyle(node).backgroundColor;
			if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
		}
		return "#ffffff";
	}

	/** A PNG of `rect` (viewport coordinates) as it looks inside `el`, or null when the page can't be drawn. */
	async function snapshot(el, rect) {
		const box = el.getBoundingClientRect();
		const images = [];
		const clone = cloneTree(el, images, { n: 0 });
		if (!clone) return null;
		images.forEach(inlineImage);
		clone.style.margin = "0";
		clone.style.position = "relative";
		clone.style.inset = "auto";
		clone.style.transform = "none";
		const fonts = await fontFaces().catch(() => "");
		const width = Math.ceil(box.width);
		const height = Math.ceil(box.height);
		const wrapper = document.createElement("div");
		if (fonts) {
			const style = document.createElement("style");
			style.textContent = fonts;
			wrapper.append(style);
		}
		wrapper.append(clone);
		const markup = new XMLSerializer().serializeToString(wrapper);
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
		const image = new Image();
		image.decoding = "sync";
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = reject;
			image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
		});
		const scale = Math.min(2, devicePixelRatio || 1, 1600 / Math.max(1, rect.width));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(rect.width * scale));
		canvas.height = Math.max(1, Math.round(rect.height * scale));
		const ctx = canvas.getContext("2d");
		ctx.scale(scale, scale);
		ctx.fillStyle = backgroundOf(el);
		ctx.fillRect(0, 0, rect.width, rect.height);
		ctx.drawImage(image, box.left - rect.left, box.top - rect.top);
		return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	}

	// ---- Picking ----------------------------------------------------------------------------------

	function clearHover() {
		hovered = null;
		if (!parts) return;
		place(parts.hover, null);
		showLabel(null);
	}

	function showPicked() {
		if (!parts) return;
		if (!picked) {
			place(parts.picked, null);
			return;
		}
		const rect = picked.el?.isConnected ? picked.el.getBoundingClientRect() : viewRect(picked.rect);
		place(parts.picked, rect);
	}

	async function pick(el, area) {
		const id = ++pickId;
		const rect = area ?? el.getBoundingClientRect();
		let info;
		let target = el;
		if (area) {
			const { container, found } = areaContents(area);
			target = container;
			info = { kind: "area", target: describe(container), inside: found.map((child) => ({ tag: child.localName, selector: cssPath(child), text: textOf(child) })) };
		} else {
			info = { kind: "element", target: describe(el) };
		}
		picked = { el: area ? null : el, rect: pageRect(rect) };
		swallowUntil = performance.now() + 800;
		info.page = location.pathname + location.search;
		info.rect = rounded(rect);
		info.viewport = { width: innerWidth, height: innerHeight };
		info.label = area ? `Area in ${labelFor(target)}` : labelFor(el);
		setActive(false);
		showPicked();
		post({ type: "picked", id, selection: info, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
		let image = null;
		try {
			image = await Promise.race([snapshot(target, rect), new Promise((resolve) => setTimeout(resolve, 4000, null))]);
		} catch {}
		if (id === pickId) post({ type: "snapshot", id, image });
	}

	function block(event) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
	}

	function onPointerMove(event) {
		if (!active) return;
		if (press && event.pointerId === press.pointer && press.mouse) {
			block(event);
			if (!press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press.dragging = true;
			if (press.dragging) {
				clearHover();
				const left = Math.min(press.x, event.clientX);
				const top = Math.min(press.y, event.clientY);
				place(overlay().drag, { left, top, width: Math.abs(event.clientX - press.x), height: Math.abs(event.clientY - press.y) });
			}
			return;
		}
		if (event.pointerType !== "mouse") return;
		const el = elementAt(event.clientX, event.clientY);
		if (el === hovered) return;
		hovered = el;
		const rect = el?.getBoundingClientRect();
		place(overlay().hover, rect);
		showLabel(el && labelFor(el), rect);
	}

	function onPointerDown(event) {
		if (!active || event.button > 0) return;
		block(event);
		press = { x: event.clientX, y: event.clientY, pointer: event.pointerId, mouse: event.pointerType === "mouse", dragging: false };
	}

	function onPointerUp(event) {
		if (!active || !press || event.pointerId !== press.pointer) return;
		block(event);
		const start = press;
		press = null;
		place(overlay().drag, null);
		if (start.dragging) {
			const left = Math.min(start.x, event.clientX);
			const top = Math.min(start.y, event.clientY);
			const width = Math.abs(event.clientX - start.x);
			const height = Math.abs(event.clientY - start.y);
			if (width > 8 && height > 8) return void pick(null, { left, top, width, height, right: left + width, bottom: top + height });
		}
		const el = elementAt(event.clientX, event.clientY);
		if (el) pick(el);
	}

	function onPointerCancel() {
		// A finger that scrolls the page instead of tapping.
		press = null;
		if (parts) place(parts.drag, null);
	}

	function swallow(event) {
		if (active || performance.now() < swallowUntil) block(event);
	}

	function onKey(event) {
		if (event.key !== "Escape" || (!active && !picked)) return;
		block(event);
		setActive(false);
		clear();
		post({ type: "cancel" });
	}

	function setActive(on) {
		active = on;
		press = null;
		if (on) {
			overlay();
			document.documentElement.style.setProperty("cursor", "crosshair", "important");
		} else {
			document.documentElement.style.removeProperty("cursor");
			clearHover();
			if (parts) place(parts.drag, null);
		}
	}

	function clear() {
		pickId++;
		picked = null;
		showPicked();
	}

	const capture = { capture: true, passive: false };
	addEventListener("pointermove", onPointerMove, capture);
	addEventListener("pointerdown", onPointerDown, capture);
	addEventListener("pointerup", onPointerUp, capture);
	addEventListener("pointercancel", onPointerCancel, capture);
	for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "submit", "dragstart"]) addEventListener(type, swallow, capture);
	addEventListener("keydown", onKey, capture);
	document.documentElement.addEventListener("mouseleave", () => active && clearHover());
	let frame = 0;
	const follow = () => {
		if (!picked || frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			showPicked();
			const rect = picked?.el?.isConnected ? picked.el.getBoundingClientRect() : picked && viewRect(picked.rect);
			if (rect) post({ type: "moved", rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
		});
	};
	addEventListener("scroll", follow, { capture: true, passive: true });
	addEventListener("resize", follow);

	addEventListener("message", (event) => {
		if (event.origin !== builder || event.source !== window.parent || event.data?.source !== "agency-builder") return;
		const { type } = event.data;
		if (type === "select") {
			if (event.data.on) clear();
			setActive(Boolean(event.data.on));
		}
		if (type === "clear") {
			setActive(false);
			clear();
		}
	});

	post({ type: "ready" });
})();
