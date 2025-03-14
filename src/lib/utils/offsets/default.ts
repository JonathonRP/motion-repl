import { fillOffset } from './fill';

export function defaultOffset(arr: unknown[]): number[] {
	const offset = [0];
	fillOffset(offset, arr.length - 1);
	return offset;
}