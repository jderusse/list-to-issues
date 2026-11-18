import type { Address } from "./addresses";
import { MailError, type Mailer, type OutgoingEmail } from "./app";

// Errors of the email service that are worth another attempt
const TRANSIENT = new Set(["E_RATE_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_EMAIL_SENDING_NOT_READY"]);

function recipient(address: Address): string | EmailAddress {
	return "" === address.name ? address.address : { email: address.address, name: address.name };
}

export class CloudflareMailer implements Mailer {
	constructor(private readonly binding: SendEmail) {}

	async send(mail: OutgoingEmail): Promise<string> {
		try {
			const result = await this.binding.send({
				to: recipient(mail.to),
				...(mail.cc.length > 0 ? { cc: mail.cc.map(recipient) } : {}),
				from: recipient(mail.from),
				replyTo: mail.replyTo,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
				headers: mail.headers,
				attachments: mail.attachments.map((attachment) => ({ ...attachment, disposition: "attachment" as const })),
			});

			return result.messageId.trim().replace(/^<|>$/g, "");
		} catch (error) {
			const code = error instanceof Error && "code" in error && "string" === typeof error.code ? error.code : "E_UNKNOWN";

			throw new MailError(code, TRANSIENT.has(code));
		}
	}
}
