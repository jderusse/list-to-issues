import { addressParser } from "postal-mime";

export interface Address {
	address: string;
	name: string;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function normalizeAddress(address: string): string {
	return address.trim().replace(/^<|>$/g, "").toLowerCase();
}

export function isValidAddress(address: string): boolean {
	const normalized = normalizeAddress(address);

	return normalized.length <= 254 && ADDRESS.test(normalized);
}

// A display name that is safe to put in a header: no control character, so no CRLF injection.
export function sanitizeDisplayName(name: string): string {
	return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/["<>\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

// A header value without control characters, for subjects and other free text.
export function sanitizeHeaderValue(value: string, maxLength = 900): string {
	return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function parseAddressList(value: string | null | undefined): Address[] {
	if (!value) {
		return [];
	}

	return toAddresses(addressParser(value, { flatten: true }));
}

export function toAddresses(list: { address?: string; name: string; group?: { address: string; name: string }[] }[] | undefined): Address[] {
	const addresses: Address[] = [];
	for (const entry of list ?? []) {
		for (const mailbox of entry.group ?? [entry]) {
			if (mailbox.address && isValidAddress(mailbox.address)) {
				addresses.push({ address: normalizeAddress(mailbox.address), name: sanitizeDisplayName(mailbox.name ?? "") });
			}
		}
	}

	return addresses;
}

export function uniqueAddresses(list: Address[], exclude: string[] = [], max = 20): Address[] {
	const seen = new Set(exclude.filter((address) => "" !== address));
	const unique: Address[] = [];
	for (const entry of list) {
		if (!seen.has(entry.address)) {
			seen.add(entry.address);
			unique.push(entry);
		}
	}

	return unique.slice(0, max);
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}
