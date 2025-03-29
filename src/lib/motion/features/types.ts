import type { MotionProps } from "../types";
import type { Visual } from "../../render/Visual";
import type { Feature } from "./Feature";

export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

interface FeatureClass<I> {
	new (props: Visual<I>): Feature<I>;
}

export type HydratedFeatureDefinition<I> = {
	isEnabled: (props: MotionProps) => boolean;
	Feature: FeatureClass<I>;
	ProjectionNode?: any;
	// MeasureLayout?: typeof MeasureLayout;
};

export interface HydratedFeatureDefinitions {
	animation?: HydratedFeatureDefinition<unknown>;
	exit?: HydratedFeatureDefinition<unknown>;
	drag?: HydratedFeatureDefinition<HTMLElement>;
	tap?: HydratedFeatureDefinition<Element>;
	focus?: HydratedFeatureDefinition<Element>;
	hover?: HydratedFeatureDefinition<Element>;
	pan?: HydratedFeatureDefinition<Element>;
	inView?: HydratedFeatureDefinition<Element>;
	layout?: HydratedFeatureDefinition<Element>;
}

export type FeatureDefinition = HydratedFeatureDefinitions[keyof HydratedFeatureDefinitions];

export type FeatureDefinitions = {
	[K in keyof HydratedFeatureDefinitions]: Expand<HydratedFeatureDefinitions[K]>;
};

export type FeaturePackage<T = FeatureDefinition> = {
	[K in keyof T as Exclude<K, 'isEnabled'>]: T[K];
};

export type FeaturePackages = {
	[K in keyof HydratedFeatureDefinitions]: Expand<FeaturePackage<Partial<HydratedFeatureDefinitions[K]>>>;
};