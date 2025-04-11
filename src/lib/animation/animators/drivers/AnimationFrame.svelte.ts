import { BROWSER } from 'esm-env';
import { onMount, untrack } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';

type Getter<T> = () => T;
type MaybeGetter<T> = T | Getter<T>;

type ConfigurableWindow = {
	/** Provide a custom `window` object to use in place of the global `window` object. */
	window?: typeof globalThis & Window;
};

const defaultWindow = BROWSER && typeof window !== "undefined" ? window : undefined;

type RafCallbackParams = {
	/** The number of milliseconds since the last frame. */
	delta: number;
	/**
	 * Time elapsed since the creation of the web page.
	 * See {@link https://developer.mozilla.org/en-US/docs/Web/API/DOMHighResTimeStamp#the_time_origin Time origin}.
	 */
	timestamp: DOMHighResTimeStamp;
};

/**
 * Extracts the value from a getter or a value.
 * Optionally, a default value can be provided.
 */
function extract<T>(value: MaybeGetter<T>, defaultValue?: T): T {
	if (isFunction(value)) {
		const getter = value as Getter<T>;
		return getter() ?? defaultValue ?? getter();
	}

	return value ?? defaultValue ?? value;
}

export type AnimationFramesOptions = ConfigurableWindow & {
	/**
	 * Start calling requestAnimationFrame immediately.
	 *
	 * @default true
	 */
	immediate?: boolean;

	/**
	 * Limit the number of frames per second.
	 * Set to `0` to disable
	 *
	 * @default 0
	 */
	fpsLimit?: MaybeGetter<number>;
};

/**
 * Wrapper over {@link https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame requestAnimationFrame},
 * with controls for pausing and resuming the animation, reactive tracking and optional limiting of fps, and utilities.
 */
export class AnimationFrames {
	#callback: (params: RafCallbackParams) => void;
	#fpsLimitOption: AnimationFramesOptions["fpsLimit"] = 0;
	#fpsLimit = $derived(extract(this.#fpsLimitOption) ?? 0);
	#previousTimestamp: number | null = null;
	#frame: number | null = null;
	#fps = $state(0);
	#running = $state(false);
	#window = defaultWindow;
	// #subscribe: ReturnType<typeof createSubscriber>;

	constructor(callback: (params: RafCallbackParams) => void, options: AnimationFramesOptions = {}) {
		if (options.window) this.#window = options.window;
		this.#fpsLimitOption = options.fpsLimit;
		this.#callback = callback;

		this.start = this.start.bind(this);
		this.stop = this.stop.bind(this);
		this.toggle = this.toggle.bind(this);

		// this.#subscribe = createSubscriber(() => {
		// 	console.log('subscribe');

		// 	$effect(() => {
		// 		if(options.immediate ?? true) {
		// 			untrack(this.start);
		// 		}

		// 		return this.stop;
		// 	});
		// });

		// this.#subscribe();

		$effect.root(() => {
			$effect(() => {
				if (options.immediate ?? true) {
					untrack(this.start);
				}

				return this.stop;
			});
		});
	}

	#loop(timestamp: DOMHighResTimeStamp): void {
		if (!this.#running || !this.#window) return;

		if (this.#previousTimestamp === null) {
			this.#previousTimestamp = timestamp;
		}

		const delta = timestamp - this.#previousTimestamp;
		const fps = 1000 / delta;
		if (this.#fpsLimit && fps > this.#fpsLimit) {
			this.#frame = this.#window.requestAnimationFrame(this.#loop.bind(this));
			return;
		}

		this.#fps = fps;
		this.#previousTimestamp = timestamp;
		this.#callback({ delta, timestamp });
		this.#frame = this.#window.requestAnimationFrame(this.#loop.bind(this));
		// this.#subscribe();
	}

	start(): void {
		if (!this.#window) return;
		this.#running = true;
		this.#previousTimestamp = 0;
		this.#frame = this.#window.requestAnimationFrame(this.#loop.bind(this));
	}

	stop(): void {
		if (!this.#frame || !this.#window) return;
		this.#running = false;
		this.#window.cancelAnimationFrame(this.#frame);
		this.#frame = null;
	}

	toggle(): void {
		this.#running ? this.stop() : this.start();
	}

	get fps(): number {
		return !this.#running ? 0 : this.#fps;
	}

	get running(): boolean {
		return this.#running;
	}
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}