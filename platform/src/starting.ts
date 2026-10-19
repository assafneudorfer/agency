/**
 * The page people see while an app starts: Axel, the mascot, strolls around with a magnifying glass.
 * It is served with a 503 and polls the same address; once the app answers with something other
 * than this page or a gateway error, it reloads into the app. Plain HTML, SVG and CSS, so it works
 * on any app host without the builder's scripts.
 */

/** Marks this page's responses, so its own polling can tell it from the app. */
export const STARTING_HEADER = "X-Agency-Starting";

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const LINES = [
	"Following the clues…",
	"Dusting for fingerprints…",
	"Questioning the server…",
	"Looking under the couch…",
	"Waking up the hamsters…",
	"Connecting the dots…",
	"Checking the alibi of port 3000…",
	"Almost cracked the case…",
];

// Axel: the logo's axolotl in a fedora and trench coat, drawn in parts so each can move.
const AXEL = `<svg class="axel" viewBox="0 0 200 230" aria-hidden="true">
	<ellipse cx="100" cy="221" rx="46" ry="6" fill="#141467" opacity=".12"/>
	<g class="tail"><path d="M66 172c-18 10-38 10-52-4 6-2 12-1 18 1 10 2 22 0 32-7z" fill="#f4a9d0"/><path d="M14 168c8 8 22 12 36 8" fill="none" stroke="#fb86b8" stroke-width="3" stroke-linecap="round"/></g>
	<g class="leg leg-a"><rect x="76" y="186" width="16" height="30" rx="8" fill="#f9c5e4"/><ellipse cx="82" cy="215" rx="11" ry="6" fill="#f4a9d0"/></g>
	<g class="leg leg-b"><rect x="108" y="186" width="16" height="30" rx="8" fill="#f9c5e4"/><ellipse cx="118" cy="215" rx="11" ry="6" fill="#f4a9d0"/></g>
	<path d="M60 196l10-58h60l10 58q-40 10-80 0z" fill="#1b1b7a"/>
	<path d="M70 138h60l-30 34z" fill="#f9c5e4"/>
	<path d="M70 138l30 34-14 10-22-38zM130 138l-30 34 14 10 22-38z" fill="#2a2a9e"/>
	<rect x="62" y="176" width="76" height="8" rx="3" fill="#141467"/>
	<rect x="95" y="175" width="10" height="10" rx="2" fill="none" stroke="#b9b9ff" stroke-width="2.5"/>
	<g class="head">
		<g class="gills gills-l">
			<path d="M46 70c-18-8-30-4-38 4 12 2 24 4 36 8z" fill="#fb86b8"/>
			<path d="M44 86c-20 0-30 8-34 18 12-4 24-8 36-10z" fill="#fb86b8"/>
			<path d="M50 100c-16 6-22 16-22 26 8-8 18-14 28-18z" fill="#fb86b8"/>
		</g>
		<g class="gills gills-r">
			<path d="M154 70c18-8 30-4 38 4-12 2-24 4-36 8z" fill="#fb86b8"/>
			<path d="M156 86c20 0 30 8 34 18-12-4-24-8-36-10z" fill="#fb86b8"/>
			<path d="M150 100c16 6 22 16 22 26-8-8-18-14-28-18z" fill="#fb86b8"/>
		</g>
		<ellipse cx="100" cy="96" rx="60" ry="46" fill="#f9c5e4"/>
		<ellipse cx="66" cy="112" rx="10" ry="6" fill="#fb86b8" opacity=".45"/>
		<ellipse cx="134" cy="112" rx="10" ry="6" fill="#fb86b8" opacity=".45"/>
		<g class="eyes">
			<ellipse cx="78" cy="96" rx="12" ry="14" fill="#141467"/>
			<ellipse cx="122" cy="96" rx="12" ry="14" fill="#141467"/>
			<circle cx="82" cy="90" r="4.5" fill="#fff"/><circle cx="126" cy="90" r="4.5" fill="#fff"/>
			<circle cx="75" cy="101" r="2" fill="#fff"/><circle cx="119" cy="101" r="2" fill="#fff"/>
		</g>
		<path d="M88 118q12 10 24 0" fill="none" stroke="#141467" stroke-width="4" stroke-linecap="round"/>
		<g class="hat">
			<ellipse cx="100" cy="60" rx="66" ry="12" fill="#141467"/>
			<path d="M58 60c0-26 14-44 42-44s42 18 42 44q-42 8-84 0z" fill="#1b1b7a"/>
			<path d="M84 22q16 10 32 0" fill="none" stroke="#141467" stroke-width="5" stroke-linecap="round"/>
			<path d="M59 50q41 9 82 0v9q-41 8-82 0z" fill="#5453f6"/>
		</g>
	</g>
	<g class="arm">
		<rect x="128" y="146" width="34" height="13" rx="6.5" fill="#1b1b7a"/>
		<circle cx="162" cy="152" r="8" fill="#f9c5e4"/>
		<g class="glass">
			<rect x="164" y="128" width="7" height="22" rx="3.5" transform="rotate(32 167 139)" fill="#7a4b2a"/>
			<circle cx="184" cy="112" r="16" fill="#cfe9ff" fill-opacity=".55" stroke="#141467" stroke-width="5"/>
			<path class="glint" d="M175 106a10 10 0 0 1 9-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
		</g>
	</g>
</svg>`;

/** The waiting page for an app that is starting. `why` says, in a sentence, why it takes a moment. */
export function startingPage(name: string, why: string): string {
	const safe = escape(name);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting ${safe}…</title>
<style>
:root{--bg:#fafafb;--text:#111117;--text-2:#5c5c6e;--text-3:#8d8d9e;--floor:rgb(16 16 32/.08);--accent:#5b5bf0;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--text:#ededf2;--text-2:#a3a3b3;--text-3:#6f6f82;--floor:rgb(255 255 255/.08);--accent:#7b7bff}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 "Inter var",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;padding:24px 16px;-webkit-font-smoothing:antialiased;overflow:hidden}
main{width:min(100%,560px);text-align:center}
.stage{--walk:calc(min(100vw - 32px,560px) - 170px);position:relative;height:210px;margin:0 auto 28px;border-bottom:2px dashed var(--floor)}
.stroll{position:absolute;left:0;bottom:-6px;width:170px;animation:stroll 14s cubic-bezier(.45,0,.55,1) infinite}
.stroll::before{content:"";position:absolute;inset:-20px -30px 0;background:radial-gradient(closest-side,rgb(123 123 255/.18),transparent);opacity:0}
@media (prefers-color-scheme:dark){.stroll::before{opacity:1}}
.face{animation:face 14s steps(1) infinite}
.axel{display:block;width:170px;height:auto;overflow:visible}
.body-bob{animation:bob .5s ease-in-out infinite alternate}
.leg{transform-box:fill-box;transform-origin:50% 0}
.leg-a{animation:step .5s ease-in-out infinite alternate}
.leg-b{animation:step .5s ease-in-out infinite alternate-reverse}
.tail{transform-box:fill-box;transform-origin:100% 50%;animation:wag .7s ease-in-out infinite alternate}
.gills{transform-box:fill-box;animation:wiggle 1.4s ease-in-out infinite alternate}
.gills-l{transform-origin:100% 50%}.gills-r{transform-origin:0 50%;animation-delay:-.7s}
.eyes{transform-box:fill-box;transform-origin:50% 50%;animation:blink 4.2s infinite}
.arm{transform-box:fill-box;transform-origin:0 50%;animation:sniff 14s ease-in-out infinite}
.glint{animation:glint 2.4s ease-in-out infinite}
.hat{transform-box:fill-box;transform-origin:50% 100%;animation:tip 14s ease-in-out infinite}
.clue{position:absolute;top:-4px;font:700 22px/1 ui-rounded,system-ui,sans-serif;color:var(--accent);opacity:0;animation:clue 14s ease-out infinite}
.clue-l{left:40px;animation-delay:-7s}
.clue-r{right:24px;animation-delay:-.4s}
h1{font-size:19px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.line{color:var(--text-2);margin:0 0 4px;min-height:1.5em;transition:opacity .25s,transform .25s}
.line.out{opacity:0;transform:translateY(4px)}
.why{color:var(--text-3);font-size:13px;margin:10px auto 0;max-width:24rem}
.slow{display:none;color:var(--text-2);font-size:13px;margin-top:14px}
.slow a{color:var(--accent)}
body.is-slow .slow{display:block}
@keyframes stroll{0%,6%{transform:translateX(0)}44%,56%{transform:translateX(var(--walk))}94%,100%{transform:translateX(0)}}
@keyframes face{0%{transform:scaleX(1)}50%{transform:scaleX(-1)}}
@keyframes bob{from{transform:translateY(0)}to{transform:translateY(-5px)}}
@keyframes step{from{transform:rotate(-14deg)}to{transform:rotate(14deg)}}
@keyframes wag{from{transform:rotate(-10deg)}to{transform:rotate(12deg)}}
@keyframes wiggle{from{transform:rotate(-7deg)}to{transform:rotate(7deg)}}
@keyframes blink{0%,46%,50%,100%{transform:scaleY(1)}48%{transform:scaleY(.1)}}
@keyframes sniff{0%,40%,60%,100%{transform:rotate(0)}46%,54%{transform:rotate(-22deg)}50%{transform:rotate(-14deg)}}
@keyframes glint{0%,70%,100%{opacity:.9}85%{opacity:.2}}
@keyframes tip{0%,46%,54%,100%{transform:rotate(0)}50%{transform:rotate(-8deg) translateY(-3px)}}
@keyframes clue{0%,40%{opacity:0;transform:translateY(10px) scale(.6)}46%{opacity:1;transform:translateY(-6px) scale(1)}58%{opacity:0;transform:translateY(-26px) scale(.9)}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){
.stroll,.face,.body-bob,.leg,.tail,.gills,.arm,.hat,.clue,.glint{animation:none}
.stroll{left:50%;transform:translateX(-50%)}
.line{transition:none}
}
</style></head>
<body>
<main>
	<div class="stage" aria-hidden="true">
		<span class="clue clue-l">?</span><span class="clue clue-r">!</span>
		<div class="stroll"><div class="face"><div class="body-bob">${AXEL}</div></div></div>
	</div>
	<h1>Starting ${safe}</h1>
	<p class="line" aria-live="polite">${LINES[0]}</p>
	<p class="why">${escape(why)}</p>
	<p class="slow">It is taking longer than usual. <a href="">Try again</a></p>
</main>
<script>
(() => {
	const lines = ${JSON.stringify(LINES)};
	const line = document.querySelector(".line");
	let i = 0;
	setInterval(() => {
		line.classList.add("out");
		setTimeout(() => { i = (i + 1) % lines.length; line.textContent = lines[i]; line.classList.remove("out"); }, 250);
	}, 2800);
	// Asks for this same address until the app itself answers, then shows it.
	const started = Date.now();
	async function check() {
		try {
			const res = await fetch(location.href, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
			const waiting = res.headers.has("${STARTING_HEADER}") || (res.status >= 502 && res.status <= 504);
			if (!waiting) return location.reload();
		} catch {}
		if (Date.now() - started > 180000) document.body.classList.add("is-slow");
		setTimeout(check, 2000);
	}
	setTimeout(check, 1500);
})();
</script>
</body></html>`;
}
