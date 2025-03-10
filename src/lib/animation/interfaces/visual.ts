import type { Visual } from "../../render/Visual";
import { resolveVariant } from "../../render/utils/resolve-dynamic-variants";
import type { AnimationDefinition } from "../types";
import type { VisualAnimationOptions } from "./types";
import { animateTarget } from "./visual-target";
import { animateVariant } from "./visual-variant";

export function animateVisual(
	visual: Visual<unknown>,
	definition: AnimationDefinition,
	options: VisualAnimationOptions = {}
) {
	visual.notify('AnimationStart', definition);
	let animation;

	if (Array.isArray(definition)) {
		const animations = definition.map((variant) => animateVariant(visual, variant, options));
		animation = Promise.all(animations);
	} else if (typeof definition === 'string') {
		animation = animateVariant(visual, definition, options);
	} else {
		const resolvedDefinition =
			typeof definition === 'function' ? resolveVariant(visual, definition, options.custom) : definition;

		animation = Promise.all(animateTarget(visual, resolvedDefinition, options));
	}

	return animation.then(() => {
		visual.notify('AnimationComplete', definition);
	});
}