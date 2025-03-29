import { HTMLVisual } from "../html/HTMLVisual";
import type { CreateVisual, VisualOptions } from "../types";
import { createAnimationState } from "../utils/animation-state";

export const createDomVisual: CreateVisual<HTMLElement> = (Component: string, options: VisualOptions<HTMLElement>) => {
	const visual = new HTMLVisual(options, {});
	return visual;
}