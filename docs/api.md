# The Samsung Food API

Reconstructed from the web app and the generated protobuf clients in its
JavaScript bundles.

## Transport

Samsung Food speaks **gRPC-Web**, not REST:

```
POST https://app.samsungfood.com/api/grpc-web/<fully.qualified.Service>/<Method>
content-type: application/grpc-web+proto
```

Body framing: `1 byte flag` + `4 byte length (big endian)` + protobuf message.
The response ends with a trailer frame (flag `0x80`) that carries
`grpc-status`. **The HTTP status is always 200** – errors appear only in the
trailer.

The backend is still Whisk (bought by Samsung in 2019): all packages are
named `whisk.x.*`, assets live on `cdn.whisk.com`, tracking on
`e.whisk.com`. Cloudflare and Envoy sit in front. The message field names
(`sealedValue` for oneofs) give away ScalaPB, so the backend is Scala.

### Headers

| Header | Value |
|---|---|
| `authorization` | `Bearer <accessToken>` |
| `content-type` | `application/grpc-web+proto` |
| `x-grpc-web` | `1` |
| `x-user-agent` | `grpc-web-ts/1.0` |
| `user-agent` | `unofficial-samsung-food-mcp/<version> (+https://github.com/derdennis1012/unofficial-samsung-food-mcp)`, this project, not a browser |
| `x-whisk-app-name` | `webapp` |
| `x-whisk-app-version` | `2.88.0` (built-in default, override with `SAMSUNG_FOOD_APP_VERSION`) |
| `x-whisk-device-type` | `Desktop` |
| `x-whisk-page` | base64 JSON with analytics context (optional) |
| `request-id` | UUID per call (optional) |

### Authentication

The web app keeps its session token in a non-HttpOnly cookie named
`whisk.USER_TOKEN` on `app.samsungfood.com` (an opaque 64-character string, not
a JWT; `document.cookie` looks like `_whsk=3; whisk.USER_TOKEN=<token>`). Login
itself (`whisk.x.user.v1.AuthAPI`) runs on its own origin `login.whisk.com`
(`/api/grpc-web`) behind a captcha, so this project takes over the browser's
token instead.

**Renewal** also uses the login origin and needs the current token as bearer:

1. `whisk.x.user.v1.AuthAPI/IssueAuthCode` with `{}` returns `{code}` (64
   characters, single use).
2. `whisk.x.user.v1.AuthAPI/UseAuthCode` with `{code}` returns
   `authenticated.token = {accessToken, tokenType: "Bearer", expiresIn: 1209600}`.
   The bearer header is required here too (without it: `ERROR_AUTH_TOKEN_REQUIRED`).

Tokens last 14 days (1209600 s); there is no refresh token. The old token stays
valid after a renewal, and each renewal creates a new session. The web app sends
the AuthAPI calls without `X-Whisk-Device-Type` and `X-Whisk-App-Version`; the
client mirrors that. An expired or unknown token yields `UNAUTHENTICATED` with
`ERROR_AUTH_TOKEN_NOT_FOUND`, a missing one `ERROR_AUTH_TOKEN_REQUIRED`.

## Common patterns

**FieldMask controls the scope.** Almost every request carries a
`google.protobuf.FieldMask` that switches expensive response parts on and off:

```
GetRecipe { recipeId, recipeMask: { paths: [
  "nutrition", "instructions", "normalized_ingredients",
  "reviews.rating", "recipe_author.author" ] } }
```

Without a matching mask, ingredients or nutrition values are missing from the
response. `GetMealSchedule` sends two masks – one for the embedded recipe
(`mealMask`), one for the plan itself (`responseMask`).

**Type-prefixed IDs.** `101…` recipe, `102…` user, `105…`/`106…`
collection or list, `107…` own recipe, `01a0…` UUIDv7 (meals, list
items).

**Dates** are `google.type.Date` (`{year, month, day}`), timestamps are
Unix seconds.

**Paging** uses `{ limit, cursors }`.

## The most important services

| Service | Purpose |
|---|---|
| `recipe.v1.RecipeAPI` | Read and save recipes, extract from a URL; `GetRecipes.query` searches **only saved** recipes |
| `recipe.v1.CollectionAPI` | Collections |
| `recipe.v1.RecipeSearchAPI` | Autocomplete, categories |
| `mealplan.v2.MealPlanV2API` | Read and modify the meal plan |
| `mealplan.v2.MealPlanTemplateAPI` | Weekly templates |
| `list.v1.ListAPI` | Shopping lists (delta sync) |
| `foodlist.v1.FoodlistAPI` | Pantry with expiry dates |
| `provision.v1.ProvisionAPI` | All dictionaries and enums, localized |
| `user.v1.UserAPI` | Account and settings |

Full list: `sf methods`, signatures via `sf describe <method>`.

## What is missing

There is no **global recipe search** in this API surface.
`RecipeAPI/GetRecipes` with `query` searches only the user's own saved
recipes (control test: a term with no match in the user's collection returns
0). `RecommendationAPI/GetPopularRecipes` accepts a `query` field but ignores
it – the response is always the same list of recommendations.
`RecipeSearchAPI` only does autocomplete and categories.

Downloading all 529 lazy chunks did not yield any further definitions either:
all protos are contained in the `main-*.js` bundles. The web app's Explore
search therefore runs either through an endpoint that does not go through
these descriptors, or through a path that was not observed.

## Data model

### Recipe

Besides title, ingredient text and images, the API delivers **resolved
ingredients** against a food graph:

```
"400 g hokkaido pumpkin"
 → canonical: "HOKKAIDO PUMPKIN", localized: "hokkaido pumpkin",
   category: "FRUITS AND VEGETABLES", quantity: 400, unit: "g",
   measures: [METRIC{400,g}, IMPERIAL{15,ounce}], imageUrl: …
```

Nutrition values come with Edamam codes (`ENERC_KCAL`, `CHOCDF`, `FASAT`,
`FAPU`, `TOCPHA`, `VITK1` …), each with value, localized label and unit.

### Meal plan

A meal is `{ id, schedule, content[], updatedTime }`.
`schedule` is a **oneof**:

- `scheduledMeal { day, mealTime }` – scheduled for a fixed slot
- `unscheduledMeal { mealTime }` – in the unscheduled pool

`mealTime` (from `ProvisionAPI/GetDictionaries`, dictionary `planned_meals`):

| Value | Meaning |
|---|---|
| 1 | Breakfast |
| 2 | Lunch |
| 3 | Dinner |
| 4 | Snacks |
| 5 | Takeaway |

All changes go through **one** call, `ModifyMealsBatch`, with separate lists
for `create`, `move`, `replicate`, `delete` and `updateContent`.
`GetMealSchedule` additionally returns, per day, the nutrition balance against
the calorie target.

### Weekly templates

`MealPlanTemplateAPI` plus `ApplyMealPlanTemplate`. A template is a list
`mealsTemplate[] { orderDay, mealTime, content[] }` – `orderDay` is the day
offset, which allows the same template to be applied to any week.

Two pitfalls:

- **Asymmetric field names.** `CreateTemplate` expects `content.recipe.recipeId`,
  `GetTemplate` returns the same field as `content.recipe.id`. The same
  applies to `GetPreviouslyPlannedMeals`.
- **Restricted masks.** `GetTemplate` and `GetTemplatesFromCollection`
  accept only a fixed vocabulary (`title`, `image_url`, `description`,
  `labels`, `info_url`, `owner`, `source_id`, `nutrition_details`) – the
  meals come exclusively via `meals_template.content`, recipe names via
  `meals_template.content.recipe.name`. The server answers anything else with
  `Incorrect fields provided`. The limit of `GetTemplatesFromCollection`
  is capped at 10.

### Shopping list

Not CRUD, but **delta sync**:

```
SyncItems {
  listId, lastSync,
  items: [ { create: { raw: { text: "leek" } } },
           { update: { id, item: { name, quantity, unit }, checked } },
           { delete: { id } } ],
  recipes: [ { add: { recipeId, scale, measurementSystem } } ],
  combineServings: true
}
→ { lastSync, diff: { created[], updated[], deleted[] } }
```

The client polls `SyncItems` with an empty op list as a heartbeat. Free text
is resolved on the server: `"leek"` → `LEEK`, category
`FRUITS AND VEGETABLES`, matching image. With `recipes[].add`, all ingredients
of a recipe land on the list at once, and quantities are merged.

Lists can be shared – `GetLists` returns members with role and profile.

### Pantry

`foodlist.v1.FoodlistAPI` is the app's "Food List": `GetItems` (with `mask`
and `filters.presence`), `AddItems`, `UpdateItems`, `ConsumeItems`,
`UnConsumeItems`, `DeleteItems`.

Notably, `AddItems` accepts only `{ name }` – **the server sets storage
location and expiry date itself**, from the `storing` data of the food graph.
Both can be corrected via `UpdateItems` with a matching mask (`location`,
`expiry_date`).

Storage location enum: **1 = fridge, 2 = freezer, 3 = pantry.**

The rule for the expiry date, determined empirically: the server sets one
only if the ingredient has **exactly one** storage location in the graph and
ends up there. It then takes the **upper** bound of the range.

| Ingredient | Graph | Result |
|---|---|---|
| Coconut milk | fridge only, 7–10 days | Fridge, +10 days |
| Basmati rice | pantry only, 12–24 months | Pantry, +24 months |
| Chicken breast | fridge 1–2 days **and** freezer 9 months | Fridge, **no date** |
| Apple | pantry + fridge + freezer | Pantry, **no date** |
| Agave nectar | pantry only, but `defaultLocation` is `Fridge` | Fridge, **no date** |

Changing the storage location via `UpdateItems` does **not** recompute the
date.

Consumed items are not deleted but marked via `ConsumeItems` with a
`consumedAt` timestamp, and can be reversed via `UnConsumeItems`.

## Public and without a token

```
https://cdn.whisk.com/autocomplete/v1/<locale>/all.json
```

The complete food graph as JSON (de-de: ~341 KB): name, display name, image,
category and shelf life per storage location. The client fetches it from this
URL and caches it per locale in the config dir (`~/.samsung-food`, or
`$SAMSUNG_FOOD_HOME`).

## Schema extraction

The schema is not distributed with this repository. It is built on the
user's machine by `sf schema update` (`src/schema-build.js`) from the public
web app bundles and cached as `schema.json` in the config dir
(`~/.samsung-food`, or `$SAMSUNG_FOOD_HOME`).

The web app bundles its generated clients as descriptors:

```js
{ name: "whisk.x.mealplan.v2.MealPlanV2API/GetMealSchedule",
  encode: function () { return [[1,"mealPlanId","string",0],
                                [2,"period",dI,0], …] },
  decode: function () { return [[1,"meals",["repeated",od],1], …] } }
```

Each entry is `[fieldNumber, name, type, flag, oneof?]`. The type is either a
scalar, a reference to a message function, or `["repeated", T]` /
`["wrapper", T]`. `src/schema-build.js` reads these descriptors and resolves
the references – the result is roughly 240 RPCs and 830 messages without a single
unresolved reference.

### Field names you cannot guess

The schema is authoritative – guessed names fail with
`ERROR_INVALID_ARGUMENTS`. Pitfalls from practice:

| Where | Correct |
|---|---|
| `GetMealSchedule.period` | `startDate` / `endDate` (not `start`/`end`) |
| Meal content | `recipe.recipeId`, `food.foodId` (not `id`) |
| List item | `analysis.category.canonicalName` (not `name`) |
| `SyncItems` response | `sync` (not `lastSync`) |

When in doubt, `sf describe <method> --depth 5`.

## Findings behind the dedicated tools

- **Shopping list item updates.** `ListAPI/SyncItems` `update` needs the full `item`
  (name, brand, comment, quantity, unit) next to `id` and `checked`; sending only
  `{id, checked}` fails with "item is required". Read the list first.
- **Collection membership** lives on the recipe: `RecipeAPI/UpdateRecipe` with
  `updateMask.paths = ["collection_ids"]` and `collectionIds` replaces the recipe's whole
  collection list (read it with `GetRecipe` mask `saved`, change it, write it back).
  Recipes that are not saved in the account are rejected ("Recipe isn't saved").
  Deleting a collection keeps its recipes; copying one copies the memberships.
  `UpdateRecipe` for content only accepts the update mask `payload`, which replaces the
  entire payload, so partial edits must merge client-side.
- **Ratings** are thumbs up/down (`liked: bool`), not stars. `recipe_get` does not expose
  the review id; `RecipeAPI/GetRecipe` with mask `reviews.my_review` does.
- **`MealPlanV2API/UpdateMealContent`** does not swap recipes: it toggles `isLogged`
  (eaten) and sets a food entry's amount. The food log id of a meal is its meal id in
  UUID form (`Meal.foodLogItemId`); there is no method to list food log items.
- **`MealPlanTemplateAPI/GetTemplateList`** returns curated public templates
  (`key` = `onboarding` or `wellness_tips`); own templates come from
  `MealPlanTemplateCollectionAPI/GetTemplatesFromCollection`.
- **`PremiumAPI/GetRemainingUsage`** only accepts the features
  `mealplan_template_collections` and `hr_tailored_plan`.
- **Recent recipe searches**: the server keeps the last 5; every search registers its term.
- **Enums** taken from the web bundle: collection access mode 1 private / 2 public,
  link medium copy = 1.
- **Unknown field names** are rejected by this client's codec; mistyped keys in `api_call`
  requests fail with the list of valid fields.
- **Pantry size.** `FoodlistAPI/GetItems` returns every consumed entry too (hundreds), hence
  the paging of `pantry_get`.
