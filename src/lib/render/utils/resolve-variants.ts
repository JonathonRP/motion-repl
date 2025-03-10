import type { MotionProps } from '../../motion/types';
import type { TargetAndTransition, TargetResolver } from '../../types';
import type { Visual } from '../Visual';
import type { ResolvedValues } from '../types';

function getValueState<I>(visualElement?: Visual<I>): [ResolvedValues, ResolvedValues] {
	const state: [ResolvedValues, ResolvedValues] = [{}, {}];

	visualElement?.values.forEach((value, key) => {
		state[0][key] = value.get();
		state[1][key] = value.getVelocity();
	});

	return state;
}

export function resolveVariantFromProps<I>(
	props: MotionProps,
	definition: TargetAndTransition | TargetResolver,
	custom?: any,
	visual?: Visual<I>
): TargetAndTransition;
export function resolveVariantFromProps<I>(
	props: MotionProps,
	definition?: string | TargetAndTransition | TargetResolver,
	custom?: any,
	visual?: Visual<I>
): undefined | TargetAndTransition;
export function resolveVariantFromProps<I>(
	props: MotionProps,
	definition?: string | TargetAndTransition | TargetResolver,
	custom?: any,
	visual?: Visual<I>
) {
    /**
     * If the variant definition is a function, resolve.
     */
    if (typeof definition === 'function') {
      const [current, velocity] = getValueState(visual);
      definition = definition(
        custom !== undefined ? custom : props.custom,
        current,
        velocity
      );
    }
  
    /**
     * If the variant definition is a variant label, or
     * the function returned a variant label, resolve.
     */
    if (typeof definition === 'string') {
      definition = props.variants && props.variants[definition];
    }
  
    /**
     * At this point we've resolved both functions and variant labels,
     * but the resolved variant label might itself have been a function.
     * If so, resolve. This can only have returned a valid target object.
     */
    if (typeof definition === 'function') {
      const [current, velocity] = getValueState(visual);
      definition = definition(
        custom !== undefined ? custom : props.custom,
        current,
        velocity
      );
    }
  
    return definition;
  }