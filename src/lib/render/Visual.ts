import { createSubscriber } from "svelte/reactivity";
import type { MotionProps, MotionStyle } from "../motion/types";
import { motionValue, type MotionValue } from "../value";
import { isMotionValue } from "../value/utils/is-motion-value";
import type { ResolvedValues, VisualEventCallbacks, VisualOptions } from "./types";
import type { AnimationState } from "./utils/animation-state";
import { KeyframeResolver } from "./utils/KeyframesResolver";
import { SubscriptionManager } from "../utils/subscription-manager";
import { cancelFrame, frame } from "../frameloop";
import { transformProps } from "./html/utils/transform";
import { time } from "../frameloop/sync-time";
import { isNumericalString } from "../utils/is-numerical-string";
import { isZeroValueString } from "../utils/is-zero-value-string";
import { complex } from "../value/types/complex";
import { getAnimatableNone } from "./dom/value-types/animatable-none";
import { findValueType } from "./dom/value-types/find";
import { resolveVariantFromProps } from "./utils/resolve-variants";

const propEventHandlers = [
	'AnimationStart',
	'AnimationComplete',
	'Update',
	'BeforeLayoutMeasure',
	'LayoutMeasure',
	'LayoutAnimationStart',
	'LayoutAnimationComplete',
] as const;

export abstract class Visual<
Instance,
RenderState = unknown,
Options extends {} = {},
> {
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
     * When a value has been removed from the VisualElement we use this to remove
     * it from the inherting class' unique render state.
     */
    abstract removeValueFromRenderState(
        key: string,
        renderState: RenderState
    ): void
	
	/**
	 * Run before a React or VisualElement render, builds the latest motion
	 * values into an Instance-specific format. For example, HTMLVisualElement
	 * will use this step to build `style` and `var` values.
	 */
	abstract build(renderState: RenderState, latestValues: ResolvedValues, props: MotionProps): void

	/**
	 * Apply the built values to the Instance. For example, HTMLElements will have
	 * styles applied via `setProperty` and the style attribute, whereas SVGElements
	 * will have values applied to attributes.
	 */
	abstract renderInstance(
		instance: Instance,
		renderState: RenderState,
		styleProp?: MotionStyle
	): void

	/**
	 * A reference to the current underlying Instance, e.g. a HTMLElement
	 * or Three.Mesh etc.
	 */
	current: Instance | null = null;

    /**
	 * The depth of this VisualElement within the overall VisualElement tree.
	 */
	// depth: number;

	/**
	 * The current render state of this VisualElement. Defined by inherting VisualElements.
	 */
	renderState: RenderState;
	
	/**
	 * An object containing the latest static values for each of this VisualElement's
	 * MotionValues.
	 */
	latestValues: ResolvedValues;

    /**
     * Decides whether this VisualElement should animate in reduced motion
     * mode.
     *
     * TODO: This is currently set on every individual VisualElement but feels
     * like it could be set globally.
     */
    shouldReduceMotion: boolean | null = null

    /**
     * Normally, if a component is controlled by a parent's variants, it can
     * rely on that ancestor to trigger animations further down the tree.
     * However, if a component is created after its parent is mounted, the parent
     * won't trigger that mount animation so the child needs to.
     *
     * TODO: This might be better replaced with a method isParentMounted
     */
    manuallyAnimateOnMount: boolean

    /**
     * This can be set by AnimatePresence to force components that mount
     * at the same time as it to mount as if they have initial={false} set.
     */
    blockInitialAnimation: boolean

	/**
	 * A map of all motion values attached to this visual element. Motion
	 * values are source of truth for any given animated value. A motion
	 * value might be provided externally by the component via props.
	 */
	values = new Map();

	/**
	 * The AnimationState, this is hydrated by the animation Feature.
	 */
	animationState?: AnimationState;

    KeyframeResolver = KeyframeResolver

	/**
	 * The options used to create this VisualElement. The Options type is defined
	 * by the inheriting VisualElement and is passed straight through to the render functions.
	 */
	readonly options: Options;

	/**
	 * A reference to the latest props provided to the VisualElement's host React component.
	 */
	props: MotionProps;
	prevProps?: MotionProps;

	/**
	 * A map of every subscription that binds the provided or generated
	 * motion values onChange listeners to this visual element.
	 */
	private valueSubscriptions = new Map<string, VoidFunction>();

    /**
     * When values are removed from all animation props we need to search
     * for a fallback value to animate to. These values are tracked in baseTarget.
     */
    private baseTarget: ResolvedValues

    /**
     * Create an object of the values we initially animated from (if initial prop present).
     */
    private initialValues: ResolvedValues

	/**
	 * An object containing a SubscriptionManager for each active event.
	 */
	private events: {
        [key: string]: SubscriptionManager<any>
    } = {}

	/**
	 * An object containing an unsubscribe function for each prop event subscription.
	 * For example, every "Update" event can have multiple subscribers via
	 * VisualElement.on(), but only one of those can be defined via the onUpdate prop.
	 */
	private propEventSubscriptions: {
        [key: string]: VoidFunction
    } = {};

	/**
	 * hold subscription to hook into svelte reactivity graph
	 */
	#subscribe: ReturnType<typeof createSubscriber>;

	/**
	 * hold update callback to hook into svelte reactivity graph
	 */
	#update: Parameters<Parameters<typeof createSubscriber>[0]>[0];

	constructor(
		{
			props,
			visualState,
            blockInitialAnimation
		}: VisualOptions<Instance, RenderState>,
		options: Options = {} as any
	) {
		const { latestValues, renderState } = visualState;
		this.latestValues = latestValues;
        this.baseTarget = {...latestValues};
        this.initialValues = props.initial ? { ...latestValues } : {}
		this.renderState = renderState;
		this.props = props;
		this.options = options;
        this.blockInitialAnimation = Boolean(blockInitialAnimation)

        this.manuallyAnimateOnMount = true

		this.#subscribe = createSubscriber((update) => {
			this.#update = update;
			for (const eventKey in this.events) {
				this.events[eventKey].add(update);
			}

			return () => {
				this.unmount();
			};
		});

		// this.#subscribe();
	}

	mount(instance: Instance) {
		this.#subscribe();
		this.current = instance;

		this.update(this.props);
	}

	unmount() {
		cancelFrame(this.notifyUpdate);
		cancelFrame(this.render);
        this.valueSubscriptions.forEach((remove) => remove())
        this.valueSubscriptions.clear()

		for (const key in this.events) {
			this.events[key].clear();
		}
		this.current = null;
	}

	private bindToMotionValue(key: string, value: MotionValue) {
		if (this.valueSubscriptions.has(key)) {
			this.valueSubscriptions.get(key)!();
		}

		const valueIsTransform = transformProps.has(key);

		const removeOnChange = value.on('change', (latestValue: string | number) => {
			this.latestValues[key] = latestValue;

			this.props.onUpdate && frame.preRender(this.notifyUpdate);
		});

		const removeOnRenderRequest = value.on('renderRequest', this.scheduleRender);

		let removeSyncCheck: VoidFunction | void;
		if (window.MotionCheckAppearSync) {
			removeSyncCheck = window.MotionCheckAppearSync(this, key, value);
		}

		this.valueSubscriptions.set(key, () => {
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
		this.renderInstance(this.current, this.renderState, this.props.style);
	};

	private renderScheduledAt = 0.0;
	scheduleRender = () => {
		const now = time.now();
		if (this.renderScheduledAt < now) {
			this.renderScheduledAt = now;
			frame.render(this.render, false, true);
		}
	};

	/**
	 * Update the provided props. Ensure any newly-added motion values are
	 * added to our map, old ones removed, and listeners updated.
	 */
	update(props: MotionProps) {
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
			if (this.propEventSubscriptions[key]) {
				this.propEventSubscriptions[key]();
				delete this.propEventSubscriptions[key];
			}

			const listenerName = ('on' + key) as keyof typeof props;
			const listener = props[listenerName];
			if (listener) {
				this.propEventSubscriptions[key] = this.on(key, listener);
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
	getVariant(name: string) {
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
	addValue(key: string, value: MotionValue) {
		// Remove existing value if it exists
		const existingValue = this.values.get(key);

		if (value !== existingValue) {
			if (existingValue) this.removeValue(key);
			this.bindToMotionValue(key, value);
			this.values.set(key, value);
			this.latestValues[key] = value.get();
		}
	}

    /**
	 * Remove a motion value and unbind any active subscriptions.
	 */
	removeValue(key: string) {
		this.values.delete(key);
		const unsubscribe = this.valueSubscriptions.get(key);
		if (unsubscribe) {
			unsubscribe();
			this.valueSubscriptions.delete(key);
		}
		delete this.latestValues[key];
		this.removeValueFromRenderState(key, this.renderState);
	}

    /**
	 * Check whether we have a motion value for this key
	 */
	hasValue(key: string) {
		return this.values.has(key);
	}

	/**
	 * Get a motion value for this key. If called with a default
	 * value, we'll create one if none exists.
	 */
	getValue(key: string): MotionValue | undefined;
	getValue(key: string, defaultValue: string | number | null): MotionValue;
	getValue(key: string, defaultValue?: string | number | null): MotionValue | undefined {
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
            let customInContext = false;
			const variant = resolveVariantFromProps(this.props, initial as any, customInContext);
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

	on<EventName extends keyof VisualEventCallbacks>(
        eventName: EventName,
        callback: VisualEventCallbacks[EventName]
    ) {
		if (!this.events[eventName]) {
			this.events[eventName] = new SubscriptionManager();
		}

		return this.events[eventName].add(callback);
	}

	notify<EventName extends keyof VisualEventCallbacks>(
        eventName: EventName,
        ...args: any
    ) {
		if (this.events[eventName]) {
			this.events[eventName].notify(...args);
		}
	}
	
}
