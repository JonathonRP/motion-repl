import { isMotionValue } from "../utils/is-motion-value";
import type { WillChange } from "./types";

export function isWillChangeMotionValue(value: unknown): value is WillChange {
	return Boolean(isMotionValue(value) && (value as WillChange).add);
}