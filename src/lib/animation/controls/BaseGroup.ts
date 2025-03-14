import type { AnimationPlaybackControls } from "../types";

type PropNames = "time" | "speed" | "duration" | "attachTimeline" | "startTime"

export type AcceptedAnimations =
    | AnimationPlaybackControls
    | AnimationPlaybackControls

export type GroupedAnimations = AcceptedAnimations[]

export class BaseGroupPlaybackControls implements AnimationPlaybackControls
{
    animations: GroupedAnimations;

    constructor(animations: Array<AcceptedAnimations | undefined>) {
        this.animations = animations.filter(Boolean) as GroupedAnimations;
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
    private getAll(propName: PropNames) {
        return this.animations[0][propName] as any
    }

    private setAll<V extends any>(propName: PropNames, newValue: V) {
        for (let i = 0; i < this.animations.length; i++) {
            this.animations[i][propName] = newValue as any
        }
    }

    attachTimeline(
        timeline: any,
        fallback: ((animation: AnimationPlaybackControls) => VoidFunction) | undefined
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
        return this.getAll("time")
    }

    set time(time: number) {
        this.setAll("time", time)
    }

    get speed() {
        return this.getAll("speed")
    }

    set speed(speed: number) {
        this.setAll("speed", speed)
    }

    get startTime() {
        return this.getAll("startTime")
    }

    get duration() {
        let max = 0
        for (let i = 0; i < this.animations.length; i++) {
            max = Math.max(max, this.animations[i].duration)
        }
        return max
    }

    private runAll<K extends keyof Omit<AnimationPlaybackControls, PropNames | "then" | "state">>(
        cb: (input: AnimationPlaybackControls) => AnimationPlaybackControls[K]
    ) {
        this.animations.forEach((controls) => cb(controls)())
    }

    flatten() {
        this.runAll(controls => controls.flatten)
    }

    play() {
        this.runAll(controls => controls.play)
    }

    pause() {
        this.runAll(controls => controls.pause)
    }

    // Bound to accomodate common `return animation.stop` pattern
    stop = () => this.runAll(controls => controls.stop)

    cancel() {
        this.runAll(controls => controls.cancel)
    }

    complete() {
        this.runAll(controls => controls.complete)
    }
}