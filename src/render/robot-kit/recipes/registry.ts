// Recipe registry. Humanoid recipes register below; quadruped, wheeled and tracked kits add
// theirs with registerKitRecipe('quad.leg', fn) etc. Unknown ids fall back to a dressed version
// of the collision geoms, so new designs render immediately.
import type { KitRecipe } from './context';
import { fallbackRecipe } from './fallback';

const RECIPES = new Map<string, KitRecipe>();

export function registerKitRecipe(id: string, recipe: KitRecipe): void {
  RECIPES.set(id, recipe);
}

export function hasKitRecipe(id: string): boolean {
  return RECIPES.has(id);
}

export function resolveRecipe(id: string): KitRecipe {
  return RECIPES.get(id) ?? fallbackRecipe;
}

export function registeredRecipes(): string[] {
  return [...RECIPES.keys()].sort();
}
