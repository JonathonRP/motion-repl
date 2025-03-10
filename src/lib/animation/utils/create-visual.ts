export function createDOMVisual(element: HTMLElement | SVGElement) {
	const options = {
		presenceContext: null,
		props: {},
		visualState: {
			renderState: {
				transform: {},
				transformOrigin: {},
				transformKeys: [],
				style: {},
				vars: {},
				attrs: {},
			},
			latestValues: {},
		},
	} satisfies VisualOptions<SVGElement | HTMLElement, SVGRenderState | HTMLRenderState>;
	const node = isSVGElement(element) ? new SVGVisualElement(options) : new HTMLVisualElement(options);

	node.mount(element as any);

	visualElementStore.set(element, node);
}

export const createDomVisual = (Component, options) => {
	const visual = new HTMLVisual(options, {});
	// this is handled in a feature class called animation.
	visual.animationState ||= createAnimationState(visual);

	return visual;
}