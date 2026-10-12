import { useState } from "react";
import type { FilterGroup, FilterOption } from "@kash-commerce/storefront-sdk";

/**
 * Filter sidebar driven entirely by `filters.get()`. The URL query string is the source of truth:
 * every group's `key` is exactly the query parameter name (`attr.color`, `prop.fit`, `tag`,
 * `collection`, `inStock`, `price` -> minPrice/maxPrice, `category` -> path), so toggling an option
 * just edits the URL and re-fetches.
 */
export interface FilterChange {
  key: string;
  type: FilterGroup["type"];
  /** option value (for options) */
  value?: string;
  /** current selection state of that option before the click */
  selected?: boolean;
  min?: string;
  max?: string;
}

function OptionList({ group, onChange }: { group: FilterGroup; onChange(c: FilterChange): void }) {
  const single = group.type === "single";
  return (
    <ul className="filter-options">
      {group.options.map((o: FilterOption) => {
        const id = `f-${group.key}-${o.value}`;
        return (
          <li key={o.value}>
            <input
              id={id}
              type={single ? "radio" : "checkbox"}
              name={`f-${group.key}`}
              checked={o.selected}
              onChange={() =>
                onChange({
                  key: group.key,
                  type: group.type,
                  value: o.value,
                  selected: o.selected,
                })
              }
            />{" "}
            <label htmlFor={id}>
              {o.label} <span className="muted">({o.count})</span>
            </label>
          </li>
        );
      })}
      {single && group.options.some((o) => o.selected) ? (
        <li>
          <button
            type="button"
            className="link-button"
            onClick={() => onChange({ key: group.key, type: "single", selected: true })}
          >
            Clear
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function PriceRange({
  group,
  initialMin,
  initialMax,
  onChange,
}: {
  group: FilterGroup;
  initialMin: string;
  initialMax: string;
  onChange(c: FilterChange): void;
}) {
  const [min, setMin] = useState(initialMin);
  const [max, setMax] = useState(initialMax);
  return (
    <form
      className="price-range"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ key: "price", type: "range", min, max });
      }}
    >
      <label>
        Min
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder={group.range?.min ?? ""}
          value={min}
          onChange={(e) => setMin(e.target.value)}
        />
      </label>
      <label>
        Max
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder={group.range?.max ?? ""}
          value={max}
          onChange={(e) => setMax(e.target.value)}
        />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}

export function Filters({
  groups,
  minPrice,
  maxPrice,
  onChange,
}: {
  groups: FilterGroup[];
  minPrice: string;
  maxPrice: string;
  onChange(c: FilterChange): void;
}) {
  if (!groups.length) return null;
  return (
    <aside className="filters" aria-label="Filters">
      <h2 className="sr-only">Filters</h2>
      {groups.map((g) => (
        <details key={g.id} open={g.open} className="filter-group">
          <summary>{g.label}</summary>
          {g.type === "range" ? (
            <PriceRange group={g} initialMin={minPrice} initialMax={maxPrice} onChange={onChange} />
          ) : (
            <OptionList group={g} onChange={onChange} />
          )}
        </details>
      ))}
    </aside>
  );
}

/** Pure helper: apply a FilterChange to a query string. */
export function applyFilterChange(
  params: URLSearchParams,
  c: FilterChange,
): { params: URLSearchParams; categorySlug?: string | null } {
  const next = new URLSearchParams(params);
  next.delete("page");
  if (c.key === "price") {
    if (c.min) next.set("minPrice", c.min);
    else next.delete("minPrice");
    if (c.max) next.set("maxPrice", c.max);
    else next.delete("maxPrice");
    return { params: next };
  }
  if (c.key === "category") {
    return { params: next, categorySlug: c.selected ? null : (c.value ?? null) };
  }
  if (c.type === "boolean") {
    if (c.selected) next.delete(c.key);
    else next.set(c.key, "true");
    return { params: next };
  }
  const current = (next.get(c.key) ?? "").split(",").filter(Boolean);
  if (c.type === "single") {
    if (c.selected || !c.value) next.delete(c.key);
    else next.set(c.key, c.value);
  } else if (c.value) {
    const list = c.selected ? current.filter((v) => v !== c.value) : [...current, c.value];
    if (list.length) next.set(c.key, list.join(","));
    else next.delete(c.key);
  }
  return { params: next };
}
