import type { Writable, Unsubscriber } from 'svelte/store';
import type { AnimationPlaybackControls } from '../animation/types';
import { frame } from '../frameloop';
import { SubscriptionManager } from '../utils/subscription-manager';
import { velocityPerSecond } from '../utils/velocity-per-second';
import { warnOnce } from '../utils/warn-once';
import { time } from '../frameloop/sync-time';

export type Transformer<T> = (v: T) => T;
/**
 * @public
 */
export type Subscriber<T> = (v: T) => void;
/**
 * @public
 */
export type PassiveEffect<T> = (v: T, safeSetter: (v: T) => void) => void;
export type StartAnimation = (complete: () => void) => AnimationPlaybackControls | undefined;

export interface MotionValueEventCallbacks<V> {
	animationStart: () => void;
	animationComplete: () => void;
	animationCancel: () => void;
	change: (latestValue: V) => void;
	renderRequest: () => void;
}

/**
 * Maximum time between the value of two frames, beyond which we
 * assume the velocity has since been 0.
 */
const MAX_VELOCITY_DELTA = 30;

const isFloat = (value: any): value is string => {
	return !Number.isNaN(Number.parseFloat(value));
};

interface ResolvedValues {
	[key: string]: string | number;
}

export interface Owner {
	current: HTMLElement | unknown;
	getProps: () => { onUpdate?: (latest: ResolvedValues) => void };
}

export interface MotionValueOptions {
	owner?: Owner;
	startStopNotifier?: () => () => void;
}

export const collectMotionValues: { current: MotionValue[] | undefined } = {
	current: undefined,
};

/**
 * `MotionValue` is used to track the state and velocity of motion values.
 *
 * @public
 */
export class MotionValue<V = any> implements Writable<V> {
	/**
	 * Subscribe method to make MotionValue compatible with Svelte store. Returns a unsubscribe function.
	 * Same as onChange.
	 *
	 * @public
	 */
	subscribe(this: void & MotionValue<V>, subscription: Subscriber<V>): Unsubscriber {
		return this.onChange(subscription);
	}
	/**
	 * Update method to make MotionValue compatible with Svelte writable store
	 *
	 * @public
	 */
	update = (cb: (value: V) => V): void => {
		this.set(cb(this.get()));
	};

	/**
	 * This will be replaced by the build step with the latest version number.
	 * When MotionValues are provided to motion components, warn if versions are mixed.
	 */
	version = '__VERSION__';

	/**
	 * If a MotionValue has an owner, it was created internally within Motion
	 * and therefore has no external listeners. It is therefore safe to animate via WAAPI.
	 */
	owner;

	/**
	 * The current state of the `MotionValue`.
	 *
	 * @internal
	 */
	private current: V | undefined;

	/**
	 * The previous state of the `MotionValue`.
	 *
	 * @internal
	 */
	private prev: V | undefined;

	/**
	 * The previous state of the `MotionValue` at the end of the previous frame.
	 */
	private prevFrameValue: V | undefined;

	/**
	 * The last time the `MotionValue` was updated.
	 */
	updatedAt: number;

	/**
	 * The time `prevFrameValue` was updated.
	 */
	prevUpdatedAt: number | undefined;

	/**
	 * Add a passive effect to this `MotionValue`.
	 *
	 * A passive effect intercepts calls to `set`. For instance, `useSpring` adds
	 * a passive effect that attaches a `spring` to the latest
	 * set value. Hypothetically there could be a `useSmooth` that attaches an input smoothing effect.
	 *
	 * @internal
	 */
	private passiveEffect?: PassiveEffect<V>;
	private stopPassiveEffect?: VoidFunction;

	/**
	 * A reference to the currently-controlling animation.
	 */
	animation?: AnimationPlaybackControls;

	/**
	 * Tracks whether this value can output a velocity. Currently this is only true
	 * if the value is numerical, but we might be able to widen the scope here and support
	 * other value types.
	 *
	 * @internal
	 */
	private canTrackVelocity: boolean | null = null;

	/**
	 * Tracks whether this value should be removed
	 * @internal
	 */
	liveStyle?: boolean;

	private  onSubscription = () => {};
	private onUnsubscription = () => {};

	/**
	 * @param init - The initiating value
	 * @param config - Optional configuration options
	 *
	 * -  `transformer`: A function to transform incoming values with.
	 *
	 * @internal
	 */
	constructor(init: V, options: MotionValueOptions = {}) {
		this.setCurrent(init);
		this.owner = options.owner;

		const { startStopNotifier } = options;

		if (startStopNotifier) {
			this.onSubscription = () => {
				if (Object.entries(this.events).reduce((acc, [_key, currEvent]) => acc + currEvent.getSize(), 0) === 0) {
					const unsub = startStopNotifier();
					this.onUnsubscription = () => {};
					if (unsub) {
						this.onUnsubscription = () => {
							if (Object.entries(this.events).reduce((acc, [_key, currEvent]) => acc + currEvent.getSize(), 0) === 0) {
								unsub();
							}
						};
					}
				}
			};
		}
	}

	setCurrent(current: V) {
		this.current = current;
		this.updatedAt = time.now();

		if (this.canTrackVelocity === null && current !== undefined) {
			this.canTrackVelocity = isFloat(this.current);
		}
	}

	setPrevFrameValue(prevFrameValue: V | undefined = this.current) {
		this.prevFrameValue = prevFrameValue;
		this.prevUpdatedAt = this.updatedAt;
	}

	onChange = (subscription: Subscriber<V>): (() => void) => {
		if (process.env.NODE_ENV !== 'production') {
			warnOnce(false, `value.onChange(callback) is deprecated. Switch to value.on("change", callback).`);
		}
		return this.on('change', subscription);
	};

	/**
	 * An object containing a SubscriptionManager for each active event.
	 */
	private events: {
		[key: string]: SubscriptionManager<any>;
	} = {};

	on<EventName extends keyof MotionValueEventCallbacks<V>>(
		eventName: EventName,
		callback: MotionValueEventCallbacks<V>[EventName]
	) {
		if (!this.events[eventName]) {
			this.events[eventName] = new SubscriptionManager();
		}

		this.onSubscription();

		const unsubscribe = this.events[eventName].add(callback);

		if (eventName === 'change') {
			return () => {
				unsubscribe();
				this.onUnsubscription();

				/**
				 * If we have no more change listeners by the start
				 * of the next frame, stop active animations.
				 */
				frame.read(() => {
					if (!this.events.change.getSize()) {
						this.stop();
					}
				});
			};
		}

		return () => {
			unsubscribe();
			this.onUnsubscription();
		};
	}

	clearListeners() {
		for (const eventManagers in this.events) {
			this.events[eventManagers].clear();
		}
		this.onUnsubscription();
	}

	/**
	 * Attaches a passive effect to the `MotionValue`.
	 *
	 * @internal
	 */
	attach(passiveEffect: PassiveEffect<V>, stopPassiveEffect: VoidFunction) {
		this.passiveEffect = passiveEffect;
		this.stopPassiveEffect = stopPassiveEffect;
	}

	/**
	 * Sets the state of the `MotionValue`.
	 *
	 * @remarks
	 *
	 * ```jsx
	 * const x = useMotionValue(0)
	 * x.set(10)
	 * ```
	 *
	 * @param latest - Latest value to set.
	 * @param render - Whether to notify render subscribers. Defaults to `true`
	 *
	 * @public
	 */
	set(v: V, render = true) {
		if (!render || !this.passiveEffect) {
			this.updateAndNotify(v, render);
		} else {
			this.passiveEffect(v, this.updateAndNotify);
		}
	}

	setWithVelocity(prev: V, current: V, delta: number) {
		this.set(current);
		this.prev = undefined;
		this.prevFrameValue = prev;
		this.prevUpdatedAt = this.updatedAt - delta;
	}

	/**
	 * Set the state of the `MotionValue`, stopping any active animations,
	 * effects, and resets velocity to `0`.
	 */
	jump(v: V, endAnimation = true) {
		this.updateAndNotify(v);
		this.prev = v;
		this.prevUpdatedAt = this.prevFrameValue = undefined;
		endAnimation && this.stop();
		if (this.stopPassiveEffect) this.stopPassiveEffect();
	}

	updateAndNotify = (v: V, render = true) => {
		const currentTime = time.now();

		/**
		 * If we're updating the value during another frame or eventloop
		 * than the previous frame, then the we set the previous frame value
		 * to current.
		 */
		if (this.updatedAt !== currentTime) {
			this.setPrevFrameValue();
		}

		this.prev = this.current;

		this.setCurrent(v);

		// Update update subscribers
		if (this.current !== this.prev && this.events.change) {
			this.events.change.notify(this.current);
		}

		// Update render subscribers
		if (render && this.events.renderRequest) {
			this.events.renderRequest.notify(this.current);
		}
	};

	/**
	 * Returns the latest state of `MotionValue`
	 *
	 * @returns - The latest state of `MotionValue`
	 *
	 * @public
	 */
	get() {
		this.onSubscription();

		if (collectMotionValues.current) {
			collectMotionValues.current.push(this);
		}
		const curr = this.current!;

		this.onUnsubscription();
		return curr;
	}

	/**
	 * @public
	 */
	getPrevious() {
		return this.prev;
	}

	/**
	 * Returns the latest velocity of `MotionValue`
	 *
	 * @returns - The latest velocity of `MotionValue`. Returns `0` if the state is non-numerical.
	 *
	 * @public
	 */
	getVelocity() {
		const currentTime = time.now();

		if (
			!this.canTrackVelocity ||
			this.prevFrameValue === undefined ||
			currentTime - this.updatedAt > MAX_VELOCITY_DELTA
		) {
			return 0;
		}

		this.onSubscription();

		const delta = Math.min(this.updatedAt - this.prevUpdatedAt!, MAX_VELOCITY_DELTA);

		// Casts because of parseFloat's poor typing
		const vel = velocityPerSecond(
			Number.parseFloat(this.current as any) - Number.parseFloat(this.prevFrameValue as any),
			delta
		);

		this.onUnsubscription();
		return vel;
	}

	hasAnimated = false;

	/**
	 * Registers a new animation to control this `MotionValue`. Only one
	 * animation can drive a `MotionValue` at one time.
	 *
	 * ```jsx
	 * value.start()
	 * ```
	 *
	 * @param animation - A function that starts the provided animation
	 *
	 * @internal
	 */
	start(startAnimation: StartAnimation) {
		this.stop();
		const { promise, resolve } = Promise.withResolvers<void>();

		this.hasAnimated = true;

		this.animation = startAnimation(resolve);

		if (this.events.animationStart) {
			this.events.animationStart.notify();
		}

		return promise.then(() => {
			if (this.events.animationComplete) {
				this.events.animationComplete.notify();
			}
			this.clearAnimation();
		});
	}
	/**
	 * Stop the currently active animation.
	 *
	 * @public
	 */
	stop() {
		if (this.animation) {
			this.animation.stop();
			if (this.events.animationCancel) {
				this.events.animationCancel.notify();
			}
		}
		this.clearAnimation();
	}
	/**
	 * Returns `true` if this value is currently animating.
	 *
	 * @public
	 */
	isAnimating() {
		return !!this.animation;
	}

	private clearAnimation() {
		delete this.animation;
	}
	/**
	 * Destroy and clean up subscribers to this `MotionValue`.
	 *
	 * The `MotionValue` hooks like `useMotionValue` and `useTransform` automatically
	 * handle the lifecycle of the returned `MotionValue`, so this method is only necessary if you've manually
	 * created a `MotionValue` via the `motionValue` function.
	 *
	 * @public
	 */
	destroy() {
		this.clearListeners();
		this.stop();

		if (this.passiveEffect) {
			this.stopPassiveEffect?.();
		}
		this.onUnsubscription();
	}
}

/**
 * @internal
 */
export function motionValue<V>(init: V, options?: MotionValueOptions): MotionValue<V> {
	return new MotionValue(init, options);
}