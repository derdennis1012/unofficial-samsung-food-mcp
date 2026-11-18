/**
 * High-level client for Samsung Food.
 *
 * Wraps the raw gRPC calls in everyday operations:
 * meal plan, shopping list, recipes, collections, pantry.
 * Raw access to every RPC method remains available via .call().
 */

import { Codec } from './proto.js';
import { today, addDays, daysBetween, assertRange } from './dates.js';
export { today };
import { GrpcWebTransport, GrpcError } from './grpc.js';
import { fileTokenStore, LOGIN_HINT } from './auth.js';
import { ensureFreshToken } from './session.js';
import { storageInfo, expiryFor, locationCode, loadGraph } from './foodgraph.js';
import { ensureSchema, readSchema, buildSchema, SCHEMA_FILE } from './schema-build.js';

/** Meal slots (from ProvisionAPI/GetDictionaries, dictionary "planned_meals"). */
export const MEAL_TIME = {
  breakfast: 1,
  lunch: 2,
  dinner: 3,
  snack: 4,
  togo: 5,
};
export const MEAL_TIME_LABEL = {
  1: 'Breakfast',
  2: 'Lunch',
  3: 'Dinner',
  4: 'Snack',
  5: 'To go',
};

export const MEASUREMENT_SYSTEM = { metric: 1, imperial: 2 };

/** Categories of the food graph (cdn.whisk.com/autocomplete/v1/…), English labels. */
export const CATEGORY_LABEL = {
  'BABY CARE': 'Baby care',
  BAKING: 'Baking',
  'BEER, WINE AND SPIRITS': 'Beer, wine and spirits',
  'BREAD AND BAKERY': 'Bread and bakery',
  'BREAKFAST FOODS': 'Breakfast foods',
  'CANNED FOODS': 'Canned foods',
  CONDIMENTS: 'Condiments',
  CONFECTIONARY: 'Confectionery',
  'DAIRY AND EGGS': 'Dairy and eggs',
  DELI: 'Deli',
  'DIETS AND SPORTS NUTRITION': 'Diet and sports nutrition',
  DRINKS: 'Drinks',
  FROZEN: 'Frozen',
  'FRUITS AND VEGETABLES': 'Fruits and vegetables',
  'HEALTH AND BEAUTY': 'Health and beauty',
  'HERBS AND SPICES': 'Herbs and spices',
  HOUSEHOLD: 'Household',
  'MEATS AND SEAFOOD': 'Meats and seafood',
  OTHER: 'Other',
  'PASTA, RICE AND BEANS': 'Pasta, rice and beans',
  'PET CARE': 'Pet care',
  SNACKS: 'Snacks',
};

/** Display a float32 from the protocol cleanly: 0.33000001311302185 → 0.33 */
export function tidyNumber(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

/** Field masks used by the web app - they determine how much the API returns. */
const MASK = {
  recipeShort: [
    'content_policy_violation',
    'save_count',
    'reviews.rating',
    'recipe_author.author',
  ],
  recipeFull: [
    'community_sharing',
    'normalized_ingredients',
    'instructions',
    'nutrition',
    'content_policy_violation',
    'save_count',
    'reviews.rating',
    'reviews.my_review',
    'recipe_author.author',
    'labels',
  ],
  mealContent: [
    'recipe.name',
    'recipe.normalized_ingredients',
    'recipe.ingredients',
    'recipe.images',
    'recipe.user',
    'food.title',
    'food.image_url',
    'food.food_type',
    'food.measures_qty',
    'recipe.content_policy_violation',
    'nutrition_details',
  ],
  mealResponse: ['nutrition_details', 'meals', 'notes'],
};

/* ------------------------------------------------------------ Helper functions */

/** "2026-09-21" or Date → { year, month, day } */
export function toProtoDate(value) {
  if (value == null) throw new Error('Date missing');
  if (typeof value === 'object' && 'year' in value) return value;
  const ymd = value instanceof Date ? today(value) : String(value);
  addDays(ymd, 0); // validates the format
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
}

export function fromProtoDate(d) {
  if (!d?.year) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.year}-${p(d.month ?? 1)}-${p(d.day ?? 1)}`;
}

/** "dinner" | 3 | "Dinner" → 3 */
export function toMealTime(value) {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  const key = String(value).toLowerCase();
  if (MEAL_TIME[key]) return MEAL_TIME[key];
  const alias = {
    frühstück: 1, fruehstueck: 1, breakfast: 1,
    mittag: 2, mittagessen: 2, lunch: 2,
    abend: 3, abendessen: 3, dinner: 3,
    snack: 4, snacks: 4,
    mitnehmen: 5, togo: 5,
  }[key];
  if (!alias) throw new Error(`unknown meal: ${value} (allowed: breakfast, lunch, dinner, snack, togo)`);
  return alias;
}


/**
 * Methods that never modify data: whole verbs only (so "Issue..." or "Checkout..." can never
 * match "Is..." / "Check..."), plus a short allowlist of read-only methods with unusual verbs.
 * Everything else counts as a write and is only retried when provably unsent.
 */
const READ_VERB = /\/(Get|Search|Autocomplete|Analyze|Recommend|Extract)(?=[A-Z0-9]|$)[A-Za-z0-9]*$/;
const READ_ALLOWLIST = new Set([
  'IsMealPlanPartSavedAsTemplate',
  'IsIndexed',
  'CheckUsername',
  'CheckUserExists',
  'HasSamsungAccountLinked',
]);
export const isReadMethod = (method) =>
  READ_VERB.test(method) || READ_ALLOWLIST.has(method.slice(method.lastIndexOf('/') + 1));

/** The response (or request) does not match the cached schema: the API probably changed. */
export class SchemaDriftError extends Error {
  constructor(message, { sent = false } = {}) {
    super(message);
    this.name = 'SchemaDriftError';
    this.sent = sent;
  }
}

/**
 * Errors that suggest the cached schema is outdated. Retrying is only safe when the server
 * did not already apply the request: reads, or requests the server rejected as invalid.
 */
export function looksLikeDrift(err, read) {
  if (err instanceof SchemaDriftError) return read || !err.sent;
  if (/^unknown method/.test(err?.message ?? '')) return true;
  return err instanceof GrpcError && err.status === 3 && /ERROR_INVALID_ARGUMENTS|field/i.test(err.message);
}

/** UNAUTHENTICATED errors (missing, expired or revoked session) become an actionable message. */
export function withLoginHint(err) {
  if (err instanceof GrpcError && err.status === 16) {
    return new Error(LOGIN_HINT, { cause: err });
  }
  return err;
}

/* ---------------------------------------------------------------- The client */

export class SamsungFood {
  /**
   * Preferred entry point: builds the protocol schema on first use if it is missing.
   * The plain constructor only reads an already cached schema.
   */
  static async create(options = {}) {
    const schema = options.schema ?? (await ensureSchema({ background: options.backgroundSchemaRefresh }));
    return new SamsungFood({ ...options, schema });
  }

  constructor(options = {}) {
    this.schema = options.schema ?? readSchema();
    if (!this.schema) {
      throw new Error(`Protocol schema not found at ${SCHEMA_FILE}. Run "sf schema update" or use SamsungFood.create().`);
    }
    this.codec = new Codec(this.schema);
    this.transport = options.transport ?? new GrpcWebTransport(options);
    this.locale = options.locale ?? process.env.SAMSUNG_FOOD_LOCALE ?? 'en-US';
    this._token = options.token ?? null;
    /** Where the session (token, expiry, cached meal plan id) lives; default ~/.samsung-food/auth.json. */
    this.store = options.tokenStore ?? fileTokenStore;
    this._buildSchema = options.buildSchema ?? buildSchema;
    /** Receives the warning of a failed token renewal (default: stderr). */
    this._warn = options.warn;
    this._cache = {};
  }

  /** A usable token: the explicit one, or the stored one (renewed automatically when due). */
  async freshToken() {
    if (this._token) return this._token;
    return ensureFreshToken({ codec: this.codec, transport: this.transport, store: this.store, ...(this._warn ? { warn: this._warn } : {}) });
  }

  /**
   * Raw RPC call against any RPC method.
   * @param {{read?: boolean}} opts  read-only methods may be retried freely after transient
   *   failures; by default this is inferred from the method name (Get*, Search*, ...).
   */
  async call(method, request = {}, opts = {}) {
    const read = opts.read ?? isReadMethod(method);
    try {
      return await this.callOnce(method, request, read);
    } catch (err) {
      if (!looksLikeDrift(err, read) || !(await this.refreshSchema())) throw withLoginHint(err);
      return this.callOnce(method, request, read).catch((e) => {
        throw withLoginHint(e);
      });
    }
  }

  async callOnce(method, request, read) {
    const payload = this.codec.encodeRequest(method, request);
    let body;
    try {
      body = await this.transport.call(method, payload, {
        token: await this.freshToken(),
        locale: this.locale,
        read,
      });
    } catch (err) {
      throw withLoginHint(err);
    }
    try {
      return this.codec.decodeResponse(method, body);
    } catch (err) {
      const hint = read ? '' : ' The write was probably applied; check the current state before retrying.';
      throw new SchemaDriftError(`Could not decode the response of ${method}: ${err.message}.${hint}`, { sent: !read });
    }
  }

  /**
   * Rebuilds the protocol schema from the web app (at most every 10 minutes).
   * Returns true when the schema actually changed.
   */
  async refreshSchema() {
    if (Date.now() - (this._lastSchemaRefresh ?? 0) < 10 * 60 * 1000) return false;
    this._lastSchemaRefresh = Date.now();
    try {
      const fresh = await this._buildSchema({ log: () => {} });
      const changed =
        JSON.stringify(fresh.rpcs) !== JSON.stringify(this.schema.rpcs) ||
        JSON.stringify(fresh.messages) !== JSON.stringify(this.schema.messages);
      this.schema = fresh;
      this.codec = new Codec(fresh);
      return changed;
    } catch {
      return false;
    }
  }

  /** All method names, optionally filtered by substring. */
  methods(filter) {
    return this.codec.methods(filter);
  }

  describe(method, depth) {
    return this.codec.describe(method, depth);
  }

  /* ------------------------------------------------------------- Account */

  async me() {
    const res = await this.call('whisk.x.user.v1.UserAPI/GetMe', {});
    return res.user ?? res;
  }

  /* -------------------------------------------------------- Meal plan */

  async mealPlan() {
    if (this._cache.mealPlan) return this._cache.mealPlan;
    const cached = this.store.load()?.mealPlanId;
    const res = await this.call('whisk.x.mealplan.v1.MealPlanAPI/GetMealPlan', {
      mealPlanId: cached ?? '',
    });
    this._cache.mealPlan = res;
    if (res.mealPlanId && res.mealPlanId !== cached) await this.store.update({ mealPlanId: res.mealPlanId });
    return res;
  }

  async mealPlanId() {
    return (await this.mealPlan()).mealPlanId;
  }

  /**
   * Meal plan for a date range.
   * @param {{from?:string,to?:string,days?:number}} opts
   */
  async schedule({ from = today(), to, days = 7 } = {}) {
    const end = to ?? addDays(from, days - 1);
    assertRange(from, end);
    const res = await this.call('whisk.x.mealplan.v2.MealPlanV2API/GetMealSchedule', {
      mealPlanId: await this.mealPlanId(),
      period: { startDate: toProtoDate(from), endDate: toProtoDate(end) },
      mealMask: { paths: MASK.mealContent },
      responseMask: { paths: MASK.mealResponse },
    });
    return this.normalizeSchedule(res, from, end);
  }

  normalizeSchedule(res, from, to) {
    const days = new Map();
    const unscheduled = [];

    for (const meal of res.meals ?? []) {
      const scheduled = meal.schedule?.scheduledMeal;
      const entry = {
        id: meal.id,
        mealTime: scheduled?.mealTime ?? meal.schedule?.unscheduledMeal?.mealTime,
        title: mealTitle(meal),
        recipeId: meal.content?.[0]?.recipe?.recipeId ?? meal.content?.[0]?.recipe?.id ?? null,
        contentId: meal.content?.[0]?.mealContentId ?? null,
        isLogged: Boolean(meal.isLogged),
        kind: meal.content?.[0]?.recipe ? 'recipe' : meal.content?.[0]?.food ? 'food' : 'unknown',
      };
      entry.mealTimeLabel = MEAL_TIME_LABEL[entry.mealTime] ?? null;

      if (scheduled?.day) {
        const date = fromProtoDate(scheduled.day);
        if (!days.has(date)) days.set(date, []);
        days.get(date).push(entry);
      } else {
        unscheduled.push(entry);
      }
    }

    for (const list of days.values()) list.sort((a, b) => (a.mealTime ?? 9) - (b.mealTime ?? 9));

    const nutritionByDay = {};
    for (const n of res.nutritionDetails ?? []) {
      const date = fromProtoDate(n.date);
      if (!date) continue;
      const nutrients = n.nutritionDetails ?? [];
      const kcal = nutrients.find((x) => x.code?.name === 'ENERC_KCAL') ?? nutrients[0];
      nutritionByDay[date] = {
        kcal: kcal?.planned ?? 0,
        goal: kcal?.goal ?? null,
        nutrients: nutrients.map((x) => ({
          code: x.code?.name ?? null,
          label: x.code?.displayName ?? null,
          planned: x.planned ?? 0,
          goal: x.goal ?? null,
          unit: x.unit?.displayName ?? null,
        })),
      };
    }

    return {
      from,
      to,
      days: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, meals]) => ({ date, meals, nutrition: nutritionByDay[date] ?? null })),
      unscheduled,
      notes: (res.notes ?? []).map((n) => ({ id: n.id, date: fromProtoDate(n.date), text: n.content ?? '' })),
    };
  }

  /**
   * Schedule a meal.
   * @param {{recipeId?:string, foodId?:string, date?:string, mealTime:string|number, servings?:number}} opts
   */
  async addMeal({ recipeId, foodId, date, mealTime }) {
    if (!recipeId && !foodId) throw new Error('recipeId or foodId is required');
    const time = toMealTime(mealTime);

    // The meal only carries the reference; scaling happens on the recipe itself.
    const content = recipeId ? { recipe: { recipeId } } : { food: { foodId } };

    const schedule = date
      ? { scheduledMeal: { day: toProtoDate(date), mealTime: time } }
      : { unscheduledMeal: { mealTime: time } };

    const res = await this.call('whisk.x.mealplan.v2.MealPlanV2API/ModifyMealsBatch', {
      mealPlanId: await this.mealPlanId(),
      create: [{ content: [content], schedule }],
      mealMask: { paths: MASK.mealContent },
      responseMask: { paths: ['meals'] },
    });
    return (res.diff?.created ?? []).map((m) => ({
      id: m.id,
      title: mealTitle(m),
      date: fromProtoDate(m.schedule?.scheduledMeal?.day),
      mealTime: m.schedule?.scheduledMeal?.mealTime ?? m.schedule?.unscheduledMeal?.mealTime,
    }));
  }

  async deleteMeal(mealId) {
    const ids = Array.isArray(mealId) ? mealId : [mealId];
    const res = await this.call('whisk.x.mealplan.v2.MealPlanV2API/ModifyMealsBatch', {
      mealPlanId: await this.mealPlanId(),
      delete: ids.map((id) => ({ id })),
      responseMask: { paths: ['meals'] },
    });
    return { deleted: (res.diff?.deleted ?? []).map((d) => d.id) };
  }

  async moveMeal({ mealId, date, mealTime }) {
    const time = toMealTime(mealTime);
    const schedule = date
      ? { scheduledMeal: { day: toProtoDate(date), mealTime: time } }
      : { unscheduledMeal: { mealTime: time } };
    const res = await this.call('whisk.x.mealplan.v2.MealPlanV2API/ModifyMealsBatch', {
      mealPlanId: await this.mealPlanId(),
      move: [{ id: mealId, schedule }],
      mealMask: { paths: MASK.mealContent },
      responseMask: { paths: ['meals'] },
    });
    return res.diff?.updated ?? [];
  }

  /* -------------------------------------------------- Weekly templates */

  /** Own templates. The endpoint returns at most 10 at a time. */
  async templates({ limit = 10 } = {}) {
    const res = await this.call(
      'whisk.x.mealplan.v2.MealPlanTemplateCollectionAPI/GetTemplatesFromCollection',
      {
        responseMask: { paths: ['title', 'image_url'] },
        paging: { limit: Math.min(limit, 10) },
      }
    );
    // The list only returns header data; template(id) fetches the meals.
    return (res.templates ?? []).map((t) => ({
      id: t.id,
      title: t.title ?? null,
      description: t.description ?? null,
      imageUrl: t.imageUrl ?? null,
    }));
  }

  /** A template with all its meals. */
  async template(templateId) {
    const res = await this.call('whisk.x.mealplan.v2.MealPlanTemplateAPI/GetTemplate', {
      id: templateId,
      // Note the asymmetry: CreateTemplate writes recipe.recipeId,
      // GetTemplate returns recipe.id.
      responseMask: {
        paths: ['title', 'image_url', 'meals_template.content', 'meals_template.content.recipe.name'],
      },
    });
    const t = res.mealPlanTemplate ?? {};
    return {
      id: t.id,
      title: t.title ?? null,
      description: t.description ?? null,
      days: groupTemplateDays(t.mealsTemplate ?? []),
    };
  }

  /**
   * Saves a date range of the meal plan as a template.
   * orderDay is the offset from the start date, not the date itself -
   * this way the template can be applied to any week.
   */
  async saveWeekAsTemplate({ from = today(), days = 7, to, title, description } = {}) {
    if (!title) throw new Error('title is required');
    const plan = await this.schedule({ from, days, to });

    const mealsTemplate = [];
    for (const day of plan.days) {
      const orderDay = daysBetween(plan.from, day.date);
      for (const meal of day.meals) {
        if (!meal.recipeId) continue; // templates only carry recipes, no food entries
        mealsTemplate.push({
          orderDay,
          mealTime: meal.mealTime,
          content: [{ recipe: { recipeId: meal.recipeId } }],
        });
      }
    }
    if (!mealsTemplate.length) {
      throw new Error(`No recipes are scheduled between ${plan.from} and ${plan.to}.`);
    }

    const res = await this.call('whisk.x.mealplan.v2.MealPlanTemplateAPI/CreateTemplate', {
      mealsTemplate,
      title,
      ...(description ? { description } : {}),
    });
    const created = res.templateCreated ?? res.templateAlreadyExists;
    return {
      id: created?.mealPlanTemplateId ?? null,
      alreadyExisted: Boolean(res.templateAlreadyExists),
      title,
      meals: mealsTemplate.length,
      days: new Set(mealsTemplate.map((m) => m.orderDay)).size,
      from: plan.from,
      to: plan.to,
    };
  }

  /**
   * Applies a template to the plan starting at `startDate`. Existing meals
   * stay in place - with `replace` the date range is cleared first.
   * The template is always loaded first, so an unknown or empty template never clears anything.
   * If the apply fails after a clear, the error lists the removed meals (`err.removed`) so they can be restored.
   */
  async applyTemplate(templateId, { startDate = today(), replace = false, days } = {}) {
    const tpl = await this.template(templateId);
    if (!tpl.days.length) {
      throw new Error(`Template ${templateId} was not found or has no meals; nothing was changed.`);
    }
    // The template covers orderDay 0..max, gaps included, so clear max+1 days (not the number of filled days).
    const span = days ?? Math.max(0, ...tpl.days.map((d) => d.orderDay)) + 1;
    let removed = null;
    if (replace) {
      const before = await this.schedule({ from: startDate, days: span });
      removed = before.days.flatMap((d) =>
        d.meals.map((m) => ({ date: d.date, mealTime: m.mealTime, mealTimeLabel: m.mealTimeLabel, title: m.title, recipeId: m.recipeId, kind: m.kind }))
      );
      await this.clearWeek({ from: startDate, days: span });
    }
    try {
      await this.call('whisk.x.mealplan.v2.MealPlanV2API/ApplyMealPlanTemplate', {
        mealPlanId: await this.mealPlanId(),
        mealPlanTemplateId: templateId,
        startDate: toProtoDate(startDate),
      });
    } catch (err) {
      if (!removed) throw err;
      const list = removed.length
        ? removed.map((m) => `${m.date} ${m.mealTimeLabel ?? m.mealTime}: ${m.title}${m.recipeId ? ` (recipe ${m.recipeId})` : ''}`).join('; ')
        : 'none (the range was empty)';
      const e = new Error(
        `Applying template ${templateId} failed after the range ${startDate} + ${span} days was cleared (${err.message}). ` +
          `Removed meals: ${list}. Re-add them with meal_plan_add / addMeal.`,
        { cause: err }
      );
      e.removed = removed;
      throw e;
    }
    return this.schedule({ from: startDate, days: days ?? (replace ? span : 7) });
  }

  /** Clears a date range of the meal plan. */
  async clearWeek({ from = today(), days = 7, to } = {}) {
    const end = to ?? addDays(from, days - 1);
    assertRange(from, end);
    await this.call('whisk.x.mealplan.v2.MealPlanV2API/ClearScheduledMeals', {
      mealPlanId: await this.mealPlanId(),
      period: { startDate: toProtoDate(from), endDate: toProtoDate(end) },
    });
    return { cleared: { from, to: end } };
  }

  /** Clears the unscheduled pool. */
  async clearUnscheduled() {
    await this.call('whisk.x.mealplan.v2.MealPlanV2API/ClearUnscheduledMeals', {
      mealPlanId: await this.mealPlanId(),
    });
    return { cleared: 'unscheduled' };
  }

  /** Deletes own templates. */
  async deleteTemplates(templateIds) {
    const ids = Array.isArray(templateIds) ? templateIds : [templateIds];
    await this.call('whisk.x.mealplan.v2.MealPlanTemplateCollectionAPI/DeleteTemplatesFromCollection', {
      templateIds: ids,
    });
    return { deleted: ids };
  }

  /** What has been planned before - the pool for new weeks. */
  async previouslyPlanned({ limit = 30 } = {}) {
    const res = await this.call('whisk.x.mealplan.v2.MealPlanV2API/GetPreviouslyPlannedMeals', {
      mealPlanId: await this.mealPlanId(),
      mealMask: { paths: MASK.mealContent },
      paging: { limit },
    });
    const seen = new Set();
    const out = [];
    for (const meal of res.meals ?? []) {
      // Read side uses recipe.id, write side recipe.recipeId.
      const r = meal.content?.[0]?.recipe;
      const recipeId = r?.recipeId ?? r?.id ?? null;
      const key = recipeId ?? mealTitle(meal);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        recipeId,
        title: mealTitle(meal),
        mealTime: meal.schedule?.scheduledMeal?.mealTime ?? meal.schedule?.unscheduledMeal?.mealTime ?? null,
      });
    }
    return out;
  }

  /* ----------------------------------------------------- Shopping list */

  async lists() {
    const res = await this.call('whisk.x.list.v1.ListAPI/GetLists', {});
    return (res.lists ?? []).map((l) => ({
      id: l.list?.id ?? null,
      name: l.list?.name ?? null,
      isPrimary: Boolean(l.list?.primary),
      itemCount: l.itemCount ?? null,
      role: l.access?.role ?? null,
      createdTime: l.list?.createdTime ?? null,
    }));
  }

  /**
   * The primary list's id, cached for the lifetime of this client only: the primary list can be
   * changed or deleted elsewhere, so it is never persisted (see withList for the re-validation).
   */
  async primaryListId() {
    if (this._cache.listId) return this._cache.listId;
    // Older versions persisted the primary list id forever; drop that stale value.
    this.store.unset(['listId']);
    const lists = await this.lists();
    if (!lists.length) throw new Error('No shopping list found');
    const primary = lists.find((l) => l.isPrimary) ?? lists[0];
    this._cache.listId = primary.id;
    return primary.id;
  }

  /**
   * Runs fn(listId). Without an explicit listId the primary list is used; if the server answers
   * NOT_FOUND for a cached primary id, the lists are fetched once more and fn is retried.
   */
  async withList(listId, fn) {
    if (listId) return fn(listId);
    const id = await this.primaryListId();
    try {
      return await fn(id);
    } catch (err) {
      if (!(err instanceof GrpcError && err.status === 5)) throw err;
      delete this._cache.listId;
      const fresh = await this.primaryListId();
      if (fresh === id) throw err; // the list exists: NOT_FOUND was about something else
      return fn(fresh);
    }
  }

  /** Full list including items. */
  async listItems(listId) {
    return this.withList(listId, async (id) => {
      const res = await this.call('whisk.x.list.v1.ListAPI/GetList', { listId: id });
      return {
        listId: id,
        name: res.list?.name ?? null,
        sync: res.sync ?? null,
        items: (res.content?.items ?? []).map(normalizeListItem),
        groups: (res.content?.groups ?? []).map(normalizeListItem),
        recipes: (res.content?.recipes ?? []).map((r) => ({
          id: r.recipe?.id ?? null,
          name: r.recipe?.name ?? null,
        })),
      };
    });
  }

  /** Create free-text items ("2 onions", "milk"). */
  async addListItems(texts, { listId, checked = false, addToRecent = true } = {}) {
    return this.withList(listId, async (id) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      const res = await this.call('whisk.x.list.v1.ListAPI/SyncItems', {
        listId: id,
        lastSync: Date.now(),
        items: arr.map((text) => ({
          create: { raw: { text: String(text) }, checked, addToRecent },
        })),
      });
      return summarizeSync(res);
    });
  }

  /** Put all ingredients of a recipe on the list. */
  async addRecipeToList(recipeId, { listId, servings, system = 'metric' } = {}) {
    return this.withList(listId, async (id) => {
      const res = await this.call('whisk.x.list.v1.ListAPI/SyncItems', {
        listId: id,
        lastSync: Date.now(),
        recipes: [
          {
            add: {
              recipeId,
              ...(servings ? { scale: { scale: servings } } : {}),
              measurementSystem: MEASUREMENT_SYSTEM[system] ?? 1,
            },
          },
        ],
        combineServings: true,
      });
      return summarizeSync(res);
    });
  }

  async checkListItem(itemId, checked = true, opts = {}) {
    return this.checkListItems([itemId], checked, opts);
  }

  /**
   * Checks or unchecks items. The server insists on receiving the item content with
   * the update, so the current list is read first.
   */
  async checkListItems(itemIds, checked = true, { listId } = {}) {
    return this.withList(listId, async (id) => {
      const current = await this.call('whisk.x.list.v1.ListAPI/GetList', { listId: id });
      const byId = new Map((current.content?.items ?? []).map((e) => [e.id, e]));
      const missing = itemIds.filter((i) => !byId.has(i));
      if (missing.length) throw new Error(`Item(s) not found on the list: ${missing.join(', ')}`);
      const res = await this.call('whisk.x.list.v1.ListAPI/SyncItems', {
        listId: id,
        lastSync: Date.now(),
        items: itemIds.map((i) => ({ update: { id: i, item: byId.get(i).item, checked } })),
      });
      return summarizeSync(res);
    });
  }

  async deleteListItems(itemIds, { listId } = {}) {
    return this.withList(listId, async (id) => {
      const arr = Array.isArray(itemIds) ? itemIds : [itemIds];
      const res = await this.call('whisk.x.list.v1.ListAPI/SyncItems', {
        listId: id,
        lastSync: Date.now(),
        items: arr.map((i) => ({ delete: { id: i } })),
      });
      return summarizeSync(res);
    });
  }

  /* ------------------------------------------------------------ Recipes */

  /**
   * Searches the **user's own saved** recipes (all collections), not the
   * global catalog - this API surface has no method for that.
   * Restricted to one collection via collectionId.
   */
  async searchRecipes(query, { limit = 20, collectionId = '', filters, sorting } = {}) {
    const res = await this.call('whisk.x.recipe.v1.RecipeAPI/GetRecipes', {
      collectionId,
      query: query ?? '',
      recipeMask: { paths: MASK.recipeShort },
      paging: { limit },
      ...(filters ? { filters } : {}),
      ...(sorting ? { sorting } : {}),
    });
    return {
      totalCount: res.totalCount ?? null,
      recipes: (res.recipes ?? []).map((r) => normalizeRecipe(r.recipe ?? r)),
    };
  }

  /**
   * Recipe suggestions from the global catalog. Note: the API's `query`
   * parameter is ignored server-side; this is a recommendation list,
   * not a search. Useful for browsing while planning.
   */
  async popularRecipes({ limit = 20, seed } = {}) {
    const res = await this.call('whisk.x.recommendation.v1.RecommendationAPI/GetPopularRecipes', {
      recipeMask: { paths: MASK.recipeShort },
      paging: { limit },
      ...(seed ? { shuffling: { seed } } : {}),
    });
    return (res.recipes ?? []).map((r) => normalizeRecipe(r.recipe ?? r));
  }

  async recipe(recipeId, { full = true } = {}) {
    const res = await this.call('whisk.x.recipe.v1.RecipeAPI/GetRecipe', {
      recipeId,
      recipeMask: { paths: full ? MASK.recipeFull : MASK.recipeShort },
    });
    return normalizeRecipe(res.recipe ?? res, { full: true });
  }

  async similarRecipes(recipeId, limit = 12) {
    const res = await this.call('whisk.x.recipe.v1.RecipeAPI/GetSimilarRecipes', {
      recipeId,
      recipeMask: { paths: MASK.recipeShort },
      limit,
    });
    return (res.recipes ?? []).map((r) => normalizeRecipe(r.recipe ?? r));
  }

  /** Parse a recipe from any website (without saving). */
  async extractRecipe(url) {
    const res = await this.call('whisk.x.recipe.v1.RecipeAPI/ExtractRecipe', {
      url,
      recipeMask: { paths: MASK.recipeFull },
    });
    if (res.recipe) return { status: 'ok', recipe: normalizeRecipe(res.recipe, { full: true }) };
    return { status: 'partial', recipe: res.partiallyParsed ?? null };
  }

  /**
   * Create your own recipe or overwrite an existing one.
   * @param {{recipeId?:string, name:string, ingredients:string[], instructions?:string[], ...}} data
   */
  async saveRecipe(data) {
    const {
      recipeId,
      name,
      description,
      ingredients = [],
      instructions = [],
      images = [],
      servings,
      cookTime,
      prepTime,
      sourceUrl,
      sourceName,
      collectionIds,
      language = this.locale.split('-')[0].toLowerCase(),
    } = data;

    if (!name) throw new Error('name is required');

    const payload = {
      name,
      ...(description ? { description } : {}),
      ingredients: ingredients.map((t) => (typeof t === 'string' ? { text: t } : t)),
      instructions: instructions.map((t) => (typeof t === 'string' ? { text: t } : t)),
      ...(images.length ? { images: images.map((u) => (typeof u === 'string' ? { url: u } : u)) } : {}),
      ...(servings ? { servings } : {}),
      ...(cookTime || prepTime ? { durations: { ...(cookTime ? { cookTime } : {}), ...(prepTime ? { prepTime } : {}) } } : {}),
      ...(sourceUrl || sourceName
        ? { source: { ...(sourceName ? { displayName: sourceName } : {}), ...(sourceUrl ? { sourceRecipeUrl: sourceUrl } : {}) } }
        : {}),
      language,
    };

    const res = await this.call('whisk.x.recipe.v1.RecipeAPI/SaveRecipe', {
      ...(recipeId ? { recipeId } : {}),
      payload,
      ...(collectionIds?.length ? { collectionIds } : {}),
      recipeMask: { paths: MASK.recipeShort },
    });
    return normalizeRecipe(res.recipe ?? res);
  }

  /** Import a recipe from a URL and save it directly. */
  async importRecipe(url, { collectionIds } = {}) {
    const extracted = await this.extractRecipe(url);
    if (extracted.status !== 'ok' || !extracted.recipe) {
      throw new Error(`Recipe could not be parsed: ${url}`);
    }
    const r = extracted.recipe;
    return this.saveRecipe({
      name: r.name,
      description: r.description,
      ingredients: r.ingredients ?? [],
      instructions: r.instructions ?? [],
      images: r.imageUrl ? [r.imageUrl] : [],
      servings: r.servings,
      sourceUrl: url,
      sourceName: r.source?.name,
      collectionIds,
    });
  }

  async deleteRecipe(recipeId) {
    await this.call('whisk.x.recipe.v1.RecipeAPI/DeleteRecipe', { recipeId });
    return { deleted: recipeId };
  }

  /* --------------------------------------------------------- Collections */

  async collections({ limit = 50 } = {}) {
    const res = await this.call('whisk.x.recipe.v1.CollectionAPI/GetCollections', {
      paging: { limit },
    });
    return (res.collections ?? []).map((c) => ({
      id: c.collection?.id ?? null,
      name: c.collection?.name ?? null,
      recipeCount: c.recipeCount ?? null,
    }));
  }

  async collectionRecipes(collectionId, { limit = 50 } = {}) {
    return this.searchRecipes('', { collectionId, limit });
  }

  async createCollection(name, { accessMode } = {}) {
    const res = await this.call('whisk.x.recipe.v1.CollectionAPI/CreateCollection', {
      name,
      ...(accessMode ? { accessMode } : {}),
    });
    return res.collection ?? res;
  }

  /* ------------------------------------------------------ Pantry */

  /**
   * Pantry ("Food List"). presence filters for stock or consumed items -
   * the web app queries both.
   */
  async pantry({ presence = [1, 2], includeConsumed = true } = {}) {
    const res = await this.call('whisk.x.foodlist.v1.FoodlistAPI/GetItems', {
      mask: { paths: ['image', 'expiry_date', 'name', 'location', 'added_at', 'consumed_at'] },
      filters: { presence },
    });
    const items = (res.items ?? []).map(normalizePantryItem);
    return includeConsumed ? items : items.filter((i) => !i.consumedAt);
  }

  /**
   * Adds entries to the pantry.
   *
   * `AddItems` only takes the name; the server decides storage location and
   * expiry date - and it only sets the date if the ingredient has exactly
   * one storage location in the food graph. Chicken breast (fridge OR
   * freezer) stays without a date. If `location` is given, the location is
   * set and the shelf life is recomputed from the graph.
   *
   * @param {string|string[]} names
   * @param {{location?: string|number}} opts  "fridge"|"freezer"|"pantry" or code
   */
  async addPantryItems(names, { location } = {}) {
    const arr = (Array.isArray(names) ? names : [names]).map((n) =>
      typeof n === 'string' ? { name: n } : n
    );
    // Without the food graph the items are still added, just without computed expiry dates.
    await loadGraph(this.locale).catch(() => null);

    // Compare before/after by IDs: names are not unique,
    // the same item may appear in the pantry several times.
    const before = new Set((await this.pantry()).map((i) => i.id));
    await this.call('whisk.x.foodlist.v1.FoodlistAPI/AddItems', { items: arr });
    // Only entries that match a name we just sent: someone else may add items at the same time.
    const wanted = new Set(arr.map((n) => String(n.name).toLowerCase()));
    const created = (await this.pantry()).filter((i) => !before.has(i.id) && wanted.has(String(i.name).toLowerCase()));

    for (const item of created) {
      const wish =
        arr.find((n) => String(n.name).toLowerCase() === String(item.name).toLowerCase()) ?? {};
      const loc = wish.location ?? location;
      const info = storageInfo(item.name);

      const patch = { id: item.id };
      if (loc && locationCode(loc) !== item.locationCode) patch.location = locationCode(loc);

      // Only compute if the storage location is known: either stated explicitly
      // or unambiguous in the graph. For chicken breast (fridge OR freezer)
      // the date stays empty - guessing would be worse than nothing here.
      if (!item.expiryDate && info?.exact && (loc || info.ambiguous === false)) {
        const expiry = expiryFor(item.name, loc ?? item.locationCode);
        if (expiry) patch.expiryDate = expiry;
      }

      if (patch.location === undefined && patch.expiryDate === undefined) continue;
      Object.assign(item, await this.updatePantryItem(patch));
    }
    return created.map((i) => {
      const storage = storageInfo(i.name);
      // A guessed product never gets an automatic expiry date; say which product was guessed.
      return storage && !storage.exact
        ? { ...i, storage, matchedProduct: storage.product, warning: `${storage.warning} No expiry date was set automatically.` }
        : { ...i, storage };
    });
  }

  /** Where does an ingredient belong and how long does it keep there? (purely local) */
  async storageFor(name) {
    await loadGraph(this.locale);
    return storageInfo(name);
  }

  /** Change storage location (enum) and/or expiry date. */
  async updatePantryItem({ id, name, location, expiryDate }) {
    const item = { id };
    const paths = [];
    if (name !== undefined) {
      item.name = name;
      paths.push('name');
    }
    if (location !== undefined) {
      const code = locationCode(location);
      if (!code) throw new Error(`unknown storage location: ${location} (fridge | freezer | pantry)`);
      item.location = code;
      paths.push('location');
    }
    if (expiryDate !== undefined) {
      item.expiryDate = toProtoDate(expiryDate);
      paths.push('expiry_date');
    }
    if (!paths.length) throw new Error('nothing to change');
    await this.call('whisk.x.foodlist.v1.FoodlistAPI/UpdateItems', {
      mask: { paths },
      items: [item],
    });
    return (await this.pantry()).find((i) => i.id === id) ?? { id, updated: paths };
  }

  /** Mark as consumed (or undo). */
  async consumePantryItems(itemIds, { undo = false } = {}) {
    const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
    const method = undo
      ? 'whisk.x.foodlist.v1.FoodlistAPI/UnConsumeItems'
      : 'whisk.x.foodlist.v1.FoodlistAPI/ConsumeItems';
    await this.call(method, { itemIds: ids });
    return { consumed: undo ? [] : ids, unconsumed: undo ? ids : [] };
  }

  async deletePantryItems(itemIds) {
    const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
    await this.call('whisk.x.foodlist.v1.FoodlistAPI/DeleteItems', { itemIds: ids });
    return { deleted: ids };
  }
}

/* -------------------------------------------------------- Normalization */

function mealTitle(meal) {
  const c = meal.content?.[0];
  return c?.recipe?.name ?? c?.food?.title ?? c?.recipe?.id ?? '(untitled)';
}

function normalizeListItem(entry) {
  const i = entry.item ?? {};
  const qty = tidyNumber(i.quantity);
  const parts = [qty, i.unit, i.name].filter((x) => x !== undefined && x !== null && x !== '');
  const category = entry.analysis?.category?.canonicalName ?? null;
  return {
    id: entry.id ?? null,
    name: i.name ?? null,
    text: parts.join(' ').trim() || null,
    quantity: qty ?? null,
    unit: i.unit ?? null,
    comment: i.comment ?? null,
    checked: Boolean(entry.checked),
    category: category ? CATEGORY_LABEL[category] ?? category : null,
    categoryCode: category,
    product: entry.analysis?.product?.canonicalName ?? null,
    imageUrl: entry.imageUrl ?? null,
    fromRecipeId: entry.recipe?.recipeId ?? null,
  };
}

function normalizeRecipe(r, { full = false } = {}) {
  if (!r) return null;
  const out = {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    imageUrl: r.images?.[0]?.original?.url ?? r.images?.[0]?.url ?? null,
    servings: r.servings ?? null,
    cookTime: r.durations?.cookTime ?? null,
    prepTime: r.durations?.prepTime ?? null,
    source: r.source ? { name: r.source.displayName ?? r.source.name, url: r.source.sourceRecipeUrl } : null,
    rating: r.reviews?.rating?.value ?? null,
    saveCount: r.saveCount ?? null,
  };
  if (full) {
    out.ingredients = (r.ingredients ?? []).map((i) => i.text);
    out.instructions = (r.instructions?.steps ?? r.instructions ?? []).map((s) => s.text ?? s);
    out.nutrition = (r.nutrition?.components ?? []).map((n) => ({
      code: n.code?.name ?? null,
      label: n.code?.displayName ?? null,
      value: n.value ?? null,
      unit: n.unit?.displayName ?? null,
    }));
    out.healthScore = r.nutrition?.healthScore ?? null;
    out.normalizedIngredients = (r.normalizedIngredients ?? []).map((n) => {
      const a = n.analysis ?? {};
      return {
        text: n.sourceText ?? null,
        // canonicalName is English and stable, originalName is the spelling
        // from the recipe - better for searching catalogs in the recipe's language.
        food: a.product?.canonicalName ?? null,
        localName: a.product?.originalName ?? null,
        quantity: a.quantity ?? null,
        unit: a.unit ?? null,
        category: a.category?.canonicalName ?? null,
        imageUrl: a.imageUrl ?? null,
      };
    });
  }
  return out;
}

/** Days until the expiry date; negative means expired. */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return daysBetween(today(), dateStr);
}

function normalizePantryItem(item) {
  const expiry = fromProtoDate(item.expiryDate);
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    location: item.location?.displayName ?? null,
    locationCode: item.location?.code ?? null,
    expiryDate: expiry,
    daysLeft: daysUntil(expiry),
    addedAt: item.addedAt?.seconds ? today(new Date(item.addedAt.seconds * 1000)) : null,
    consumedAt: item.consumedAt?.seconds
      ? today(new Date(item.consumedAt.seconds * 1000))
      : null,
    product: item.analysis?.canonicalName ?? null,
    imageUrl: item.image?.url ?? null,
  };
}

/** mealsTemplate[] → grouped by orderDay */
function groupTemplateDays(mealsTemplate) {
  const byDay = new Map();
  for (const m of mealsTemplate) {
    const d = m.orderDay ?? 0;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({
      mealTime: m.mealTime ?? null,
      mealTimeLabel: MEAL_TIME_LABEL[m.mealTime] ?? null,
      recipeId: m.content?.[0]?.recipe?.id ?? m.content?.[0]?.recipe?.recipeId ?? null,
      title: m.content?.[0]?.recipe?.name ?? m.content?.[0]?.food?.title ?? null,
    });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([orderDay, meals]) => ({
      orderDay,
      meals: meals.sort((a, b) => (a.mealTime ?? 9) - (b.mealTime ?? 9)),
    }));
}

function summarizeSync(res) {
  const d = res.diff ?? res;
  return {
    sync: res.sync ?? null,
    recipeAlreadyAdded: res.recipeAlreadyAdded ?? false,
    created: (d.items?.created ?? d.created ?? []).length,
    updated: (d.items?.updated ?? d.updated ?? []).length,
    deleted: (d.items?.deleted ?? d.deleted ?? []).length,
    raw: res,
  };
}

export { GrpcError, MASK };
