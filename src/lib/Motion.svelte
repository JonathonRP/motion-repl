<script module lang="ts">
import { IsMounted, AnimationFrames } from 'runed';


export const createHtmlRenderState = () =>
	({
		style: {},
		transform: {},
		transformOrigin: {},
		vars: {},
	});


function getValueState(visualElement) {
	const state = [{}, {}];

	visualElement?.values.forEach((value, key) => {
		state[0][key] = value.get();
		state[1][key] = value.getVelocity();
	});

	return state;
}

export function resolveVariantFromProps(
	props,
	definition,
	custom,
	visual
) {
	/**
	 * If the variant definition is a function, resolve.
	 */
	if (typeof definition === 'function') {
		const [current, velocity] = getValueState(visual);
		definition = definition(custom !== undefined ? custom : props.custom, current, velocity);
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
		definition = definition(custom !== undefined ? custom : props.custom, current, velocity);
	}

	return definition;
}

function isVariantLabel(v) {
	return typeof v === 'string' || Array.isArray(v);
}

const isKeyframesTarget = (v) => {
	return Array.isArray(v);
};

function shallowCompare(next, prev) {
	if (!Array.isArray(prev)) return false;

	const prevLength = prev.length;

	if (prevLength !== next.length) return false;

	for (let i = 0; i < prevLength; i++) {
		if (prev[i] !== next[i]) return false;
	}

	return true;
}

function resolveVariant(
	visualElement,
	definition,
	custom
) {
	const props = visualElement.getProps();
	return resolveVariantFromProps(props, definition, custom !== undefined ? custom : props.custom, visualElement);
}

export const createDomVisual = (Component, options) => {
	const visual = new HTMLVisual(options, {});
	// this is handled in a feature class called animation.
	visual.animationState ||= createAnimationState(visual);

	return visual;
}

const propEventHandlers = [
	'AnimationStart',
	'AnimationComplete',
	'Update',
	'BeforeLayoutMeasure',
	'LayoutMeasure',
	'LayoutAnimationStart',
	'LayoutAnimationComplete',
] as const;

abstract class Visual {
	/**
	 * When a value has been removed from all animation props we need to
	 * pick a target to animate back to. For instance, for HTMLElements
	 * we can look in the style prop.
	 */
	abstract getBaseTargetFromProps(props: MotionProps, key: string): string | number | undefined | MotionValue;

	/**
	 * When we first animate to a value we need to animate it *from* a value.
	 * Often this have been specified via the initial prop but it might be
	 * that the value needs to be read from the Instance.
	 */
	abstract readValueFromInstance(instance: Instance, key: string, options: Options): string | number | null | undefined;
	
	/**
	 * Run before a React or VisualElement render, builds the latest motion
	 * values into an Instance-specific format. For example, HTMLVisualElement
	 * will use this step to build `style` and `var` values.
	 */
	abstract build(renderState, latestValues, props): void

	/**
	 * Apply the built values to the Instance. For example, HTMLElements will have
	 * styles applied via `setProperty` and the style attribute, whereas SVGElements
	 * will have values applied to attributes.
	 */
	abstract renderInstance(
		instance,
		renderState,
		styleProp
	): void

	/**
	 * A reference to the current underlying Instance, e.g. a HTMLElement
	 * or Three.Mesh etc.
	 */
	current = null;

	
	/**
	 * An object containing the latest static values for each of this VisualElement's
	 * MotionValues.
	 */
	latestValues;

	/**
	 * A map of all motion values attached to this visual element. Motion
	 * values are source of truth for any given animated value. A motion
	 * value might be provided externally by the component via props.
	 */
	values = new Map();

	/**
	 * The AnimationState, this is hydrated by the animation Feature.
	 */
	animationState;

	/**
	 * The options used to create this VisualElement. The Options type is defined
	 * by the inheriting VisualElement and is passed straight through to the render functions.
	 */
	options;

	/**
	 * A reference to the latest props provided to the VisualElement's host React component.
	 */
	props;
	prevProps;

	/**
	 * A map of every subscription that binds the provided or generated
	 * motion values onChange listeners to this visual element.
	 */
	#valueSubscriptions = new Map();

	/**
	 * An object containing a SubscriptionManager for each active event.
	 */
	#events = {};

	/**
	 * An object containing an unsubscribe function for each prop event subscription.
	 * For example, every "Update" event can have multiple subscribers via
	 * VisualElement.on(), but only one of those can be defined via the onUpdate prop.
	 */
	#propEventSubscriptions = {};

	/**
	 * hold subscription to hook into svelte reactivity graph
	 */
	#subscribe;

	/**
	 * hold update callback to hook into svelte reactivity graph
	 */
	#update;

	constructor(
		{
			props,
			visualState,
		},
		options = {}
	) {
		const { latestValues, renderState } = visualState;
		this.latestValues = latestValues;
		this.renderState = renderState;
		this.props = props;
		this.options = options;

		this.#subscribe = createSubscriber((update) => {
			this.#update = update;
			// for (const eventKey in this.#events) {
			// 	this.#events[eventKey].add(update);
			// }

			return () => {
				this.unmount();
			};
		});

		// this.#subscribe();
	}

	mount(instance) {
		this.#subscribe();
		this.current = instance;

		this.update(this.props);
	}

	unmount() {
		// cancelFrame(this.notifyUpdate);
		// cancelFrame(this.render);

		for (const key in this.events) {
			this.events[key].clear();
		}
		this.current = null;
	}

	#bindToMotionValue(key, value) {
		if (this.#valueSubscriptions.has(key)) {
			this.#valueSubscriptions.get(key)();
		}

		const valueIsTransform = transformProps.has(key);

		const removeOnChange = value.on('change', (latestValue) => {
			this.latestValues[key] = latestValue;

			this.props.onUpdate && frame.preRender(this.notifyUpdate);

			if (valueIsTransform && this.projection) {
				this.projection.isTransformDirty = true;
			}
		});

		const removeOnRenderRequest = value.on('renderRequest', this.scheduleRender);

		let removeSyncCheck;
		if (window.MotionCheckAppearSync) {
			removeSyncCheck = window.MotionCheckAppearSync(this, key, value);
		}

		this.#valueSubscriptions.set(key, () => {
			removeOnChange();
			removeOnRenderRequest();
			if (removeSyncCheck) removeSyncCheck();
			if (value.owner) value.stop();
		});
	}

	notifyUpdate = () => this.notify('Update', this.latestValues);

	triggerBuild() {
		this.build(this.renderState, this.latestValues, this.props);
	}

	render = () => {
		if (!this.current) return;
		this.triggerBuild();
		this.renderInstance(this.current, this.renderState, this.props.style, this.projection);
	};

	#renderScheduledAt = 0.0;
	scheduleRender = () => {
		const now = time.now();
		if (this.#renderScheduledAt < now) {
			this.#renderScheduledAt = now;
			frame.render(this.render, false, true);
		}
	};

	/**
	 * Update the provided props. Ensure any newly-added motion values are
	 * added to our map, old ones removed, and listeners updated.
	 */
	update(props) {
		if (props.transformTemplate || this.props.transformTemplate) {
			this.scheduleRender();
		}

		this.prevProps = this.props;
		this.props = props;

		/**
		 * Update prop event handlers ie onAnimationStart, onAnimationComplete
		 */
		for (let i = 0; i < propEventHandlers.length; i++) {
			const key = propEventHandlers[i];
			if (this.#propEventSubscriptions[key]) {
				this.#propEventSubscriptions[key]();
				delete this.#propEventSubscriptions[key];
			}

			const listenerName = ('on' + key);
			const listener = props[listenerName];
			if (listener) {
				this.#propEventSubscriptions[key] = this.on(key, listener);
			}
		}

		this.#update?.();
	}

	getProps() {
		return this.props;
	}

	/**
	 * Returns the variant definition with a given name.
	 */
	getVariant(name) {
		return this.props.variants ? this.props.variants[name] : undefined;
	}

	/**
	 * Returns the defined default transition on this component.
	 */
	getDefaultTransition() {
		return this.props.transition;
	}

	/**
	 * Add a motion value and bind it to this visual element.
	 */
	addValue(key, value) {
		// Remove existing value if it exists
		const existingValue = this.values.get(key);

		if (value !== existingValue) {
			if (existingValue) this.removeValue(key);
			this.#bindToMotionValue(key, value);
			this.values.set(key, value);
			this.latestValues[key] = value.get();
		}
	}

	/**
	 * Get a motion value for this key. If called with a default
	 * value, we'll create one if none exists.
	 */
	getValue(key, defaultValue) {
		if (this.props.values && this.props.values[key]) {
			return this.props.values[key];
		}

		let value = this.values.get(key);

		if (value === undefined && defaultValue !== undefined) {
			// TODO: implement motionvalue and animateMotionValue to animate!
			value = motionValue(defaultValue === null ? undefined : defaultValue, { owner: this });
			this.addValue(key, value);
		}

		return value;
	}

	/**
	 * If we're trying to animate to a previously unencountered value,
	 * we need to check for it in our state and as a last resort read it
	 * directly from the instance (which might have performance implications).
	 */
	readValue(key: string, target?: string | number | null) {
		let value =
			this.latestValues[key] !== undefined || !this.current
				? this.latestValues[key]
				: (this.getBaseTargetFromProps(this.props, key) ?? this.readValueFromInstance(this.current, key, this.options));

		if (value !== undefined && value !== null) {
			if (typeof value === 'string' && (isNumericalString(value) || isZeroValueString(value))) {
				// If this is a number read as a string, ie "0" or "200", convert it to a number
				value = Number.parseFloat(value);
			} else if (!findValueType(value) && complex.test(target)) {
				value = getAnimatableNone(key, target as string);
			}

			this.setBaseTarget(key, isMotionValue(value) ? value.get() : value);
		}

		return isMotionValue(value) ? value.get() : value;
	}

	/**
	 * Set the base target to later animate back to. This is currently
	 * only hydrated on creation and when we first read a value.
	 */
	setBaseTarget(key: string, value: string | number) {
		this.baseTarget[key] = value;
	}

	/**
	 * Find the base target for a value thats been removed from all animation
	 * props.
	 */
	getBaseTarget(key: string): ResolvedValues[string] | undefined | null {
		const { initial } = this.props;

		let valueFromInitial: ResolvedValues[string] | undefined | null;

		if (typeof initial === 'string' || typeof initial === 'object') {
			const variant = resolveVariantFromProps(this.props, initial as any, this.presenceContext?.custom);
			if (variant) {
				valueFromInitial = variant[key as keyof typeof variant] as string;
			}
		}

		/**
		 * If this value still exists in the current initial variant, read that.
		 */
		if (initial && valueFromInitial !== undefined) {
			return valueFromInitial;
		}

		/**
		 * Alternatively, if this VisualElement config has defined a getBaseTarget
		 * so we can read the value from an alternative source, try that.
		 */
		const target = this.getBaseTargetFromProps(this.props, key);
		if (target !== undefined && !isMotionValue(target)) return target;

		/**
		 * If the value was initially defined on initial, but it doesn't any more,
		 * return undefined. Otherwise return the value as initially read from the DOM.
		 */
		return this.initialValues[key] !== undefined && valueFromInitial === undefined ? undefined : this.baseTarget[key];
	}

	on(
		eventName,
		callback
	) {
		if (!this.#events[eventName]) {
			this.#events[eventName] = new SubscriptionManager();
		}

		return this.#events[eventName].add(callback);
	}

	notify(eventName, ...args) {
		if (this.#events[eventName]) {
			this.#events[eventName].notify(...args);
		}
	}
	
}

class DOMKeyframesResolver<T extends string | number> extends KeyframeResolver<T> {
	declare name: string;
	declare element?: VisualElement<HTMLElement | SVGElement>;

	private removedTransforms?: [string, string | number][];
	private measuredOrigin?: string | number;

	constructor(
		unresolvedKeyframes: UnresolvedKeyframes<string | number>,
		onComplete: OnKeyframesResolved<T>,
		name?: string,
		motionValue?: MotionValue<T>,
		element?: VisualElement<HTMLElement | SVGElement | unknown>
	) {
		super(unresolvedKeyframes, onComplete, name, motionValue, element, true);
	}

	readKeyframes() {
		const { unresolvedKeyframes, element, name } = this;

		if (!element || !element.current) return;

		super.readKeyframes();

		/**
		 * If any keyframe is a CSS variable, we need to find its value by sampling the element
		 */
		for (let i = 0; i < unresolvedKeyframes.length; i++) {
			let keyframe = unresolvedKeyframes[i];

			if (typeof keyframe === 'string') {
				keyframe = keyframe.trim();

				if (isCSSVariableToken(keyframe)) {
					const resolved = getVariableValue(keyframe, element.current);

					if (resolved !== undefined) {
						unresolvedKeyframes[i] = resolved as T;
					}

					if (i === unresolvedKeyframes.length - 1) {
						this.finalKeyframe = keyframe as T;
					}
				}
			}
		}

		/**
		 * Resolve "none" values. We do this potentially twice - once before and once after measuring keyframes.
		 * This could be seen as inefficient but it's a trade-off to avoid measurements in more situations, which
		 * have a far bigger performance impact.
		 */
		this.resolveNoneKeyframes();

		/**
		 * Check to see if unit type has changed. If so schedule jobs that will
		 * temporarily set styles to the destination keyframes.
		 * Skip if we have more than two keyframes or this isn't a positional value.
		 * TODO: We can throw if there are multiple keyframes and the value type changes.
		 */
		if (!positionalKeys.has(name) || unresolvedKeyframes.length !== 2) {
			return;
		}

		const [origin, target] = unresolvedKeyframes;
		const originType = findDimensionValueType(origin);
		const targetType = findDimensionValueType(target);

		/**
		 * Either we don't recognise these value types or we can animate between them.
		 */
		if (originType === targetType) return;

		/**
		 * If both values are numbers or pixels, we can animate between them by
		 * converting them to numbers.
		 */
		if (isNumOrPxType(originType) && isNumOrPxType(targetType)) {
			for (let i = 0; i < unresolvedKeyframes.length; i++) {
				const value = unresolvedKeyframes[i];
				if (typeof value === 'string') {
					unresolvedKeyframes[i] = Number.parseFloat(value as string);
				}
			}
		} else {
			/**
			 * Else, the only way to resolve this is by measuring the element.
			 */
			this.needsMeasurement = true;
		}
	}

	resolveNoneKeyframes() {
		const { unresolvedKeyframes, name } = this;

		const noneKeyframeIndexes: number[] = [];
		for (let i = 0; i < unresolvedKeyframes.length; i++) {
			if (isNone(unresolvedKeyframes[i])) {
				noneKeyframeIndexes.push(i);
			}
		}

		if (noneKeyframeIndexes.length) {
			makeNoneKeyframesAnimatable(unresolvedKeyframes, noneKeyframeIndexes, name);
		}
	}

	measureInitialState() {
		const { element, unresolvedKeyframes, name } = this;

		if (!element || !element.current) return;

		if (name === 'height') {
			this.suspendedScrollY = window.pageYOffset;
		}

		this.measuredOrigin = positionalValues[name](
			element.measureViewportBox(),
			window.getComputedStyle(element.current)
		);

		unresolvedKeyframes[0] = this.measuredOrigin;

		// Set final key frame to measure after next render
		const measureKeyframe = unresolvedKeyframes[unresolvedKeyframes.length - 1];

		if (measureKeyframe !== undefined) {
			element.getValue(name, measureKeyframe).jump(measureKeyframe, false);
		}
	}

	measureEndState() {
		const { element, name, unresolvedKeyframes } = this;

		if (!element || !element.current) return;

		const value = element.getValue(name);
		value && value.jump(this.measuredOrigin, false);

		const finalKeyframeIndex = unresolvedKeyframes.length - 1;
		const finalKeyframe = unresolvedKeyframes[finalKeyframeIndex];

		unresolvedKeyframes[finalKeyframeIndex] = positionalValues[name](
			element.measureViewportBox(),
			window.getComputedStyle(element.current)
		) as any;

		if (finalKeyframe !== null && this.finalKeyframe === undefined) {
			this.finalKeyframe = finalKeyframe as T;
		}

		// If we removed transform values, reapply them before the next render
		if (this.removedTransforms?.length) {
			this.removedTransforms.forEach(([unsetTransformName, unsetTransformValue]) => {
				element.getValue(unsetTransformName)!.set(unsetTransformValue);
			});
		}

		this.resolveNoneKeyframes();
	}
}

class DOMVisual extends Visual {
	getBaseTargetFromProps(props: MotionProps, key: string): string | number | MotionValue<any> | undefined {
		return props.style ? (props.style[key as keyof MotionStyle] as string) : undefined;
	}

	KeyframeResolver = DOMKeyframesResolver;
}

function getComputedStyle(element) {
	return window.getComputedStyle(element);
}

class HTMLVisual extends DOMVisual {

	build(renderState, latestValues, props) {
		buildHTMLStyles(renderState, latestValues, props.transformTemplate);
	}

	renderInstance = renderHTML;
}

function animateVisual(
	visual,
	definition,
	options = {}
) {
	visual.notify('AnimationStart', definition);
	let animation;

	if (Array.isArray(definition)) {
		const animations = definition.map((variant) => animateVariant(visual, variant, options));
		animation = Promise.all(animations);
	} else if (typeof definition === 'string') {
		animation = animateVariant(visual, definition, options);
	} else {
		const resolvedDefinition =
			typeof definition === 'function' ? resolveVariant(visual, definition, options.custom) : definition;

		animation = Promise.all(animateTarget(visual, resolvedDefinition, options));
	}

	return animation.then(() => {
		visual.notify('AnimationComplete', definition);
	});
}

const isMotionValue = (value) =>
	value && value.getVelocity;

function isWillChangeMotionValue(value) {
	return isMotionValue(value) && value.add;
}

function addValueToWillChange(visualElement, key) {
	const willChange = visualElement.getValue('willChange');

	/**
	 * It could be that a user has set willChange to a regular MotionValue,
	 * in which case we can't add the value to it.
	 */
	if (isWillChangeMotionValue(willChange)) {
		return willChange.add(key);
	}
}

function shouldBlockAnimation({ protectedKeys, needsAnimating }, key) {
	const shouldBlock = protectedKeys.hasOwnProperty(key) && needsAnimating[key] !== true;

	needsAnimating[key] = false;
	return shouldBlock;
}

function animateTarget(
	visual,
	targetAndTransition,
	{ delay = 0, transitionOverride, type } = {}
) {
	let { transition = visual.getDefaultTransition(), transitionEnd, ...target } = targetAndTransition;

	if (transitionOverride) transition = transitionOverride;

	const animations = [];

	const animationTypeState = type && visual.animationState && visual.animationState.getState()[type];

	for (const key in target) {
		const value = visual.getValue(key, visual.latestValues[key] ?? null);
		const valueTarget = target[key];

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

function animateVariant(
	visual,
	variant,
	options = {}
) {
	const resolved = resolveVariant(
		visual,
		variant,
		// options.type === 'exit' ? visualElement.presenceContext?.custom : undefined
	);

	let { transition = visual.getDefaultTransition() || {} } = resolved || {};

	if (options.transitionOverride) {
		transition = options.transitionOverride;
	}

	/**
	 * If we have a variant, create a callback that runs it as an animation.
	 * Otherwise, we resolve a Promise immediately for a composable no-op.
	 */
	const getAnimation = resolved
		? () => Promise.all(animateTarget(visual, resolved, options))
		: () => Promise.resolve();

	/**
	 * If we have children, create a callback that runs all their animations.
	 * Otherwise, we resolve a Promise immediately for a composable no-op.
	 */
	const getChildAnimations =
		visual.variantChildren && visual.variantChildren.size
			? (forwardDelay = 0) => {
					const { delayChildren = 0, staggerChildren, staggerDirection } = transition;

					return animateChildren(
						visual,
						variant,
						delayChildren + forwardDelay,
						staggerChildren,
						staggerDirection,
						options
					);
				}
			: () => Promise.resolve();

	/**
	 * If the transition explicitly defines a "when" option, we need to resolve either
	 * this animation or all children animations before playing the other.
	 */
	const { when } = transition;
	if (when) {
		const [first, last] =
			when === 'beforeChildren' ? [getAnimation, getChildAnimations] : [getChildAnimations, getAnimation];

		return first().then(() => last());
	} else {
		return Promise.all([getAnimation(), getChildAnimations(options.delay)]);
	}
}

const variantPriorityOrder = [
	'animate',
	'whileInView',
	'whileFocus',
	'whileHover',
	'whileTap',
	'whileDrag',
	'exit',
];
const reversePriorityOrder = [...variantPriorityOrder].reverse();
const numAnimationTypes = variantPriorityOrder.length;

function animateList(visual) {
	return (animations) =>
		Promise.all(animations.map(({ animation, options }) => animateVisual(visual, animation, options)));
}

function createAnimationState(visual) {
	let animate = animateList(visual);
	let state = createState();
	let isInitialRender = true;

	/**
	 * This function will be used to reduce the animation definitions for
	 * each active animation type into an object of resolved values for it.
	 */
	const buildResolvedTypeValues =
		(type) => (acc, definition) => {
			const resolved = resolveVariant(
				visual,
				definition,
				// type === 'exit' ? visual.presenceContext?.custom : undefined
			);

			if (resolved) {
				const { transition, transitionEnd, ...target } = resolved;
				acc = { ...acc, ...target, ...transitionEnd };
			}

			return acc;
		};

	/**
	 * This just allows us to inject mocked animation functions
	 * @internal
	 */
	function setAnimateFunction(makeAnimator) {
		animate = makeAnimator(visual);
	}

	/**
	 * When we receive new props, we need to:
	 * 1. Create a list of protected keys for each type. This is a directory of
	 *    value keys that are currently being "handled" by types of a higher priority
	 *    so that whenever an animation is played of a given type, these values are
	 *    protected from being animated.
	 * 2. Determine if an animation type needs animating.
	 * 3. Determine if any values have been removed from a type and figure out
	 *    what to animate those to.
	 */
	function animateChanges(changedActiveType) {
		const { props } = visual;

		/**
		 * A list of animations that we'll build into as we iterate through the animation
		 * types. This will get executed at the end of the function.
		 */
		const animations = [];

		/**
		 * Keep track of which values have been removed. Then, as we hit lower priority
		 * animation types, we can check if they contain removed values and animate to that.
		 */
		const removedKeys = new Set();

		/**
		 * A dictionary of all encountered keys. This is an object to let us build into and
		 * copy it without iteration. Each time we hit an animation type we set its protected
		 * keys - the keys its not allowed to animate - to the latest version of this object.
		 */
		let encounteredKeys = {};

		/**
		 * If a variant has been removed at a given index, and this component is controlling
		 * variant animations, we want to ensure lower-priority variants are forced to animate.
		 */
		let removedVariantIndex = Number.POSITIVE_INFINITY;

		/**
		 * Iterate through all animation types in reverse priority order. For each, we want to
		 * detect which values it's handling and whether or not they've changed (and therefore
		 * need to be animated). If any values have been removed, we want to detect those in
		 * lower priority props and flag for animation.
		 */
		for (let i = 0; i < numAnimationTypes; i++) {
			const type = reversePriorityOrder[i];
			const typeState = state[type];
			const prop = props[type];
			const propIsVariant = isVariantLabel(prop);

			/**
			 * If this type has *just* changed isActive status, set activeDelta
			 * to that status. Otherwise set to null.
			 */
			const activeDelta = type === changedActiveType ? typeState.isActive : null;

			if (activeDelta === false) removedVariantIndex = i;

			/**
			 * If this prop is an inherited variant, rather than been set directly on the
			 * component itself, we want to make sure we allow the parent to trigger animations.
			 *
			 * TODO: Can probably change this to a !isControllingVariants check
			 */
			let isInherited = prop !== props[type];

			/**
			 *
			 */
			if (isInherited && isInitialRender) {
				isInherited = false;
			}

			/**
			 * Set all encountered keys so far as the protected keys for this type. This will
			 * be any key that has been animated or otherwise handled by active, higher-priortiy types.
			 */
			typeState.protectedKeys = { ...encounteredKeys };

			// Check if we can skip analysing this prop early
			if (
				// If it isn't active and hasn't *just* been set as inactive
				(!typeState.isActive && activeDelta === null) ||
				// If we didn't and don't have any defined prop for this animation type
				(!prop && !typeState.prevProp) ||
				// Or if the prop doesn't define an animation
				// isAnimationControls(prop) ||
				typeof prop === 'boolean'
			) {
				continue;
			}

			/**
			 * As we go look through the values defined on this type, if we detect
			 * a changed value or a value that was removed in a higher priority, we set
			 * this to true and add this prop to the animation list.
			 */
			const variantDidChange = checkVariantsDidChange(typeState.prevProp, prop);

			let shouldAnimateType =
				variantDidChange ||
				// If we're making this variant active, we want to always make it active
				(type === changedActiveType && typeState.isActive && !isInherited && propIsVariant) ||
				// If we removed a higher-priority variant (i is in reverse order)
				(i > removedVariantIndex && propIsVariant);

			let handledRemovedValues = false;

			/**
			 * As animations can be set as variant lists, variants or target objects, we
			 * coerce everything to an array if it isn't one already
			 */
			const definitionList = Array.isArray(prop) ? prop : [prop];

			/**
			 * Build an object of all the resolved values. We'll use this in the subsequent
			 * animateChanges calls to determine whether a value has changed.
			 */
			let resolvedValues = definitionList.reduce(buildResolvedTypeValues(type), {});

			if (activeDelta === false) resolvedValues = {};

			/**
			 * Now we need to loop through all the keys in the prev prop and this prop,
			 * and decide:
			 * 1. If the value has changed, and needs animating
			 * 2. If it has been removed, and needs adding to the removedKeys set
			 * 3. If it has been removed in a higher priority type and needs animating
			 * 4. If it hasn't been removed in a higher priority but hasn't changed, and
			 *    needs adding to the type's protectedKeys list.
			 */
			const { prevResolvedValues = {} } = typeState;

			const allKeys = {
				...prevResolvedValues,
				...resolvedValues,
			};
			const markToAnimate = (key) => {
				shouldAnimateType = true;
				if (removedKeys.has(key)) {
					handledRemovedValues = true;
					removedKeys.delete(key);
				}
				typeState.needsAnimating[key] = true;

				const motionValue = visual.getValue(key);
				if (motionValue) motionValue.liveStyle = false;
			};

			for (const key in allKeys) {
				const next = resolvedValues[key];
				const prev = prevResolvedValues[key];

				// If we've already handled this we can just skip ahead
				if (encounteredKeys.hasOwnProperty(key)) continue;

				/**
				 * If the value has changed, we probably want to animate it.
				 */
				let valueHasChanged = false;
				if (isKeyframesTarget(next) && isKeyframesTarget(prev)) {
					valueHasChanged = !shallowCompare(next, prev);
				} else {
					valueHasChanged = next !== prev;
				}

				if (valueHasChanged) {
					if (next !== undefined && next !== null) {
						// If next is defined and doesn't equal prev, it needs animating
						markToAnimate(key);
					} else {
						// If it's undefined, it's been removed.
						removedKeys.add(key);
					}
				} else if (next !== undefined && removedKeys.has(key)) {
					/**
					 * If next hasn't changed and it isn't undefined, we want to check if it's
					 * been removed by a higher priority
					 */
					markToAnimate(key);
				} else {
					/**
					 * If it hasn't changed, we add it to the list of protected values
					 * to ensure it doesn't get animated.
					 */
					typeState.protectedKeys[key] = true;
				}
			}

			/**
			 * Update the typeState so next time animateChanges is called we can compare the
			 * latest prop and resolvedValues to these.
			 */
			typeState.prevProp = prop;
			typeState.prevResolvedValues = resolvedValues;

			/**
			 *
			 */
			if (typeState.isActive) {
				encounteredKeys = { ...encounteredKeys, ...resolvedValues };
			}

			if (isInitialRender && visual.blockInitialAnimation) {
				shouldAnimateType = false;
			}

			/**
			 * If this is an inherited prop we want to skip this animation
			 * unless the inherited variants haven't changed on this render.
			 */
			const willAnimateViaParent = isInherited && variantDidChange;
			const needsAnimating = !willAnimateViaParent || handledRemovedValues;
			if (shouldAnimateType && needsAnimating) {
				animations.push(
					...definitionList.map((animation) => ({
						animation: animation,
						options: { type },
					}))
				);
			}
		}

		/**
		 * If there are some removed value that haven't been dealt with,
		 * we need to create a new animation that falls back either to the value
		 * defined in the style prop, or the last read value.
		 */
		if (removedKeys.size) {
			const fallbackAnimation = {};
			removedKeys.forEach((key) => {
				const fallbackTarget = visualElement.getBaseTarget(key);

				const motionValue = visualElement.getValue(key);
				if (motionValue) motionValue.liveStyle = true;

				fallbackAnimation[key] = fallbackTarget ?? null;
			});

			animations.push({ animation: fallbackAnimation });
		}

		let shouldAnimate = animations.length;

		if (
			isInitialRender &&
			(props.initial === false || props.initial === props.animate) &&
			!visualElement.manuallyAnimateOnMount
		) {
			shouldAnimate = false;
		}

		isInitialRender = false;
		return shouldAnimate ? animate(animations) : Promise.resolve();
	}

	/**
	 * Change whether a certain animation type is active.
	 */
	function setActive(type, isActive) {
		// If the active state hasn't changed, we can safely do nothing here
		if (state[type].isActive === isActive) return Promise.resolve();

		// Propagate active change to children
		visualElement.variantChildren?.forEach((child) => child.animationState?.setActive(type, isActive));

		state[type].isActive = isActive;

		const animations = animateChanges(type);

		for (const key in state) {
			state[key].protectedKeys = {};
		}

		return animations;
	}

	return {
		animateChanges,
		setActive,
		setAnimateFunction,
		getState: () => state,
		reset: () => {
			state = createState();
			isInitialRender = true;
		},
	};
}

export function checkVariantsDidChange(prev, next) {
	if (typeof next === 'string') {
		return next !== prev;
	} else if (Array.isArray(next)) {
		return !shallowCompare(next, prev);
	}

	return false;
}

function createTypeState(isActive = false) {
	return {
		isActive,
		protectedKeys: {},
		needsAnimating: {},
		prevResolvedValues: {},
	};
}

function createState() {
	return {
		animate: createTypeState(true),
		whileInView: createTypeState(),
		whileHover: createTypeState(),
		whileTap: createTypeState(),
		whileDrag: createTypeState(),
		whileFocus: createTypeState(),
		exit: createTypeState(),
	};
}

function buildHTMLStyles(
	state,
	latestValues,
	transformTemplate
) {
	const { style, vars, transformOrigin } = state;

	// Track whether we encounter any transform or transformOrigin values.
	let hasTransform = false;
	let hasTransformOrigin = false;

	/**
	 * Loop over all our latest animated values and decide whether to handle them
	 * as a style or CSS variable.
	 *
	 * Transforms and transform origins are kept separately for further processing.
	 */
	for (const key in latestValues) {
		const value = latestValues[key];

		if (transformProps.has(key)) {
			// If this is a transform, flag to enable further transform processing
			hasTransform = true;
			continue;
		} else if (isCSSVariableName(key)) {
			vars[key] = value;
			continue;
		} else {
			// Convert the value to its default value type, ie 0 -> "0px"
			const valueAsType = getValueAsType(value, numberValueTypes[key]);

			if (key.startsWith('origin')) {
				// If this is a transform origin, flag and enable further transform-origin processing
				hasTransformOrigin = true;
				transformOrigin[key] = valueAsType;
			} else {
				style[key] = valueAsType;
			}
		}
	}

	// if (!latestValues.transform) {
	// 	if (hasTransform || transformTemplate) {
	// 		style.transform = buildTransform(latestValues, state.transform, transformTemplate);
	// 	} else if (style.transform) {
	// 		/**
	// 		 * If we have previously created a transform but currently don't have any,
	// 		 * reset transform style to none.
	// 		 */
	// 		style.transform = 'none';
	// 	}
	// }

	/**
	 * Build a transformOrigin style. Uses the same defaults as the browser for
	 * undefined origins.
	 */
	if (hasTransformOrigin) {
		const { originX = '50%', originY = '50%', originZ = 0 } = transformOrigin;
		style.transformOrigin = `${originX} ${originY} ${originZ}`;
	}
}

function renderHTML(
	element,
	{ style, vars },
	styleProp,
) {
	Object.assign(element.style, style);

	// Loop over any CSS variables and assign those.
	for (const key in vars) {
		element.style.setProperty(key, vars[key]);
	}
}

const camelToDash = (str) => str.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
const optimizedAppearDataId = 'framerAppearId';
const optimizedAppearDataAttribute = 'data-' + camelToDash(optimizedAppearDataId);

export function useVisual(
	Component,
	visualState,
	props,
) {
	const visualRef = { current: null };

	if (!visualRef.current && createDomVisual) {
			visualRef.current = createDomVisual(Component, {
				visualState,
				props
			});
	}
	
	const visual = $derived(visualRef.current);

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
	const optimisedAppearId = props[optimizedAppearDataAttribute];
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

		visual.render;

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
</script>

<script lang="ts">
	import { interpolateHsl } from 'd3-interpolate';
	import { Spring, Tween } from 'svelte/motion';

	let { props, as = 'div', children, ref = $bindable(), useVisualState, ...rest } = $props();

	// const animated = {
	// 	scale: Spring.of(() => props.animate.scale),
	// 	bg: Tween.of(() => props.animate.backgroundColor, { interpolate: interpolateHsl })
	// }

	// const style = $derived(Object.entries({
	// 	'scale': animated.scale.current,
	// 	'background-color': animated.bg.current
	// }).map(([k, v]) => `${k}:${v}`).join(';'));

	const visualState = $derived(useVisualState(props, false))
	const visual = $derived(useVisual(
      as,
			visualState,
      props,
    ));

	$inspect(visual);
</script>

<!-- style={visual} -->
<svelte:element this={as} bind:this={() => ref, (v) => {
	visualState && visualState.mount && visualState.mount(v);
	visual && visual.mount(v);
	ref = v;
}} {...rest}>
	{@render children?.()}
</svelte:element>