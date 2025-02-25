import { IsMounted, AnimationFrames } from 'runed';

const MotionGlobalConfig = {
	skipAnimations: false,
	useManualTiming: false,
};

type GeneratorFactory = (options: ValueAnimationOptions<any>) => KeyframeGenerator<any>;

const generators: { [key: string]: GeneratorFactory } = {
	decay: inertia,
	inertia,
	tween: keyframes,
	keyframes: keyframes,
	spring,
};

const percentToProgress = (percent: number) => percent / 100;

interface ResolvedData<T extends string | number> {
	generator: KeyframeGenerator<T>;
	mirroredGenerator: KeyframeGenerator<T> | undefined;
	mapPercentToKeyframes: ((v: number) => T) | undefined;

	/**
	 * Duration of the animation as calculated by the generator.
	 */
	calculatedDuration: number;

	/**
	 * Duration of the animation plus repeatDelay.
	 */
	resolvedDuration: number;

	/**
	 * Total duration of the animation including repeats.
	 */
	totalDuration: number;
}

interface AnimationPlaybackControls {
	time: number;
	speed: number;
	startTime: number | null;
	state?: AnimationPlayState;

	/*
	 * The duration is the duration of time calculated for the active part
	 * of the animation without delay or repeat,
	 * which may be added as an extra prop at a later date.
	 */
	duration: number;

	stop: () => void;
	play: () => void;
	pause: () => void;
	complete: () => void;
	cancel: () => void;
	then: (onResolve: VoidFunction, onReject?: VoidFunction) => Promise<void>;
	attachTimeline?: (
		timeline: ProgressTimeline,
		fallback: ((animation: AnimationPlaybackControls) => VoidFunction) | undefined
	) => VoidFunction;
}

interface AnimationPlaybackOptions {
	repeat?: number;
	repeatType?: RepeatType;
	repeatDelay?: number;
}

interface AnimationPlaybackLifecycles<V> {
	onUpdate?: (latest: V) => void;
	onPlay?: () => void;
	onComplete?: () => void;
	onRepeat?: () => void;
	onStop?: () => void;
}

interface Transition
	extends AnimationPlaybackOptions,
		Omit<SpringOptions, 'keyframes'>,
		Omit<InertiaOptions, 'keyframes'>,
		KeyframeOptions {
	delay?: number;
	elapsed?: number;
	driver?: Driver;
	type?: AnimationGeneratorType;
	duration?: number;
	autoplay?: boolean;
	startTime?: number;
}

interface ValueAnimationTransition<V = any> extends Transition, AnimationPlaybackLifecycles<V> {}

interface ValueAnimationOptions<V extends string | number = number> extends ValueAnimationTransition {
	keyframes: V[];
	name?: string;
	from?: V;
	isGenerator?: boolean;
}

interface ValueAnimationOptionsWithRenderContext<V extends string | number = number>
	extends ValueAnimationOptions<V> {
	KeyframeResolver?: typeof KeyframeResolver;
	motionValue?: MotionValue<V>;
	element?: VisualElement<unknown>;
}

const noop = <T>(any: T): T => any;

function addUniqueItem(arr, item) {
	if (arr.indexOf(item) === -1) arr.push(item);
}

function removeItem(arr, item) {
	const index = arr.indexOf(item);
	if (index > -1) arr.splice(index, 1);
}

function getValueTransition(transition, key) {
	return transition
		? transition[key] || transition['default'] || transition
		: undefined;
}

function velocityPerSecond(velocity: number, frameDuration: number) {
	return frameDuration ? velocity * (1000 / frameDuration) : 0;
}

const clamp = (min: number, max: number, v: number) => {
	if (v > max) return max;
	if (v < min) return min;
	return v;
};

type DevMessage = (check: boolean, message: string) => void;

let warning: DevMessage = noop;
let invariant: DevMessage = noop;

if (process.env.NODE_ENV !== 'production') {
	warning = (check, message) => {
		if (!check && typeof console !== 'undefined') {
			console.warn(message);
		}
	};

	invariant = (check, message) => {
		if (!check) {
			throw new Error(message);
		}
	};
}

function createRenderStep(runNextFrame: () => void): Step {
	/**
	 * We create and reuse two queues, one to queue jobs for the current frame
	 * and one for the next. We reuse to avoid triggering GC after x frames.
	 */
	let thisFrame = new Set<Process>();
	let nextFrame = new Set<Process>();

	/**
	 * Track whether we're currently processing jobs in this step. This way
	 * we can decide whether to schedule new jobs for this frame or next.
	 */
	let isProcessing = false;

	let flushNextFrame = false;

	/**
	 * A set of processes which were marked keepAlive when scheduled.
	 */
	const toKeepAlive = new WeakSet<Process>();

	let latestFrameData: FrameData = {
		delta: 0.0,
		timestamp: 0.0,
		isProcessing: false,
	};

	function triggerCallback(callback: Process) {
		if (toKeepAlive.has(callback)) {
			step.schedule(callback);
			runNextFrame();
		}

		callback(latestFrameData);
	}

	const step: Step = {
		/**
		 * Schedule a process to run on the next frame.
		 */
		schedule: (callback, keepAlive = false, immediate = false) => {
			const addToCurrentFrame = immediate && isProcessing;
			const queue = addToCurrentFrame ? thisFrame : nextFrame;

			if (keepAlive) toKeepAlive.add(callback);

			if (!queue.has(callback)) queue.add(callback);

			return callback;
		},

		/**
		 * Cancel the provided callback from running on the next frame.
		 */
		cancel: (callback) => {
			nextFrame.delete(callback);
			toKeepAlive.delete(callback);
		},

		/**
		 * Execute all schedule callbacks.
		 */
		process: (frameData) => {
			latestFrameData = frameData;

			/**
			 * If we're already processing we've probably been triggered by a flushSync
			 * inside an existing process. Instead of executing, mark flushNextFrame
			 * as true and ensure we flush the following frame at the end of this one.
			 */
			if (isProcessing) {
				flushNextFrame = true;
				return;
			}

			isProcessing = true;

			// Swap this frame and the next to avoid GC
			[thisFrame, nextFrame] = [nextFrame, thisFrame];

			// Clear the next frame queue
			nextFrame.clear();

			// Execute this frame
			thisFrame.forEach(triggerCallback);

			isProcessing = false;

			if (flushNextFrame) {
				flushNextFrame = false;
				step.process(frameData);
			}
		},
	};

	return step;
}

const stepsOrder: StepId[] = [
	'read', // Read
	'resolveKeyframes', // Write/Read/Write/Read
	'update', // Compute
	'preRender', // Compute
	'render', // Write
	'postRender', // Compute
];

const maxElapsed = 40;

export function createRenderBatcher(scheduleNextBatch: (callback: Function) => void, allowKeepAlive: boolean) {
	let runNextFrame = false;
	let useDefaultElapsed = true;

	const state: FrameData = {
		delta: 0.0,
		timestamp: 0.0,
		isProcessing: false,
	};

	const flagRunNextFrame = () => (runNextFrame = true);

	const steps = stepsOrder.reduce((acc, key) => {
		acc[key] = createRenderStep(flagRunNextFrame);
		return acc;
	}, {} as Steps);

	const { read, resolveKeyframes, update, preRender, render, postRender } = steps;

	const processBatch = () => {
		const timestamp = MotionGlobalConfig.useManualTiming ? state.timestamp : performance.now();
		runNextFrame = false;

		state.delta = useDefaultElapsed ? 1000 / 60 : Math.max(Math.min(timestamp - state.timestamp, maxElapsed), 1);

		state.timestamp = timestamp;
		state.isProcessing = true;

		// Unrolled render loop for better per-frame performance
		read.process(state);
		resolveKeyframes.process(state);
		update.process(state);
		preRender.process(state);
		render.process(state);
		postRender.process(state);

		state.isProcessing = false;

		if (runNextFrame && allowKeepAlive) {
			useDefaultElapsed = false;
			scheduleNextBatch(processBatch);
		}
	};

	const wake = () => {
		runNextFrame = true;
		useDefaultElapsed = true;

		if (!state.isProcessing) {
			scheduleNextBatch(processBatch);
		}
	};

	const schedule = stepsOrder.reduce((acc, key) => {
		const step = steps[key];
		acc[key] = (process: Process, keepAlive = false, immediate = false) => {
			if (!runNextFrame) wake();

			return step.schedule(process, keepAlive, immediate);
		};
		return acc;
	}, {} as Batcher);

	const cancel = (process: Process) => {
		for (let i = 0; i < stepsOrder.length; i++) {
			steps[stepsOrder[i]].cancel(process);
		}
	};

	return { schedule, cancel, state, steps };
}

const {
	schedule: frame,
	cancel: cancelFrame,
	state: frameData,
	steps: frameSteps,
} = createRenderBatcher(typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : noop, true);

/**
 * This is ported from the Framer implementation of duration-based spring resolution.
 */

type Resolver = (num: number) => number;

const safeMin = 0.001;
export const minDuration = 0.01;
export const maxDuration = 10.0;
export const minDamping = 0.05;
export const maxDamping = 1;

export function findSpring({ duration = 800, bounce = 0.25, velocity = 0, mass = 1 }: SpringOptions) {
	let envelope: Resolver;
	let derivative: Resolver;

	warning(duration <= secondsToMilliseconds(maxDuration), 'Spring duration must be 10 seconds or less');

	let dampingRatio = 1 - bounce;

	/**
	 * Restrict dampingRatio and duration to within acceptable ranges.
	 */
	dampingRatio = clamp(minDamping, maxDamping, dampingRatio);
	duration = clamp(minDuration, maxDuration, millisecondsToSeconds(duration));

	if (dampingRatio < 1) {
		/**
		 * Underdamped spring
		 */
		envelope = (undampedFreq) => {
			const exponentialDecay = undampedFreq * dampingRatio;
			const delta = exponentialDecay * duration;
			const a = exponentialDecay - velocity;
			const b = calcAngularFreq(undampedFreq, dampingRatio);
			const c = Math.exp(-delta);
			return safeMin - (a / b) * c;
		};

		derivative = (undampedFreq) => {
			const exponentialDecay = undampedFreq * dampingRatio;
			const delta = exponentialDecay * duration;
			const d = delta * velocity + velocity;
			const e = Math.pow(dampingRatio, 2) * Math.pow(undampedFreq, 2) * duration;
			const f = Math.exp(-delta);
			const g = calcAngularFreq(Math.pow(undampedFreq, 2), dampingRatio);
			const factor = -envelope(undampedFreq) + safeMin > 0 ? -1 : 1;
			return (factor * ((d - e) * f)) / g;
		};
	} else {
		/**
		 * Critically-damped spring
		 */
		envelope = (undampedFreq) => {
			const a = Math.exp(-undampedFreq * duration);
			const b = (undampedFreq - velocity) * duration + 1;
			return -safeMin + a * b;
		};

		derivative = (undampedFreq) => {
			const a = Math.exp(-undampedFreq * duration);
			const b = (velocity - undampedFreq) * (duration * duration);
			return a * b;
		};
	}

	const initialGuess = 5 / duration;
	const undampedFreq = approximateRoot(envelope, derivative, initialGuess);

	duration = secondsToMilliseconds(duration);
	if (isNaN(undampedFreq)) {
		return {
			stiffness: 100,
			damping: 10,
			duration,
		};
	} else {
		const stiffness = Math.pow(undampedFreq, 2) * mass;
		return {
			stiffness,
			damping: dampingRatio * 2 * Math.sqrt(mass * stiffness),
			duration,
		};
	}
}

const rootIterations = 12;
function approximateRoot(envelope: Resolver, derivative: Resolver, initialGuess: number): number {
	let result = initialGuess;
	for (let i = 1; i < rootIterations; i++) {
		result = result - envelope(result) / derivative(result);
	}
	return result;
}

export function calcAngularFreq(undampedFreq: number, dampingRatio: number) {
	return undampedFreq * Math.sqrt(1 - dampingRatio * dampingRatio);
}

const durationKeys = ['duration', 'bounce'];
const physicsKeys = ['stiffness', 'damping', 'mass'];
const velocitySampleDuration = 5; // ms

function calcGeneratorVelocity(resolveValue: (v: number) => number, t: number, current: number) {
	const prevT = Math.max(t - velocitySampleDuration, 0);
	return velocityPerSecond(current - resolveValue(prevT), t - prevT);
}

function isSpringType(options: SpringOptions, keys: string[]) {
	return keys.some((key) => (options as any)[key] !== undefined);
}

function spring({
	keyframes,
	restDelta,
	restSpeed,
	...options
}: ValueAnimationOptions<number>): KeyframeGenerator<number> {
	const origin = keyframes[0];
	const target = keyframes[keyframes.length - 1];

	/**
	 * This is the Iterator-spec return value. We ensure it's mutable rather than using a generator
	 * to reduce GC during animation.
	 */
	const state: AnimationState<number> = { done: false, value: origin };

	const { stiffness, damping, mass, duration, velocity, isResolvedFromDuration } = getSpringOptions({
		...options,
		velocity: -millisecondsToSeconds(options.velocity || 0),
	});

	const initialVelocity = velocity || 0.0;
	const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass));

	const initialDelta = target - origin;
	const undampedAngularFreq = millisecondsToSeconds(Math.sqrt(stiffness / mass));

	/**
	 * If we're working on a granular scale, use smaller defaults for determining
	 * when the spring is finished.
	 *
	 * These defaults have been selected emprically based on what strikes a good
	 * ratio between feeling good and finishing as soon as changes are imperceptible.
	 */
	const isGranularScale = Math.abs(initialDelta) < 5;
	restSpeed ||= isGranularScale ? 0.01 : 2;
	restDelta ||= isGranularScale ? 0.005 : 0.5;

	let resolveSpring: (v: number) => number;
	if (dampingRatio < 1) {
		const angularFreq = calcAngularFreq(undampedAngularFreq, dampingRatio);

		// Underdamped spring
		resolveSpring = (t: number) => {
			const envelope = Math.exp(-dampingRatio * undampedAngularFreq * t);

			return (
				target -
				envelope *
					(((initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) / angularFreq) *
						Math.sin(angularFreq * t) +
						initialDelta * Math.cos(angularFreq * t))
			);
		};
	} else if (dampingRatio === 1) {
		// Critically damped spring
		resolveSpring = (t: number) =>
			target -
			Math.exp(-undampedAngularFreq * t) * (initialDelta + (initialVelocity + undampedAngularFreq * initialDelta) * t);
	} else {
		// Overdamped spring
		const dampedAngularFreq = undampedAngularFreq * Math.sqrt(dampingRatio * dampingRatio - 1);

		resolveSpring = (t: number) => {
			const envelope = Math.exp(-dampingRatio * undampedAngularFreq * t);

			// When performing sinh or cosh values can hit Infinity so we cap them here
			const freqForT = Math.min(dampedAngularFreq * t, 300);

			return (
				target -
				(envelope *
					((initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) * Math.sinh(freqForT) +
						dampedAngularFreq * initialDelta * Math.cosh(freqForT))) /
					dampedAngularFreq
			);
		};
	}

	return {
		calculatedDuration: isResolvedFromDuration ? duration || null : null,
		next: (t: number) => {
			const current = resolveSpring(t);

			if (!isResolvedFromDuration) {
				let currentVelocity = 0.0;

				/**
				 * We only need to calculate velocity for under-damped springs
				 * as over- and critically-damped springs can't overshoot, so
				 * checking only for displacement is enough.
				 */
				if (dampingRatio < 1) {
					currentVelocity =
						t === 0 ? secondsToMilliseconds(initialVelocity) : calcGeneratorVelocity(resolveSpring, t, current);
				}

				const isBelowVelocityThreshold = Math.abs(currentVelocity) <= restSpeed!;
				const isBelowDisplacementThreshold = Math.abs(target - current) <= restDelta!;

				state.done = isBelowVelocityThreshold && isBelowDisplacementThreshold;
			} else {
				state.done = t >= duration!;
			}

			state.value = state.done ? target : current;

			return state;
		},
	};
}

function inertia({
	keyframes,
	velocity = 0.0,
	power = 0.8,
	timeConstant = 325,
	bounceDamping = 10,
	bounceStiffness = 500,
	modifyTarget,
	min,
	max,
	restDelta = 0.5,
	restSpeed,
}: ValueAnimationOptions<number>): KeyframeGenerator<number> {
	const origin = keyframes[0];

	const state: AnimationState<number> = {
		done: false,
		value: origin,
	};

	const isOutOfBounds = (v: number) => (min !== undefined && v < min) || (max !== undefined && v > max);

	const nearestBoundary = (v: number) => {
		if (min === undefined) return max;
		if (max === undefined) return min;

		return Math.abs(min - v) < Math.abs(max - v) ? min : max;
	};

	let amplitude = power * velocity;
	const ideal = origin + amplitude;
	const target = modifyTarget === undefined ? ideal : modifyTarget(ideal);

	/**
	 * If the target has changed we need to re-calculate the amplitude, otherwise
	 * the animation will start from the wrong position.
	 */
	if (target !== ideal) amplitude = target - origin;

	const calcDelta = (t: number) => -amplitude * Math.exp(-t / timeConstant);

	const calcLatest = (t: number) => target + calcDelta(t);

	const applyFriction = (t: number) => {
		const delta = calcDelta(t);
		const latest = calcLatest(t);
		state.done = Math.abs(delta) <= restDelta;
		state.value = state.done ? target : latest;
	};

	/**
	 * Ideally this would resolve for t in a stateless way, we could
	 * do that by always precalculating the animation but as we know
	 * this will be done anyway we can assume that spring will
	 * be discovered during that.
	 */
	let timeReachedBoundary: number | undefined;
	let spring: KeyframeGenerator<number> | undefined;

	const checkCatchBoundary = (t: number) => {
		if (!isOutOfBounds(state.value)) return;

		timeReachedBoundary = t;

		spring = createSpring({
			keyframes: [state.value, nearestBoundary(state.value)!],
			velocity: calcGeneratorVelocity(calcLatest, t, state.value), // TODO: This should be passing * 1000
			damping: bounceDamping,
			stiffness: bounceStiffness,
			restDelta,
			restSpeed,
		});
	};

	checkCatchBoundary(0);

	return {
		calculatedDuration: null,
		next: (t: number) => {
			/**
			 * We need to resolve the friction to figure out if we need a
			 * spring but we don't want to do this twice per frame. So here
			 * we flag if we updated for this frame and later if we did
			 * we can skip doing it again.
			 */
			let hasUpdatedFrame = false;
			if (!spring && timeReachedBoundary === undefined) {
				hasUpdatedFrame = true;
				applyFriction(t);
				checkCatchBoundary(t);
			}

			/**
			 * If we have a spring and the provided t is beyond the moment the friction
			 * animation crossed the min/max boundary, use the spring.
			 */
			if (timeReachedBoundary !== undefined && t >= timeReachedBoundary) {
				return spring!.next(t - timeReachedBoundary);
			} else {
				!hasUpdatedFrame && applyFriction(t);
				return state;
			}
		},
	};
}

function defaultEasing(values: any[], easing?: EasingFunction): EasingFunction[] {
	return values.map(() => easing || easeInOut).splice(0, values.length - 1);
}

export function keyframes<T extends string | number>({
	duration = 300,
	keyframes: keyframeValues,
	times,
	ease = 'easeInOut',
}: ValueAnimationOptions<T>): KeyframeGenerator<T> {
	/**
	 * Easing functions can be externally defined as strings. Here we convert them
	 * into actual functions.
	 */
	const easingFunctions = isEasingArray(ease) ? ease.map(easingDefinitionToFunction) : easingDefinitionToFunction(ease);

	/**
	 * This is the Iterator-spec return value. We ensure it's mutable rather than using a generator
	 * to reduce GC during animation.
	 */
	const state: AnimationState<T> = {
		done: false,
		value: keyframeValues[0],
	};

	/**
	 * Create a times array based on the provided 0-1 offsets
	 */
	const absoluteTimes = convertOffsetToTimes(
		// Only use the provided offsets if they're the correct length
		// TODO Maybe we should warn here if there's a length mismatch
		times && times.length === keyframeValues.length ? times : defaultOffset(keyframeValues),
		duration
	);

	const mapTimeToKeyframe = interpolate<T>(absoluteTimes, keyframeValues, {
		ease: Array.isArray(easingFunctions) ? easingFunctions : defaultEasing(keyframeValues, easingFunctions),
	});

	return {
		calculatedDuration: duration,
		next: (t: number) => {
			state.value = mapTimeToKeyframe(t);
			state.done = t >= duration;
			return state;
		},
	};
}

const time = {
	// svelte Tween uses this from raf.now()
	// timestamp/time from RAF is fanicy according to svelte in source
	now() {
		return performance?.now() ?? Date.now();
	}
}

/**
 * Generate a list of every possible transform key.
 */
export const transformPropOrder = [
	'transformPerspective',
	'x',
	'y',
	'z',
	'translateX',
	'translateY',
	'translateZ',
	'scale',
	'scaleX',
	'scaleY',
	'rotate',
	'rotateX',
	'rotateY',
	'rotateZ',
	'skew',
	'skewX',
	'skewY',
] as const;

/**
 * A quick lookup for transform props.
 */
export const transformProps = new Set(transformPropOrder);

export class SubscriptionManager {
	#subscriptions = [];
	add = (handler) => {
		addUniqueItem(this.#subscriptions, handler);
		return () => {
			return removeItem(this.#subscriptions, handler);
		};
	};
	notify = (...[a, b, c]) => {
		const numSubscriptions = this.#subscriptions.length;
		if (!numSubscriptions) return;
		if (numSubscriptions === 1) {
			/**
			 * If there's only a single handler we can just call it without invoking a loop.
			 */
			this.subscriptions[0](a, b, c);
		} else {
			for (let i = 0; i < numSubscriptions; i++) {
				/**
				 * Check whether the handler exists before firing as it's possible
				 * the subscriptions were modified during this loop running.
				 */
				const handler = this.#subscriptions[i];
				handler && handler(a, b, c);
			}
		}
	};
	getSize = () => {
		return this.#subscriptions.length;
	};
	clear = () => {
		this.#subscriptions.length = 0;
	};
}

const MAX_RESOLVE_DELAY = 40;

interface ValueAnimationOptionsWithDefaults<T extends string | number>
	extends ValueAnimationOptionsWithRenderContext<T> {
	autoplay: boolean;
	delay: number;
	repeat: number;
	repeatDelay: number;
	repeatType: RepeatType;
}

abstract class BaseAnimation<T extends string | number, Resolved> implements AnimationPlaybackControls {
	// Persistent reference to the options used to create this animation
	protected options: ValueAnimationOptionsWithDefaults<T>;

	// Resolve the current finished promise
	protected resolveFinishedPromise: VoidFunction;

	// A promise that resolves when the animation is complete
	protected currentFinishedPromise: Promise<void>;

	// Track whether the animation has been stopped. Stopped animations won't restart.
	protected isStopped = false;

	// Internal reference to defered resolved keyframes and animation-specific data returned from initPlayback.
	protected _resolved: Resolved & { keyframes: ResolvedKeyframes<T> };

	protected hasAttemptedResolve = false;

	// Reference to the active keyframes resolver.
	protected resolver: KeyframeResolver<T>;

	private createdAt: number;

	private resolvedAt: number | undefined;

	constructor({
		autoplay = true,
		delay = 0,
		type = 'keyframes',
		repeat = 0,
		repeatDelay = 0,
		repeatType = 'loop',
		...options
	}: ValueAnimationOptions<T>) {
		this.createdAt = time.now();

		this.options = {
			autoplay,
			delay,
			type,
			repeat,
			repeatDelay,
			repeatType,
			...options,
		};

		this.updateFinishedPromise();
	}

	/**
	 * This method uses the createdAt and resolvedAt to calculate the
	 * animation startTime. *Ideally*, we would use the createdAt time as t=0
	 * as the following frame would then be the first frame of the animation in
	 * progress, which would feel snappier.
	 *
	 * However, if there's a delay (main thread work) between the creation of
	 * the animation and the first commited frame, we prefer to use resolvedAt
	 * to avoid a sudden jump into the animation.
	 */
	calcStartTime() {
		if (!this.resolvedAt) return this.createdAt;

		return this.resolvedAt - this.createdAt > MAX_RESOLVE_DELAY ? this.resolvedAt : this.createdAt;
	}

	protected abstract initPlayback(keyframes, finalKeyframe?: T): Resolved | false;

	abstract play(): void;
	abstract pause(): void;
	abstract stop(): void;
	abstract cancel(): void;
	abstract complete(): void;
	abstract get speed(): number;
	abstract set speed(newSpeed: number);
	abstract get time(): number;
	abstract set time(newTime: number);
	abstract get duration(): number;
	abstract get state(): AnimationPlayState;
	abstract get startTime(): number | null;

	/**
	 * A getter for resolved data. If keyframes are not yet resolved, accessing
	 * this.resolved will synchronously flush all pending keyframe resolvers.
	 * This is a deoptimisation, but at its worst still batches read/writes.
	 */
	get resolved(): (Resolved & {
				keyframes: ResolvedKeyframes<T>;
				finalKeyframe?: T;
		  })
		| undefined {
		if (!this._resolved && !this.hasAttemptedResolve) {
			flushKeyframeResolvers();
		}

		return this._resolved;
	}

	/**
	 * A method to be called when the keyframes resolver completes. This method
	 * will check if its possible to run the animation and, if not, skip it.
	 * Otherwise, it will call initPlayback on the implementing class.
	 */
	protected onKeyframesResolved(keyframes: ResolvedKeyframes<T>, finalKeyframe?: T) {
		this.resolvedAt = time.now();
		this.hasAttemptedResolve = true;
		const { name, type, velocity, delay, onComplete, onUpdate, isGenerator } = this.options;

		/**
		 * If we can't animate this value with the resolved keyframes
		 * then we should complete it immediately.
		 */
		if (!isGenerator && !canAnimate(keyframes, name, type, velocity)) {
			// Finish immediately
			if (instantAnimationState.current || !delay) {
				onUpdate?.(getFinalKeyframe(keyframes, this.options, finalKeyframe));
				onComplete?.();
				this.resolveFinishedPromise();

				return;
			}
			// Finish after a delay
			else {
				this.options.duration = 0;
			}
		}

		const resolvedAnimation = this.initPlayback(keyframes, finalKeyframe);

		if (resolvedAnimation === false) return;

		this._resolved = {
			keyframes,
			finalKeyframe,
			...resolvedAnimation,
		};

		this.onPostResolved();
	}

	onPostResolved() {}

	/**
	 * Allows the returned animation to be awaited or promise-chained. Currently
	 * resolves when the animation finishes at all but in a future update could/should
	 * reject if its cancels.
	 */
	then(resolve, reject) {
		return this.currentFinishedPromise.then(resolve, reject);
	}

	protected updateFinishedPromise() {
		this.currentFinishedPromise = new Promise((resolve) => {
			this.resolveFinishedPromise = resolve;
		});
	}
}

const toResolve = new Set<KeyframeResolver>();
let isScheduled = false;
let anyNeedsMeasurement = false;

function measureAllKeyframes() {
	if (anyNeedsMeasurement) {
		const resolversToMeasure = Array.from(toResolve).filter((resolver: KeyframeResolver) => resolver.needsMeasurement);
		const elementsToMeasure = new Set(resolversToMeasure.map((resolver) => resolver.element));
		const transformsToRestore = new Map<VisualElement<unknown, unknown>, [string, string | number][]>();

		/**
		 * Write pass
		 * If we're measuring elements we want to remove bounding box-changing transforms.
		 */
		elementsToMeasure.forEach((element: VisualElement<HTMLElement>) => {
			const removedTransforms = removeNonTranslationalTransform(element);

			if (!removedTransforms.length) return;

			transformsToRestore.set(element, removedTransforms);

			element.render();
		});

		// Read
		resolversToMeasure.forEach((resolver) => resolver.measureInitialState());

		// Write
		elementsToMeasure.forEach((element: VisualElement<HTMLElement>) => {
			element.render();

			const restore = transformsToRestore.get(element);
			if (restore) {
				restore.forEach(([key, value]) => {
					element.getValue(key)?.set(value);
				});
			}
		});

		// Read
		resolversToMeasure.forEach((resolver) => resolver.measureEndState());

		// Write
		resolversToMeasure.forEach((resolver) => {
			if (resolver.suspendedScrollY !== undefined) {
				window.scrollTo(0, resolver.suspendedScrollY);
			}
		});
	}

	anyNeedsMeasurement = false;
	isScheduled = false;

	toResolve.forEach((resolver) => resolver.complete());

	toResolve.clear();
}

function readAllKeyframes() {
	toResolve.forEach((resolver) => {
		resolver.readKeyframes();

		if (resolver.needsMeasurement) {
			anyNeedsMeasurement = true;
		}
	});
}

export function flushKeyframeResolvers() {
	readAllKeyframes();
	measureAllKeyframes();
}
	
class KeyframeResolver<T extends string | number = any> {
	name?: string;
	element?: VisualElement<any>;
	finalKeyframe?: T;
	suspendedScrollY?: number;

	protected unresolvedKeyframes: UnresolvedKeyframes<string | number>;

	private motionValue?: MotionValue<T>;
	private onComplete: OnKeyframesResolved<T>;

	/**
	 * Track whether this resolver has completed. Once complete, it never
	 * needs to attempt keyframe resolution again.
	 */
	private isComplete = false;

	/**
	 * Track whether this resolver is async. If it is, it'll be added to the
	 * resolver queue and flushed in the next frame. Resolvers that aren't going
	 * to trigger read/write thrashing don't need to be async.
	 */
	private isAsync = false;

	/**
	 * Track whether this resolver needs to perform a measurement
	 * to resolve its keyframes.
	 */
	needsMeasurement = false;

	/**
	 * Track whether this resolver is currently scheduled to resolve
	 * to allow it to be cancelled and resumed externally.
	 */
	isScheduled = false;

	constructor(
		unresolvedKeyframes: UnresolvedKeyframes<string | number>,
		onComplete: OnKeyframesResolved<T>,
		name?: string,
		motionValue?: MotionValue<T>,
		element?: VisualElement<any>,
		isAsync = false
	) {
		this.unresolvedKeyframes = [...unresolvedKeyframes];
		this.onComplete = onComplete;
		this.name = name;
		this.motionValue = motionValue;
		this.element = element;
		this.isAsync = isAsync;
	}

	scheduleResolve() {
		this.isScheduled = true;
		if (this.isAsync) {
			toResolve.add(this);

			if (!isScheduled) {
				isScheduled = true;
				frame.read(readAllKeyframes);
				frame.resolveKeyframes(measureAllKeyframes);
			}
		} else {
			this.readKeyframes();
			this.complete();
		}
	}

	readKeyframes() {
		const { unresolvedKeyframes, name, element, motionValue } = this;

		/**
		 * If a keyframe is null, we hydrate it either by reading it from
		 * the instance, or propagating from previous keyframes.
		 */
		for (let i = 0; i < unresolvedKeyframes.length; i++) {
			if (unresolvedKeyframes[i] === null) {
				/**
				 * If the first keyframe is null, we need to find its value by sampling the element
				 */
				if (i === 0) {
					const currentValue = motionValue?.get();

					const finalKeyframe = unresolvedKeyframes[unresolvedKeyframes.length - 1];

					if (currentValue !== undefined) {
						unresolvedKeyframes[0] = currentValue;
					} else if (element && name) {
						const valueAsRead = element.readValue(name, finalKeyframe);

						if (valueAsRead !== undefined && valueAsRead !== null) {
							unresolvedKeyframes[0] = valueAsRead;
						}
					}

					if (unresolvedKeyframes[0] === undefined) {
						unresolvedKeyframes[0] = finalKeyframe;
					}

					if (motionValue && currentValue === undefined) {
						motionValue.set(unresolvedKeyframes[0] as T);
					}
				} else {
					unresolvedKeyframes[i] = unresolvedKeyframes[i - 1];
				}
			}
		}
	}

	setFinalKeyframe() {}
	measureInitialState() {}
	renderEndStyles() {}
	measureEndState() {}

	complete() {
		this.isComplete = true;

		this.onComplete(this.unresolvedKeyframes as ResolvedKeyframes<T>, this.finalKeyframe as T);

		toResolve.delete(this);
	}

	cancel() {
		if (!this.isComplete) {
			this.isScheduled = false;
			toResolve.delete(this);
		}
	}

	resume() {
		if (!this.isComplete) this.scheduleResolve();
	}
}

function test(v: any) {
	return (
		isNaN(v) && typeof v === 'string' && (v.match(floatRegex)?.length || 0) + (v.match(colorRegex)?.length || 0) > 0
	);
}

const NUMBER_TOKEN = 'number';
const COLOR_TOKEN = 'color';
const VAR_TOKEN = 'var';
const VAR_FUNCTION_TOKEN = 'var(';
const SPLIT_TOKEN = '${}';

export type ComplexValues = Array<CSSVariableToken | string | number | Color>;

export type ValueIndexes = {
	color: number[];
	number: number[];
	var: number[];
};

export interface ComplexValueInfo {
	values: ComplexValues;
	split: string[];
	indexes: ValueIndexes;
	types: Array<keyof ValueIndexes>;
}

// this regex consists of the `singleCssVariableRegex|rgbHSLValueRegex|digitRegex`
const complexRegex =
	/var\s*\(\s*--(?:[\w-]+\s*|[\w-]+\s*,(?:\s*[^)(\s]|\s*\((?:[^)(]|\([^)(]*\))*\))+\s*)\)|#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\)|-?(?:\d+(?:\.\d+)?|\.\d+)/giu;

export function analyseComplexValue(value: string | number): ComplexValueInfo {
	const originalValue = value.toString();

	const values: ComplexValues = [];
	const indexes: ValueIndexes = {
		color: [],
		number: [],
		var: [],
	};
	const types: Array<keyof ValueIndexes> = [];

	let i = 0;
	const tokenised = originalValue.replace(complexRegex, (parsedValue) => {
		if (color.test(parsedValue)) {
			indexes.color.push(i);
			types.push(COLOR_TOKEN);
			values.push(color.parse(parsedValue));
		} else if (parsedValue.startsWith(VAR_FUNCTION_TOKEN)) {
			indexes.var.push(i);
			types.push(VAR_TOKEN);
			values.push(parsedValue);
		} else {
			indexes.number.push(i);
			types.push(NUMBER_TOKEN);
			values.push(Number.parseFloat(parsedValue));
		}
		++i;
		return SPLIT_TOKEN;
	});
	const split = tokenised.split(SPLIT_TOKEN);

	return { values, split, indexes, types };
}

function parseComplexValue(v: string | number) {
	return analyseComplexValue(v).values;
}

function createTransformer(source: string | number) {
	const { split, types } = analyseComplexValue(source);

	const numSections = split.length;
	return (v: Array<CSSVariableToken | Color | number | string>) => {
		let output = '';
		for (let i = 0; i < numSections; i++) {
			output += split[i];
			if (v[i] !== undefined) {
				const type = types[i];
				if (type === NUMBER_TOKEN) {
					output += sanitize(v[i] as number);
				} else if (type === COLOR_TOKEN) {
					output += color.transform(v[i] as Color);
				} else {
					output += v[i];
				}
			}
		}

		return output;
	};
}

const convertNumbersToZero = (v: number | string | Color) => (typeof v === 'number' ? 0 : v);

function getAnimatableNone(v: string | number) {
	const parsed = parseComplexValue(v);
	const transformer = createTransformer(v);
	return transformer(parsed.map(convertNumbersToZero));
}

export const complex = {
	test,
	parse: parseComplexValue,
	createTransformer,
	getAnimatableNone,
};
	
const isAnimatable = (value: ValueKeyframesDefinition, name?: string) => {
	// If the list of keys tat might be non-animatable grows, replace with Set
	if (name === 'zIndex') return false;

	// If it's a number or a keyframes array, we can animate it. We might at some point
	// need to do a deep isAnimatable check of keyframes, or let Popmotion handle this,
	// but for now lets leave it like this for performance reasons
	if (typeof value === 'number' || Array.isArray(value)) return true;

	if (
		typeof value === 'string' && // It's animatable if we have a string
		(complex.test(value) || value === '0') && // And it contains numbers and/or colors
		!value.startsWith('url(') // Unless it starts with "url("
	) {
		return true;
	}

	return false;
};

function isGenerator(type?: AnimationGeneratorType): type is GeneratorFactory {
	return typeof type === 'function';
}

function hasKeyframesChanged(keyframes: ResolvedKeyframes<any>) {
	const current = keyframes[0];
	if (keyframes.length === 1) return true;
	for (let i = 0; i < keyframes.length; i++) {
		if (keyframes[i] !== current) return true;
	}
}

export function canAnimate(
	keyframes: ResolvedKeyframes<any>,
	name?: string,
	type?: AnimationGeneratorType,
	velocity?: number
) {
	/**
	 * Check if we're able to animate between the start and end keyframes,
	 * and throw a warning if we're attempting to animate between one that's
	 * animatable and another that isn't.
	 */
	const originKeyframe = keyframes[0];
	if (originKeyframe === null) return false;

	/**
	 * These aren't traditionally animatable but we do support them.
	 * In future we could look into making this more generic or replacing
	 * this function with mix() === mixImmediate
	 */
	if (name === 'display' || name === 'visibility') return true;

	const targetKeyframe = keyframes[keyframes.length - 1];
	const isOriginAnimatable = isAnimatable(originKeyframe, name);
	const isTargetAnimatable = isAnimatable(targetKeyframe, name);

	warning(
		isOriginAnimatable === isTargetAnimatable,
		`You are trying to animate ${name} from "${originKeyframe}" to "${targetKeyframe}". ${originKeyframe} is not an animatable value - to enable this animation set ${originKeyframe} to a value animatable to ${targetKeyframe} via the \`style\` property.`
	);

	// Always skip if any of these are true
	if (!isOriginAnimatable || !isTargetAnimatable) {
		return false;
	}

	return hasKeyframesChanged(keyframes) || ((type === 'spring' || isGenerator(type)) && velocity);
}

const isNotNull = (value: unknown) => value !== null;

export function getFinalKeyframe<T>(keyframes: T[], { repeat, repeatType = 'loop' }: Repeat, finalKeyframe?: T): T {
	const resolvedKeyframes = keyframes.filter(isNotNull);
	const index = repeat && repeatType !== 'loop' && repeat % 2 === 1 ? 0 : resolvedKeyframes.length - 1;

	return !index || finalKeyframe === undefined ? resolvedKeyframes[index] : finalKeyframe;
}

class MainThreadAnimation<T extends string | number> extends BaseAnimation<T, ResolvedData<T>> {
	/**
	 * The driver that's controlling the animation loop. Normally this is a requestAnimationFrame loop
	 * but in tests we can pass in a synchronous loop.
	 */
	private driver?: DriverControls = $state();

	/**
	 * The time at which the animation was paused.
	 */
	private holdTime: number | null = $state(null);

	/**
	 * The time at which the animation was cancelled.
	 */
	private cancelTime: number | null = $state(null);

	/**
	 * The current time of the animation.
	 */
	private currentTime = $state(0);

	/**
	 * Playback speed as a factor. 0 would be stopped, -1 reverse and 2 double speed.
	 */
	private playbackSpeed = $state(1);

	/**
	 * The state of the animation to apply when the animation is resolved. This
	 * allows calls to the public API to control the animation before it is resolved,
	 * without us having to resolve it first.
	 */
	private pendingPlayState: AnimationPlayState = $state('running');

	/**
	 * The time at which the animation was started.
	 */
	startTime: number | null = null;
	
	constructor(options: ValueAnimationOptions<T>) {
		super(options);

		const { name, motionValue, element, keyframes } = this.options;

		const KeyframeResolverer = element?.KeyframeResolver || KeyframeResolver;

		const onResolved = (resolvedKeyframes: ResolvedKeyframes<T>, finalKeyframe: T) =>
			this.onKeyframesResolved(resolvedKeyframes, finalKeyframe);

		this.resolver = new KeyframeResolverer(keyframes, onResolved, name, motionValue, element);

		this.resolver.scheduleResolve();
	}

	#initPlayback(keyframes) {
		const { type = 'keyframes', repeat = 0, repeatDelay = 0, repeatType, velocity = 0 } = this.options;

		const generatorFactory = isGenerator(type) ? type : generators[type] || keyframesGeneratorFactory;

		/**
		 * If our generator doesn't support mixing numbers, we need to replace keyframes with
		 * [0, 100] and then make a function that maps that to the actual keyframes.
		 *
		 * 100 is chosen instead of 1 as it works nicer with spring animations.
		 */
		let mapPercentToKeyframes;
		let mirroredGenerator;

		if (generatorFactory !== keyframesGeneratorFactory && typeof keyframes[0] !== 'number') {
			if (process.env.NODE_ENV !== 'production') {
				invariant(
					keyframes.length === 2,
					`Only two keyframes currently supported with spring and inertia animations. Trying to animate ${keyframes}`
				);
			}

			mapPercentToKeyframes = pipe(percentToProgress, mix(keyframes[0], keyframes[1]));

			keyframes = [0, 100];
		}

		const generator = generatorFactory({ ...this.options, keyframes });

		/**
		 * If we have a mirror repeat type we need to create a second generator that outputs the
		 * mirrored (not reversed) animation and later ping pong between the two generators.
		 */
		if (repeatType === 'mirror') {
			mirroredGenerator = generatorFactory({
				...this.options,
				keyframes: [...keyframes].reverse(),
				velocity: -velocity,
			});
		}

		/**
		 * If duration is undefined and we have repeat options,
		 * we need to calculate a duration from the generator.
		 *
		 * We set it to the generator itself to cache the duration.
		 * Any timeline resolver will need to have already precalculated
		 * the duration by this step.
		 */
		if (generator.calculatedDuration === null) {
			generator.calculatedDuration = calcGeneratorDuration(generator);
		}

		const { calculatedDuration } = generator;
		const resolvedDuration = calculatedDuration + repeatDelay;
		const totalDuration = resolvedDuration * (repeat + 1) - repeatDelay;

		return {
			generator,
			mirroredGenerator,
			mapPercentToKeyframes,
			calculatedDuration,
			resolvedDuration,
			totalDuration,
		};
	}

	onPostResolved() {
		const { autoplay = true } = this.options;

		this.play();

		if (this.pendingPlayState === 'paused' || !autoplay) {
			this.pause();
		} else {
			this.state.current = this.pendingPlayState;
		}
	}

	tick(timestamp, sample = false) {
		const { resolved } = this;

		// If the animations has failed to resolve, return the final keyframe.
		if (!resolved) {
			const { keyframes } = this.options;
			return { done: true, value: keyframes[keyframes.length - 1] };
		}

		const {
			finalKeyframe,
			generator,
			mirroredGenerator,
			mapPercentToKeyframes,
			keyframes,
			calculatedDuration,
			totalDuration,
			resolvedDuration,
		} = resolved;

		if (this.startTime === null) return generator.next(0);

		const { delay, repeat, repeatType, repeatDelay, onUpdate } = this.options;

		/**
		 * requestAnimationFrame timestamps can come through as lower than
		 * the startTime as set by performance.now(). Here we prevent this,
		 * though in the future it could be possible to make setting startTime
		 * a pending operation that gets resolved here.
		 */
		if (this.speed > 0) {
			this.startTime = Math.min(this.startTime, timestamp);
		} else if (this.speed < 0) {
			this.startTime = Math.min(timestamp - totalDuration / this.speed, this.startTime);
		}

		// Update currentTime
		if (sample) {
			this.currentTime = timestamp;
		} else if (this.holdTime !== null) {
			this.currentTime = this.holdTime;
		} else {
			// Rounding the time because floating point arithmetic is not always accurate, e.g. 3000.367 - 1000.367 =
			// 2000.0000000000002. This is a problem when we are comparing the currentTime with the duration, for
			// example.
			this.currentTime = Math.round(timestamp - this.startTime) * this.speed;
		}

		// Rebase on delay
		const timeWithoutDelay = this.currentTime - delay * (this.speed >= 0 ? 1 : -1);
		const isInDelayPhase = this.speed >= 0 ? timeWithoutDelay < 0 : timeWithoutDelay > totalDuration;
		this.currentTime = Math.max(timeWithoutDelay, 0);

		// If this animation has finished, set the current time  to the total duration.
		if (this.state === 'finished' && this.holdTime === null) {
			this.currentTime = totalDuration;
		}

		let elapsed = this.currentTime;

		let frameGenerator = generator;

		if (repeat) {
			/**
			 * Get the current progress (0-1) of the animation. If t is >
			 * than duration we'll get values like 2.5 (midway through the
			 * third iteration)
			 */
			const progress = Math.min(this.currentTime, totalDuration) / resolvedDuration;

			/**
			 * Get the current iteration (0 indexed). For instance the floor of
			 * 2.5 is 2.
			 */
			let currentIteration = Math.floor(progress);

			/**
			 * Get the current progress of the iteration by taking the remainder
			 * so 2.5 is 0.5 through iteration 2
			 */
			let iterationProgress = progress % 1.0;

			/**
			 * If iteration progress is 1 we count that as the end
			 * of the previous iteration.
			 */
			if (!iterationProgress && progress >= 1) {
				iterationProgress = 1;
			}

			iterationProgress === 1 && currentIteration--;

			currentIteration = Math.min(currentIteration, repeat + 1);

			/**
			 * Reverse progress if we're not running in "normal" direction
			 */

			const isOddIteration = Boolean(currentIteration % 2);
			if (isOddIteration) {
				if (repeatType === 'reverse') {
					iterationProgress = 1 - iterationProgress;
					if (repeatDelay) {
						iterationProgress -= repeatDelay / resolvedDuration;
					}
				} else if (repeatType === 'mirror') {
					frameGenerator = mirroredGenerator;
				}
			}

			elapsed = clamp(0, 1, iterationProgress) * resolvedDuration;
		}

		/**
		 * If we're in negative time, set state as the initial keyframe.
		 * This prevents delay: x, duration: 0 animations from finishing
		 * instantly.
		 */
		const state = isInDelayPhase ? { done: false, value: keyframes[0] } : frameGenerator.next(elapsed);

		if (mapPercentToKeyframes) {
			state.value = mapPercentToKeyframes(state.value);
		}

		let { done } = state;

		if (!isInDelayPhase && calculatedDuration !== null) {
			done = this.speed >= 0 ? this.currentTime >= totalDuration : this.currentTime <= 0;
		}

		const isAnimationFinished =
			this.holdTime === null && (this.state === 'finished' || (this.state === 'running' && done));

		if (isAnimationFinished && finalKeyframe !== undefined) {
			state.value = getFinalKeyframe(keyframes, this.options, finalKeyframe);
		}

		if (onUpdate) {
			onUpdate(state.value);
		}

		if (isAnimationFinished) {
			this.finish();
		}

		return state;
	}

	state: AnimationPlayState = 'idle';

	get duration() {
		const { resolved } = this;
		return resolved ? millisecondsToSeconds(resolved.calculatedDuration) : 0;
	}

	get time() {
		return millisecondsToSeconds(this.currentTime);
	}

	set time(newTime) {
		newTime = secondsToMilliseconds(newTime);
		this.currentTime = newTime;

		if (this.holdTime !== null || this.speed === 0) {
			this.holdTime = newTime;
		} else if (this.driver) {
			this.startTime = this.driver.now() - newTime / this.speed;
		}
	}

	get speed() {
		return this.playbackSpeed;
	}

	set speed(newSpeed) {
		const hasChanged = this.playbackSpeed !== newSpeed;
		this.playbackSpeed = newSpeed;
		if (hasChanged) {
			this.time = millisecondsToSeconds(this.currentTime);
		}
	}

	// svelte Tween uses this from raf.now()
	// timestamp/time from RAF is fanicy according to svelte in source
	// now() {
	// 	return performance?.now() ?? Date.now();
	// }

	play() {
		if (!this.resolver.isScheduled) {
			this.resolver.resume();
		}

		if (!this._resolved) {
			this.pendingPlayState = 'running';
			return;
		}

		if (this.isStopped) return;

		const { driver = frameloopDriver, onPlay, startTime } = this.options;

		if (!this.driver) {
			this.driver = driver((timestamp) => this.tick(timestamp));
		}

		onPlay && onPlay();

		const now = this.driver.now();
		if (this.holdTime !== null) {
			this.startTime = now - this.holdTime;
		} else if (!this.startTime) {
			this.startTime = startTime ?? this.calcStartTime();
		} else if (this.state === 'finished') {
			this.startTime = now;
		}

		if (this.state === 'finished') {
			this.updateFinishedPromise();
		}

		this.cancelTime = this.startTime;
		this.holdTime = null;

		/**
		 * Set playState to running only after we've used it in
		 * the previous logic.
		 */
		this.state = 'running';

		this.driver.start();
	}

	pause() {
		if (!this._resolved) {
			this.pendingPlayState = 'paused';
			return;
		}

		this.state = 'paused';
		this.holdTime = this.currentTime ?? 0;
	}

	/**
	 * This method is bound to the instance to fix a pattern where
	 * animation.stop is returned as a reference from a useEffect.
	 */
	stop = () => {
		this.resolver.cancel();
		this.isStopped = true;
		if (this.state === 'idle') return;
		this.teardown();
		const { onStop } = this.options;
		onStop && onStop();
	};

	complete() {
		if (this.state !== 'running') {
			this.play();
		}

		this.pendingPlayState = this.state.current = 'finished';
		this.holdTime = null;
	}

	finish() {
		this.teardown();
		this.state.current = 'finished';

		const { onComplete } = this.options;
		onComplete && onComplete();
	}

	cancel() {
		if (this.cancelTime !== null) {
			this.tick(this.cancelTime);
		}
		this.teardown();
		this.updateFinishedPromise();
	}

	#teardown() {
		this.state.current = 'idle';
		this.stopDriver();
		this.resolveFinishedPromise();
		this.updateFinishedPromise();
		this.startTime = this.cancelTime = null;
		this.resolver.cancel();
	}

	#stopDriver() {
		if (!this.driver) return;
		this.driver.stop();
		this.driver = undefined;
	}
}

export class GroupPlaybackControls
    implements AnimationPlaybackControls
{
    animations;

    constructor(animations /* Array<AcceptedAnimations | undefined> */) {
        this.animations = animations.filter(x => x);
    }

    get finished() {
        // Support for new finished Promise and legacy thennable API
        return Promise.all(
            this.animations.map((animation) =>
                "finished" in animation ? animation.finished : animation
            )
        )
    }

    /**
     * TODO: Filter out cancelled or stopped animations before returning
     */
    #getAll(propName) {
        return this.animations[0][propName]
    }

    #setAll(propName, newValue) {
        for (let i = 0; i < this.animations.length; i++) {
            this.animations[i][propName] = newValue
        }
    }

    attachTimeline(
        timeline,
        fallback
    ) {
        const subscriptions = this.animations.map((animation) => {
             if (typeof fallback === "function") {
                return fallback(animation)
            }
        })

        return () => {
            subscriptions.forEach((cancel, i) => {
                cancel && cancel()
                this.animations[i].stop()
            })
        }
    }

    get time() {
        return this.#getAll("time")
    }

    set time(time) {
        this.#setAll("time", time)
    }

    get speed() {
        return this.#getAll("speed")
    }

    set speed(speed) {
        this.#setAll("speed", speed)
    }

    get startTime() {
        return this.#getAll("startTime")
    }

    get duration() {
        let max = 0
        for (let i = 0; i < this.animations.length; i++) {
            max = Math.max(max, this.animations[i].duration)
        }
        return max
    }

		// <K extends keyof Omit<AnimationPlaybackControls, PropsNames | "then" | "state">>
    #runAll(
        cb // (input: AnimationPlaybackControls) => K
    ) {
        this.animations.forEach((controls) => controls[cb(controls)]())
    }

    flatten() {
        this.#runAll(controls => controls.flatten)
    }

    play() {
        this.#runAll(controls => controls.play)
    }

    pause() {
        this.#runAll(controls => controls.pause)
    }

    // Bound to accomodate common `return animation.stop` pattern
    stop = () => this.#runAll(controls => controls.stop)

    cancel() {
        this.#runAll(controls => controls.cancel)
    }

    complete() {
        this.#runAll(controls => controls.complete)
    }
}

const secondsToMilliseconds = (seconds: number) => seconds * 1000;
const millisecondsToSeconds = (milliseconds: number) => milliseconds / 1000;

const instantAnimationState = {
	current: false,
};

export const animateMotionValue =
	(
		name,
		value,
		target,
		transition = {},
		element,
		isHandoff
	) =>
	(onComplete) => {
		const valueTransition = getValueTransition(transition, name) || {};

		/**
		 * Most transition values are currently completely overwritten by value-specific
		 * transitions. In the future it'd be nicer to blend these transitions. But for now
		 * delay actually does inherit from the root transition if not value-specific.
		 */
		const delay = valueTransition.delay || transition.delay || 0;

		/**
		 * Elapsed isn't a public transition option but can be passed through from
		 * optimized appear effects in milliseconds.
		 */
		let { elapsed = 0 } = transition;
		elapsed = elapsed - secondsToMilliseconds(delay);

		let options = {
			keyframes: Array.isArray(target) ? target : [null, target],
			ease: 'easeOut',
			velocity: value.getVelocity(),
			...valueTransition,
			delay: -elapsed,
			onUpdate: (v) => {
				value.set(v);
				valueTransition.onUpdate && valueTransition.onUpdate(v);
			},
			onComplete: () => {
				onComplete();
				valueTransition.onComplete && valueTransition.onComplete();
			},
			name,
			motionValue: value,
			element: isHandoff ? undefined : element,
		};

		/**
		 * If there's no transition defined for this value, we can generate
		 * unqiue transition settings for this value.
		 */
		if (!isTransitionDefined(valueTransition)) {
			options = {
				...options,
				...getDefaultTransition(name, options),
			};
		}

		/**
		 * Both WAAPI and our internal animation functions use durations
		 * as defined by milliseconds, while our external API defines them
		 * as seconds.
		 */
		if (options.duration) {
			options.duration = secondsToMilliseconds(options.duration);
		}
		if (options.repeatDelay) {
			options.repeatDelay = secondsToMilliseconds(options.repeatDelay);
		}

		if (options.from !== undefined) {
			options.keyframes[0] = options.from;
		}

		let shouldSkip = false;

		if (options.type === false || (options.duration === 0 && !options.repeatDelay)) {
			options.duration = 0;

			if (options.delay === 0) {
				shouldSkip = true;
			}
		}

		if (instantAnimationState.current || MotionGlobalConfig.skipAnimations) {
			shouldSkip = true;
			options.duration = 0;
			options.delay = 0;
		}

		/**
		 * If we can or must skip creating the animation, and apply only
		 * the final keyframe, do so. We also check once keyframes are resolved but
		 * this early check prevents the need to create an animation at all.
		 */
		if (shouldSkip && !isHandoff && value.get() !== undefined) {
			const finalKeyframe = getFinalKeyframe<V>(options.keyframes, valueTransition);

			if (finalKeyframe !== undefined) {
				frame.update(() => {
					options.onUpdate(finalKeyframe);
					options.onComplete();
				});

				// We still want to return some animation controls here rather
				// than returning undefined
				return new GroupPlaybackControls([]);
			}
		}
		/**
		 * Animate via WAAPI if possible. If this is a handoff animation, the optimised animation will be running via
		 * WAAPI. Therefore, this animation must be JS to ensure it runs "under" the
		 * optimised animation.
		 */
		// if (!isHandoff && AcceleratedAnimation.supports(options)) {
		// 	return new AcceleratedAnimation(options);
		// } else {
			return new MainThreadAnimation(options);
		// }
	};

function isTransitionDefined(transition) {
	return !!Object.keys(transition).length;
}

/**
 * Maximum time between the value of two frames, beyond which we
 * assume the velocity has since been 0.
 */
const MAX_VELOCITY_DELTA = 30;

const isFloat = (value) => {
	return !Number.isNaN(Number.parseFloat(value));
};

export const collectMotionValues = {
	current: undefined,
};

/**
 * `MotionValue` is used to track the state and velocity of motion values.
 *
 * @public
 */
export class MotionValue {
	/**
	 * Subscribe method to make MotionValue compatible with Svelte store. Returns a unsubscribe function.
	 * Same as onChange.
	 *
	 * @public
	 */
	subscribe(subscription) {
		return this.onChange(subscription);
	}
	/**
	 * Update method to make MotionValue compatible with Svelte writable store
	 *
	 * @public
	 */
	update = (cb) => {
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
	#current;

	/**
	 * The previous state of the `MotionValue`.
	 *
	 * @internal
	 */
	#prev;

	/**
	 * The previous state of the `MotionValue` at the end of the previous frame.
	 */
	#prevFrameValue;

	/**
	 * The last time the `MotionValue` was updated.
	 */
	#updatedAt;

	/**
	 * The time `prevFrameValue` was updated.
	 */
	#prevUpdatedAt;

	/**
	 * Add a passive effect to this `MotionValue`.
	 *
	 * A passive effect intercepts calls to `set`. For instance, `useSpring` adds
	 * a passive effect that attaches a `spring` to the latest
	 * set value. Hypothetically there could be a `useSmooth` that attaches an input smoothing effect.
	 *
	 * @internal
	 */
	#passiveEffect;
	#stopPassiveEffect;

	/**
	 * A reference to the currently-controlling animation.
	 */
	animation;

	/**
	 * Tracks whether this value can output a velocity. Currently this is only true
	 * if the value is numerical, but we might be able to widen the scope here and support
	 * other value types.
	 *
	 * @internal
	 */
	#canTrackVelocity = null;

	/**
	 * Tracks whether this value should be removed
	 * @internal
	 */
	liveStyle;

	#onSubscription = () => {};
	#onUnsubscription = () => {};

	/**
	 * @param init - The initiating value
	 * @param config - Optional configuration options
	 *
	 * -  `transformer`: A function to transform incoming values with.
	 *
	 * @internal
	 */
	constructor(init, options = {}) {
		this.setCurrent(init);
		this.owner = options.owner;

		const { startStopNotifier } = options;

		if (startStopNotifier) {
			this.#onSubscription = () => {
				if (Object.entries(this.#events).reduce((acc, [_key, currEvent]) => acc + currEvent.getSize(), 0) === 0) {
					const unsub = startStopNotifier();
					this.#onUnsubscription = () => {};
					if (unsub) {
						this.#onUnsubscription = () => {
							if (Object.entries(this.#events).reduce((acc, [_key, currEvent]) => acc + currEvent.getSize(), 0) === 0) {
								unsub();
							}
						};
					}
				}
			};
		}
	}

	setCurrent(current) {
		this.current = current;
		this.#updatedAt = time.now();

		if (this.#canTrackVelocity === null && current !== undefined) {
			this.#canTrackVelocity = isFloat(this.current);
		}
	}

	setPrevFrameValue(prevFrameValue = this.current) {
		this.#prevFrameValue = prevFrameValue;
		this.#prevUpdatedAt = this.#updatedAt;
	}

	onChange = (subscription) => {
		if (process.env.NODE_ENV !== 'production') {
			warnOnce(false, `value.onChange(callback) is deprecated. Switch to value.on("change", callback).`);
		}
		return this.on('change', subscription);
	};

	/**
	 * An object containing a SubscriptionManager for each active event.
	 */
	#events = {};

	on(
		eventName,
		callback
	) {
		if (!this.#events[eventName]) {
			this.#events[eventName] = new SubscriptionManager();
		}

		this.#onSubscription();

		const unsubscribe = this.#events[eventName].add(callback);

		if (eventName === 'change') {
			return () => {
				unsubscribe();
				this.#onUnsubscription();

				/**
				 * If we have no more change listeners by the start
				 * of the next frame, stop active animations.
				 */
				frame.read(() => {
					if (!this.#events.change.getSize()) {
						this.stop();
					}
				});
			};
		}

		return () => {
			unsubscribe();
			this.#onUnsubscription();
		};
	}

	clearListeners() {
		for (const eventManagers in this.#events) {
			this.#events[eventManagers].clear();
		}
		this.#onUnsubscription();
	}

	/**
	 * Attaches a passive effect to the `MotionValue`.
	 *
	 * @internal
	 */
	attach(passiveEffect, stopPassiveEffect) {
		this.#passiveEffect = passiveEffect;
		this.#stopPassiveEffect = stopPassiveEffect;
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
	set(v, render = true) {
		if (!render || !this.#passiveEffect) {
			this.updateAndNotify(v, render);
		} else {
			this.#passiveEffect(v, this.updateAndNotify);
		}
	}

	setWithVelocity(prev, current, delta) {
		this.set(current);
		this.#prev = undefined;
		this.#prevFrameValue = prev;
		this.#prevUpdatedAt = this.#updatedAt - delta;
	}

	/**
	 * Set the state of the `MotionValue`, stopping any active animations,
	 * effects, and resets velocity to `0`.
	 */
	jump(v, endAnimation = true) {
		this.updateAndNotify(v);
		this.#prev = v;
		this.#prevUpdatedAt = this.#prevFrameValue = undefined;
		endAnimation && this.stop();
		if (this.#stopPassiveEffect) this.#stopPassiveEffect();
	}

	updateAndNotify = (v, render = true) => {
		const currentTime = time.now();

		/**
		 * If we're updating the value during another frame or eventloop
		 * than the previous frame, then the we set the previous frame value
		 * to current.
		 */
		if (this.#updatedAt !== currentTime) {
			this.setPrevFrameValue();
		}

		this.#prev = this.current;

		this.setCurrent(v);

		// Update update subscribers
		if (this.current !== this.#prev && this.#events.change) {
			this.#events.change.notify(this.current);
		}

		// Update render subscribers
		if (render && this.#events.renderRequest) {
			this.#events.renderRequest.notify(this.current);
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
		this.#onSubscription();

		if (collectMotionValues.current) {
			collectMotionValues.current.push(this);
		}
		const curr = this.current;

		this.#onUnsubscription();
		return curr;
	}

	/**
	 * @public
	 */
	getPrevious() {
		return this.#prev;
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
			!this.#canTrackVelocity ||
			this.#prevFrameValue === undefined ||
			currentTime - this.#updatedAt > MAX_VELOCITY_DELTA
		) {
			return 0;
		}

		this.#onSubscription();

		const delta = Math.min(this.#updatedAt - this.#prevUpdatedAt, MAX_VELOCITY_DELTA);

		// Casts because of parseFloat's poor typing
		const vel = velocityPerSecond(
			Number.parseFloat(this.current) - Number.parseFloat(this.#prevFrameValue),
			delta
		);

		this.#onUnsubscription();
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
	start(startAnimation) {
		this.stop();
		const { promise, resolve } = Promise.withResolvers();

		this.hasAnimated = true;

		this.animation = startAnimation(resolve);

		if (this.#events.animationStart) {
			this.#events.animationStart.notify();
		}

		return promise.then(() => {
			if (this.#events.animationComplete) {
				this.#events.animationComplete.notify();
			}
			this.#clearAnimation();
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
			if (this.#events.animationCancel) {
				this.#events.animationCancel.notify();
			}
		}
		this.#clearAnimation();
	}
	/**
	 * Returns `true` if this value is currently animating.
	 *
	 * @public
	 */
	isAnimating() {
		return !!this.animation;
	}

	#clearAnimation() {
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

		if (this.#passiveEffect) {
			this.#stopPassiveEffect?.();
		}
		this.#onUnsubscription();
	}
}

/**
 * @internal
 */
export function motionValue(init, options) {
	return new MotionValue(init, options);
}

export const createHtmlRenderState = () =>
	({
		style: {},
		transform: {},
		transformOrigin: {},
		vars: {},
	});

function makeState(
	{ createRenderState, onMount },
	props
) {
	const state = {
		latestValues: makeLatestValues(props),
		renderState: createRenderState(),
	};

	if (onMount) {
		state.mount = (instance) => onMount(props, instance, state);
	}

	return state;
}

export const makeUseVisualState =
	(config) =>
	(props, isStatic) => {
		const make = () => makeState(config, props);

		const state = make();

		return isStatic ? make() : state;
	};

function makeLatestValues(
	props
) {
	const values = {};

	// const motionValues = scrapeMotionValues(() => props, {});
	// for (const key in motionValues) {
	// 	values[key] = resolveMotionValue(motionValues[key]);
	// }

	let { initial, animate } = props;

	const variantToSet = false ? animate : initial;

	if (variantToSet && typeof variantToSet !== 'boolean' && !isAnimationControls(variantToSet)) {
		const list = Array.isArray(variantToSet) ? variantToSet : [variantToSet];
		list.forEach((definition) => {
			const resolved = resolveVariantFromProps(props, definition);
			if (!resolved) return;

			const { transitionEnd, transition, ...target } = resolved;
			for (const key in target) {
				let valueTarget = target[key];

				if (Array.isArray(valueTarget)) {
					/**
					 * Take final keyframe if the initial animation is blocked because
					 * we want to initialise at the end of that blocked animation.
					 */
					const index = isInitialAnimationBlocked ? valueTarget.length - 1 : 0;
					valueTarget = valueTarget[index];
				}

				if (valueTarget !== null) {
					values[key] = valueTarget;
				}
			}
			for (const key in transitionEnd)
				values[key] = transitionEnd[key];
		});
	}

	return values;
}

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
];

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