import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import { config } from "./config.ts";
import { credentialsFromFile } from "./ecs.ts";
import { deleteSetting, getSetting, putSetting } from "./settings.ts";

/**
 * Email from the platform, such as telling an owner their app was taken down. Two ways to send:
 *
 * - An SMTP server an admin enters in Settings > Email (any setup: Gmail or Microsoft 365, SendGrid,
 *   Amazon SES's SMTP interface, the company's own server). It wins when set.
 * - Amazon SES in the all-AWS setup, with no stored keys: the host assumes a send-only role and refreshes
 *   its short-lived keys (infra/aws/host/agency-aws-credentials), and Terraform verifies the domain.
 *
 * With neither, nothing is sent and the message goes to the log.
 */

export class MailError extends Error {}

export interface Smtp {
	host: string;
	port: number;
	// "tls": TLS from the start (usually port 465). "starttls": upgrade a plain connection (587). "none": no encryption.
	security: "tls" | "starttls" | "none";
	username: string;
	password: string;
	from: string;
}

export interface Message {
	to: string;
	subject: string;
	text: string;
}

const ses = config.mail.sesCredentialsFile
	? new SESv2Client({ region: config.awsRegion, credentials: () => credentialsFromFile(config.mail.sesCredentialsFile) })
	: undefined;

/** How mail goes out, for the Settings page. The SMTP password never leaves the server. */
export async function mailView() {
	const smtp = await getSetting<Smtp>("smtp");
	return {
		ses: ses ? { from: config.mail.from } : null,
		smtp: smtp ? { ...smtp, password: undefined, hasPassword: Boolean(smtp.password) } : null,
	};
}

export async function saveSmtp(input: Partial<Smtp>): Promise<ReturnType<typeof mailView>> {
	const before = await getSetting<Smtp>("smtp");
	const host = (input.host ?? "").trim();
	const from = (input.from ?? "").trim();
	const port = Number(input.port);
	const security = input.security ?? "starttls";
	if (!host) throw new MailError("Enter the SMTP server's host name");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("Enter the SMTP port, usually 587 or 465");
	if (!["tls", "starttls", "none"].includes(security)) throw new MailError("Pick how to connect");
	if (!/^[^\s@<>]+@[^\s@<>]+$/.test(from.replace(/^.*<(.+)>\s*$/, "$1"))) throw new MailError('Enter a sender address, like "Agency <agency@example.com>"');
	const username = (input.username ?? "").trim();
	// An empty password keeps the saved one, as long as the user name stays the same.
	const password = input.password || (before && before.username === username ? before.password : "");
	await putSetting("smtp", { host, port, security, username, password, from } satisfies Smtp);
	return mailView();
}

export async function removeSmtp(): Promise<ReturnType<typeof mailView>> {
	await deleteSetting("smtp");
	return mailView();
}

/** Whether the platform has a way to send email. */
export async function canSendMail(): Promise<boolean> {
	return Boolean(ses || (await getSetting<Smtp>("smtp")));
}

/** Sends a plain-text email. Returns false, after logging it, when no way to send is set up. */
export async function sendMail(message: Message): Promise<boolean> {
	const smtp = await getSetting<Smtp>("smtp");
	if (smtp) {
		const transport = nodemailer.createTransport({
			host: smtp.host,
			port: smtp.port,
			secure: smtp.security === "tls",
			requireTLS: smtp.security === "starttls",
			ignoreTLS: smtp.security === "none",
			auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
			connectionTimeout: 20_000,
		});
		try {
			await transport.sendMail({ from: smtp.from, to: message.to, subject: message.subject, text: message.text });
		} catch (error) {
			throw new MailError(`The SMTP server refused the email: ${error instanceof Error ? error.message : error}`);
		} finally {
			transport.close();
		}
		return true;
	}
	if (ses) {
		await ses.send(
			new SendEmailCommand({
				FromEmailAddress: config.mail.from,
				Destination: { ToAddresses: [message.to] },
				Content: { Simple: { Subject: { Data: message.subject, Charset: "UTF-8" }, Body: { Text: { Data: message.text, Charset: "UTF-8" } } } },
			}),
		);
		return true;
	}
	console.log(`[mail] no way to send email is set up (Settings > Email); not sent to ${message.to}: ${message.subject}`);
	return false;
}
