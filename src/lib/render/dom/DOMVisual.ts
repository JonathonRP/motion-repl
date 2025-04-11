import type { MotionProps, MotionStyle } from "../../motion/types";
import type { MotionValue } from "../../value";
import { Visual } from "../Visual.svelte";
import type { HTMLRenderState } from "../html/types";
import { DOMKeyframesResolver } from "./DOMKeyframesResolver";
import type { DOMVisualOptions } from "./types";

export abstract class DOMVisual<
    Instance extends HTMLElement = HTMLElement,
    State extends HTMLRenderState = HTMLRenderState,
    Options extends DOMVisualOptions = DOMVisualOptions
> extends Visual<Instance, State, Options> {
	getBaseTargetFromProps(props: MotionProps, key: string): string | number | MotionValue<any> | undefined {
		return props.style ? (props.style[key as keyof MotionStyle] as string) : undefined;
	}

	KeyframeResolver = DOMKeyframesResolver;
}