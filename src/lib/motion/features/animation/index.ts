import { isAnimationControls } from "../../../animation/utils/is-animation-controls";
import type { Visual } from "../../../render/Visual.svelte";
import { createAnimationState } from "../../../render/utils/animation-state";
import { Feature } from "../Feature";

export class AnimationFeature extends Feature<unknown> {
	unmountControls?: () => void;

	/**
	 * We dynamically generate the AnimationState manager as it contains a reference
	 * to the underlying animation library. We only want to load that if we load this,
	 * so people can optionally code split it out using the `m` component.
	 */
	constructor(node: Visual<unknown>) {
        console.log(node.current);
		super(node);
		node.animationState ||= createAnimationState(node);
	}

	updateAnimationControlsSubscription() {
		const { animate } = this.node.getProps();
		if (isAnimationControls(animate)) {
			this.unmountControls = animate.subscribe(this.node);
		}
	}

	/**
	 * Subscribe any provided AnimationControls to the component's VisualElement
	 */
	mount() {
		this.updateAnimationControlsSubscription();
	}

	update() {
		const { animate } = this.node.getProps();
        console.log(animate);
		const { animate: prevAnimate } = this.node.prevProps || {};
		if (animate !== prevAnimate) {
			this.updateAnimationControlsSubscription();
		}
	}

	unmount() {
		this.node.animationState!.reset();
		this.unmountControls?.();
	}
}