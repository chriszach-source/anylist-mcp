# AnyList style guide

How recipes and items are written in this AnyList. Follow it whenever you
create, import, or edit recipes, meal plans, or shopping items.

## Recipe titles

- Title Case, keeping these words lowercase unless they come first:
  a, an, the, and, or, with, of, in, on.

## Ingredients

- Use the separate fields: quantity in Quantity, the ingredient in Name, and
  prep details, alternates, and "optional" in Note.
- Group sub-parts under headings, such as "Sauce".
- Give a gram weight for every ingredient, with the volume in the note.
- "To taste" items such as salt and pepper may have no quantity.

## Shopping list

- Use the same names as recipe ingredients; put the quantity in the quantity field.
- Check the list for an existing item before adding a near-duplicate.

## Audit rules

Used by `recipes` → `audit`. Keep this block valid JSON.

```json
{
  "titleLowercaseWords": ["a", "an", "the", "and", "or", "with", "of", "in", "on"],
  "spellings": { "cherry tomatos": "cherry tomatoes" },
  "prepInNote": true,
  "requireGrams": true,
  "noQuantityOk": ["salt", "pepper", "to taste"],
  "requireNutrition": false
}
```
