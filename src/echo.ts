import { hmacHex, timingSafeEqual } from "./crypto";

// Every outbound email carries this header. The Message-ID is chosen by the email
// service and only known after sending, so it can't identify our own emails in time.
export async function echoHeader(commentId: number, secret: string): Promise<string> {
	return `${commentId}.${await hmacHex(secret, `echo:${commentId}`)}`;
}

// Returns the id of the comment that was emailed, or null when the value isn't ours.
export async function verifyEchoHeader(value: string | null, secret: string): Promise<number | null> {
	const match = /^(\d{1,20})\.([0-9a-f]{64})$/.exec(value ?? "");
	if (null === match) {
		return null;
	}

	return (await timingSafeEqual(match[2]!, await hmacHex(secret, `echo:${match[1]}`))) ? Number(match[1]) : null;
}
