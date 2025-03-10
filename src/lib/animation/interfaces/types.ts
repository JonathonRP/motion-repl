import type { AnimationType } from '../../render/utils/types';
import type { Transition } from '../../types';

export type VisualAnimationOptions = {
	delay?: number;
	transitionOverride?: Transition;
	custom?: any;
	type?: AnimationType;
};