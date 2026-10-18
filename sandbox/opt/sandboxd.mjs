// sandboxd: runs commands for the Agency platform when the sandbox is an ECS task on AWS Fargate, where
// there is no `docker exec`. Only the Agency server can reach this port (security group), and every
// request needs the app's own token.
//
// POST /exec: the body is a 4-byte length, a JSON spec {argv, env, cwd}, then the command's stdin.
// The response is frames of [type (1 byte), length (4 bytes), data]: 1 stdout, 2 stderr, 3 exit code.
// Ending the request body closes stdin; dropping the request kills the command.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const token = Buffer.from(process.env.AGENCY_SANDBOXD_TOKEN ?? "");
const port = Number(process.env.AGENCY_SANDBOXD_PORT ?? 7070);

function authorized(req) {
	const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
	return token.length > 0 && given.length === token.length && timingSafeEqual(given, token);
}

createServer((req, res) => {
	if (req.url === "/health") return res.end("ok");
	if (req.method !== "POST" || req.url !== "/exec") {
		res.statusCode = 404;
		return res.end();
	}
	if (!authorized(req)) {
		res.statusCode = 401;
		return res.end();
	}
	let head = Buffer.alloc(0);
	let child;
	let ended = false;
	const frame = (type, data) => {
		if (ended) return;
		const header = Buffer.alloc(5);
		header[0] = type;
		header.writeUInt32BE(data.length, 1);
		res.write(Buffer.concat([header, data]));
	};
	const exit = (code) => {
		const data = Buffer.alloc(4);
		data.writeInt32BE(code);
		frame(3, data);
		ended = true;
		res.end();
	};
	const run = (spec, rest) => {
		res.writeHead(200, { "content-type": "application/octet-stream" });
		res.flushHeaders();
		child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd ?? "/workspace", env: { ...process.env, ...spec.env } });
		child.stdout.on("data", (data) => frame(1, data));
		child.stderr.on("data", (data) => frame(2, data));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			frame(2, Buffer.from(`${error.message}\n`));
			exit(127);
		});
		child.on("close", (code, signal) => exit(code ?? (signal ? 137 : 1)));
		if (rest.length > 0) child.stdin.write(rest);
		if (req.readableEnded) child.stdin.end();
	};
	req.on("data", (chunk) => {
		if (child) return child.stdin.write(chunk);
		head = Buffer.concat([head, chunk]);
		if (head.length < 4 || head.length < 4 + head.readUInt32BE(0)) return;
		const size = head.readUInt32BE(0);
		run(JSON.parse(head.subarray(4, 4 + size).toString()), head.subarray(4 + size));
	});
	req.on("end", () => child?.stdin.end());
	res.on("close", () => {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
}).listen(port, () => console.log(`[sandboxd] listening on :${port}`));
