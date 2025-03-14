import type { MotionProps } from "../../motion/types";
import { DOMVisual } from "../dom/DOMVisual";
import type { DOMVisualOptions } from "../dom/types";
import { isCSSVariableName } from "../dom/utils/is-css-variable";
import { getDefaultValueType } from "../dom/value-types/defaults";
import type { ResolvedValues } from "../types";
import type { HTMLRenderState } from "./types";
import { buildHTMLStyles } from "./utils/build-styles";
import { renderHTML } from "./utils/render";
import { transformProps } from "./utils/transform";

export function getComputedStyle(element: HTMLElement) {
	return window.getComputedStyle(element);
}

export class HTMLVisual extends DOMVisual<HTMLElement, HTMLRenderState, DOMVisualOptions> {
	readValueFromInstance(instance: HTMLElement, key: string): string | number | null | undefined {
		if (transformProps.has(key)) {
			const defaultType = getDefaultValueType(key);
			return defaultType ? defaultType.default || 0 : 0;
		} else {
			const computedStyle = getComputedStyle(instance);
			const value =
				(isCSSVariableName(key)
					? computedStyle.getPropertyValue(key)
					: computedStyle[key as keyof typeof computedStyle]) || 0;

			return typeof value === 'string' ? value.trim() : (value as number);
		}
	}

	build(renderState: HTMLRenderState, latestValues: ResolvedValues, props: MotionProps) {
		buildHTMLStyles(renderState, latestValues, props.transformTemplate);
	}

	renderInstance = renderHTML;
}