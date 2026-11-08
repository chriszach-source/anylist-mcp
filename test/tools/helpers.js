/**
 * Shared test infrastructure for tool-level tests.
 *
 * createMockServer() — returns a minimal MCP server stub that captures
 *   registerTool() calls, plus the resulting handlers map.
 *
 * MockAnyListClient — in-memory client that owns its own state arrays.
 *   Call client.reset() (or create a fresh instance) in beforeEach.
 */

export function createMockServer() {
  const handlers = {};
  const server = {
    registerTool: (name, _schema, handler) => {
      handlers[name] = handler;
      // Return a stub registeredTool so callers can call .update() without error.
      return { update: () => {} };
    },
    // elicitation.js calls server.server.getClientCapabilities() to detect support.
    // Returning null means elicitation is disabled; missing-param paths throw instead.
    server: { getClientCapabilities: () => null },
  };
  return { server, handlers };
}

export class MockAnyListClient {
  constructor() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this.defaultListName = null;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    this._categories = defaultCategories();
  }

  reset() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    this._categories = defaultCategories();
  }

  async connect(listName = null) {
    const name = listName || process.env.ANYLIST_LIST_NAME || 'Test List';
    this._connected = true;
    const items = this._items;
    this.targetList = {
      name,
      identifier: 'list-123',
      items,
      getItemByName: (n) => items.find(i => i.name.toLowerCase() === n.toLowerCase()) || null,
    };
    this.client = {};
    return true;
  }

  getLists() { return this._lists; }
  getStores() { return this._stores || []; }

  async addItem(name, qty, notes, category, store = null) {
    this._items.push({ name, quantity: qty, notes, category, store });
  }

  async removeItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't check it`);
    this._items[idx].checked = true;
  }

  async uncheckItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't uncheck it`);
    this._items[idx].checked = false;
  }

  async deleteItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't delete it`);
    this._items.splice(idx, 1);
  }

  async getItems(includeChecked = false, includeNotes = false) {
    let items = [...this._items];
    if (!includeChecked) items = items.filter(i => !i.checked);
    return items.map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
      checked: i.checked || false,
      category: this.findCategory(i.category)?.category.name || i.category || 'other',
      ...(includeNotes && i.notes ? { note: i.notes } : {}),
      stores: i.store ? [i.store] : [],
      price: i.price ?? null,
      ...(i.storePrices ? { storePrices: i.storePrices } : {}),
    }));
  }

  async setItemStore(name, store) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    item.store = store || null;
  }

  _setFor(store) {
    if (!store) return this._categories;
    const key = Object.keys(this._storeCategories || {}).find(k => k.toLowerCase() === store.trim().toLowerCase());
    if (!key) throw new Error(`${store} doesn't have its own category set on list "${this.targetList.name}".`);
    return this._storeCategories[key];
  }

  getCategories(store = null) {
    return [{ group: store ? `${store} aisles` : 'Default', stores: store ? [store] : [], categories: this._setFor(store).map(c => c.name) }];
  }

  findCategory(nameOrSlug, store = null) {
    if (!nameOrSlug) return null;
    const t = String(nameOrSlug).trim().toLowerCase();
    const category = this._setFor(store).find(c => c.name.toLowerCase() === t || c.slug === t);
    return category ? { group: { name: 'Default' }, category } : null;
  }

  async setItemCategory(name, category, store = null) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    const found = this.findCategory(category, store).category;
    if (store) item.storeCategory = found.name;
    else item.category = found.slug;
    return found.name;
  }

  async updateItem(name, { newName, quantity, notes } = {}) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    if (newName != null) item.name = newName.trim();
    if (quantity != null) item.quantity = quantity;
    if (notes != null) item.notes = notes;
    return { name: item.name, quantity: item.quantity, notes: item.notes || '' };
  }

  async setItemPrice(name, amount, store = null) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    if (store) {
      item.storePrices = [...(item.storePrices || []).filter(p => p.store !== store), ...(amount ? [{ store, amount }] : [])];
    } else {
      item.price = amount ? amount : null;
    }
  }

  async createStore(name) {
    if (this._stores.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Failed to create store "${name}": a store with that name already exists`);
    }
    const store = { identifier: `store-${this._stores.length + 1}`, name };
    this._stores.push(store);
    return store;
  }

  async createCategory(name, store = null) {
    if (this.findCategory(name, store)) throw new Error(`Category "${name}" already exists in list "${this.targetList.name}"`);
    const category = { name, slug: name.toLowerCase().replace(/\s+/g, '-') };
    this._setFor(store).push(category);
    return category;
  }

  async getFavoriteItems() { return this._favorites; }
  async getRecentItems() { return this._recents; }

  async getRecipes(search = null) {
    let r = [...this._recipes];
    if (search) r = r.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
    return r;
  }

  async getRecipeDetails(name) {
    const r = this._recipes.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new Error(`Recipe "${name}" not found`);
    return { ...r, ingredients: r.ingredients || [], preparationSteps: r.preparationSteps || [] };
  }

  async createRecipe(opts) {
    this._recipes.push(opts);
    return { identifier: 'r-1', name: opts.name };
  }

  async updateRecipe(name, fields = {}) {
    const matches = this._recipes.filter(r => r.name && r.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) throw new Error(`Recipe "${name}" not found`);
    if (matches.length > 1) throw new Error(`Multiple recipes named "${name}" (${matches.length}) exist`);
    const r = matches[0];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) r[key] = value;
    }
    return { identifier: r.identifier, name: r.name };
  }

  async getAllRecipeDetails() {
    return this._recipes.map(r => ({ preparationSteps: [], ingredients: [], ...r }));
  }

  async listIngredients({ search = null, recipeName = null } = {}) {
    return this._recipes
      .filter(r => !recipeName || r.name.toLowerCase() === recipeName.toLowerCase())
      .flatMap(r => (r.ingredients || []).map((i, idx) => ({
        recipe: r.name, line: idx + 1, isHeading: Boolean(i.isHeading),
        quantity: i.quantity || '', name: i.name || '', note: i.note || '',
      })))
      .filter(row => !search || `${row.quantity} ${row.name} ${row.note}`.toLowerCase().includes(search.toLowerCase()));
  }

  async editIngredients(edits) {
    return edits.map(e => {
      const r = this._recipes.find(x => x.name.toLowerCase() === e.recipe.toLowerCase());
      const ing = r?.ingredients?.[e.line - 1];
      if (!ing) return { ...e, outcome: 'recipe not found' };
      for (const k of ['quantity', 'name', 'note', 'isHeading']) if (e[k] !== undefined) ing[k] = e[k];
      return { ...e, outcome: 'updated' };
    });
  }

  async deleteRecipe(name) {
    const idx = this._recipes.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe "${name}" not found`);
    this._recipes.splice(idx, 1);
  }

  async importRecipeFromUrl(url) {
    if (!this._pendingImport) throw new Error('Could not parse recipe from URL. The site may not be supported.');
    const imp = this._pendingImport;
    this._recipes.push({ identifier: 'r-imported', name: imp.name, ...imp });
    return {
      name: imp.name,
      identifier: 'r-imported',
      ingredientCount: imp.ingredientCount || 0,
      stepCount: imp.stepCount || 0,
      source: imp.source || null,
      sourceUrl: imp.sourceUrl || url,
    };
  }

  async getMealPlanEvents() { return [...this._events]; }
  async getMealPlanLabels() { return [...this._labels]; }

  async createMealPlanEvent(opts) {
    this._events.push(opts);
    return { identifier: 'e-1', date: opts.date };
  }

  async deleteMealPlanEvent(id) {
    const idx = this._events.findIndex(e => e.identifier === id);
    if (idx === -1) throw new Error(`Meal plan event "${id}" not found`);
    this._events.splice(idx, 1);
  }

  async getRecipeCollections() { return [...this._collections]; }

  async createRecipeCollection(name, recipeNames = []) {
    const c = { identifier: 'c-1', name, recipeCount: recipeNames.length, recipeNames };
    this._collections.push(c);
    return c;
  }

  async _changeRecipeCollection(adding, name, recipeNames) {
    const c = this._collections.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`Recipe collection "${name}" not found`);
    const changed = [], unchanged = [], notFound = [];
    for (const rName of recipeNames) {
      const r = this._recipes.find(r => r.name.toLowerCase() === rName.toLowerCase());
      if (!r) { notFound.push(rName); continue; }
      const isIn = c.recipeNames.includes(r.name);
      if (adding === isIn) { unchanged.push(r.name); continue; }
      if (adding) c.recipeNames.push(r.name);
      else c.recipeNames.splice(c.recipeNames.indexOf(r.name), 1);
      changed.push(r.name);
    }
    c.recipeCount = c.recipeNames.length;
    return { name: c.name, changed, unchanged, notFound };
  }

  async addRecipesToCollection(name, recipeNames) { return this._changeRecipeCollection(true, name, recipeNames); }

  async removeRecipesFromCollection(name, recipeNames) { return this._changeRecipeCollection(false, name, recipeNames); }

  async deleteRecipeCollection(name) {
    const idx = this._collections.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe collection "${name}" not found`);
    this._collections.splice(idx, 1);
  }
}

function defaultCategories() {
  return [
    ['Produce', 'produce'], ['Dairy', 'dairy'], ['Meat', 'meat'], ['Bakery', 'bakery'], ['Other', 'other'],
  ].map(([name, slug]) => ({ name, slug }));
}
