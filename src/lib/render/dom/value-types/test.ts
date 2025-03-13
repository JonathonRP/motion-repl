import type { ValueType } from '../../../value/types/types';

/**
 * Tests a provided value against a ValueType
 */
export const testValueType = (v: unknown) => (type: ValueType) => type.test(v);