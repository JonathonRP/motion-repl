import { IsMounted } from 'runed';
import { createDomVisual as createVisual } from '../../animation/utils/create-visual';
import type { VisualState } from './use-visual-state.js';
import type { MotionProps } from '../types';
import { optimizedAppearDataAttribute } from '../../animation/optimized-appear/data-id';

export function useVisual<Instance, RenderState>(Component: string, visualState: VisualState<Instance, RenderState>, props: MotionProps) {
  const visualRef = $state({ current: null });
  const createVisualInstance = () => {
    if (!visualRef.current && createVisual) {
      visualRef.current = createVisual(Component, {
        visualState,
        props,
      });
    }
    return visualRef.current;
  };
  $effect(() => {
    createVisualInstance(); // Call in an effect
  });

  const visual = $derived.by(() => visualRef.current);

  // const initialLayoutGroupConfig = useContext(SwitchLayoutGroupContext);

  // if (
  // 	visualElement &&
  // 	!visualElement.projection &&
  // 	ProjectionNodeConstructor &&
  // 	(visualElement.type === 'html' || visualElement.type === 'svg')
  // ) {
  // 	createProjectionNode(visualElementRef.current!, props, ProjectionNodeConstructor, initialLayoutGroupConfig);
  // }

  const isMounted = new IsMounted();
  $effect.pre(() => {
    /**
     * Check the component has already mounted before calling
     * `update` unnecessarily. This ensures we skip the initial update.
     */
    if (visual && isMounted.current) {
      /**
       * make sure props update but untrack update because scroll and interpolate break from infinite effect call *greater then 9/10 calls.
       */
      visual.update(props);
    }
  });

  /**
   * Cache this value as we want to know whether HandoffAppearAnimations
   * was present on initial render - it will be deleted after this.
   */
  const optimisedAppearId = props[optimizedAppearDataAttribute]!;
  let wantsHandoff =
    Boolean(optimisedAppearId) &&
    !window.MotionHandoffIsComplete?.(optimisedAppearId) &&
    window.MotionHasOptimisedAnimation?.(optimisedAppearId);

  // $inspect(presenceContext);

  $effect(() => {
    // const logger = console.context('use-visual-element');
    // $inspect(presenceContext).with(logger.info);

    if (!visual) return;

    window.MotionIsMounted = true;

    // visualElement.updateFeatures();
    // microtask.render(() => visualElement.render);

    /**
     * Ideally this function would always run in a useEffect.
     *
     * However, if we have optimised appear animations to handoff from,
     * it needs to happen synchronously to ensure there's no flash of
     * incorrect styles in the event of a hydration error.
     *
     * So if we detect a situtation where optimised appear animations
     * are running, we use useLayoutEffect to trigger animations.
     */
    if (wantsHandoff && visual.animationState) {
      visual.animationState.animateChanges();
    }
  });

  // $inspect(props().animate);

  // watch.pre(
  // 	props,
  // 	(_props) => {
  // 		if (!visualElement) return;
  // 		// visualElement.update(_props, presenceContext);

  // 		// visualElement.updateFeatures();
  // 		microtask.render(() => visualElement.render);

  // 		if (wantsHandoff && visualElement.animationState) {
  // 			visualElement.animationState.animateChanges();
  // 		}
  // 	},
  // 	{
  // 		/**
  // 		 * only fire on changes...
  // 		 * this only fires on changes in props
  // 		 */
  // 		lazy: true,
  // 	}
  // );

  $effect(() => {
    if (!visual) return;

    if (!wantsHandoff && visual.animationState) {
      visual.animationState.animateChanges();
    }

    if (wantsHandoff) {
      // This ensures all future calls to animateChanges() in this component will run in useEffect
      // queueMicrotask(() => {
      // 	window.MotionHandoffMarkAsComplete?.(optimisedAppearId);
      // });

      wantsHandoff = false;
    }
  });

  // watch(
  // 	props,
  // 	(_props) => {
  // 		if (!visualElement) return;

  // 		if (!wantsHandoff && visualElement.animationState) {
  // 			visualElement.animationState.animateChanges();
  // 		}

  // 		if (wantsHandoff) {
  // 			// This ensures all future calls to animateChanges() in this component will run in useEffect
  // 			queueMicrotask(() => {
  // 				window.MotionHandoffMarkAsComplete?.(optimisedAppearId);
  // 			});

  // 			wantsHandoff = false;
  // 		}
  // 	},
  // 	{
  // 		/**
  // 		 * only fire on changes...
  // 		 * this only fires on changes in props
  // 		 */
  // 		lazy: true,
  // 	}
  // );

  // watch(
  // 	() => presenceContext.current,
  // 	() => {
  // 		visualElement?.updateFeatures();

  // 		microtask.render(() => visualElement.render);
  // 	},
  // 	{ lazy: true }
  // );

  return visual;
}