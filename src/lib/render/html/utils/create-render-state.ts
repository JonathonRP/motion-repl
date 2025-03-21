import type { HTMLRenderState } from "../types";

export const createHtmlRenderState = (): HTMLRenderState =>
	({
		style: {},
		transform: {},
		transformOrigin: {},
		vars: {},
	}) as HTMLRenderState;