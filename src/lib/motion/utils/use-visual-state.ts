import type { ResolvedValues, ScrapeMotionValuesFromProps } from '../../render/types';
import type { MotionProps } from '../types';
import { isAnimationControls } from '../../animation/utils/is-animation-controls.js';
import { resolveVariantFromProps } from '../../render/utils/resolve-variants.js';

export interface VisualState<Instance, RenderState> {
	renderState: RenderState;
	latestValues: ResolvedValues;
	mount?: (instance: Instance) => void;
}
export interface UseVisualStateConfig<Instance, RenderState> {
	scrapeMotionValuesFromProps: ScrapeMotionValuesFromProps;
	createRenderState: () => RenderState;
	onMount?: (props: MotionProps, instance: Instance, visualState: VisualState<Instance, RenderState>) => void;
}
export type makeUseVisualState = <I, RS>(config: UseVisualStateConfig<I, RS>) => UseVisualState<I, RS>;

export type UseVisualState<Instance, RenderState> = (
	props: MotionProps,
	isStatic: boolean
) => VisualState<Instance, RenderState>;

function makeState(
	{ createRenderState, onMount },
	props
) {
	const state = {
		latestValues: makeLatestValues(props),
		renderState: createRenderState(),
	};

	if (onMount) {
		state.mount = (instance) => onMount(props, instance, state);
	}

	return state;
}

export const makeUseVisualState =
	(config) =>
	(props, isStatic) => {
		const make = () => makeState(config, props);

		const state = make();

		return isStatic ? make() : state;
	};

function makeLatestValues(
	props
) {
	const values = {};

	// const motionValues = scrapeMotionValues(() => props, {});
	// for (const key in motionValues) {
	// 	values[key] = resolveMotionValue(motionValues[key]);
	// }

	let { initial, animate } = props;

	const variantToSet = false ? animate : initial;

	if (variantToSet && typeof variantToSet !== 'boolean' && !isAnimationControls(variantToSet)) {
		const list = Array.isArray(variantToSet) ? variantToSet : [variantToSet];
		list.forEach((definition) => {
			const resolved = resolveVariantFromProps(props, definition);
			if (!resolved) return;

			const { transitionEnd, transition, ...target } = resolved;
			for (const key in target) {
				let valueTarget = target[key];

				if (Array.isArray(valueTarget)) {
					/**
					 * Take final keyframe if the initial animation is blocked because
					 * we want to initialise at the end of that blocked animation.
					 */
					const index = isInitialAnimationBlocked ? valueTarget.length - 1 : 0;
					valueTarget = valueTarget[index];
				}

				if (valueTarget !== null) {
					values[key] = valueTarget;
				}
			}
			for (const key in transitionEnd)
				values[key] = transitionEnd[key];
		});
	}

	return values;
}