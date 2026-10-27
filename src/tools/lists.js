/** MCP tools: shopping lists (beyond the core item tools) and recipe collections. */

import { z } from 'zod';
import { defineTool, idSchema, idList, shortText, limitSchema } from './util.js';

const LIST_ID = 'Shopping list ID from shopping_lists (ids start with 106)';
const COLLECTION_ID = 'Collection ID from collections_list (ids start with 105)';
const RECIPE_IDS = 'Recipe IDs from recipe_search, collection_recipes or recipe_create (ids start with 101 or 107)';

const accessMode = () =>
  z.enum(['private', 'public']).describe('"private" (only you) or "public" (anyone with the link can view)');

const favoriteFields = {
  brand: z.string().trim().min(1).max(200).optional(),
  comment: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().positive().max(100000).optional(),
  unit: z.string().trim().min(1).max(50).optional().describe('e.g. "kg", "ml", "pack"'),
};

const favoriteOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), name: shortText('name', 300), ...favoriteFields }).strict(),
  z
    .object({
      op: z.literal('update'),
      id: idSchema('favorite id').describe('Favorite ID from shopping_list_favorites'),
      name: shortText('name', 300),
      ...favoriteFields,
    })
    .strict(),
  z.object({ op: z.literal('delete'), id: idSchema('favorite id').describe('Favorite ID from shopping_list_favorites') }).strict(),
]);

export const tools = [
  /* ------------------------------------------------------------ Shopping lists */
  defineTool({
    name: 'shopping_list_create',
    kind: 'write',
    description:
      'Creates a new (non-primary) shopping list, optionally filled with free-text items like "2 onions". Returns the new list with its ID for the other shopping_list_* tools (listId argument).',
    schema: z.object({
      name: shortText('list name', 200),
      items: z.array(shortText('item text', 300)).max(100).optional().describe('e.g. ["2 onions", "milk"]'),
      addToRecent: z.boolean().optional().describe('Remember the items in "recent items" (default true)'),
    }),
    example: { name: 'Weekend BBQ', items: ['2 onions', 'milk'] },
    handler: async (a, sf) => sf.createShoppingList(a.name, { items: a.items, addToRecent: a.addToRecent ?? true }),
  }),
  defineTool({
    name: 'shopping_list_rename',
    kind: 'update',
    description: 'Renames a shopping list.',
    schema: z.object({ listId: idSchema('listId').describe(LIST_ID), name: shortText('list name', 200) }),
    example: { listId: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Party' },
    handler: async (a, sf) => sf.renameShoppingList(a.listId, a.name),
  }),
  defineTool({
    name: 'shopping_list_delete',
    kind: 'destructive',
    description:
      'Deletes a shopping list with all its items; this cannot be undone and affects everyone the list is shared with. The primary list is refused: call shopping_list_set_primary for another list first.',
    schema: z.object({ listId: idSchema('listId').describe(LIST_ID) }),
    example: { listId: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    handler: async (a, sf) => sf.deleteShoppingList(a.listId),
  }),
  defineTool({
    name: 'shopping_list_copy',
    kind: 'write',
    description:
      'Copies a shopping list including its items into a new list (named "Copy of <name>", localized by the server). Returns the new list; rename it with shopping_list_rename.',
    schema: z.object({ listId: idSchema('listId').describe(LIST_ID) }),
    example: { listId: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    handler: async (a, sf) => sf.copyShoppingList(a.listId),
  }),
  defineTool({
    name: 'shopping_list_set_primary',
    kind: 'update',
    description:
      'Makes a shopping list the primary one. The primary list is the default for shopping_list_get, shopping_list_add, shopping_list_add_recipe and shopping_list_update when no listId is given, so use with care. No-op if it already is primary.',
    schema: z.object({ listId: idSchema('listId').describe(LIST_ID) }),
    example: { listId: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    handler: async (a, sf) => sf.setPrimaryShoppingList(a.listId),
  }),
  defineTool({
    name: 'shopping_list_recent_items',
    kind: 'read',
    description:
      'Items recently used on any shopping list (the suggestion pool of the app). Returns {total, items}; if total exceeds the limit, raise limit (max 100).',
    schema: z.object({ limit: limitSchema(50) }),
    example: { limit: 20 },
    handler: async (a, sf) => sf.recentListItems({ limit: a.limit }),
  }),
  defineTool({
    name: 'shopping_list_favorites',
    kind: 'read',
    description:
      'Favorite shopping items (quick-add pool). Returns {total, items} with the favorite IDs needed by shopping_list_favorites_modify; if total exceeds the limit, raise limit (max 100).',
    schema: z.object({ limit: limitSchema(50) }),
    example: { limit: 20 },
    handler: async (a, sf) => sf.favoriteListItems({ limit: a.limit }),
  }),
  defineTool({
    name: 'shopping_list_favorites_modify',
    kind: 'destructive',
    idempotent: false,
    description:
      'Creates, updates or deletes favorite shopping items in one call. ops is a list of {op:"create", name, brand?, comment?, quantity?, unit?}, {op:"update", id, name, ...} (replaces the whole favorite, so repeat the fields you want to keep) or {op:"delete", id}. IDs come from shopping_list_favorites. Returns the created/updated items and deleted IDs.',
    schema: z.object({ ops: z.array(favoriteOp).min(1).max(50) }),
    example: {
      ops: [
        { op: 'create', name: 'oat milk', quantity: 1, unit: 'l' },
        { op: 'delete', id: '01a0dddddddddddddddddddddddddddd' },
      ],
    },
    handler: async (a, sf) => sf.modifyFavoriteListItems(a.ops),
  }),
  defineTool({
    name: 'shopping_list_share_link',
    kind: 'update',
    description:
      'Generates a share link for a shopping list and returns it. Nothing is sent to anyone; passing the link on is up to the user. accessMode in the result shows whether the list is private or public.',
    schema: z.object({ listId: idSchema('listId').describe(LIST_ID) }),
    example: { listId: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    handler: async (a, sf) => sf.shoppingListShareLink(a.listId),
  }),

  /* -------------------------------------------------------------- Collections */
  defineTool({
    name: 'collection_get',
    kind: 'read',
    description:
      'Details of one recipe collection: name, recipe count, accessMode (private | public) and your role (owner | none). Use collection_recipes to see the recipes.',
    schema: z.object({ collectionId: idSchema('collectionId').describe(COLLECTION_ID) }),
    example: { collectionId: '10501cccccccccccccccccccccccccccccc' },
    handler: async (a, sf) => sf.getCollection(a.collectionId),
  }),
  defineTool({
    name: 'collection_create',
    kind: 'write',
    description:
      'Creates an empty recipe collection. It is private unless accessMode is "public". Returns the new collection with its ID; fill it with collection_add_recipes.',
    schema: z.object({ name: shortText('collection name', 200), accessMode: accessMode().optional() }),
    example: { name: 'Quick dinners', accessMode: 'private' },
    handler: async (a, sf) => sf.createRecipeCollection(a.name, { accessMode: a.accessMode ?? 'private' }),
  }),
  defineTool({
    name: 'collection_update',
    kind: 'update',
    description: 'Renames a collection and/or switches it between private and public. Give at least one of name, accessMode.',
    schema: z.object({
      collectionId: idSchema('collectionId').describe(COLLECTION_ID),
      name: shortText('collection name', 200).optional(),
      accessMode: accessMode().optional(),
    }),
    example: { collectionId: '10501cccccccccccccccccccccccccccccc', name: 'Keto', accessMode: 'private' },
    handler: async (a, sf) => sf.updateCollection(a.collectionId, { name: a.name, accessMode: a.accessMode }),
  }),
  defineTool({
    name: 'collection_delete',
    kind: 'destructive',
    description:
      'Deletes a recipe collection. The recipes in it stay saved in the account, they only lose this membership. Cannot be undone.',
    schema: z.object({ collectionId: idSchema('collectionId').describe(COLLECTION_ID) }),
    example: { collectionId: '10501cccccccccccccccccccccccccccccc' },
    handler: async (a, sf) => sf.deleteCollection(a.collectionId),
  }),
  defineTool({
    name: 'collection_copy',
    kind: 'write',
    description: 'Copies a collection into a new one (the server names the copy). Returns the copy with its ID.',
    schema: z.object({ collectionId: idSchema('collectionId').describe(COLLECTION_ID) }),
    example: { collectionId: '10501cccccccccccccccccccccccccccccc' },
    handler: async (a, sf) => sf.copyCollection(a.collectionId),
  }),
  defineTool({
    name: 'collection_add_recipes',
    kind: 'update',
    description: `Adds recipes to a collection (a recipe can be in several collections). ${RECIPE_IDS}. Only recipes already saved in your account work; others are reported under notSaved (save them first, e.g. with recipe_import_url or recipe_create). Returns {added, unchanged, notSaved, failed}.`,
    schema: z.object({
      collectionId: idSchema('collectionId').describe(COLLECTION_ID),
      recipeIds: idList('recipe IDs', 50),
    }),
    example: {
      collectionId: '10501cccccccccccccccccccccccccccccc',
      recipeIds: ['10701eeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    },
    handler: async (a, sf) => sf.addRecipesToCollection(a.collectionId, a.recipeIds),
  }),
  defineTool({
    name: 'collection_remove_recipes',
    kind: 'destructive',
    description: `Removes recipes from a collection. The recipes themselves stay saved in your account (verified: even when this was their last collection, for recipes you created; for recipes you did not create, removing the last collection is refused). ${RECIPE_IDS}. Returns {removed, unchanged, notSaved, failed}.`,
    schema: z.object({
      collectionId: idSchema('collectionId').describe(COLLECTION_ID),
      recipeIds: idList('recipe IDs', 50),
    }),
    example: {
      collectionId: '10501cccccccccccccccccccccccccccccc',
      recipeIds: ['10701eeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    },
    handler: async (a, sf) => sf.removeRecipesFromCollection(a.collectionId, a.recipeIds),
  }),
  defineTool({
    name: 'collection_share_link',
    kind: 'update',
    description:
      'Generates a share link for a recipe collection and returns it. Nothing is sent to anyone. If accessMode in the result is "private", the link may not work for others until collection_update sets it to "public".',
    schema: z.object({ collectionId: idSchema('collectionId').describe(COLLECTION_ID) }),
    example: { collectionId: '10501cccccccccccccccccccccccccccccc' },
    handler: async (a, sf) => sf.collectionShareLink(a.collectionId),
  }),
];
