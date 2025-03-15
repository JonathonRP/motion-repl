import type { AnimationDefinition } from "../animation/types";
import type { MotionProps } from "../motion/types";
import type { VisualState } from "../motion/utils/use-visual-state";
import type { Axis, Box } from "../projection/geometry/types";
import type { Visual } from "./Visual";

export type VisualOptions<Instance, RenderState = any> = {
	visualState: VisualState<Instance, RenderState>;
	parent?: Visual<unknown>;
	variantParent?: Visual<unknown>;
	// presenceContext: PresenceContext | null;
	props: MotionProps;
	blockInitialAnimation?: boolean;
	// reducedMotionConfig?: ReducedMotionConfig;
};

/**
 * A generic set of string/number values
 */
export interface ResolvedValues {
	[key: string]: string | number;
}

export interface VisualEventCallbacks {
    BeforeLayoutMeasure: () => void
    LayoutMeasure: (layout: Box, prevLayout?: Box) => void
    LayoutUpdate: (layout: Axis, prevLayout: Axis) => void
    Update: (latest: ResolvedValues) => void
    AnimationStart: (definition: AnimationDefinition) => void
    AnimationComplete: (definition: AnimationDefinition) => void
    LayoutAnimationStart: () => void
    LayoutAnimationComplete: () => void
    SetAxisTarget: () => void
    Unmount: () => void
}

export interface LayoutLifecycles {
    onBeforeLayoutMeasure?(box: Box): void

    onLayoutMeasure?(box: Box, prevBox: Box): void

    /**
     * @internal
     */
    onLayoutAnimationStart?(): void

    /**
     * @internal
     */
    onLayoutAnimationComplete?(): void
}

export interface AnimationLifecycles {
    /**
     * Callback with latest motion values, fired max once per frame.
     *
     * ```jsx
     * function onUpdate(latest) {
     *   console.log(latest.x, latest.opacity)
     * }
     *
     * <motion.div animate={{ x: 100, opacity: 0 }} onUpdate={onUpdate} />
     * ```
     */
    onUpdate?(latest: ResolvedValues): void

    /**
     * Callback when animation defined in `animate` begins.
     *
     * The provided callback will be called with the triggering animation definition.
     * If this is a variant, it'll be the variant name, and if a target object
     * then it'll be the target object.
     *
     * This way, it's possible to figure out which animation has started.
     *
     * ```jsx
     * function onStart() {
     *   console.log("Animation started")
     * }
     *
     * <motion.div animate={{ x: 100 }} onAnimationStart={onStart} />
     * ```
     */
    onAnimationStart?(definition: AnimationDefinition): void

    /**
     * Callback when animation defined in `animate` is complete.
     *
     * The provided callback will be called with the triggering animation definition.
     * If this is a variant, it'll be the variant name, and if a target object
     * then it'll be the target object.
     *
     * This way, it's possible to figure out which animation has completed.
     *
     * ```jsx
     * function onComplete() {
     *   console.log("Animation completed")
     * }
     *
     * <motion.div
     *   animate={{ x: 100 }}
     *   onAnimationComplete={definition => {
     *     console.log('Completed animating', definition)
     *   }}
     * />
     * ```
     */
    onAnimationComplete?(definition: AnimationDefinition): void
}

export type EventProps = LayoutLifecycles & AnimationLifecycles

export type CreateVisual<Instance> = (
	Component: string, // | Component<{ children: Snippet | Component }>
	options: VisualOptions<Instance>
) => Visual<Instance>;