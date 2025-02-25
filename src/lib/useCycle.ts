import { writable } from 'svelte/store';
	
function* wrap<T>(params: T[]) {
    while(true) {
        yield* params;
    }
}

export function useCycle<T>(items: Array<T>) {
    const cycle = wrap(items);
    let item = writable(cycle.next().value);
    
    const cycleNext = () => {
        item.set(cycle.next().value);
    }

    return [item, cycleNext] as const
}