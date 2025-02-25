export function velocityPerSecond(velocity: number, frameDuration: number) {
	return frameDuration ? velocity * (1000 / frameDuration) : 0;
}