import type { AnimationPlaybackControls } from '../types';
import { BaseGroupPlaybackControls } from './BaseGroup';

export class GroupPlaybackControls extends BaseGroupPlaybackControls
    implements AnimationPlaybackControls
{
    animations: AnimationPlaybackControls[]

    then(onResolve: VoidFunction, onReject?: VoidFunction) {
        return Promise.all(this.animations).then(onResolve).catch(onReject);
    }
}