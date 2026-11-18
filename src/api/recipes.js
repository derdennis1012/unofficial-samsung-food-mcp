/**
 * Client methods: recipes (update, reviews, search helpers, smart collections, feeds, health
 * recommendations, dishes). Installed onto SamsungFood.prototype by ./index.js.
 *
 * All methods return small normalized objects instead of the raw protobuf trees.
 */

import { MASK, MEAL_TIME, MEAL_TIME_LABEL, toMealTime, toProtoDate, fromProtoDate, tidyNumber } from '../client.js';

const RECIPE_API = 'whisk.x.recipe.v1.RecipeAPI/';
const REVIEW_API = 'whisk.x.recipe.v1.RecipeReviewAPI/';
const SEARCH_API = 'whisk.x.recipe.v1.RecipeSearchAPI/';
const SMART_API = 'whisk.x.recipe.v1.SmartCollectionAPI/';

/** CategoryType of RecipeSearchAPI/GetCategories: 1 = the home grid, 2 = the full list. */
export const CATEGORY_TYPE = { featured: 1, all: 2 };
/** SmartCollection.type as observed: 1 made_it, 2 recently_viewed, 3 planned, 4 my_recipes. */
export const SMART_COLLECTION_TYPE = { 1: 'made_it', 2: 'recently_viewed', 3: 'planned', 4: 'my_recipes' };
/** Sorting.direction of GetSmartCollectionRecipes: 1 = oldest first, 2 = newest first (default). */
export const SORT_DIRECTION = { oldest: 1, newest: 2 };

/* --------------------------------------------------------------- helpers */

/** Copies the fields of `value` that the message `ref` knows, recursively; shape mismatches fall away. */
function projectMessage(codec, ref, value) {
  const out = {};
  for (const f of codec.fieldsOf(ref)) {
    const v = projectField(codec, f, value?.[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function projectField(codec, f, v) {
  if (v === undefined || v === null) return undefined;
  if (f.repeated) {
    if (!Array.isArray(v)) return undefined;
    const items = v.map((x) => projectField(codec, { ...f, repeated: false }, x)).filter((x) => x !== undefined);
    return items.length ? items : undefined;
  }
  if (Array.isArray(v)) return undefined;
  if (f.type === 'message') {
    if (typeof v !== 'object') return undefined;
    const sub = projectMessage(codec, f.ref, v);
    return Object.keys(sub).length ? sub : undefined;
  }
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return undefined;
  return v;
}

/** {name: {name}} -> name (the read side wraps dictionary values in {name, displayName}). */
const dictName = (x) => x?.name?.name ?? x?.name ?? undefined;

/** A read-side instruction step (with `analysis`) in the shape UpdateRecipe expects. */
function writeStep(step) {
  const { analysis, ...rest } = step ?? {};
  return {
    ...rest,
    ...(analysis?.ingredientIds?.length ? { rawIngredientIds: analysis.ingredientIds } : {}),
    ...(analysis?.intents?.length
      ? {
          intents: analysis.intents.map((i) => ({
            device: dictName(i.device),
            mode: dictName(i.mode),
            attributes: (i.attributes ?? []).map((a) => ({
              name: dictName(a),
              type: a.type,
              ...(a.intValue ? { intValue: { value: a.intValue.value, unitName: dictName(a.intValue.unit) } } : {}),
              ...(a.doubleValue ? { doubleValue: { value: a.doubleValue.value, unitName: dictName(a.doubleValue.unit) } } : {}),
              ...(a.stringValue ? { stringValue: { value: dictName(a.stringValue.value), unitName: dictName(a.stringValue.unit) } } : {}),
            })),
          })),
        }
      : {}),
  };
}

const imageOf = (r) => r?.images?.[0]?.responsive?.url ?? r?.images?.[0]?.original?.url ?? r?.images?.[0]?.url ?? null;

/** Compact recipe summary used by all list-returning methods in this file. */
export function briefRecipe(r) {
  if (!r) return null;
  return dropEmpty({
    id: r.id ?? null,
    name: r.name ?? null,
    description: r.description ?? null,
    imageUrl: imageOf(r),
    servings: r.servings ?? null,
    cookTime: r.durations?.cookTime ?? null,
    prepTime: r.durations?.prepTime ?? null,
    source: r.source ? (r.source.displayName ?? r.source.name ?? null) : null,
    likedPercent: r.reviews?.rating?.score ?? null,
    saveCount: r.saveCount ?? null,
  });
}

/** Removes null / undefined entries so list results stay compact. */
function dropEmpty(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

const cursorOf = (res) => res?.paging?.cursors?.after ?? null;
const paging = (limit, cursor) => ({ limit, ...(cursor ? { cursors: { after: cursor } } : {}) });

/** A review as returned by PostReview / GetReview / PostReviewRating. */
export function normalizeReview(rv) {
  if (!rv) return null;
  return {
    id: rv.id ?? null,
    recipeId: rv.recipeId ?? null,
    // an empty rating message means "disliked" (proto3 drops `liked: false`)
    rating: rv.rating ? (rv.rating.liked ? 'like' : 'dislike') : null,
    comment: rv.detailed?.comment?.text ?? null,
    tags: (rv.detailed?.tags ?? []).map((t) => t.name),
    isMine: Boolean(rv.user?.isMe),
  };
}

function recommendedMeals(list) {
  return (list ?? []).map((m) => ({
    mealId: m.mealId || null,
    planned: Boolean(m.isPlanned),
    items: (m.recommendedFood ?? []).map((f) =>
      f.recipe?.recipe
        ? { type: 'recipe', ...briefRecipe(f.recipe.recipe) }
        : f.food?.food
          ? { type: 'food', id: f.food.food.id ?? null, name: f.food.food.title ?? null, imageUrl: f.food.food.imageUrl ?? null }
          : { type: 'unknown' },
    ),
    reasons: (m.explanationReasons ?? []).flatMap((r) =>
      Object.entries(r)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([kind, v]) => ({ kind, weight: tidyNumber(v.contributionWeight ?? 0) })),
    ),
  }));
}

const HEALTH_RECIPE_MASK = ['recipe.name', 'recipe.images', 'recipe.servings', 'recipe.durations'];

/* --------------------------------------------------------------- methods */

export const methods = {
  /**
   * Partial update of one of your own recipes. UpdateRecipe only accepts the whole payload
   * (update mask "payload"), so the current recipe is loaded and the changes are merged in;
   * everything else the payload knows (ingredient ids and groups, step images/intents/ingredient
   * links, images, source, times, videos, AI flags) is sent back unchanged.
   */
  async updateRecipe(recipeId, changes = {}) {
    const { name, description, ingredients, instructions, servings, cookTime, prepTime, images, sourceName, sourceUrl } = changes;
    const touched = Object.entries({ name, description, ingredients, instructions, servings, cookTime, prepTime, images, sourceName, sourceUrl })
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (!touched.length) throw new Error('nothing to update: pass at least one field');

    const got = await this.call(RECIPE_API + 'GetRecipe', {
      recipeId,
      recipeMask: { paths: [...MASK.recipeFull, 'permissions'] },
    });
    const cur = got.recipe;
    if (!cur) throw new Error(`recipe not found: ${recipeId}`);
    if (cur.user?.owner === false || cur.permissions?.canEditRecipe === false) {
      throw new Error('This is not your own recipe, only recipes you created can be updated');
    }

    // Start from a copy of everything the stored recipe has that UpdateRecipe's payload knows
    // (read-only fields such as id, nutrition or reviews are not part of it and fall away).
    const payloadField = this.codec.rpc(RECIPE_API + 'UpdateRecipe').request.find((f) => f.name === 'payload');
    const readShaped = {
      ...cur,
      // The read side nests steps and step analysis differently than the write side.
      instructions: (cur.instructions?.steps ?? []).map(writeStep),
      images: (cur.images ?? []).map((i) => ({ url: i.original?.url ?? i.responsive?.url })).filter((i) => i.url),
    };
    const payload = projectMessage(this.codec, payloadField.ref, readShaped);

    const txt = (t) => (typeof t === 'string' ? { text: t } : t);
    if (name !== undefined) payload.name = name;
    if (description !== undefined) payload.description = description;
    if (!payload.description) delete payload.description;
    if (ingredients) payload.ingredients = ingredients.map(txt);
    if (instructions) payload.instructions = instructions.map(txt);
    if (images) payload.images = images.map((u) => ({ url: u }));
    payload.ingredients ??= [];
    payload.instructions ??= [];
    payload.language ||= this.locale.split('-')[0].toLowerCase();
    if (sourceName !== undefined || sourceUrl !== undefined) {
      const srcName = sourceName ?? payload.source?.displayName;
      const srcUrl = sourceUrl ?? payload.source?.sourceRecipeUrl;
      payload.source = { ...(srcName ? { displayName: srcName } : {}), ...(srcUrl ? { sourceRecipeUrl: srcUrl } : {}) };
    }
    if (servings !== undefined) payload.servings = servings;
    if (cookTime !== undefined || prepTime !== undefined) {
      const ck = cookTime ?? payload.durations?.cookTime;
      const pt = prepTime ?? payload.durations?.prepTime;
      payload.durations = { ...(ck ? { cookTime: ck } : {}), ...(pt ? { prepTime: pt } : {}) };
    }

    // Probe-encode every carried-over field: one the codec cannot encode is dropped with a warning
    // instead of failing the whole update.
    const warnings = [];
    for (const key of Object.keys(payload)) {
      if (touched.includes(key)) continue;
      try {
        this.codec.encodeRequest(RECIPE_API + 'UpdateRecipe', { recipeId, payload: { [key]: payload[key] } });
      } catch {
        delete payload[key];
        warnings.push(`The recipe's ${key} could not be preserved and was dropped`);
      }
    }

    const res = await this.call(RECIPE_API + 'UpdateRecipe', {
      recipeId,
      updateMask: { paths: ['payload'] },
      payload,
      recipeMask: { paths: MASK.recipeShort },
    });
    const recipe = briefRecipe(res.recipe ?? res);
    return {
      updated: touched,
      recipe,
      ...(recipe?.id && recipe.id !== recipeId ? { previousId: recipeId, warnings: [...warnings, 'The recipe got a new ID, use the returned one from now on'] } : warnings.length ? { warnings } : {}),
    };
  },

  /** Like / dislike a recipe (RecipeReviewAPI/PostReviewRating). */
  async rateRecipe(recipeId, liked) {
    const res = await this.call(REVIEW_API + 'PostReviewRating', { recipeId, rating: { liked: Boolean(liked) } });
    return normalizeReview(res.review ?? { recipeId, rating: { liked: Boolean(liked) } });
  },

  /** Post a written review with optional tags and rating. */
  async postReview(recipeId, { text, tags, liked } = {}) {
    const payload = {
      ...(text ? { text } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(liked !== undefined ? { rating: { liked: Boolean(liked) } } : {}),
    };
    if (!Object.keys(payload).length) throw new Error('a review needs text, tags or a rating');
    const res = await this.call(REVIEW_API + 'PostReview', { recipeId, payload });
    return normalizeReview(res.review);
  },

  /**
   * Reads a review: by review ID (GetReview), or your own review of a recipe by recipe ID
   * (read from the recipe, where it is the field reviews.my_review).
   */
  async getReview({ reviewId, recipeId } = {}) {
    if (reviewId) {
      const res = await this.call(REVIEW_API + 'GetReview', { recipeReviewId: reviewId });
      return { review: normalizeReview(res.review), recipe: res.recipe ? { id: res.recipe.id, name: res.recipe.name } : null };
    }
    if (!recipeId) throw new Error('reviewId or recipeId is required');
    const res = await this.call(RECIPE_API + 'GetRecipe', { recipeId, recipeMask: { paths: ['reviews.my_review'] } });
    const mine = res.recipe?.reviews?.myReview;
    return { review: mine ? normalizeReview({ ...mine, recipeId: mine.recipeId ?? recipeId }) : null, recipe: { id: recipeId, name: res.recipe?.name ?? null } };
  },

  /** Removes your own review of a recipe. */
  async deleteReview(recipeId) {
    await this.call(REVIEW_API + 'DeleteReview', { recipeId });
    return { deleted: true, recipeId };
  },

  /** Search term suggestions; with includeRecent your recent searches are mixed in. */
  async recipeAutocomplete(query, { limit = 10, includeRecent = false } = {}) {
    const res = await this.call(SEARCH_API + 'GetAutocompleteSuggestions', {
      query,
      limit,
      ...(includeRecent ? { supportedEntities: [{ recent: {} }] } : {}),
    });
    return (res.suggestions ?? []).map((s) => ({
      text: s.entity?.text ?? s.entity?.recent ?? null,
      recent: s.entity?.recent !== undefined,
    }));
  },

  /** Search categories of the explore page. type: featured | all. */
  async recipeCategories(type = 'featured') {
    const categoryType = CATEGORY_TYPE[type];
    if (!categoryType) throw new Error(`unknown category type: ${type} (allowed: featured, all)`);
    const res = await this.call(SEARCH_API + 'GetCategories', { categoryType });
    return (res.categories ?? []).map((c) => ({ id: c.id, title: c.title, imageUrl: c.imageUrl ?? null }));
  },

  /** The built-in smart collections (made_it, recently_viewed, planned, my_recipes). */
  async smartCollections() {
    const res = await this.call('whisk.x.recipe.v1.CollectionAPI/GetCollections', {
      paging: { limit: 1 },
      withSmartCollections: true,
    });
    return (res.smartCollections ?? []).map((s) => ({
      id: s.collection?.id ?? null,
      name: s.collection?.name ?? null,
      kind: SMART_COLLECTION_TYPE[s.collection?.type] ?? null,
      recipeCount: s.collection?.recipeCount ?? null,
    }));
  },

  /** One smart collection with its tags and a page of recipes. */
  async smartCollection(collectionId, { limit = 20, cursor, order = 'newest', tags } = {}) {
    const direction = SORT_DIRECTION[order];
    if (!direction) throw new Error(`unknown order: ${order} (allowed: newest, oldest)`);
    const [meta, list] = await Promise.all([
      this.call(SMART_API + 'GetSmartCollection', { collectionId }),
      this.call(SMART_API + 'GetSmartCollectionRecipes', {
        collectionId,
        recipeMask: { paths: MASK.recipeShort },
        paging: paging(limit, cursor),
        ...(tags?.length ? { smartTags: tags } : {}),
        sorting: { direction },
      }),
    ]);
    const c = meta.collection ?? {};
    return {
      id: c.id ?? collectionId,
      name: c.name ?? null,
      kind: SMART_COLLECTION_TYPE[c.type] ?? null,
      recipeCount: c.recipeCount ?? null,
      tags: (meta.smartTags ?? []).map((t) => ({ name: t.value?.name ?? null, label: t.value?.displayName ?? null })),
      recipes: (list.recipes ?? []).map((r) => briefRecipe(r.recipe ?? r)),
      nextCursor: cursorOf(list),
    };
  },

  /** Personalized home feed, recipes only. */
  async recommendedRecipes({ limit = 20, cursor, seed } = {}) {
    const res = await this.call('whisk.x.homefeed.v1.HomefeedAPI/GetRecommendedRecipes', {
      paging: paging(limit, cursor),
      ...(seed ? { shufflingSeed: seed } : {}),
    });
    const recipes = [];
    for (const item of res.recipes ?? []) {
      const d = item.singleRecipeAdded?.recipe?.recipeDetails;
      if (!d) continue;
      const by = item.postedBy;
      recipes.push({
        ...briefRecipe(d),
        postedBy: by ? [by.firstName, by.lastName].filter(Boolean).join(' ') || by.username || null : null,
        community: item.community?.name ?? null,
      });
    }
    return { recipes, nextCursor: cursorOf(res) };
  },

  /** Meal suggestions that fit the calorie / nutrition goals of the account. */
  async healthRecommend({ from, to, mealTimes = ['breakfast', 'lunch', 'dinner'], limit = 3 } = {}) {
    const res = await this.call('whisk.x.health.v1.HealthAPI/Recommend', {
      period: { startDate: toProtoDate(from), endDate: toProtoDate(to ?? from) },
      mealTimes: mealTimes.map(toMealTime),
      limit,
      responseMask: { paths: HEALTH_RECIPE_MASK },
    });
    return {
      status: res.recommendationStatus ?? null,
      slots: (res.recommendation ?? []).map((r) => ({
        date: fromProtoDate(r.date),
        mealTime: MEAL_TIME_LABEL[r.mealTime] ?? r.mealTime ?? null,
        meals: recommendedMeals(r.recommendedMeals),
      })),
    };
  },

  /** More suggestions for one slot (the "show other options" of the health recommendations). */
  async healthAlternatives({ date, mealTime, limit = 5 }) {
    const res = await this.call('whisk.x.health.v1.HealthAPI/GetAlternativeRecommendations', {
      startDate: toProtoDate(date),
      mealTime: toMealTime(mealTime),
      limit,
      responseMask: { paths: HEALTH_RECIPE_MASK },
    });
    const a = res.alternativeRecommendedMeals ?? {};
    return {
      date: fromProtoDate(a.date) ?? date,
      mealTime: MEAL_TIME_LABEL[a.mealTime] ?? MEAL_TIME_LABEL[MEAL_TIME[mealTime]] ?? null,
      meals: recommendedMeals(a.recommendedMeals),
    };
  },

  /** Dish pages (generic dishes with nutrition, per 100 g): one by URL path, or the top level list. */
  async dishLookup({ urlPath, limit = 20, cursor } = {}) {
    if (urlPath) {
      const res = await this.call('whisk.x.dish.v1.DishAPI/GetDishByUrl', { urlPath });
      const d = res.dish;
      if (!d) return { found: false, urlPath };
      return {
        found: true,
        id: d.id,
        name: d.name?.displayName ?? d.name?.name ?? null,
        servingSizeGrams: d.servingSize ?? null,
        description: d.additionalInformation?.description ?? null,
        children: (d.childDishId ?? []).map((c) => ({ name: c.name?.displayName ?? null, urlPath: c.urlPath })),
        nutritionPer100g: (d.nutrition?.components ?? []).map((n) => ({
          code: n.code?.name ?? null,
          label: n.code?.displayName ?? null,
          value: tidyNumber(n.value),
          unit: n.unit?.displayName ?? null,
        })),
      };
    }
    const res = await this.call('whisk.x.dish.v1.DishAPI/GetTopLevelDishes', {
      cursor: paging(limit, cursor),
      withoutChildren: true,
    });
    return {
      dishes: (res.dish ?? []).map((d) => ({
        name: d.parent?.name?.displayName ?? null,
        urlPath: d.parent?.urlPath ?? null,
        children: (d.children ?? []).map((c) => ({ name: c.name?.displayName ?? null, urlPath: c.urlPath })),
      })),
      nextCursor: cursorOf(res),
    };
  },

  /** Other recipes by the author of a recipe. Empty for recipes without a user author. */
  async moreFromUser(recipeId, limit = 10) {
    const res = await this.call(RECIPE_API + 'GetMoreUserRecipes', {
      recipeId,
      recipeMask: { paths: MASK.recipeShort },
      limit,
    });
    return (res.result?.recipes ?? []).map(briefRecipe);
  },

  /** Your recent recipe searches, newest first (the server keeps only the last 5). */
  async recentQueries() {
    const res = await this.call(RECIPE_API + 'GetRecentRecipeQueries', {});
    return (res.queries ?? []).map((q) => q.text);
  },

  async deleteRecentQuery(query) {
    await this.call(RECIPE_API + 'DeleteRecentRecipeQuery', { query });
    return { deleted: query };
  },
};
