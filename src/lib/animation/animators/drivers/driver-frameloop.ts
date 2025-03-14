import { frame, cancelFrame } from '../../../frameloop';
import { frameData } from '../../../frameloop';
import { time } from '../../../frameloop/sync-time';
import type { FrameData } from '../../../frameloop/types';
import type { Driver } from './types';

export const frameloopDriver: Driver = (update) => {
	const passTimestamp = ({ timestamp }: FrameData) => update(timestamp);

	return {
		start: () => frame.update(passTimestamp, true),
		stop: () => cancelFrame(passTimestamp),
		/**
		 * If we're processing this frame we can use the
		 * framelocked timestamp to keep things in sync.
		 */
		now: () => (frameData.isProcessing ? frameData.timestamp : time.now()),
	};
};

// future test scenerio

// import { AnimationFrames } from "runed";
// import { time } from "../../../frameloop/sync-time";
// import type { Driver } from "./types";

// const frameData = {
//     timestamp: 0.0
// };

// export const frameloopDriver: Driver = (update) => {
//     const passTimeStamp = new AnimationFrames(
//         ({ timestamp }) => {
//             frameData.timestamp = timestamp;
//             return update(timestamp); 
//         }, { immediate: true });

//     return {
//         start: () => passTimeStamp.start,
//         stop: () => passTimeStamp.stop,
//         now: () => (passTimeStamp.running ? frameData.timestamp : time.now())
//     }
// }