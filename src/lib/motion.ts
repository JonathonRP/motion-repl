import type { SvelteHTMLElements } from 'svelte/elements';
import Motion from './Motion.svelte';

const motion = new Proxy({} as { [K in keyof SvelteHTMLElements]: Motion }, {
    get(_target, key: string) {
        return Motion
    }
});

// motion. // -> ctrl + space auto complete is working here
// motion.div