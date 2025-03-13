import type { MotionProps } from "../motion/types";
import type { VisualState } from "../motion/utils/use-visual-state";
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

export type CreateVisual<Instance> = (
	Component: string, // | Component<{ children: Snippet | Component }>
	options: VisualOptions<Instance>
) => Visual<Instance>;