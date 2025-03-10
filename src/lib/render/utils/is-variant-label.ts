export function isVariantLabel(v: unknown): v is string | string[] {
	return typeof v === 'string' || Array.isArray(v);
}