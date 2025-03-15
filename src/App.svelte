<script lang="ts">
  import { useCycle } from './lib/useCycle';
  import { motion } from './lib/motion';

  let stateText = $state("State 1");

  const [animate, cycle] = useCycle([
	  { scale: 0.8, backgroundColor: "#9EF4FF" },
	  { scale: 1.2, backgroundColor: "#0FBFFF" }
  ]);
</script>

<div style="min-height: 350px; height: fit-content; touch-action:none; display: flex; justify-content: center; align-items: center;">
	<div style="background: #000; border-radius: 0.5rem; border-style: solid; border-width: 1px; border-color: #0404;">
		<div style=" margin-block: calc(0.25rem * 2); padding: calc(0.25rem * 6); width: 94%">
		<motion.div animate={$animate} onclick={() => {
			cycle();
			if (stateText === "State 1") {
					stateText = "State 2";
			} else {
					stateText = "State 1";
			}
		}}
			class="box">
			{stateText}
		</motion.div>
		</div>
	</div>
</div>

<style>
	:global(.box) {
		color: #455;
		width: 150px;
		height: 150px;
		background-color: #fff;
		border-radius: 30px;
		box-shadow: 0 0 10px #0000001a;
		display: flex;
		justify-content: center;
		align-items: center;
		text-align: center;
		font-size: 1.12rem;
		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;
	}
</style>
