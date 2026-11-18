/**
 * Client methods: food and nutrition (food graph search, Foodpedia products, ingredient analysis,
 * food log). Installed onto SamsungFood.prototype by ./index.js.
 */

import { tidyNumber } from '../core/client.js';

const FOOD_API = 'whisk.x.food.v1.FoodAPI/';
const PEDIA_API = 'whisk.x.foodpedia.v1.FoodpediaAPI/';
const LOG_API = 'whisk.x.foodlog.v1.FoodLogAPI/';

const cursorOf = (res) => res?.paging?.cursors?.after ?? null;
const paging = (limit, cursor) => ({ limit, ...(cursor ? { cursors: { after: cursor } } : {}) });

const dropEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

const nutrients = (list) =>
  (list ?? []).map((n) => ({
    code: n.code?.name ?? null,
    label: n.code?.displayName ?? null,
    // proto3 drops zero values, so a missing amount means 0
    value: tidyNumber(n.value ?? n.amount ?? 0),
    unit: n.unit?.displayName ?? null,
  }));

/** A meal ID (32 hex characters) in UUID form, which is what the food log uses as item ID. */
export function foodLogIdFor(id) {
  return /^[0-9a-f]{32}$/i.test(id) ? id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : id;
}

export const methods = {
  /** Foods of the food graph (the catalog behind meal plan "food" entries). */
  async foodSearch(query, { limit = 20, cursor, language } = {}) {
    const res = await this.call(FOOD_API + 'Search', {
      query,
      language: language ?? this.locale.split('-')[0].toLowerCase(),
      paging: paging(limit, cursor),
    });
    return {
      foods: (res.hits ?? []).map((h) => ({
        id: h.foodId,
        title: h.title ?? null,
        imageUrl: h.imageUrl ?? null,
        ...(h.attributeId ? { attributeId: h.attributeId } : {}),
      })),
      nextCursor: cursorOf(res),
    };
  },

  /** One food with its portion sizes (grams per measure) and, per 100 g, its nutrition. */
  async foodGet(foodId, { attributeId, language, nutrition = true } = {}) {
    const res = await this.call(FOOD_API + 'Get', {
      foodId,
      ...(attributeId ? { attributeId } : {}),
      language: language ?? this.locale.split('-')[0].toLowerCase(),
      // the server only honours a single path here; this one returns measures AND nutrition
      responseMask: { paths: ['measures_qty_with_nutrition'] },
    });
    const f = res.food;
    if (!f) throw new Error(`food not found: ${foodId}`);
    const measures = (f.measuresQty?.measureQty ?? []).map((m) => ({
      name: m.detailed?.measure?.name ?? m.simple?.unit?.displayName ?? null,
      quantity: m.detailed?.quantity ?? 1,
      grams: tidyNumber(m.simple?.amount ?? m.detailed?.measure?.amount),
    }));
    const withNutrition = f.measuresQty?.measuresQtyWithNutrition?.[0];
    return {
      id: f.id,
      title: f.title ?? null,
      imageUrl: f.imageUrl ?? null,
      measures,
      ...(withNutrition && nutrition ? { nutritionPer100g: nutrients(withNutrition.nutrition?.nutrition) } : {}),
    };
  },

  async foodAutocomplete(query, { limit = 10, language } = {}) {
    const res = await this.call(FOOD_API + 'Autocomplete', {
      query,
      limit,
      language: language ?? this.locale.split('-')[0].toLowerCase(),
    });
    return (res.suggestions ?? []).map((s) => s.name);
  },

  /** Foodpedia products (ingredient encyclopedia). Product IDs are canonical names like "BANANA". */
  async productSearch(query, { limit = 20, cursor } = {}) {
    const res = await this.call(PEDIA_API + 'SearchProducts', { query, cursor: paging(limit, cursor) });
    return {
      total: res.total?.exact ?? res.total?.moreThan ?? null,
      totalIsLowerBound: res.total?.exact === undefined && res.total?.moreThan !== undefined,
      products: (res.food ?? []).map((p) => ({
        id: p.canonicalName,
        name: p.localisedTitle?.displayName ?? p.canonicalName,
        imageUrl: p.imageUrl ?? null,
      })),
      nextCursor: cursorOf(res),
    };
  },

  async productGet(productId) {
    const res = await this.call(PEDIA_API + 'GetProduct', { productId });
    const p = res.product;
    if (!p) throw new Error(`product not found: ${productId}`);
    return {
      id: p.productId ?? productId,
      name: p.title ?? null,
      category: p.category ?? null,
      description: p.description ?? null,
      storage: p.storageLocationName?.displayName ?? null,
      glycemicIndex: p.glycemicIndex?.value ?? null,
      imageUrl: p.image?.responsive?.url ?? p.image?.original?.url ?? null,
      defaultMeasure: p.defaultMeasure
        ? { unit: p.defaultMeasure.unit?.displayName ?? null, amount: tidyNumber(p.defaultMeasure.amount) }
        : null,
      nutritionPer100g: nutrients(p.nutrition?.components),
      // measurePerOneGram is "units per gram": invert it to grams per unit
      gramsPerUnit: (p.measuresPerOneGram?.measurePerOneGram ?? [])
        .filter((m) => m.amount > 0)
        .map((m) => ({ unit: m.unit?.displayName ?? m.unit?.name, grams: tidyNumber(1 / m.amount) })),
      diets: (p.dietsAll?.length ? p.dietsAll.filter((d) => d.isSupported) : p.diets ?? []).map(
        (d) => d.name?.displayName ?? d.name?.name,
      ),
      tips: (p.tips ?? []).map((t) => t.tip),
      substitutes: (p.substitutes ?? []).flatMap((s) =>
        (s.items ?? []).map((i) => ({ id: i.productId, name: i.displayName })),
      ),
      linkedRecipes: (p.linkedRecipes ?? []).slice(0, 5).map((r) => ({ id: r.id, name: r.name })),
    };
  },

  async popularProducts({ limit = 20, cursor } = {}) {
    const res = await this.call(PEDIA_API + 'GetPopularProducts', { cursor: paging(limit, cursor) });
    return {
      products: (res.products ?? []).map((p) => ({
        id: p.canonicalName,
        name: p.localisedTitle?.displayName ?? p.canonicalName,
        imageUrl: p.image?.url ?? null,
      })),
      nextCursor: cursorOf(res),
    };
  },

  /** Parses free-text ingredient lines ("2 cups milk") into food, quantity, unit and category. */
  async analyzeIngredients(items, { language } = {}) {
    const res = await this.call('whisk.x.analysis.v1.AnalysisAPI/AnalyzeItems', {
      items,
      language: language ?? this.locale.split('-')[0].toLowerCase(),
    });
    return (res.items ?? []).map((i) => {
      const a = i.analysis ?? {};
      return dropEmpty({
        text: i.sourceText ?? null,
        food: a.product?.canonicalName ?? null,
        localName: a.product?.originalName ?? null,
        category: a.category?.canonicalName ?? null,
        quantity: tidyNumber(a.amount?.quantity) ?? null,
        unit: a.amount?.unit ?? null,
        comment: a.comment ?? null,
        brand: a.brand?.canonicalName ?? null,
        imageUrl: a.imageUrl ?? null,
      });
    });
  },

  /**
   * Logs planned meals as eaten. The response is empty; the log item ID of a meal is its meal ID
   * in UUID form (verified live: it equals Meal.foodLogItemId), returned here for foodlog_delete.
   */
  async addFoodLogFromMealPlan(mealIds) {
    await this.call(LOG_API + 'AddFoodLogItemsFromMealPlan', { mealPlanId: await this.mealPlanId(), mealIds });
    return { logged: mealIds.length, foodLogIds: mealIds.map(foodLogIdFor) };
  },

  async deleteFoodLogItems(foodLogIds) {
    const ids = foodLogIds.map(foodLogIdFor);
    await this.call(LOG_API + 'DeleteFoodLogItems', { foodLogIds: ids });
    return { deleted: ids };
  },
};
