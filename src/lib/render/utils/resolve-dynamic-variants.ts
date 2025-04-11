import type { Visual } from "../Visual.svelte";
import { resolveVariantFromProps } from "./resolve-variants";
import type { TargetAndTransition, TargetResolver } from "../../types";

export function resolveVariant<I>(
	visual: Visual<I>,
	definition: TargetAndTransition | TargetResolver,
	custom?: any
): TargetAndTransition;
export function resolveVariant<I>(
	visual: Visual<I>,
	definition?: string | TargetAndTransition | TargetResolver,
	custom?: any
): TargetAndTransition | undefined;
export function resolveVariant<I>(
	visual: Visual<I>,
	definition?: string | TargetAndTransition | TargetResolver,
	custom?: any
) {
	const props = visual.getProps();
	return resolveVariantFromProps(props, definition, custom !== undefined ? custom : props.custom, visual);
}