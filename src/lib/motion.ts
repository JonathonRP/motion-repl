import type { SvelteHTMLElements } from 'svelte/elements';
import Motion from './Motion.svelte';
import { createHtmlRenderState, makeUseVisualState } from './motion/utils/use-visual-state';
import { animations } from './motion/features/animations';
import { loadFeatures } from './motion/features/load-features';

export const motion = new Proxy({} as { [K in keyof SvelteHTMLElements]: typeof Motion }, {
    get(_target, key: string) {
        return new Proxy(Motion, {
            apply(target, _thisArg, args) {
                loadFeatures({ ...animations });
                const useVisualState = makeUseVisualState({ createRenderState: createHtmlRenderState });
                if (!args[1]) {
                    args[1] = { props: args[1], useVisualState };
                } else {
                    args[1].props = args[1];
                    args[1].useVisualState = useVisualState;
                }

                return target(...args)
            }
        });
    }
})