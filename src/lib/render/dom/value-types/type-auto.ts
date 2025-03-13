import type { ValueType } from '../../../value/types/types';

/**
 * ValueType for "auto"
 */
export const auto: ValueType = {
	test: (v: unknown) => v === 'auto',
	parse: (v) => v,
};