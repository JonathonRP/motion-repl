import { transformProps } from '../../render/html/utils/transform';
import type { AnimationTypeState } from '../../render/utils/animation-state';
import type { Visual } from '../../render/Visual.svelte';
import type { TargetAndTransition } from '../../types';
import type { VisualAnimationOptions } from './types';
import { animateMotionValue } from './motion-value';
import { setTarget } from '../../render/utils/setters';
import type { AnimationPlaybackControls } from '../types';
import { getValueTransition } from '../utils/get-value-transition';
import { frame } from '../../frameloop';
import { getOptimisedAppearId } from '../optimized-appear/get-appear-id';
import { addValueToWillChange } from '../../value/use-will-change/add-will-change';

function shouldBlockAnimation({ protectedKeys, needsAnimating }: AnimationTypeState, key: string) {
	const shouldBlock = protectedKeys.hasOwnProperty(key) && needsAnimating[key] !== true;

	needsAnimating[key] = false;
	return shouldBlock;
}

export function animateTarget(
	visual: Visual<unknown>,
	targetAndTransition: TargetAndTransition,
	{ delay = 0, transitionOverride, type }: VisualAnimationOptions = {}
) {
	let { transition = visual.getDefaultTransition(), transitionEnd, ...target } = targetAndTransition;

	if (transitionOverride) transition = transitionOverride;

	const animations: AnimationPlaybackControls[] = [];

	const animationTypeState = type && visual.animationState && visual.animationState.getState()[type];

	for (const key in target) {
		const value = visual.getValue(key, visual.latestValues[key] ?? null);
		const valueTarget = target[key as keyof typeof target];

		if (valueTarget === undefined || (animationTypeState && shouldBlockAnimation(animationTypeState, key))) {
			continue;
		}

		const valueTransition = {
			delay,
			...getValueTransition(transition || {}, key),
		};

		/**
		 * If this is the first time a value is being animated, check
		 * to see if we're handling off from an existing animation.
		 */
		let isHandoff = false;
		if (window.MotionHandoffAnimation) {
			const appearId = getOptimisedAppearId(visual);

			if (appearId) {
				const startTime = window.MotionHandoffAnimation(appearId, key, frame);

				if (startTime !== null) {
					valueTransition.startTime = startTime;
					isHandoff = true;
				}
			}
		}

		addValueToWillChange(visual, key);

		value.start(
			animateMotionValue(
				key,
				value,
				valueTarget,
				visual.shouldReduceMotion && transformProps.has(key) ? { type: false } : valueTransition,
				visual,
				isHandoff
			)
		);

		const animation = value.animation;

		if (animation) {
			animations.push(animation);
		}
	}

	if (transitionEnd) {
		Promise.all(animations).then(() => {
			frame.update(() => {
				transitionEnd && setTarget(visual, transitionEnd);
			});
		});
	}

	return animations;
}