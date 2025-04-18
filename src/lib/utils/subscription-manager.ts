import { addUniqueItem, removeItem } from './array.js';

type GenericHandler = (...args: any) => void;
export class SubscriptionManager<Handler extends GenericHandler> {
	private subscriptions = new Set<Handler>([]);
	// private subscriptions: Handler[] = [];
	add = (handler: Handler) => {
		// addUniqueItem(this.subscriptions, handler);
		this.subscriptions.add(handler);
		return () => {
			// return removeItem(this.subscriptions, handler);
			return this.subscriptions.delete(handler);
		};
	};
	notify = (...[a, b, c]: Parameters<Handler>) => {
		const numSubscriptions = this.subscriptions.size;
		if (!numSubscriptions) return;
		if (numSubscriptions === 1) {
			/**
			 * If there's only a single handler we can just call it without invoking a loop.
			 */
			this.subscriptions[Symbol.iterator]().next().value(a, b, c);
			// this.subscriptions[0](a,b,c);
		} else {
			for (const handler of this.subscriptions) {
				/**
				 * Check whether the handler exists before firing as it's possible
				 * the subscriptions were modified during this loop running.
				 */
				handler && handler(a, b, c);
			}
			// for (let i = 0; i < numSubscriptions; i++) {
			// 	/**
			// 	 * Check whether the handler exists before firing as it's possible
			// 	 * the subscriptions were modified during this loop running.
			// 	 */
			// 	const handler = this.subscriptions[i];
			// 	handler && handler(a, b, c);
			// }
		}
	};
	getSize = () => {
		// return this.subscriptions.length;
		return this.subscriptions.size;
	};
	clear = () => {
		// this.subscriptions.length = 0;
		this.subscriptions.clear();
	};
}