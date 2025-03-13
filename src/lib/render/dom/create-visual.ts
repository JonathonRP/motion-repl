import { HTMLVisual } from "../html/HTMLVisual";
import type { CreateVisual, VisualOptions } from "../types";
import { createAnimationState } from "../utils/animation-state";

export const createDomVisual: CreateVisual<HTMLElement> = (Component: string, options: VisualOptions<HTMLElement>) => {
	const visual = new HTMLVisual(options, {});
	// this is handled in a feature class called animation.
	visual.animationState ||= createAnimationState(visual);

	return visual;
}