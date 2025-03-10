import type { Visual } from "../../render/Visual";
import { isWillChangeMotionValue } from "./is";

export function addValueToWillChange<I>(visual: Visual<I>, key: string) {
	const willChange = visual.getValue('willChange');

	/**
	 * It could be that a user has set willChange to a regular MotionValue,
	 * in which case we can't add the value to it.
	 */
	if (isWillChangeMotionValue(willChange)) {
		return willChange.add(key);
	}
}