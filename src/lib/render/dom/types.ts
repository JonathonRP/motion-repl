import type { HTMLMotionComponents } from '../html/types';
// import type { SVGMotionComponents } from '../svg/types';

export interface DOMVisualOptions {
	/**
	 * If `true`, this element will be included in the projection tree.
	 *
	 * Default: `true`
	 *
	 * @public
	 */
	allowProjection?: boolean;

	/**
	 * Allow this element to be GPU-accelerated. We currently enable this by
	 * adding a `translateZ(0)`.
	 *
	 * @public
	 */
	enableHardwareAcceleration?: boolean;
}

export type DOMMotionComponents = HTMLMotionComponents // & SVGMotionComponents;