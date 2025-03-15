<script lang="ts">
	import { interpolateHsl } from 'd3-interpolate';
	import { Spring, Tween } from 'svelte/motion';
    import { useVisual } from './motion/utils/use-visual.svelte';

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
	const visual = useVisual(
      	as,
		() => visualState,
      	() => props,
    );

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