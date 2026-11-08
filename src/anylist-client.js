import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import AnyList from '../anylist-js/lib/index.js';
import { normalizeRecipe } from './recipe-normalizer.js';

// Load the helpers the anylist-js library uses, resolved the same way it resolves them.
const requireFromAnyList = createRequire(new URL('../anylist-js/lib/index.js', import.meta.url));
const FormData = requireFromAnyList('form-data');
const uuid = requireFromAnyList('./uuid');

// AnyList Web derives each item's category-assignment ID from the category
// group ID with this UUIDv5 namespace, so an item has one assignment per group.
const CATEGORY_ASSIGNMENT_NAMESPACE = '08e5c5bd-cd69-4454-a1ff-d611b6d9abc0';
// AnyList Web's namespaces for categorization-rule IDs (item name + group +
// list) and for a list's default category set (list ID). From aioanylist.
const CATEGORY_GROUP_NAMESPACE = 'f656a81f-0e0a-419a-a451-21f4f2eac51b';
const CATEGORIZATION_RULE_NAMESPACE = 'f4338133-428d-4f0b-9402-7c9b23243f14';

// Category match IDs AnyList treats as built-in; ListItem.category holds one of
// these, or "other" for a custom category.
const SYSTEM_CATEGORIES = new Set(["baby", "bakery", "beverages", "breakfast-and-cereal",
  "condiments-oils-and-salad-dressings", "cooking-and-baking", "dairy", "frozen-foods",
  "grains-pasta-and-side-dishes", "health-and-personal-care", "household-and-cleaning", "meat",
  "pet-supplies", "produce", "seafood", "snacks-cookies-and-candy", "soups-and-canned-goods",
  "wine-beer-spirits", "other"]);

// ListItem fields anylist-js's Item doesn't carry. Copied from the loaded item
// when an operation has to send the whole item, so the send doesn't drop them.
const UNTRACKED_ITEM_FIELDS = ['recipeId', 'rawIngredient', 'priceMatchupTag', 'priceId', 'photoIds',
  'eventId', 'priceQuantityPb', 'priceQuantityShouldOverrideItemQuantity', 'packageSizePb',
  'pricePackageSizePb', 'pricePackageSizeShouldOverrideItemPackageSize', 'ingredients',
  'itemQuantityShouldOverrideIngredientQuantity', 'itemPackageSizeShouldOverrideIngredientPackageSize',
  'productUpc'];

// anylist-js's Ingredient keeps the heading flag in _isHeading with no getter,
// so `ingredient.isHeading` is always undefined. This is why reading a recipe
// back showed its headings as plain ingredients.
function ingredientIsHeading(ingredient) {
  return Boolean(ingredient.isHeading ?? ingredient._isHeading);
}

function uuid5Hex(name, namespace) {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.subarray(0, 16).toString('hex');
}

// The match ID AnyList groups an item under: a built-in category's system
// slug, or a slug of a custom category's name ("Bulk Bins" -> "bulk-bins").
function categoryMatchId(category) {
  if (category.systemCategory) return category.systemCategory;
  return String(category.name || '').toLowerCase().trim()
    .replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

class AnyListClient {
  /**
   * @param {{ username?: string, password?: string, defaultListName?: string }} [credentials]
   *   Optional credentials. Falls back to ANYLIST_USERNAME / ANYLIST_PASSWORD / ANYLIST_LIST_NAME
   *   environment variables when not provided (stdio mode).
   */
  constructor({ username, password, defaultListName } = {}) {
    this.client = null;
    this._targetListId = null;
    this._lastTargetList = null;
    this._listsFetchedAt = 0;
    this._username = username || null;
    this._password = password || null;
    this.defaultListName = defaultListName || null;
  }

  /**
   * The connected list, looked up by identifier on every access. anylist-js
   * replaces `client.lists` with new objects on each refresh, so a cached
   * List object goes stale. Falls back to the last object seen if the list
   * isn't in `client.lists`. From linuxmaier/anylist-mcp#27.
   */
  get targetList() {
    if (!this._targetListId) return null;
    const current = this.client?.lists?.find(l => l.identifier === this._targetListId);
    if (current) this._lastTargetList = current;
    return this._lastTargetList;
  }

  set targetList(list) {
    this._targetListId = list?.identifier ?? null;
    this._lastTargetList = list ?? null;
  }

  // Re-read the lists, so changes made in the apps are seen. The library's
  // websocket push is meant to do this, but rnilssoncx measured it not
  // reaching a long-lived client (an item changed half an hour earlier still
  // showed the old store), so don't rely on it. Calls a few seconds apart
  // share one read.
  async _refreshLists() {
    if (Date.now() - this._listsFetchedAt < 5000) return;
    await this.client.getLists();
    this._listsFetchedAt = Date.now();
  }

  async connect(listName = null) {
    const username = this._username || process.env.ANYLIST_USERNAME;
    const password = this._password || process.env.ANYLIST_PASSWORD;
    const targetListName = listName || this.defaultListName || process.env.ANYLIST_LIST_NAME;

    if (!username || !password) {
      const error = new Error('Missing AnyList credentials. Provide username and password.');
      console.error(error.message);
      throw error;
    }

    if (!targetListName) {
      const error = new Error('No list name provided and no default list configured');
      console.error(error.message);
      throw error;
    }

    try {
      if (this.client) {
        await this._refreshLists();
        // Already connected to the same list: nothing else to do
        if (this.targetList && this.targetList.name === targetListName) {
          return true;
        }
      } else {
        // Create the AnyList client and authenticate
        this.client = new AnyList({
          email: username,
          password: password
        });

        // Authenticate
        console.error(`Connecting to AnyList as ${username}...`);
        await this.client.login();
        console.error('Successfully authenticated with AnyList');

        await this.client.getLists();
        this._listsFetchedAt = Date.now();
      }

      // Find the target list
      console.error(`Looking for list: "${targetListName}"`);
      this.targetList = this.client.getListByName(targetListName);

      if (!this.targetList) {
        const error = new Error(`List "${targetListName}" not found. Available lists: ${this.getAvailableListNames().join(', ')}`);
        console.error(error.message);
        throw error;
      }

      console.error(`Connected to list: "${this.targetList.name}"`);

      return true;

    } catch (error) {
      const wrappedError = new Error(`Failed to connect to AnyList: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  getAvailableListNames() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => list.name);
  }

  getLists() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => ({
      name: list.name,
      uncheckedCount: list.items ? list.items.filter(item => !item.checked).length : 0
    }));
  }

  // Known limitation: quantity only sticks for NEW items (set via _encode during
  // creation, below). For an existing item we fall back to existingItem.save(),
  // which emits a `set-list-item-quantity` op — that handler does NOT populate
  // quantityPb.rawQuantity, so the AnyList apps render no quantity change even
  // though this server reports success. Fixing it needs a full `update-list-item`
  // op (see Item.assignToCustomCategory), which is unsafe until Item._encode
  // round-trips recipeId / rawIngredient / prices / photoIds. Workaround for
  // callers: delete the item and re-add it with the new quantity.
  async addItem(itemName, quantity = 1, notes = null, category = "other", store = null) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // First, check if item already exists
      const existingItem = this.targetList.getItemByName(itemName);

      if (existingItem) {
        // Item exists - check if it's checked (completed)

        if (existingItem.checked) {
          // Uncheck the item to make it active again
          existingItem.checked = false;
          if (notes !== null) {
            existingItem.details = notes;
          }

          console.error(`Unchecked existing item: ${existingItem.name}`);
          await this._saveItem(existingItem);
          await this._setQuantityIfChanged(existingItem, quantity);
        } else {

          // Item already exists and is unchecked, no action needed
          console.error(`Item "${itemName}" already exists and is active`);
          if (notes !== null) {
            existingItem.details = notes;
          }
          // Category not used if item already has a category

          if (existingItem._fieldsToUpdate?.length) await this._saveItem(existingItem);
          await this._setQuantityIfChanged(existingItem, quantity);
        }
      } else {
        // Item doesn't exist, create new one
        const itemOptions = { name: itemName };
        if (notes !== null) {
          itemOptions.details = notes;
        }
        if (category && category !== "other") {
          Object.assign(itemOptions, this._categoryFields(category, []));
        }
        // Carry the quantity through creation so it lands in quantityPb.rawQuantity
        // (List.addItem encodes the item). Bare "1" is AnyList's default, so skip it.
        const rawQuantity = quantity == null ? "" : String(quantity).trim();
        if (rawQuantity !== "" && rawQuantity !== "1") {
          itemOptions.quantity = rawQuantity;
        }

        const newItem = this.client.createItem(itemOptions);
        await this.targetList.addItem(newItem);

        console.error(`Added new item: ${newItem.name}`);
      }

      if (store) {
        await this.setItemStore(itemName, store);
      }

    } catch (error) {
      const wrappedError = new Error(`Failed to add item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async deleteItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't delete it`);
        console.error(error.message);
        throw error;
      }

      await this.targetList.removeItem(existingItem);
      console.error(`Deleted item: ${existingItem.name}`);

    } catch (error) {
      const wrappedError = new Error(`Failed to delete item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async removeItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Find the item by name
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't check it`);
        console.error(error.message);
        throw error;
      }

      // Check the item (mark as completed) instead of deleting
      if (!existingItem.checked) {
        existingItem.checked = true;
        await existingItem.save();
        console.error(`Checked off item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already checked off`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to remove item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async uncheckItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't uncheck it`);
        console.error(error.message);
        throw error;
      }

      // Uncheck the item (mark as active again). No-op if already unchecked.
      if (existingItem.checked) {
        existingItem.checked = false;
        await existingItem.save();
        console.error(`Unchecked item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already unchecked`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to uncheck item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async getItems(includeChecked = false, includeNotes = false, storeName = null) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Get all items from the list
      const items = this.targetList.items || [];

      // Filter based on checked status
      const filteredItems = includeChecked
        ? items
        : items.filter(item => !item.checked);

      // Map to a clean format
      return filteredItems.map(item => {
        const result = {
          name: item.name,
          quantity: item.quantity ?? null,
          checked: item.checked || false,
          category: this._categoryNameForItem(item, storeName && this._findStore(storeName) ? storeName : null)
        };
        if (includeNotes && item.details) {
          result.note = item.details;
        }
        const stores = this.targetList.stores || [];
        result.stores = (item.storeIds || [])
          .map(id => stores.find(s => s.identifier === id))
          .filter(Boolean)
          .map(s => s.name);
        const prices = this._itemPrices(item).filter(p => p.amount != null);
        const main = prices.find(p => !p.storeId);
        result.price = main ? main.amount : null;
        const storePrices = prices.filter(p => p.storeId).map(p => ({
          store: stores.find(s => s.identifier === p.storeId)?.name || 'unknown store',
          amount: p.amount,
        }));
        if (storePrices.length > 0) result.storePrices = storePrices;

        return result;
      });
    } catch (error) {
      const wrappedError = new Error(`Failed to get items: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  _buildCategoryMap() {
    const categoryMap = {};
    try {
      // Access the raw user data from the client to get category groups
      const userData = this.client._userData;
      if (userData && userData.shoppingListsResponse && userData.shoppingListsResponse.categoryGroupResponses) {
        for (const groupResponse of userData.shoppingListsResponse.categoryGroupResponses) {
          if (groupResponse.categoryGroup && groupResponse.categoryGroup.categories) {
            for (const category of groupResponse.categoryGroup.categories) {
              if (category.identifier && category.name) {
                categoryMap[category.identifier] = category.name;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to build category map: ${error.message}`);
    }
    return categoryMap;
  }

  // ===== STORES =====

  getStores() {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    return this.targetList.stores || [];
  }

  async setItemStore(itemName, storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    const storeIds = storeName ? [this._requireStore(storeName).identifier] : [];
    await item.setStores(storeIds);
  }

  // Case-insensitive, like the tool's store validation.
  _findStore(storeName) {
    const target = String(storeName || '').trim().toLowerCase();
    return (this.targetList.stores || []).find(s => s.name.trim().toLowerCase() === target) || null;
  }

  _requireStore(storeName) {
    const store = this._findStore(storeName);
    if (!store) {
      const available = (this.targetList.stores || []).map(s => s.name).join(', ') || 'none';
      throw new Error(`Store "${storeName}" not found. Available stores: ${available}`);
    }
    return store;
  }

  async createStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    try {
      const cleanName = String(storeName || '').trim();
      if (!cleanName) throw new Error('Store name is required.');
      const stores = this.targetList.stores || (this.targetList.stores = []);
      if (stores.some(s => s.name.toLowerCase() === cleanName.toLowerCase())) {
        throw new Error('a store with that name already exists');
      }
      // anylist-js has no store creation, so send AnyList Web's new-store
      // operation: a StoreOperation on the v2 endpoint, placed after the
      // list's other stores.
      const { protobuf, uid } = this.client;
      const store = {
        identifier: uuid(),
        listId: this.targetList.identifier,
        name: cleanName,
        sortIndex: stores.reduce((max, s) => Math.max(max, s.sortIndex ?? -1), -1) + 1,
      };
      const op = new protobuf.PBListOperation();
      op.setMetadata({ operationId: uuid(), handlerId: 'new-store', userId: uid, operationClass: 1 });
      op.setListId(this.targetList.identifier);
      op.setUpdatedStore(new protobuf.PBStore(store));
      await this._postListOps([op], 'data/shopping-lists/update-v2');
      stores.push(store);
      console.error(`Created store: ${store.name}`);
      return store;
    } catch (error) {
      throw new Error(`Failed to create store "${storeName}": ${error.message}`);
    }
  }

  async deleteStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const store = this.targetList.findStoreByName(storeName);
    if (!store) {
      throw new Error(`Store "${storeName}" not found`);
    }
    try {
      await this.targetList.deleteStore(store.identifier);
      console.error(`Deleted store: ${storeName}`);
    } catch (error) {
      throw new Error(`Failed to delete store "${storeName}": ${error.message}`);
    }
  }

  // ===== CATEGORIES =====
  //
  // Each list has one or more category groups (most have one), each holding
  // the list's categories, built-in and custom. An item records the category
  // it's in twice: a categoryAssignment per group (group ID + category ID) and
  // a categoryMatchId (the category's slug), which the apps use to group it.

  // The list's main category set: the one its settings select, else the one
  // AnyList derives from the list ID, else the first.
  _mainCategoryGroup() {
    const groups = this.targetList.categoryGroups || [];
    const settings = (this.client?._userData?.listSettingsResponse?.settings || [])
      .find(s => s.listId === this.targetList.identifier);
    const derivedId = uuid5Hex(this.targetList.identifier, CATEGORY_GROUP_NAMESPACE);
    return groups.find(g => g.identifier === settings?.listCategoryGroupId)
      || groups.find(g => g.identifier === derivedId)
      || groups[0]
      || null;
  }

  // The list's store filters. anylist-js doesn't load them, so read them from
  // the loaded user data.
  _storeFilters() {
    const response = (this.client?._userData?.shoppingListsResponse?.listResponses || [])
      .find(r => r.listId === this.targetList.identifier);
    return response?.storeFilters || [];
  }

  /**
   * A store's own category set (for example, Costco's aisles), or null if the
   * store doesn't have one. In AnyList a store's set is chosen on the store
   * filter for that store, so it's found through the filter.
   */
  _storeCategoryGroup(storeName) {
    const store = this._requireStore(storeName);
    const groups = this.targetList.categoryGroups || [];
    const main = this._mainCategoryGroup();
    for (const filter of this._storeFilters()) {
      if (!(filter.storeIds || []).includes(store.identifier) || !filter.listCategoryGroupId) continue;
      const group = groups.find(g => g.identifier === filter.listCategoryGroupId);
      if (group && group !== main) return group;
    }
    return null;
  }

  // The category set to use: the store's own set when a store is named,
  // else the list's main set.
  _categoryGroupFor(storeName = null) {
    if (!storeName) return this._mainCategoryGroup();
    const group = this._storeCategoryGroup(storeName);
    if (!group) {
      throw new Error(`${this._requireStore(storeName).name} doesn't have its own category set on list "${this.targetList.name}". `
        + 'In the AnyList app, give its store filter a category set first, or leave out store_name to use the list\'s main categories.');
    }
    return group;
  }

  // Each category set, in AnyList order, with the stores whose filter uses it.
  getCategories(storeName = null) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const sorted = group => [...group.categories]
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map(c => c.name);
    if (storeName) {
      const group = this._categoryGroupFor(storeName);
      return [{ group: group.name, stores: [this._requireStore(storeName).name], categories: sorted(group) }];
    }
    const stores = this.targetList.stores || [];
    const filters = this._storeFilters();
    const main = this._mainCategoryGroup();
    const groups = this.targetList.categoryGroups || [];
    return [main, ...groups.filter(g => g !== main)].filter(Boolean).map(group => ({
      group: group.name,
      stores: group === main ? [] : stores
        .filter(st => filters.some(f => f.listCategoryGroupId === group.identifier && (f.storeIds || []).includes(st.identifier)))
        .map(st => st.name),
      categories: sorted(group),
    }));
  }

  /**
   * Find a category by its name ("Dairy", "Aisle 12") or, for built-in
   * categories, its slug ("dairy"): in the store's own set when a store is
   * named, else in the list's main set. Returns { group, category } or null.
   */
  findCategory(nameOrSlug, storeName = null) {
    if (!this.targetList || !nameOrSlug) return null;
    const group = this._categoryGroupFor(storeName);
    if (!group) return null;
    const target = String(nameOrSlug).trim().toLowerCase();
    const category = group.categories.find(c => c.name.trim().toLowerCase() === target)
      || group.categories.find(c => categoryMatchId(c) === target);
    return category ? { group, category } : null;
  }

  _requireCategory(nameOrSlug, storeName = null) {
    const found = this.findCategory(nameOrSlug, storeName);
    if (!found) {
      const available = this.getCategories(storeName)[0]?.categories.join(', ') || 'none';
      const where = storeName ? `${this._requireStore(storeName).name}'s categories` : `list "${this.targetList.name}"`;
      throw new Error(`Category "${nameOrSlug}" not found in ${where}. Available categories: ${available}`);
    }
    return found;
  }

  // The item's assignments with the one for `group` set to `category`;
  // assignments in other sets are kept. Assignment IDs are derived from the
  // set's ID the way AnyList Web derives them.
  _withAssignment(currentAssignments, group, category) {
    return [
      ...currentAssignments.filter(a => a.categoryGroupId !== group.identifier),
      {
        identifier: uuid5Hex(group.identifier, CATEGORY_ASSIGNMENT_NAMESPACE),
        categoryGroupId: group.identifier,
        categoryId: category.identifier,
      },
    ];
  }

  // The ListItem fields that put a new item in a main-set category: its
  // assignment, match ID, and the legacy `category` field ("other" for a
  // custom category).
  _categoryFields(nameOrSlug, currentAssignments) {
    const { group, category } = this._requireCategory(nameOrSlug);
    const matchId = categoryMatchId(category);
    return {
      categoryAssignments: this._withAssignment(currentAssignments, group, category),
      categoryMatchId: matchId,
      category: SYSTEM_CATEGORIES.has(matchId) ? matchId : 'other',
    };
  }

  // The name of the category an item shows under: from its assignment in the
  // store's own set when a store is named, else the main set, then the other
  // sets; else from its match ID; else the match ID itself.
  _categoryNameForItem(item, storeName = null) {
    const main = this._mainCategoryGroup();
    const preferred = storeName ? this._storeCategoryGroup(storeName) : null;
    const groups = [preferred, main, ...(this.targetList.categoryGroups || [])]
      .filter((g, i, all) => g && all.indexOf(g) === i);
    for (const group of groups) {
      const assignment = (item.categoryAssignments || []).find(a => a.categoryGroupId === group.identifier);
      const category = assignment && group.categories.find(c => c.identifier === assignment.categoryId);
      if (category) return category.name;
    }
    const matchId = item.categoryMatchId || 'other';
    for (const group of groups) {
      const category = group.categories.find(c => categoryMatchId(c) === matchId);
      if (category) return category.name;
    }
    return matchId;
  }

  /**
   * Move an existing item to another category, the way AnyList Web does: an
   * update-list-item-category-assignment operation with the whole item and
   * its new assignment, then, for the main set, set-list-item-category-match-id
   * with the whole item and the new match ID in originalValue. A store's own
   * set has no match ID, so a move there sends only the assignment
   * (rnilssoncx/anylist-mcp's live-tested sequence). Then the categorization
   * rule, so the category sticks the next time the item is added.
   */
  async setItemCategory(itemName, nameOrSlug, storeName = null) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    const { group, category } = this._requireCategory(nameOrSlug, storeName);
    const { protobuf, uid } = this.client;

    item._categoryAssignments = this._withAssignment(item.categoryAssignments || [], group, category);
    const assignmentOp = new protobuf.PBListOperation();
    assignmentOp.setMetadata({ operationId: uuid(), handlerId: 'update-list-item-category-assignment', userId: uid });
    assignmentOp.setListId(this.targetList.identifier);
    assignmentOp.setListItemId(item.identifier);
    assignmentOp.setListItem(this._encodeFullItem(item));
    const ops = [assignmentOp];

    if (group === this._mainCategoryGroup()) {
      const matchId = categoryMatchId(category);
      item._categoryMatchId = matchId;
      item._category = SYSTEM_CATEGORIES.has(matchId) ? matchId : 'other';
      const matchOp = new protobuf.PBListOperation();
      matchOp.setMetadata({ operationId: uuid(), handlerId: 'set-list-item-category-match-id', userId: uid });
      matchOp.setListId(this.targetList.identifier);
      matchOp.setListItemId(item.identifier);
      matchOp.setListItem(this._encodeFullItem(item));
      matchOp.setOriginalValue(matchId);
      ops.push(matchOp);
    }

    await this._postListOps(ops);
    item._fieldsToUpdate = (item._fieldsToUpdate || []).filter(f => f !== 'categoryMatchId');
    await this._saveCategorizationRules(item.name, [{ groupId: group.identifier, categoryId: category.identifier }]);
    return this._categoryNameForItem(item, storeName);
  }

  // Whether the list remembers item categories (the app's "Remember Item
  // Categories" setting). On unless the list's settings turn it off.
  _remembersCategories() {
    const settings = this.client?._userData?.listSettingsResponse?.settings || [];
    const forList = settings.find(s => s.listId === this.targetList.identifier);
    return forList?.shouldRememberItemCategories !== false;
  }

  /**
   * Save AnyList's categorization rule for an item name in each given category
   * group, as the apps do after a category change, so the item lands in the
   * same category the next time anyone adds it. Rule IDs are derived the way
   * AnyList Web derives them, so a later save replaces rather than duplicates.
   * Format from BookCatKid/aioanylist; rnilssoncx/anylist-mcp writes the same
   * rule after every move.
   */
  async _saveCategorizationRules(itemName, assignments) {
    if (!this._remembersCategories() || assignments.length === 0) return;
    const { protobuf, uid } = this.client;
    const listId = this.targetList.identifier;
    const ops = assignments.map(({ groupId, categoryId }) => {
      const op = new protobuf.PBListOperation();
      op.setMetadata({ operationId: uuid(), handlerId: 'save-categorization-rule', userId: uid, operationClass: 5 });
      op.setListId(listId);
      op.setUpdatedCategorizationRule(new protobuf.PBListCategorizationRule({
        identifier: uuid5Hex(String(itemName).toLowerCase() + groupId + listId, CATEGORIZATION_RULE_NAMESPACE),
        listId,
        categoryGroupId: groupId,
        itemName: String(itemName).toLowerCase(),
        categoryId,
      }));
      return op;
    });
    await this._postListOps(ops, 'data/shopping-lists/update-v2');
  }

  // ===== ITEM EDITS =====

  // anylist-js's save() sends every field changed since the item was loaded
  // and never clears that record, so a second save would resend old changes.
  async _saveItem(item) {
    await item.save();
    item._fieldsToUpdate = [];
  }

  /**
   * Set an existing item's quantity with set-list-item-quantity-v2, the
   * operation AnyList Web sends. The library's set-list-item-quantity writes
   * only a legacy field the apps don't show (found and checked live by
   * rnilssoncx/anylist-mcp, 2026-10-26). Sends a partial item, so nothing else
   * is overwritten.
   */
  async _setQuantity(item, quantity) {
    const raw = String(quantity ?? '').trim();
    if (!raw) throw new Error('Quantity is required.');
    const parts = raw.match(/^(\d+(?:[.,/]\d+)?)\s*(.*)$/);
    const quantityPb = { rawQuantity: raw };
    if (parts) {
      quantityPb.amount = parts[1];
      if (parts[2]) quantityPb.unit = parts[2];
    }
    const { protobuf, uid } = this.client;
    const op = new protobuf.PBListOperation();
    op.setMetadata({ operationId: uuid(), handlerId: 'set-list-item-quantity-v2', userId: uid });
    op.setListId(this.targetList.identifier);
    op.setListItemId(item.identifier);
    op.setListItem(new protobuf.ListItem({
      identifier: item.identifier,
      listId: this.targetList.identifier,
      quantityPb,
      deprecatedQuantity: raw,
    }));
    await this._postListOps([op]);
    item._quantity = raw;
  }

  async _setQuantityIfChanged(item, quantity) {
    if (quantity == null) return;
    if (String(item.quantity ?? '').trim() === String(quantity).trim()) return;
    // A new item's default of 1 shouldn't overwrite a quantity the item has.
    if (Number(quantity) === 1 && item.quantity) return;
    await this._setQuantity(item, quantity);
  }

  /**
   * Change an item already on the list: its name, quantity, or notes. Only the
   * fields given change. A rename keeps the item's categories remembered under
   * the new name. A name another item has (checked off or not) is refused.
   */
  async updateItem(itemName, { newName, quantity, notes } = {}) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    const cleanName = newName == null ? null : String(newName).trim();
    if (newName != null && !cleanName) throw new Error('New name is blank.');
    if (cleanName && cleanName !== item.name) {
      const clash = this.targetList.items.find(i => i !== item && i.name.trim().toLowerCase() === cleanName.toLowerCase());
      if (clash) {
        throw new Error(`An item named "${clash.name}" is already on the list${clash.checked ? ' (checked off)' : ''}`);
      }
      item.name = cleanName;
    }
    if (notes != null) item.details = String(notes);
    if (item._fieldsToUpdate?.length) await this._saveItem(item);
    if (quantity != null) await this._setQuantity(item, quantity);
    if (cleanName && cleanName.toLowerCase() !== String(itemName).toLowerCase()) {
      await this._saveCategorizationRules(cleanName, (item.categoryAssignments || [])
        .map(a => ({ groupId: a.categoryGroupId, categoryId: a.categoryId })));
    }
    return { name: item.name, quantity: item.quantity, notes: item.details || '' };
  }

  // Add a category to the list's main set, or with storeName, to that
  // store's own set (an aisle, say), after the set's other categories.
  async createCategory(name, storeName = null) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const group = this._categoryGroupFor(storeName);
    const cleanName = String(name || '').trim();
    if (group && group.categories.some(c => c.name.trim().toLowerCase() === cleanName.toLowerCase())) {
      throw new Error(`Category "${cleanName}" already exists in ${storeName ? `${this._requireStore(storeName).name}'s categories` : `list "${this.targetList.name}"`}`);
    }
    const sortIndex = group ? group.categories.reduce((max, c) => Math.max(max, c.sortIndex ?? -1), -1) + 1 : 0;
    return this.targetList.createCategory({ name: cleanName, categoryGroupId: group?.identifier, sortIndex });
  }

  // ===== PRICES =====
  //
  // AnyList keeps prices per store on each item: ListItem.prices holds one
  // PBItemPrice per storeId. The entry with no storeId is the item's main
  // price, the one the apps show when the list isn't filtered to a store; a
  // store's entry shows only under that store's filter. anylist-js's Item
  // doesn't carry prices, so they're read from the raw user-data snapshot and
  // kept in step locally after each write. Adapted from Josephtd8421's
  // anylist-mcp fork (https://github.com/Josephtd8421/anylist-mcp/pull/2).

  // The loaded (raw protobuf) copy of an item, or null if it was added after
  // the snapshot was taken.
  _rawItem(item) {
    const rawList = (this.client?._userData?.shoppingListsResponse?.newLists || [])
      .find(l => l.identifier === this.targetList.identifier);
    return (rawList?.items || []).find(i => i.identifier === item.identifier) || null;
  }

  _itemPrices(item) {
    const rawItem = this._rawItem(item);
    if (rawItem) return rawItem.prices || (rawItem.prices = []);
    this._newItemPrices ??= new Map();
    if (!this._newItemPrices.has(item.identifier)) this._newItemPrices.set(item.identifier, []);
    return this._newItemPrices.get(item.identifier);
  }

  /**
   * Set (or clear, with null or 0) an item's main price, or with `storeName`,
   * that store's price.
   */
  async setItemPrice(itemName, amount, storeName = null) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    if (amount != null && !(Number.isFinite(Number(amount)) && Number(amount) >= 0)) {
      throw new Error(`Invalid price "${amount}"`);
    }
    const storeId = storeName ? this._requireStore(storeName).identifier : '';
    const prices = this._itemPrices(item);

    // save-item-price replaces the store's whole price entry, so carry over its
    // details and date. An entry with no amount is how AnyList removes a price.
    const index = prices.findIndex(p => (p.storeId || '') === storeId);
    const clearing = amount == null || Number(amount) === 0;
    const itemPrice = { storeId: storeId || null };
    if (!clearing) {
      itemPrice.amount = Number(amount);
      if (index >= 0 && prices[index].details) itemPrice.details = prices[index].details;
      if (index >= 0 && prices[index].date) itemPrice.date = prices[index].date;
    }

    const { protobuf, uid } = this.client;
    const op = new protobuf.PBListOperation();
    op.setMetadata({ operationId: uuid(), handlerId: 'save-item-price', userId: uid });
    op.setListId(this.targetList.identifier);
    op.setListItemId(item.identifier);
    op.setItemPrice(new protobuf.PBItemPrice(itemPrice));
    await this._postListOps([op]);

    if (clearing) {
      if (index >= 0) prices.splice(index, 1);
    } else if (index >= 0) {
      prices[index] = itemPrice;
    } else {
      prices.push(itemPrice);
    }
  }

  // ===== LIST OPERATION HELPERS =====

  // The whole item, for operations that carry it: the fields anylist-js
  // tracks, plus the ones it doesn't from the loaded copy, plus prices.
  _encodeFullItem(item) {
    const encoded = item._encode();
    const raw = this._rawItem(item);
    if (raw) {
      for (const field of UNTRACKED_ITEM_FIELDS) {
        if (raw[field] != null) encoded[field] = raw[field];
      }
    }
    encoded.prices = this._itemPrices(item).map(p => new this.client.protobuf.PBItemPrice(p));
    return encoded;
  }

  async _postListOps(ops, path = 'data/shopping-lists/update') {
    const opList = new this.client.protobuf.PBListOperationList();
    opList.setOperations(ops);
    const form = new FormData();
    form.append('operations', opList.toBuffer());
    await this.client.client.post(path, { body: form });
  }

  // ===== RECIPES =====

  async getRecipes(searchQuery = null) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      let results = recipes.map(r => ({
        identifier: r.identifier,
        name: r.name,
        note: r.note || null,
        sourceName: r.sourceName || null,
        sourceUrl: r.sourceUrl || null,
        rating: r.rating || null,
        prepTime: r.prepTime || null,
        cookTime: r.cookTime || null,
        servings: r.servings || null,
        ingredientCount: r.ingredients ? r.ingredients.length : 0,
        stepCount: r.preparationSteps ? r.preparationSteps.length : 0,
      }));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        results = results.filter(r => r.name && r.name.toLowerCase().includes(q));
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to get recipes: ${error.message}`);
    }
  }

  // Full details of every recipe, from one fetch (for the style audit).
  async getAllRecipeDetails() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const recipes = await this.client.getRecipes();
    return recipes.map(r => this._recipeDetails(r));
  }

  async getRecipeDetails(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      return this._recipeDetails(recipe);
    } catch (error) {
      throw new Error(`Failed to get recipe details: ${error.message}`);
    }
  }

  _recipeDetails(recipe) {
    return {
      identifier: recipe.identifier,
      name: recipe.name,
      note: recipe.note || null,
      sourceName: recipe.sourceName || null,
      sourceUrl: recipe.sourceUrl || null,
      rating: recipe.rating || null,
      prepTime: recipe.prepTime || null,
      cookTime: recipe.cookTime || null,
      servings: recipe.servings || null,
      nutritionalInfo: recipe.nutritionalInfo || null,
      createdAt: recipe.creationTimestamp
        ? new Date(recipe.creationTimestamp * 1000).toISOString()
        : (recipe.timestamp ? new Date(recipe.timestamp * 1000).toISOString() : null),
      ingredients: recipe.ingredients ? recipe.ingredients.map(i => ({
        rawIngredient: i.rawIngredient || null,
        name: i.name || null,
        quantity: i.quantity || null,
        note: i.note || null,
        isHeading: ingredientIsHeading(i),
      })) : [],
      photoUrls: recipe.photoUrls || [],
      photoIds: recipe.photoIds || [],
      preparationSteps: recipe.preparationSteps || [],
    };
  }

  async importRecipeFromUrl(url) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Try AnyList's native web import first
    let nativeError = null;
    try {
      const result = await this.client.client.post('data/recipes/web-import?url=' + encodeURIComponent(url));
      const decoded = this.client.protobuf.PBRecipeWebImportResponse.decode(result.body);

      if (decoded.statusCode === 0 && decoded.recipe) {
        // Native import succeeded
        const recipe = await this.client.createRecipe({
          name: decoded.recipe.name,
          note: decoded.recipe.note || null,
          sourceName: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          prepTime: decoded.recipe.prepTime || null,
          cookTime: decoded.recipe.cookTime || null,
          servings: decoded.recipe.servings || null,
          nutritionalInfo: decoded.recipe.nutritionalInfo || null,
          rating: decoded.recipe.rating || null,
          ingredients: decoded.recipe.ingredients || [],
          preparationSteps: decoded.recipe.preparationSteps || [],
          photoIds: decoded.recipe.photoIds || [],
          photoUrls: decoded.recipe.photoUrls || [],
        });
        recipe.isNewRecipeFromWebImport = true;
        recipe.creationTimestamp = Date.now() / 1000;
        await recipe.save();
        console.error(`Imported recipe from URL (native): ${recipe.name}`);

        return {
          name: recipe.name,
          identifier: recipe.identifier,
          ingredientCount: decoded.recipe.ingredients?.length || 0,
          stepCount: decoded.recipe.preparationSteps?.length || 0,
          source: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          isPremiumUser: decoded.isPremiumUser,
          freeImportsRemaining: decoded.freeRecipeImportsRemainingCount,
          method: 'native',
        };
      }
      nativeError = decoded.siteSpecificHelpText || 'Native import returned no recipe';
    } catch (error) {
      nativeError = error.message;
    }

    // Fallback: use normalizer
    console.error(`Native import failed (${nativeError}), trying normalizer fallback...`);
    try {
      const normalized = await normalizeRecipe({ url });
      const created = await this.createRecipe({
        name: normalized.name,
        ingredients: normalized.ingredients,
        preparationSteps: normalized.preparationSteps,
        note: normalized.note,
        sourceName: normalized.sourceName,
        sourceUrl: normalized.sourceUrl || url,
        prepTime: normalized.prepTime,
        cookTime: normalized.cookTime,
        servings: normalized.servings,
      });
      console.error(`Imported recipe from URL (normalizer fallback): ${created.name}`);

      return {
        name: created.name,
        identifier: created.identifier,
        ingredientCount: normalized.ingredients.length,
        stepCount: normalized.preparationSteps.length,
        source: normalized.sourceName || null,
        sourceUrl: normalized.sourceUrl || url,
        method: 'normalizer',
      };
    } catch (fallbackError) {
      throw new Error(`Failed to import recipe from URL: native import failed (${nativeError}), normalizer also failed (${fallbackError.message})`);
    }
  }

  async createRecipe({ name, ingredients = [], preparationSteps = [], note = null, sourceName = null, sourceUrl = null, prepTime = null, cookTime = null, servings = null, photoUrls = [], nutritionalInfo = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const nowSecs = Date.now() / 1000;
      const recipeObj = { name, creationTimestamp: nowSecs };
      if (note) recipeObj.note = note;
      if (sourceName) recipeObj.sourceName = sourceName;
      if (sourceUrl) recipeObj.sourceUrl = sourceUrl;
      if (prepTime) recipeObj.prepTime = prepTime;
      if (cookTime) recipeObj.cookTime = cookTime;
      if (servings) recipeObj.servings = servings;
      if (photoUrls.length > 0) recipeObj.photoUrls = photoUrls;
      if (nutritionalInfo) recipeObj.nutritionalInfo = nutritionalInfo;
      if (preparationSteps.length > 0) recipeObj.preparationSteps = preparationSteps;
      if (ingredients.length > 0) {
        recipeObj.ingredients = ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
          isHeading: typeof i === 'string' ? false : Boolean(i.isHeading),
        }));
      }
      const recipe = await this.client.createRecipe(recipeObj);
      await recipe.save();
      console.error(`Created recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to create recipe: ${error.message}`);
    }
  }

  /**
   * Partially update an existing recipe in place.
   *
   * Only the fields present in `fields` are changed; every other field
   * (identifier, note, photos, rating, timestamps, and any field not passed)
   * is carried over from the existing recipe. This is a real in-place update
   * (`save-recipe` on the same identifier), NOT a delete + recreate, so recipe
   * collection membership and meal-plan links that reference the recipe id
   * survive untouched.
   *
   * `ingredients` and `preparationSteps`, when provided, REPLACE the existing
   * array wholesale — they are not merged item-by-item.
   *
   * @param {string} recipeName - name identifying the recipe to update
   * @param {object} fields - subset of { name, note, sourceName, sourceUrl,
   *   prepTime, cookTime, servings, ingredients, preparationSteps }; keys with an
   *   `undefined` value are ignored. `name` renames the recipe in place.
   */
  async updateRecipe(recipeName, fields = {}) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const matches = recipes.filter(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (matches.length === 0) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple recipes named "${recipeName}" (${matches.length}) exist. Rename or remove the duplicates so the target is unambiguous, then try again.`);
      }
      const existing = matches[0];
      if (fields.name !== undefined && recipes.some(r => r !== existing && r.name && r.name.toLowerCase() === fields.name.toLowerCase())) {
        throw new Error(`Cannot rename to "${fields.name}": a recipe with that name already exists.`);
      }

      // Start from every existing field so nothing is lost on save, then
      // override only the provided fields. Existing ingredients are serialized
      // via toJSON() to preserve their identifiers and headings.
      const merged = {
        identifier: existing.identifier,
        name: existing.name,
        note: existing.note,
        sourceName: existing.sourceName,
        sourceUrl: existing.sourceUrl,
        prepTime: existing.prepTime,
        cookTime: existing.cookTime,
        servings: existing.servings,
        rating: existing.rating,
        nutritionalInfo: existing.nutritionalInfo,
        scaleFactor: existing.scaleFactor,
        paprikaIdentifier: existing.paprikaIdentifier,
        creationTimestamp: existing.creationTimestamp,
        photoIds: existing.photoIds,
        photoUrls: existing.photoUrls,
        preparationSteps: existing.preparationSteps,
        ingredients: existing.ingredients.map(i => i.toJSON()),
      };

      for (const key of ['name', 'note', 'sourceName', 'sourceUrl', 'prepTime', 'cookTime', 'servings', 'preparationSteps', 'photoUrls', 'nutritionalInfo']) {
        if (fields[key] !== undefined) merged[key] = fields[key];
      }
      if (fields.ingredients !== undefined) {
        merged.ingredients = fields.ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
          isHeading: typeof i === 'string' ? false : Boolean(i.isHeading),
        }));
      }

      const recipe = await this.client.createRecipe(merged);
      await recipe.save();
      console.error(`Updated recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to update recipe: ${error.message}`);
    }
  }

  /**
   * Every ingredient line across recipes, for reviewing or cleaning them up in
   * bulk. `search` keeps lines whose quantity, name, or note contains it;
   * `recipeName` keeps one recipe; `since` (YYYY-MM-DD) keeps recipes created
   * on or after that date. Line numbers count from 1 and include headings.
   * Idea from djbrinkerhoff/anylist-mcp's list_ingredients.
   */
  async listIngredients({ search = null, recipeName = null, since = null } = {}) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    let recipes = await this.client.getRecipes();
    if (recipeName) {
      recipes = recipes.filter(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (recipes.length === 0) throw new Error(`Recipe "${recipeName}" not found`);
    }
    if (since) {
      const cutoff = Date.parse(since.length === 10 ? `${since}T00:00:00` : since) / 1000;
      if (Number.isNaN(cutoff)) throw new Error(`Invalid date "${since}". Use YYYY-MM-DD.`);
      // Recipes with no creation time are left out: their other timestamp moves on every edit.
      recipes = recipes.filter(r => r.creationTimestamp && r.creationTimestamp >= cutoff);
    }
    const needle = search ? search.toLowerCase() : null;
    const rows = [];
    for (const recipe of recipes) {
      recipe.ingredients.forEach((ing, index) => {
        const row = {
          recipe: recipe.name,
          line: index + 1,
          isHeading: ingredientIsHeading(ing),
          quantity: ing.quantity || '',
          name: ing.name || ing.rawIngredient || '',
          note: ing.note || '',
        };
        if (needle && ![row.quantity, row.name, row.note].some(v => v.toLowerCase().includes(needle))) return;
        rows.push(row);
      });
    }
    return rows;
  }

  /**
   * Edit ingredient lines in place across recipes. Each edit names a recipe,
   * a line number, and the line's current name (a guard, so a list that
   * changed since it was read isn't edited blindly), plus the fields to set:
   * quantity, name, note, isHeading. Only those fields change; each line keeps
   * its identifier and position, so items on a shopping list stay linked to
   * it. One save per recipe. Edits that don't match are reported, not guessed.
   */
  async editIngredients(edits = []) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const recipes = await this.client.getRecipes();
    const results = [];
    const byRecipe = new Map();
    for (const [order, original] of edits.entries()) {
      const edit = { ...original, order };
      const matches = recipes.filter(r => r.name && r.name.toLowerCase() === String(edit.recipe || '').toLowerCase());
      if (matches.length !== 1) {
        results.push({ ...edit, outcome: matches.length === 0 ? 'recipe not found' : `${matches.length} recipes have this name` });
        continue;
      }
      if (!byRecipe.has(matches[0])) byRecipe.set(matches[0], []);
      byRecipe.get(matches[0]).push(edit);
    }
    for (const [recipe, recipeEdits] of byRecipe) {
      let changed = false;
      for (const edit of recipeEdits) {
        const ing = recipe.ingredients[edit.line - 1];
        const current = ing ? (ing.name || ing.rawIngredient || '') : null;
        if (!ing) {
          results.push({ ...edit, outcome: `no line ${edit.line} (the recipe has ${recipe.ingredients.length})` });
          continue;
        }
        if (edit.currentName != null && current.trim().toLowerCase() !== String(edit.currentName).trim().toLowerCase()) {
          results.push({ ...edit, outcome: `line ${edit.line} is now "${current}", not "${edit.currentName}"; skipped` });
          continue;
        }
        if (edit.quantity !== undefined) ing._quantity = edit.quantity || null;
        if (edit.name !== undefined) {
          if (!String(edit.name).trim()) {
            results.push({ ...edit, outcome: 'a line needs a name; skipped' });
            continue;
          }
          ing._name = String(edit.name).trim();
        }
        if (edit.note !== undefined) ing._note = edit.note || null;
        if (edit.isHeading !== undefined) ing._isHeading = Boolean(edit.isHeading);
        // Kept in step with the fields, as the recipes tool builds it.
        ing._rawIngredient = ing._isHeading
          ? ing._name
          : `${ing._quantity || ''} ${ing._name || ''}${ing._note ? `, ${ing._note}` : ''}`.trim();
        changed = true;
        results.push({ ...edit, outcome: 'updated' });
      }
      if (changed) await recipe.save();
    }
    return results.sort((a, b) => a.order - b.order).map(({ order, ...rest }) => rest);
  }

  async deleteRecipe(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      await recipe.delete();
      console.error(`Deleted recipe: ${recipe.name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe: ${error.message}`);
    }
  }

  // ===== MEAL PLANNING =====

  async getMealPlanEvents() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      return events.map(e => ({
        identifier: e.identifier,
        date: e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date),
        title: e.title || null,
        details: e.details || null,
        labelName: e.label ? e.label.name : null,
        labelColor: e.label ? e.label.hexColor : null,
        recipeName: e.recipe ? e.recipe.name : null,
        recipeId: e.recipeId || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan events: ${error.message}`);
    }
  }

  async getMealPlanLabels() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.client.getMealPlanningCalendarEvents();
      return (this.client.mealPlanningCalendarEventLabels || []).map(l => ({
        identifier: l.identifier,
        name: l.name,
        hexColor: l.hexColor,
        sortIndex: l.sortIndex,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan labels: ${error.message}`);
    }
  }

  async createMealPlanEvent({ date, title = null, recipeId = null, labelId = null, details = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const eventObj = { date: new Date(`${date}T12:00:00`) };
      if (title) eventObj.title = title;
      if (recipeId) eventObj.recipeId = recipeId;
      if (labelId) eventObj.labelId = labelId;
      if (details) eventObj.details = details;
      const event = await this.client.createEvent(eventObj);
      await event.save();
      console.error(`Created meal plan event for ${date}`);
      return { identifier: event.identifier, date: date };
    } catch (error) {
      throw new Error(`Failed to create meal plan event: ${error.message}`);
    }
  }

  async deleteMealPlanEvent(eventId) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      const event = events.find(e => e.identifier === eventId);
      if (!event) {
        throw new Error(`Meal plan event "${eventId}" not found`);
      }
      await event.delete();
      console.error(`Deleted meal plan event: ${eventId}`);
    } catch (error) {
      throw new Error(`Failed to delete meal plan event: ${error.message}`);
    }
  }

  // ===== FAVORITES & RECENTS =====

  async getFavoriteItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const favList = this.client.getFavoriteItemsByListId(this.targetList.identifier);
      if (!favList || !favList.items) {
        return [];
      }
      return favList.items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get favorite items: ${error.message}`);
    }
  }

  async getRecentItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const items = this.client.getRecentItemsByListId(this.targetList.identifier);
      if (!items) {
        return [];
      }
      return items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get recent items: ${error.message}`);
    }
  }

  // ===== RECIPE COLLECTIONS =====

  async getRecipeCollections() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      return collections.map(c => ({
        identifier: c.identifier,
        name: c.name,
        recipeCount: c.recipeIds ? c.recipeIds.length : 0,
        recipeNames: (c.recipeIds || []).map(id => {
          const r = recipes.find(r => r.identifier === id);
          return r ? r.name : id;
        }),
      }));
    } catch (error) {
      throw new Error(`Failed to get recipe collections: ${error.message}`);
    }
  }

  async createRecipeCollection(name, recipeNames = []) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipeIds = [];
      if (recipeNames.length > 0) {
        const recipes = await this.client.getRecipes();
        for (const rName of recipeNames) {
          const r = recipes.find(r => r.name && r.name.toLowerCase() === rName.toLowerCase());
          if (r) recipeIds.push(r.identifier);
        }
      }
      const collection = this.client.createRecipeCollection({ name, recipeIds });
      await collection.save();
      console.error(`Created recipe collection: ${name}`);
      return { identifier: collection.identifier, name: collection.name };
    } catch (error) {
      throw new Error(`Failed to create recipe collection: ${error.message}`);
    }
  }

  /**
   * Add recipes to, or remove them from, an existing collection.
   *
   * AnyList's web app sends one operation per recipe, with the collection's
   * recipeIds narrowed to that recipe. The server adds or removes exactly the
   * IDs it receives, so sending the full list on a remove would remove every
   * recipe in the collection. The anylist library's RecipeCollection.addRecipe
   * and removeRecipe send the full list, so they are not used here.
   *
   * @param {'add'|'remove'} mode
   * @param {string} collectionName
   * @param {string[]} recipeNames
   * @returns {Promise<{name: string, changed: string[], unchanged: string[], notFound: string[]}>}
   *   changed: recipes added (or removed); unchanged: already in (or not in) the collection
   */
  async _changeRecipeCollection(mode, collectionName, recipeNames) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const verb = mode === 'add' ? 'add recipes to' : 'remove recipes from';
    try {
      const userData = await this.client._getUserData(true);
      const recipeData = userData.recipeDataResponse;
      const raw = (recipeData.recipeCollections || []).find(c => c.name && c.name.toLowerCase() === collectionName.toLowerCase());
      if (!raw) throw new Error(`Recipe collection "${collectionName}" not found`);

      const inCollection = new Set(raw.recipeIds || []);
      const recipes = recipeData.recipes || [];
      const changed = [];
      const unchanged = [];
      const notFound = [];
      const ids = [];
      for (const rName of recipeNames) {
        const r = recipes.find(r => r.name && r.name.toLowerCase() === rName.toLowerCase());
        if (!r) { notFound.push(rName); continue; }
        const isIn = inCollection.has(r.identifier);
        if ((mode === 'add') === isIn || ids.includes(r.identifier)) { unchanged.push(r.name); continue; }
        ids.push(r.identifier);
        changed.push(r.name);
      }

      if (ids.length > 0) {
        const pb = this.client.protobuf;
        const handlerId = mode === 'add' ? 'add-recipes-to-collection' : 'remove-recipes-from-collection';
        const operations = ids.map(id => {
          const op = new pb.PBRecipeOperation();
          op.setMetadata({ operationId: uuid(), handlerId, userId: this.client.uid });
          op.setRecipeDataId(recipeData.recipeDataId);
          op.setRecipeCollection(new pb.PBRecipeCollection({
            identifier: raw.identifier,
            timestamp: raw.timestamp,
            name: raw.name,
            recipeIds: [id],
            collectionSettings: raw.collectionSettings,
          }));
          return op;
        });
        const ops = new pb.PBRecipeOperationList();
        ops.setOperations(operations);
        const form = new FormData();
        form.append('operations', ops.toBuffer());
        await this.client.client.post('data/user-recipe-data/update', { body: form });
        console.error(`${mode === 'add' ? 'Added' : 'Removed'} ${ids.length} recipe(s) ${mode === 'add' ? 'to' : 'from'} collection: ${raw.name}`);
      }
      return { name: raw.name, changed, unchanged, notFound };
    } catch (error) {
      throw new Error(`Failed to ${verb} collection: ${error.message}`);
    }
  }

  async addRecipesToCollection(collectionName, recipeNames) {
    return this._changeRecipeCollection('add', collectionName, recipeNames);
  }

  async removeRecipesFromCollection(collectionName, recipeNames) {
    return this._changeRecipeCollection('remove', collectionName, recipeNames);
  }

  async deleteRecipeCollection(name) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const raw = collections.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
      if (!raw) throw new Error(`Recipe collection "${name}" not found`);
      const collection = this.client.createRecipeCollection(raw);
      await collection.delete();
      console.error(`Deleted recipe collection: ${name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe collection: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.teardown();
        console.error('Disconnected from AnyList');
      } catch (error) {
        const wrappedError = new Error(`Error during disconnect: ${error.message}`);
        console.error(wrappedError.message);
        throw wrappedError;
      }
    }
    this.client = null;
    this.targetList = null;
  }
}

export default AnyListClient;
