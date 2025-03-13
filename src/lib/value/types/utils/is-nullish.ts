export function isNullish(v: unknown): v is null | undefined {
	return v == null;
}