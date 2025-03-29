import type { VariantLabels } from "../motion/types";
import type { Point } from "../projection/geometry/types";
import type { TargetAndTransition } from "../types";

/**
 * Passed in to tap event handlers like `onTap` the `TapInfo` object contains
 * information about the tap gesture such as it‘s location.
 *
 * ```jsx
 * function onTap(event, info) {
 *   console.log(info.point.x, info.point.y)
 * }
 *
 * <motion.div onTap={onTap} />
 * ```
 *
 * @public
 */
export interface TapInfo {
	/**
	 * Contains `x` and `y` values for the tap gesture relative to the
	 * device or page.
	 *
	 * ```jsx
	 * function onTapStart(event, info) {
	 *   console.log(info.point.x, info.point.y)
	 * }
	 *
	 * <motion.div onTapStart={onTapStart} />
	 * ```
	 *
	 * @public
	 */
	point: Point;
}

/**
 * @public
 */
export interface TapHandlers {
	/**
	 * Callback when the tap gesture successfully ends on this element.
	 *
	 * ```jsx
	 * function onTap(event, info) {
	 *   console.log(info.point.x, info.point.y)
	 * }
	 *
	 * <motion.div onTap={onTap} />
	 * ```
	 *
	 * @param event - The originating pointer event.
	 * @param info - An {@link TapInfo} object containing `x` and `y` values for the `point` relative to the device or page.
	 */
	onTap?(event: MouseEvent | TouchEvent | PointerEvent, info: TapInfo): void;

	/**
	 * Callback when the tap gesture starts on this element.
	 *
	 * ```jsx
	 * function onTapStart(event, info) {
	 *   console.log(info.point.x, info.point.y)
	 * }
	 *
	 * <motion.div onTapStart={onTapStart} />
	 * ```
	 *
	 * @param event - The originating pointer event.
	 * @param info - An {@link TapInfo} object containing `x` and `y` values for the `point` relative to the device or page.
	 */
	onTapStart?(event: MouseEvent | TouchEvent | PointerEvent, info: TapInfo): void;

	/**
	 * Callback when the tap gesture ends outside this element.
	 *
	 * ```jsx
	 * function onTapCancel(event, info) {
	 *   console.log(info.point.x, info.point.y)
	 * }
	 *
	 * <motion.div onTapCancel={onTapCancel} />
	 * ```
	 *
	 * @param event - The originating pointer event.
	 * @param info - An {@link TapInfo} object containing `x` and `y` values for the `point` relative to the device or page.
	 */
	onTapCancel?(event: MouseEvent | TouchEvent | PointerEvent, info: TapInfo): void;

	/**
	 * Properties or variant label to animate to while the component is pressed.
	 *
	 * ```jsx
	 * <motion.div whileTap={{ scale: 0.8 }} />
	 * ```
	 */
	whileTap?: VariantLabels | TargetAndTransition;

	/**
	 * If `true`, the tap gesture will attach its start listener to window.
	 *
	 * Note: This is not supported publically.
	 */
	globalTapTarget?: boolean;
}