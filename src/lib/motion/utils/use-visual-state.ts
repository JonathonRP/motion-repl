import { isAnimationControls } from "../../animation/utils/is-animation-controls";
import type { ResolvedValues } from "../../render/types";
import { resolveVariantFromProps } from "../../render/utils/resolve-variants";
import type { MotionProps } from "../types";

export interface VisualState<Instance, RenderState> {
	renderState: RenderState;
	latestValues: ResolvedValues;
	mount?: (instance: Instance) => void;
}
export interface UseVisualStateConfig<Instance, RenderState> {
	// scrapeMotionValuesFromProps: ScrapeMotionValuesFromProps;
	createRenderState: () => RenderState;
	onMount?: (props: MotionProps, instance: Instance, visualState: VisualState<Instance, RenderState>) => void;
}
export type makeUseVisualState = <I, RS>(config: UseVisualStateConfig<I, RS>) => UseVisualState<I, RS>;

export type UseVisualState<Instance, RenderState> = (
	props: MotionProps,
	isStatic: boolean
) => VisualState<Instance, RenderState>;

export const createHtmlRenderState = () => ({
  style: {},
  transform: {},
  transformOrigin: {},
  vars: {},
});

function makeState<I, RS>({ createRenderState, onMount }: UseVisualStateConfig<I, RS>, props: MotionProps) {
  const state: VisualState<I, RS> = {
    latestValues: makeLatestValues(props),
    renderState: createRenderState(),
  };

  if (onMount) {
    state.mount = (instance) => onMount(props, instance, state);
  }

  return state;
}

export const makeUseVisualState = 
<I, RS>(config: UseVisualStateConfig<I, RS>): UseVisualState<I, RS> => 
(props: MotionProps, isStatic: boolean): VisualState<I, RS> => {
  const make = () => makeState(config, props);

  const state = make();

  return isStatic ? make() : state;
};

function makeLatestValues(props: MotionProps) {
  const values: ResolvedValues = {};

  // const motionValues = scrapeMotionValues(() => props, {});
  // for (const key in motionValues) {
  // 	values[key] = resolveMotionValue(motionValues[key]);
  // }

  let { initial, animate } = props;

  let isInitialAnimationBlocked = false;

  isInitialAnimationBlocked = isInitialAnimationBlocked || initial === false;

  const variantToSet = isInitialAnimationBlocked ? animate : initial;

  if (
    variantToSet &&
    typeof variantToSet !== 'boolean' &&
    !isAnimationControls(variantToSet)
  ) {
    const list = Array.isArray(variantToSet) ? variantToSet : [variantToSet];
    list.forEach((definition) => {
      const resolved = resolveVariantFromProps(props, definition);
      if (!resolved) return;

      const { transitionEnd, transition, ...target } = resolved;
      for (const key in target) {
        let valueTarget = target[key as keyof typeof target];

        if (Array.isArray(valueTarget)) {
          /**
           * Take final keyframe if the initial animation is blocked because
           * we want to initialise at the end of that blocked animation.
           */
          const index = isInitialAnimationBlocked ? valueTarget.length - 1 : 0;
          valueTarget = valueTarget[index];
        }

        if (valueTarget !== null) {
          values[key] = valueTarget as string | number;
        }
      }
      for (const key in transitionEnd) values[key] = transitionEnd[key as keyof typeof transitionEnd] as string | number;
    });
  }

  return values;
}