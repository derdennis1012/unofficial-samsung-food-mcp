/**
 * Client methods: shopping lists (ListAPI, ListFavoriteAPI, ListSharingAPI) and
 * recipe collections (CollectionAPI, CollectionSharingAPI).
 *
 * Existing in client.js and not redefined here: lists, primaryListId, listItems, addListItems,
 * addRecipeToList, checkListItem, checkListItems, deleteListItems, collections, collectionRecipes, createCollection.
 */

import { updateAuth } from '../auth.js';
import { tidyNumber, CATEGORY_LABEL } from '../client.js';

const LIST = 'whisk.x.list.v1.';
const RECIPE = 'whisk.x.recipe.v1.';

/** Enum values taken from the web app bundle (ACCESS_MODE_*, COLLECTION_ROLE_*, LINK_MEDIUM_*). */
export const ACCESS_MODE = { private: 1, public: 2 };
const ACCESS_MODE_LABEL = { 1: 'private', 2: 'public' };
const COLLECTION_ROLE_LABEL = { 1: 'owner', 2: 'none' };
const LINK_MEDIUM_COPY = 1;

const toAccessCode = (mode) => {
  if (mode == null) return undefined;
  const code = ACCESS_MODE[String(mode).toLowerCase()];
  if (!code) throw new Error(`accessMode must be "private" or "public", got ${mode}`);
  return code;
};

/* ------------------------------------------------------------ Normalizers */

function listSummary(l) {
  return {
    id: l?.id ?? null,
    name: l?.name ?? null,
    isPrimary: Boolean(l?.primary),
    createdTime: l?.createdTime ?? null,
  };
}

/** A list item (create/read) or favorite/recent item: concise, same keys as shopping_list_get. */
function simpleItem(entry, { withChecked = false } = {}) {
  const i = entry.item ?? {};
  const category = entry.analysis?.category?.canonicalName ?? null;
  return {
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    name: i.name ?? null,
    quantity: tidyNumber(i.quantity) ?? null,
    unit: i.unit ?? null,
    brand: i.brand ?? null,
    comment: i.comment ?? null,
    ...(withChecked ? { checked: Boolean(entry.checked) } : {}),
    category: category ? CATEGORY_LABEL[category] ?? category : null,
  };
}

function collectionSummary(res) {
  const c = res.collection ?? {};
  return {
    id: c.id ?? null,
    name: c.name ?? null,
    recipeCount: res.recipeCount ?? 0,
    accessMode: ACCESS_MODE_LABEL[res.access?.mode] ?? null,
    role: COLLECTION_ROLE_LABEL[res.access?.role] ?? null,
    isShoppingList: Boolean(c.shoppinglist),
  };
}

/** Item fields for favorites, only those that are set. */
function favoriteItemPayload(op) {
  const item = { name: op.name };
  if (op.brand != null) item.brand = op.brand;
  if (op.comment != null) item.comment = op.comment;
  if (op.quantity != null) item.quantity = op.quantity;
  if (op.unit != null) item.unit = op.unit;
  return item;
}

const uniq = (arr) => [...new Set(arr)];

export const methods = {
  /* ============================================================ Shopping lists */

  /** Creates a (non-primary) shopping list, optionally with free-text items ("2 onions"). */
  async createShoppingList(name, { items = [], addToRecent = true } = {}) {
    if (!name || !String(name).trim()) throw new Error('name is required');
    const res = await this.call(`${LIST}ListAPI/CreateList`, {
      name: String(name).trim(),
      ...(items.length ? { items: items.map((text) => ({ raw: { text: String(text) }, addToRecent })) } : {}),
    });
    return {
      ...listSummary(res.list),
      items: (res.content?.items ?? []).map((i) => simpleItem(i, { withChecked: true })),
    };
  },

  async renameShoppingList(listId, name) {
    if (!name || !String(name).trim()) throw new Error('name is required');
    const res = await this.call(`${LIST}ListAPI/UpdateList`, { listId, name: String(name).trim() });
    return listSummary(res.list);
  },

  /**
   * Deletes a shopping list with all its items. The primary list is refused: make another list
   * primary first, otherwise the default target of all shopping_list_* tools would vanish.
   */
  async deleteShoppingList(listId) {
    const lists = await this.lists();
    const target = lists.find((l) => l.id === listId);
    if (!target) throw new Error(`Shopping list ${listId} not found (IDs: shopping_lists)`);
    if (target.isPrimary) {
      throw new Error('This is the primary shopping list. Make another list primary first (shopping_list_set_primary).');
    }
    await this.call(`${LIST}ListAPI/DeleteList`, { listId });
    if (this._cache.listId === listId) delete this._cache.listId;
    return { deleted: listId, name: target.name, itemCount: target.itemCount };
  },

  /** Copies a list with its items. The server names the copy "Copy of <name>" (localized). */
  async copyShoppingList(listId) {
    const res = await this.call(`${LIST}ListAPI/CopyList`, { listId });
    return {
      ...listSummary(res.list),
      itemCount: (res.content?.items ?? []).length,
    };
  },

  /**
   * Makes a list the primary one (default target of the other shopping_list_* tools) and refreshes
   * the cached list id. Does nothing when it already is primary.
   */
  async setPrimaryShoppingList(listId) {
    const lists = await this.lists();
    const target = lists.find((l) => l.id === listId);
    if (!target) throw new Error(`Shopping list ${listId} not found (IDs: shopping_lists)`);
    const previous = lists.find((l) => l.isPrimary)?.id ?? null;
    if (target.isPrimary) return { listId, previousPrimaryId: previous, changed: false };
    await this.call(`${LIST}ListAPI/SetPrimaryList`, { listId });
    this._cache.listId = listId;
    updateAuth({ listId });
    return { listId, previousPrimaryId: previous, changed: true };
  },

  /** Items recently put on any list (autocomplete pool). The API returns all of them at once. */
  async recentListItems({ limit = 50 } = {}) {
    const res = await this.call(`${LIST}ListAPI/GetRecentItems`, {});
    const all = res.items ?? [];
    return { total: all.length, items: all.slice(0, limit).map(simpleItem) };
  },

  async favoriteListItems({ limit = 50 } = {}) {
    const res = await this.call(`${LIST}ListFavoriteAPI/GetFavoriteItems`, {});
    const all = res.items ?? [];
    return { total: all.length, items: all.slice(0, limit).map(simpleItem) };
  },

  /**
   * Creates, updates (replaces the whole item) or deletes favorite items.
   * @param {Array<{op:'create',name:string,brand?,comment?,quantity?,unit?}|{op:'update',id:string,name:string,...}|{op:'delete',id:string}>} ops
   */
  async modifyFavoriteListItems(ops) {
    if (!Array.isArray(ops) || !ops.length) throw new Error('ops must be a non-empty array');
    const wire = ops.map((op) => {
      switch (op.op) {
        case 'create':
          if (!op.name) throw new Error('create needs a name');
          return { create: { item: favoriteItemPayload(op) } };
        case 'update':
          if (!op.id || !op.name) throw new Error('update needs id and name (it replaces the whole item)');
          return { update: { id: op.id, item: favoriteItemPayload(op) } };
        case 'delete':
          if (!op.id) throw new Error('delete needs an id');
          return { delete: { id: op.id } };
        default:
          throw new Error(`unknown op ${op.op} (allowed: create, update, delete)`);
      }
    });
    const res = await this.call(`${LIST}ListFavoriteAPI/ModifyFavoriteItems`, { ops: wire });
    return {
      created: (res.diff?.created ?? []).map(simpleItem),
      updated: (res.diff?.updated ?? []).map(simpleItem),
      deleted: (res.diff?.deleted ?? []).map((d) => d.id),
    };
  },

  /** Generates (does not send) a share link for a list. */
  async shoppingListShareLink(listId) {
    const res = await this.call(`${LIST}ListSharingAPI/GenerateListLinks`, {
      listId,
      links: [{ medium: LINK_MEDIUM_COPY }],
    });
    const link = (res.access?.links ?? []).find((l) => l.medium === LINK_MEDIUM_COPY) ?? res.access?.links?.[0];
    return {
      listId,
      link: link?.link ?? null,
      accessMode: ACCESS_MODE_LABEL[res.access?.mode] ?? null,
    };
  },

  /* ============================================================== Collections */

  async getCollection(collectionId) {
    const res = await this.call(`${RECIPE}CollectionAPI/GetCollection`, { collectionId });
    return collectionSummary(res);
  },

  /**
   * Renames a collection and/or switches its access ("private" | "public").
   * Rename uses CollectionAPI/UpdateCollection, access uses CollectionSharingAPI/SwitchCollectionAccess.
   */
  async updateCollection(collectionId, { name, accessMode } = {}) {
    const code = toAccessCode(accessMode);
    const newName = name == null ? undefined : String(name).trim();
    if (!newName && !code) throw new Error('Give a new name and/or accessMode');
    if (name != null && !newName) throw new Error('name must not be empty');
    if (newName) await this.call(`${RECIPE}CollectionAPI/UpdateCollection`, { collectionId, name: newName });
    if (code) await this.call(`${RECIPE}CollectionSharingAPI/SwitchCollectionAccess`, { collectionId, mode: code });
    return this.getCollection(collectionId);
  },

  /** Creates a collection; unlike the server default it is private unless accessMode says otherwise. */
  async createRecipeCollection(name, { accessMode = 'private' } = {}) {
    if (!name || !String(name).trim()) throw new Error('name is required');
    const res = await this.call(`${RECIPE}CollectionAPI/CreateCollection`, {
      name: String(name).trim(),
      accessMode: toAccessCode(accessMode),
    });
    return collectionSummary({ ...res, recipeCount: 0 });
  },

  /** Deletes a collection. The recipes in it stay saved in the account (they only lose this membership). */
  async deleteCollection(collectionId) {
    const c = await this.getCollection(collectionId);
    if (c.isShoppingList) throw new Error('This is the special shopping-list collection and cannot be deleted.');
    await this.call(`${RECIPE}CollectionAPI/DeleteCollection`, { collectionId });
    return { deleted: collectionId, name: c.name, recipeCount: c.recipeCount };
  },

  async copyCollection(collectionId) {
    const res = await this.call(`${RECIPE}CollectionAPI/CopyCollection`, { collectionId });
    return collectionSummary(res);
  },

  /** Generates (does not send) a share link for a collection. */
  async collectionShareLink(collectionId) {
    const res = await this.call(`${RECIPE}CollectionSharingAPI/GenerateCollectionLinks`, {
      collectionId,
      links: [{ medium: LINK_MEDIUM_COPY }],
    });
    const link = (res.links ?? []).find((l) => l.medium === LINK_MEDIUM_COPY) ?? res.links?.[0];
    return {
      collectionId,
      link: link?.link ?? null,
      accessMode: ACCESS_MODE_LABEL[res.access?.mode] ?? null,
    };
  },

  /**
   * Collection membership lives on the recipe: RecipeAPI/UpdateRecipe with updateMask "collection_ids"
   * REPLACES the recipe's whole collection list. So each recipe's current collections are read first
   * (GetRecipe, mask "saved"), changed, and written back. Only works for recipes saved in the account
   * (the server answers "Recipe isn't saved" otherwise).
   * @returns {{collectionId, added|removed:string[], unchanged:string[], notSaved:string[], failed:{recipeId,error}[]}}
   */
  async addRecipesToCollection(collectionId, recipeIds) {
    return changeMembership.call(this, collectionId, recipeIds, 'add');
  },

  async removeRecipesFromCollection(collectionId, recipeIds) {
    return changeMembership.call(this, collectionId, recipeIds, 'remove');
  },
};

/** Per-recipe queue: concurrent membership changes of the same recipe run one after the other. */
const recipeQueues = new Map();
function serialize(recipeId, fn) {
  const prev = recipeQueues.get(recipeId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  recipeQueues.set(recipeId, run);
  run.finally(() => recipeQueues.get(recipeId) === run && recipeQueues.delete(recipeId)).catch(() => {});
  return run;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Read-modify-write of one recipe's collection list. The write replaces the whole list, so the result
 * is verified against the full expected set; if something vanished or appeared in between (another
 * client changed the recipe), the cycle is repeated once.
 * @returns {'done'|'unchanged'|'notSaved'}
 */
async function applyMembership(recipeId, collectionId, mode) {
  for (let attempt = 0; ; attempt++) {
    const got = await this.call(`${RECIPE}RecipeAPI/GetRecipe`, { recipeId, recipeMask: { paths: ['saved'] } });
    const saved = got.recipe?.saved;
    if (!saved?.value) return 'notSaved';
    const current = (saved.collections ?? []).map((c) => c.id);
    if ((mode === 'add') === current.includes(collectionId)) return 'unchanged';
    const next = mode === 'add' ? [...current, collectionId] : current.filter((id) => id !== collectionId);
    if (mode === 'remove' && !next.length && !saved.owner) {
      // Verified for own recipes only: an empty list keeps them saved. For someone else's recipe it might unsave it.
      throw new Error('Refusing to remove the last collection of a recipe you do not own (it might remove the recipe from your library).');
    }
    const res = await this.call(`${RECIPE}RecipeAPI/UpdateRecipe`, {
      recipeId,
      updateMask: { paths: ['collection_ids'] },
      collectionIds: next,
      recipeMask: { paths: ['saved'] },
    });
    const after = (res.recipe?.saved?.collections ?? []).map((c) => c.id);
    if (sameSet(after, next)) return 'done';
    if (attempt >= 1) {
      throw new Error(`membership did not end up as expected (wanted ${next.length} collection(s), server has ${after.length})`);
    }
  }
}

async function changeMembership(collectionId, recipeIds, mode) {
  const ids = uniq(Array.isArray(recipeIds) ? recipeIds : [recipeIds]);
  if (!ids.length) throw new Error('recipeIds must not be empty');
  await this.getCollection(collectionId); // fails early for unknown ids
  const done = [];
  const unchanged = [];
  const notSaved = [];
  const failed = [];

  for (const recipeId of ids) {
    try {
      const outcome = await serialize(recipeId, () => applyMembership.call(this, recipeId, collectionId, mode));
      (outcome === 'done' ? done : outcome === 'unchanged' ? unchanged : notSaved).push(recipeId);
    } catch (err) {
      failed.push({ recipeId, error: String(err.message).slice(0, 200) });
    }
  }
  return { collectionId, [mode === 'add' ? 'added' : 'removed']: done, unchanged, notSaved, failed };
}
