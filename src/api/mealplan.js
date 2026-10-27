/**
 * Client methods: meal plan extras (notes, meal content, settings, template list/update,
 * share link) and account (settings, usage). Installed onto SamsungFood.prototype.
 */

import { toProtoDate, fromProtoDate, tidyNumber } from '../client.js';

const V2 = 'whisk.x.mealplan.v2.MealPlanV2API';
const V1 = 'whisk.x.mealplan.v1.MealPlanAPI';
const TPL = 'whisk.x.mealplan.v2.MealPlanTemplateAPI';
const SHARE = 'whisk.x.mealplan.v1.MealPlanSharingAPI';
const USER = 'whisk.x.user.v1.UserAPI';

/* Enums (from the web app bundle; the cached schema only carries numbers). */
export const WEEK_START = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
export const LINK_MEDIUM = {
  copy: 1,
  native_share: 2,
  email: 4,
  sms: 6,
  twitter: 7,
  whatsapp: 8,
  facebook: 9,
  telegram: 11,
  qr: 12,
};
export const TEMPLATE_LIST_KEY = { onboarding: 1, wellness_tips: 2 };
/** Features with a usage counter that the server accepts (others answer "Feature is disabled"). */
export const USAGE_FEATURE = { mealplan_template_collections: 27, hr_tailored_plan: 30 };
export const COOKING_LEVEL = { unset: 1, beginner: 2, intermediate: 3, advanced: 4 };
export const ACTIVITY_LEVEL = { very_light: 1, light: 2, moderate: 3, active: 4, very_active: 5 };
export const GENDER = { male: 2, female: 3, non_binary: 4, undisclosed: 5 };
export const HEIGHT_UNIT = { cm: 1, inch: 2 };
export const WEIGHT_UNIT = { kg: 1, pound: 2 };
export const PLANNED_MEALS = { breakfast: 1, lunch: 2, dinner: 3, snacks: 4, takeout: 5 };
const MEAL_PLAN_ACCESS = { 1: 'private', 2: 'public' };

const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const nameOf = (table, code) => invert(table)[code] ?? null;

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/* ------------------------------------------------------- normalizers */

const noteOut = (id, details) => ({ id, date: fromProtoDate(details.date), text: details.content ?? '' });

function normalizeAccess(access) {
  return {
    mode: MEAL_PLAN_ACCESS[access?.mode] ?? access?.mode ?? null,
    collaborators: (access?.collaborators ?? []).length,
  };
}

const names = (list = []) => list.map((x) => x.name?.name ?? x.name ?? x.id ?? x.retailerId ?? x.value?.name).filter(Boolean);

/** UserAPI settings → focused, readable object. */
export function normalizeAccountSettings(s = {}) {
  const goals = s.nutritionGoals;
  const ratios = goals?.macroRatiosWithName?.macroRatios;
  return {
    username: s.username ?? null,
    name: [s.firstName, s.lastName].filter(Boolean).join(' ') || null,
    language: s.language ?? null,
    country: s.country ?? s.countryObject?.code ?? null,
    gender: nameOf(GENDER, s.gender?.code ?? s.gender) ?? null,
    yearOfBirth: s.yearOfBirth ?? null,
    cookingLevel: nameOf(COOKING_LEVEL, s.cookingLevel) ?? null,
    household: { adults: s.householdAdultCount ?? 0, children: s.householdChildCount ?? 0 },
    diets: names(s.diets),
    avoidances: names(s.avoidances),
    nutritionPreferences: names(s.nutritionPreferences),
    favouriteCuisines: names(s.favouriteCuisines),
    dislikedIngredients: names(s.dislikedIngredients),
    preferredRetailers: names(s.preferredRetailers),
    usageGoals: names(s.usageGoals),
    body: {
      height: s.height ? { value: tidyNumber(s.height.value), unit: nameOf(HEIGHT_UNIT, s.height.unit) } : null,
      weight: s.weight ? { value: tidyNumber(s.weight.value), unit: nameOf(WEIGHT_UNIT, s.weight.unit) } : null,
      activityLevel: nameOf(ACTIVITY_LEVEL, s.activityLevel?.code) ?? null,
    },
    nutritionGoals: goals
      ? {
          calories: tidyNumber(goals.calorieGoal) ?? null,
          fibre: tidyNumber(goals.fibreGoal) ?? null,
          macroPlan: goals.macroRatiosWithName?.displayName ?? null,
          protein: tidyNumber(ratios?.proteinRatio) ?? null,
          fat: tidyNumber(ratios?.fatRatio) ?? null,
          carbohydrate: tidyNumber(ratios?.carbohydrateRatio) ?? null,
        }
      : null,
    mealPlanning: {
      weekStart: nameOf(WEEK_START, s.weekStart) ?? null,
      weeklyMeals: s.weeklyMeals ?? null,
      plannedMeals: (s.plannedMeals ?? []).map((m) => nameOf(PLANNED_MEALS, m.code ?? m)).filter(Boolean),
    },
    notifications: {
      push: s.pushNotifications?.default ?? null,
      emailRecipeRecommendation: s.emailNotifications?.recipeRecommendation ?? null,
      emailProductUpdates: s.emailNotifications?.productUpdates ?? null,
      emailPromotions: s.emailNotifications?.promotionalUpdates ?? null,
    },
  };
}

function normalizeListTemplate(t) {
  return {
    id: t.id,
    title: t.title ?? null,
    description: t.description ?? null,
    imageUrl: t.imageUrl ?? null,
    days: t.labels?.numberOfDays ?? null,
    diets: (t.labels?.diets ?? []).map((d) => d.displayName ?? d.name),
  };
}

const prettyArea = (s) =>
  String(s ?? '')
    .replace(/^WELLNESS_AREA_/, '')
    .toLowerCase()
    .replace(/_/g, ' ');

/* ------------------------------------------------------------ methods */

export const methods = {
  /* ---- notes */

  /** Adds a note to a day of the meal plan. Returns {id, date, text}. */
  async addMealPlanNote({ date, text }) {
    const details = { date: toProtoDate(date), content: text };
    const res = await this.call(`${V2}/AddMealPlanNote`, { mealPlanId: await this.mealPlanId(), details });
    return noteOut(res.id, details);
  },

  /** Replaces date and text of a note (both are always sent). */
  async updateMealPlanNote({ id, date, text }) {
    const details = { date: toProtoDate(date), content: text };
    await this.call(`${V2}/UpdateMealPlanNote`, { id, mealPlanId: await this.mealPlanId(), details });
    return noteOut(id, details);
  },

  async deleteMealPlanNote(id) {
    await this.call(`${V2}/DeleteMealPlanNote`, { id, mealPlanId: await this.mealPlanId() });
    return { deleted: id };
  },

  async undeleteMealPlanNote(id) {
    await this.call(`${V2}/UndeleteMealPlanNote`, { id, mealPlanId: await this.mealPlanId() });
    return { restored: id };
  },

  /* ---- meal content */

  /**
   * UpdateMealContent. What the API really supports: marking a meal as logged/not logged
   * (isLogged) and, for food entries only, the amount (measureQty). For recipe meals the
   * `recipe` update message has no fields, so a recipe cannot be swapped or rescaled here.
   * @param {{mealContentId:string, isLogged?:boolean, amount?:number, unit?:string}} opts
   */
  async updateMealContent({ mealContentId, isLogged, amount, unit }) {
    const paths = [];
    const update = { mealContentId };
    if (isLogged !== undefined) {
      update.isLogged = isLogged;
      paths.push('is_logged');
    }
    if (unit !== undefined && amount === undefined) throw new Error('unit needs amount');
    if (amount !== undefined) {
      update.food = { measureQty: { simple: { amount, ...(unit ? { unit: { name: unit } } : {}) } } };
      paths.push('food.measure_qty');
    }
    if (!paths.length) throw new Error('nothing to update: pass isLogged and/or amount');
    update.updateMask = { paths };
    await this.call(`${V2}/UpdateMealContent`, { updateMealContent: update });
    return clean({ mealContentId, isLogged, amount, unit });
  },

  /* ---- meal plan settings */

  async mealPlanSettings() {
    // Uncached on purpose: settings may have been changed elsewhere.
    const res = await this.call(`${V1}/GetMealPlan`, { mealPlanId: await this.mealPlanId() });
    return {
      mealPlanId: res.mealPlanId,
      weekStart: nameOf(WEEK_START, res.settings?.weekStart) ?? null,
      access: normalizeAccess(res.access),
    };
  },

  async updateMealPlanSettings({ weekStart }) {
    const code = WEEK_START[weekStart];
    if (!code) throw new Error(`unknown weekStart: ${weekStart} (allowed: ${Object.keys(WEEK_START).join(', ')})`);
    await this.call(`${V1}/UpdateMealPlanSettings`, {
      mealPlanId: await this.mealPlanId(),
      settings: { weekStart: code },
    });
    delete this._cache.mealPlan;
    return { weekStart };
  },

  /* ---- templates */

  /** Curated (public) templates, grouped by diet or wellness area. */
  async templateList({ key = 'onboarding' } = {}) {
    const code = TEMPLATE_LIST_KEY[key];
    if (!code) throw new Error(`unknown key: ${key} (allowed: ${Object.keys(TEMPLATE_LIST_KEY).join(', ')})`);
    const res = await this.call(`${TPL}/GetTemplateList`, {
      key: code,
      responseMask: { paths: ['title', 'description', 'labels', 'image_url'] },
    });
    return (res.templateListItems ?? []).map((g) => ({
      group: g.diet?.displayName ?? (g.wellnessArea ? prettyArea(g.wellnessArea.name?.name) : 'general'),
      templates: (g.templates ?? []).map(normalizeListTemplate),
    }));
  },

  /** Changes title and/or description of a template (only the given fields). */
  async updateTemplate({ id, title, description }) {
    const update = clean({ title, description });
    const paths = Object.keys(update);
    if (!paths.length) throw new Error('nothing to update: pass title and/or description');
    const res = await this.call(`${TPL}/UpdateTemplate`, { id, update, updateMask: { paths: paths.map(snake) } });
    if (res.templateAlreadyExists) throw new Error('A template with identical content already exists.');
    if (res.unknownOrInvalidRecipe) throw new Error(`Template references an unknown recipe: ${res.unknownOrInvalidRecipe.recipeId}`);
    return { id, updated: paths };
  },

  /* ---- sharing */

  /** Generates (does not send) a share link for the meal plan. */
  async mealPlanShareLink({ medium = 'copy' } = {}) {
    const code = LINK_MEDIUM[medium];
    if (!code) throw new Error(`unknown medium: ${medium} (allowed: ${Object.keys(LINK_MEDIUM).join(', ')})`);
    const res = await this.call(`${SHARE}/GenerateMealPlanLinks`, {
      mealPlanId: await this.mealPlanId(),
      links: [{ medium: code }],
    });
    return {
      access: normalizeAccess(res.access).mode,
      links: (res.access?.links ?? []).map((l) => ({ medium: nameOf(LINK_MEDIUM, l.medium) ?? l.medium, url: l.link })),
    };
  },

  /* ---- account */

  async accountSettings() {
    const me = await this.me();
    return normalizeAccountSettings(me.settings);
  },

  /**
   * Changes the given settings (field mask built from the keys). Nested objects
   * (nutritionGoals, emailNotifications) are merged with the current values first, because
   * the server replaces a whole message when its path is in the mask.
   */
  async updateAccountSettings(patch) {
    const p = { ...patch };
    const paths = [];
    const settings = {};
    const set = (k, v) => {
      settings[k] = v;
      paths.push(snake(k));
    };

    const needsCurrent = p.nutritionGoals || p.emailNotifications;
    const current = needsCurrent ? (await this.me()).settings ?? {} : {};

    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      switch (k) {
        case 'dislikedIngredients':
          set(k, v.map((name) => ({ name })));
          break;
        case 'pushNotifications':
          set(k, { default: v });
          break;
        case 'emailNotifications': {
          const c = current.emailNotifications ?? {};
          set(k, {
            recipeRecommendation: v.recipeRecommendation ?? c.recipeRecommendation ?? false,
            productUpdates: v.productUpdates ?? c.productUpdates ?? false,
            promotionalUpdates: v.promotionalUpdates ?? c.promotionalUpdates ?? false,
          });
          break;
        }
        case 'nutritionGoals': {
          const c = current.nutritionGoals ?? {};
          const cr = c.macroRatiosWithName?.macroRatios ?? {};
          const macros = v.proteinRatio !== undefined || v.fatRatio !== undefined || v.carbohydrateRatio !== undefined;
          set(k, clean({
            calorieGoal: v.calorieGoal ?? c.calorieGoal,
            fibreGoal: v.fibreGoal ?? c.fibreGoal,
            macroRatios: macros
              ? {
                  proteinRatio: v.proteinRatio ?? cr.proteinRatio ?? 0,
                  fatRatio: v.fatRatio ?? cr.fatRatio ?? 0,
                  carbohydrateRatio: v.carbohydrateRatio ?? cr.carbohydrateRatio ?? 0,
                }
              : cr.proteinRatio !== undefined
                ? { proteinRatio: cr.proteinRatio, fatRatio: cr.fatRatio, carbohydrateRatio: cr.carbohydrateRatio }
                : undefined,
          }));
          break;
        }
        case 'cookingLevel':
          set(k, COOKING_LEVEL[v]);
          break;
        case 'activityLevel':
          set(k, ACTIVITY_LEVEL[v]);
          break;
        case 'gender':
          set(k, GENDER[v]);
          break;
        case 'height':
          set(k, { value: v.value, unit: HEIGHT_UNIT[v.unit] });
          break;
        case 'weight':
          set(k, { value: v.value, unit: WEIGHT_UNIT[v.unit] });
          break;
        case 'plannedMeals':
          set(k, v.map((m) => PLANNED_MEALS[m]));
          break;
        default:
          set(k, v);
      }
    }
    if (!paths.length) throw new Error('nothing to update');
    const res = await this.call(`${USER}/UpdateSettings`, { settings, updateMask: { paths } });
    return normalizeAccountSettings(res.settings);
  },

  /** Remaining uses of a limited premium feature. */
  async accountUsage({ feature }) {
    const code = USAGE_FEATURE[feature];
    if (!code) throw new Error(`unknown feature: ${feature} (allowed: ${Object.keys(USAGE_FEATURE).join(', ')})`);
    const res = await this.call('whisk.x.premium.v1.PremiumAPI/GetRemainingUsage', { feature: code });
    const v1 = res.data?.v1 ?? {};
    return {
      feature,
      remaining: v1.remaining ?? 0,
      nextUsageAvailableAt: v1.nextUsageAvailableAt?.seconds
        ? new Date(v1.nextUsageAvailableAt.seconds * 1000).toISOString()
        : null,
    };
  },
};
