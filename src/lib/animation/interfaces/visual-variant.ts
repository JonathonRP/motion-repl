import type { Visual } from "../../render/Visual";
import { resolveVariant } from "../../render/utils/resolve-dynamic-variants";
import type { VisualAnimationOptions } from "./types";
import { animateTarget } from "./visual-target";

export function animateVariant(
	visual: Visual<unknown>,
	variant: string,
	options: VisualAnimationOptions = {}
) {
	const resolved = resolveVariant(
		visual,
		variant,
		// options.type === 'exit' ? visualElement.presenceContext?.custom : undefined
	);

	let { transition = visual.getDefaultTransition() || {} } = resolved || {};

	if (options.transitionOverride) {
		transition = options.transitionOverride;
	}

	/**
	 * If we have a variant, create a callback that runs it as an animation.
	 * Otherwise, we resolve a Promise immediately for a composable no-op.
	 */
	const getAnimation = resolved
		? () => Promise.all(animateTarget(visual, resolved, options))
		: () => Promise.resolve();

	/**
	 * If we have children, create a callback that runs all their animations.
	 * Otherwise, we resolve a Promise immediately for a composable no-op.
	 */
	const getChildAnimations =
		visual.variantChildren && visual.variantChildren.size
			? (forwardDelay = 0) => {
					const { delayChildren = 0, staggerChildren, staggerDirection } = transition;

					return animateChildren(
						visual,
						variant,
						delayChildren + forwardDelay,
						staggerChildren,
						staggerDirection,
						options
					);
				}
			: () => Promise.resolve();

	/**
	 * If the transition explicitly defines a "when" option, we need to resolve either
	 * this animation or all children animations before playing the other.
	 */
	const { when } = transition;
	if (when) {
		const [first, last] =
			when === 'beforeChildren' ? [getAnimation, getChildAnimations] : [getChildAnimations, getAnimation];

		return first().then(() => last());
	} else {
		return Promise.all([getAnimation(), getChildAnimations(options.delay)]);
	}
}