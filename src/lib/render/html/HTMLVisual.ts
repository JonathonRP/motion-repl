import type { MotionProps } from "../../motion/types";
import { DOMVisual } from "../dom/DOMVisual";
import type { DOMVisualOptions } from "../dom/types";
import type { ResolvedValues } from "../types";
import type { HTMLRenderState } from "./types";
import { buildHTMLStyles } from "./utils/build-styles";
import { renderHTML } from "./utils/render";

export function getComputedStyle(element: HTMLElement) {
	return window.getComputedStyle(element);
}

export class HTMLVisual extends DOMVisual<HTMLElement, HTMLRenderState, DOMVisualOptions> {

	build(renderState: HTMLRenderState, latestValues: ResolvedValues, props: MotionProps) {
		buildHTMLStyles(renderState, latestValues, props.transformTemplate);
	}

	renderInstance = renderHTML;
}