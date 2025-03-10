import type { MotionValue } from "..";

export const isMotionValue = (value: unknown): value is MotionValue =>
	Boolean(value && (value as MotionValue).getVelocity);