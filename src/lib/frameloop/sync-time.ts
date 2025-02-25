export const time = {
	// svelte Tween uses this from raf.now()
	// timestamp/time from RAF is fanicy according to svelte in source
	now() {
		return performance?.now() ?? Date.now();
	}
}