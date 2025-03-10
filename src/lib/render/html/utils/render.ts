import type { MotionStyle } from "../../../motion/types";
import type { HTMLRenderState } from "../types";

export function renderHTML(
	element: HTMLElement,
	{ style, vars }: HTMLRenderState,
	styleProp?: MotionStyle,
) {
	Object.assign(element.style, style);

	// Loop over any CSS variables and assign those.
	for (const key in vars) {
		element.style.setProperty(key, vars[key]);
	}
}