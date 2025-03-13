import { HTMLVisual } from "../../render/html/HTMLVisual";
import type { HTMLRenderState } from "../../render/html/types";
import type { VisualOptions } from "../../render/types";
import { visualElementStore } from '../../render/store.svelte';

export function createDOMVisual(element: HTMLElement | SVGElement) {
	const options = {
		// presenceContext: null,
		props: {},
		visualState: {
			renderState: {
				transform: {},
				transformOrigin: {},
				transformKeys: [],
				style: {},
				vars: {},
				// attrs: {},
			},
			latestValues: {},
		},
	} satisfies VisualOptions<HTMLElement, HTMLRenderState>;
	const node = new HTMLVisual(options);

	node.mount(element as any);

	visualElementStore.set(element, node);
}