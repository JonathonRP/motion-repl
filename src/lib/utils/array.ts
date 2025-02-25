export function addUniqueItem<T>(arr: T[], item: T) {
	if (arr.indexOf(item) === -1) arr.push(item);
}

export function removeItem<T>(arr: T[], item: T) {
	const index = arr.indexOf(item);
	if (index > -1) arr.splice(index, 1);
}