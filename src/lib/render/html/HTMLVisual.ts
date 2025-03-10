import type { MotionProps } from "../../motion/types";
import { DOMVisual } from "../dom/DOMVisual";
import type { ResolvedValues } from "../types";
import type { HTMLRenderState } from "./types";
import { buildHTMLStyles } from "./utils/build-styles";
import { renderHTML } from "./utils/render";

export function getComputedStyle(element: HTMLElement) {
	return window.getComputedStyle(element);
}

export abstract class HTMLVisual extends DOMVisual {

	build(renderState: HTMLRenderState, latestValues: ResolvedValues, props: MotionProps) {
		buildHTMLStyles(renderState, latestValues, props.transformTemplate);
	}

	renderInstance = renderHTML;
}