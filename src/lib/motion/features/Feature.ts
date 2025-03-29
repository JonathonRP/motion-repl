import type { Visual } from '../../render/Visual';

export abstract class Feature<I> {
	isMounted = false;

	node: Visual<I>;

	constructor(node: Visual<I>) {
		this.node = node;
	}

	abstract mount(): void;

	abstract unmount(): void;

	update(): void {}
}