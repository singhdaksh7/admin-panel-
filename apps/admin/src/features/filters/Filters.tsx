import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  CheckField,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from "../../components/ui";
import { categoryOptions, useAttributes, useCategories } from "../media/shared";

export type FilterSource =
  "CATEGORY" | "COLLECTION" | "PRICE" | "STOCK" | "ATTRIBUTE" | "TAG" | "PROPERTY";

export interface FilterGroup {
  id?: string;
  uid: string;
  source: FilterSource;
  attributeId: string;
  propertyKey: string;
  label: string;
  isEnabled: boolean;
  defaultOpen: boolean;
  multiSelect: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  inheritToChildren: boolean;
}
interface ApiGroup {
  id: string;
  source: FilterSource;
  attributeId: string | null;
  propertyKey: string | null;
  label: string;
  isEnabled: boolean;
  defaultOpen: boolean;
  multiSelect: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  inheritToChildren: boolean;
  categoryId?: string | null;
}

const SOURCES: { value: FilterSource; label: string; defaultLabel: string }[] = [
  { value: "CATEGORY", label: "Category", defaultLabel: "Category" },
  { value: "COLLECTION", label: "Collection", defaultLabel: "Collection" },
  { value: "PRICE", label: "Price range", defaultLabel: "Price" },
  { value: "STOCK", label: "Availability", defaultLabel: "Availability" },
  { value: "ATTRIBUTE", label: "Attribute", defaultLabel: "" },
  { value: "TAG", label: "Tag", defaultLabel: "Tags" },
  { value: "PROPERTY", label: "Product property", defaultLabel: "" },
];

let n = 0;
const uid = () => `f${Date.now().toString(36)}${n++}`;

export function blankGroup(over: Partial<FilterGroup> = {}): FilterGroup {
  return {
    uid: uid(),
    source: "CATEGORY",
    attributeId: "",
    propertyKey: "",
    label: "Category",
    isEnabled: true,
    defaultOpen: true,
    multiSelect: true,
    showDesktop: true,
    showMobile: true,
    inheritToChildren: true,
    ...over,
  };
}
const fromApi = (g: ApiGroup): FilterGroup =>
  blankGroup({
    id: g.id,
    source: g.source,
    attributeId: g.attributeId ?? "",
    propertyKey: g.propertyKey ?? "",
    label: g.label,
    isEnabled: g.isEnabled,
    defaultOpen: g.defaultOpen,
    multiSelect: g.multiSelect,
    showDesktop: g.showDesktop,
    showMobile: g.showMobile,
    inheritToChildren: g.inheritToChildren,
  });

/** Bulk payload for PUT /filters/scope/:categoryId (array order = sort order). */
export function toBulkPayload(groups: FilterGroup[]) {
  return {
    groups: groups.map((g) => ({
      source: g.source,
      ...(g.source === "ATTRIBUTE" ? { attributeId: g.attributeId } : {}),
      ...(g.source === "PROPERTY" ? { propertyKey: g.propertyKey.trim() } : {}),
      label: g.label.trim(),
      isEnabled: g.isEnabled,
      defaultOpen: g.defaultOpen,
      multiSelect: g.multiSelect,
      showDesktop: g.showDesktop,
      showMobile: g.showMobile,
      inheritToChildren: g.inheritToChildren,
    })),
  };
}

const defKey = (g: FilterGroup) => `${g.source}:${g.attributeId}:${g.propertyKey}`;
export function validateGroups(groups: FilterGroup[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  groups.forEach((g, i) => {
    const name = g.label || `Group ${i + 1}`;
    if (!g.label.trim()) out.push(`Group ${i + 1}: label is required`);
    if (g.source === "ATTRIBUTE" && !g.attributeId) out.push(`${name}: choose an attribute`);
    if (g.source === "PROPERTY" && !/^[A-Za-z0-9_-]{1,60}$/.test(g.propertyKey))
      out.push(`${name}: property key may contain letters, digits, _ and - only`);
    const k = defKey(g);
    if (seen.has(k)) out.push(`${name}: this filter source is already configured in the list`);
    seen.add(k);
  });
  return out;
}

export function Filters() {
  const { can } = useAuth();
  const canWrite = can("filters.write");
  const toast = useToast();
  const qc = useQueryClient();
  const cats = useCategories();
  const attrs = useAttributes();
  const [scope, setScope] = useState("global");
  const [groups, setGroups] = useState<FilterGroup[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<FilterGroup | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [toRemove, setToRemove] = useState<FilterGroup | null>(null);

  const own = useQuery({
    queryKey: ["filters", scope],
    queryFn: () => api.get<{ items: ApiGroup[] }>("/filters", { categoryId: scope }),
  });
  const effective = useQuery({
    queryKey: ["filters-effective", scope],
    queryFn: () => api.get<{ items: ApiGroup[] }>(`/filters/effective/${scope}`),
  });
  useEffect(() => {
    if (own.data) {
      setGroups(own.data.items.map(fromApi));
      setDirty(false);
      setErrors([]);
    }
  }, [own.data]);

  function changeScope(s: string) {
    if (dirty && !window.confirm("Discard unsaved filter changes?")) return;
    setScope(s);
  }
  const update = (next: FilterGroup[]) => {
    setGroups(next);
    setDirty(true);
  };
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j]!, next[i]!];
    update(next);
  }

  async function save() {
    const errs = validateGroups(groups);
    setErrors(errs);
    if (errs.length) return;
    setBusy(true);
    try {
      await api.put(`/filters/scope/${scope}`, toBulkPayload(groups));
      toast.success("Filters saved");
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["filters", scope] });
      void qc.invalidateQueries({ queryKey: ["filters-effective"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        const fe = e.fieldErrors();
        setErrors(
          Object.keys(fe).length ? Object.entries(fe).map(([p, m]) => `${p}: ${m}`) : [e.message],
        );
      } else toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const catName = (id: string) => cats.data?.items.find((c) => c.id === id)?.name ?? id;
  const attrName = (id: string) => attrs.data?.items.find((a) => a.id === id)?.name ?? id;
  const describe = (g: {
    source: string;
    attributeId?: string | null;
    propertyKey?: string | null;
  }) =>
    g.source === "ATTRIBUTE"
      ? `Attribute: ${attrName(g.attributeId ?? "")}`
      : g.source === "PROPERTY"
        ? `Property: ${g.propertyKey}`
        : (SOURCES.find((s) => s.value === g.source)?.label ?? g.source);

  return (
    <>
      <PageHeader
        title="Storefront filters"
        subtitle="Choose which filters appear on category and search pages"
        actions={
          canWrite && (
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
              Save filters
            </Button>
          )
        }
      />
      <div className="toolbar">
        <SelectField
          label="Scope"
          value={scope}
          onChange={(e) => changeScope(e.target.value)}
          options={[
            { value: "global", label: "Global defaults (all categories)" },
            ...categoryOptions(cats.data?.items ?? []),
          ]}
          hint={
            scope === "global"
              ? "Used when a category defines no filters of its own"
              : `Overrides for ${catName(scope)} (and subcategories that inherit)`
          }
        />
      </div>

      {errors.length > 0 && (
        <div className="alert-box" role="alert">
          <strong>Cannot save filters</strong>
          <ul>
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid-2">
        <Card
          title={`Filters for this scope (${groups.length})`}
          actions={
            canWrite && <Button onClick={() => setEditing(blankGroup())}>Add filter group</Button>
          }
        >
          {own.isLoading ? (
            <Spinner />
          ) : own.isError ? (
            <ErrorState error={own.error} retry={() => void own.refetch()} />
          ) : groups.length === 0 ? (
            <EmptyState
              title="No filters defined here"
              hint={
                scope === "global"
                  ? "Add a group to configure defaults."
                  : "This category inherits from its parents or the global defaults."
              }
            />
          ) : (
            <ol
              className="pg-sections"
              style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}
              aria-label="Filter groups"
            >
              {groups.map((g, i) => (
                <li
                  key={g.uid}
                  style={{
                    display: "flex",
                    gap: 8,
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    opacity: g.isEnabled ? 1 : 0.6,
                  }}
                >
                  <div>
                    <strong>{g.label}</strong>{" "}
                    {!g.isEnabled && <Badge tone="neutral">disabled</Badge>}
                    <div className="muted">
                      {describe(g)}
                      {!g.showDesktop && " · hidden on desktop"}
                      {!g.showMobile && " · hidden on mobile"}
                    </div>
                  </div>
                  {canWrite && (
                    <div className="g-actions">
                      <Button
                        aria-label={`Move ${g.label} up`}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        aria-label={`Move ${g.label} down`}
                        disabled={i === groups.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button onClick={() => setEditing(g)} aria-label={`Edit ${g.label}`}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => setToRemove(g)}
                        aria-label={`Remove ${g.label}`}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="Effective filters (what shoppers see)">
          {effective.isLoading ? (
            <Spinner />
          ) : effective.isError ? (
            <ErrorState error={effective.error} retry={() => void effective.refetch()} />
          ) : effective.data!.items.length === 0 ? (
            <p className="muted">No filters will be shown.</p>
          ) : (
            <ol aria-label="Effective filters">
              {effective.data!.items.map((g) => (
                <li key={g.id}>
                  {g.label} <span className="muted">({describe(g)})</span>
                  {scope !== "global" && (g.categoryId ?? null) !== scope && (
                    <Badge tone="info">{g.categoryId ? "inherited" : "global default"}</Badge>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="muted">Reflects saved changes only.</p>
        </Card>
      </div>

      {editing && (
        <GroupDialog
          group={editing}
          isNew={!groups.some((g) => g.uid === editing.uid)}
          onClose={() => setEditing(null)}
          onApply={(g) => {
            update(
              groups.some((x) => x.uid === g.uid)
                ? groups.map((x) => (x.uid === g.uid ? g : x))
                : [...groups, g],
            );
            setEditing(null);
          }}
        />
      )}
      {toRemove && (
        <ConfirmDialog
          danger
          title="Remove filter group"
          message={`Remove "${toRemove.label}"? The change applies when you save.`}
          confirmLabel="Remove"
          onCancel={() => setToRemove(null)}
          onConfirm={() => {
            update(groups.filter((g) => g.uid !== toRemove.uid));
            setToRemove(null);
          }}
        />
      )}
    </>
  );
}

function GroupDialog({
  group,
  isNew,
  onApply,
  onClose,
}: {
  group: FilterGroup;
  isNew: boolean;
  onApply: (g: FilterGroup) => void;
  onClose: () => void;
}) {
  const attrs = useAttributes();
  const [g, setG] = useState(group);
  const [labelTouched, setLabelTouched] = useState(!isNew);
  const [err, setErr] = useState<Record<string, string>>({});
  const set = (p: Partial<FilterGroup>) => setG((s) => ({ ...s, ...p }));

  function apply() {
    const e: Record<string, string> = {};
    if (!g.label.trim()) e.label = "Label is required";
    if (g.source === "ATTRIBUTE" && !g.attributeId) e.attributeId = "Choose an attribute";
    if (g.source === "PROPERTY" && !/^[A-Za-z0-9_-]{1,60}$/.test(g.propertyKey))
      e.propertyKey = "Letters, digits, _ and - only";
    setErr(e);
    if (!Object.keys(e).length) onApply(g);
  }

  return (
    <Modal
      title={isNew ? "Add filter group" : "Edit filter group"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            {isNew ? "Add" : "Apply"}
          </Button>
        </>
      }
    >
      <div className="g-stack">
        <SelectField
          label="Source"
          value={g.source}
          onChange={(e) => {
            const source = e.target.value as FilterSource;
            const def = SOURCES.find((s) => s.value === source)!.defaultLabel;
            set({
              source,
              ...(!labelTouched && def ? { label: def } : {}),
              ...(source === "PRICE" || source === "STOCK" ? { multiSelect: false } : {}),
            });
          }}
          options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
        />
        {g.source === "ATTRIBUTE" && (
          <SelectField
            label="Attribute"
            value={g.attributeId}
            onChange={(e) => {
              const a = attrs.data?.items.find((x) => x.id === e.target.value);
              set({
                attributeId: e.target.value,
                ...(!labelTouched && a ? { label: a.name } : {}),
              });
            }}
            options={[
              { value: "", label: "Choose an attribute…" },
              ...(attrs.data?.items ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
            error={err.attributeId}
          />
        )}
        {g.source === "PROPERTY" && (
          <TextField
            label="Property key"
            value={g.propertyKey}
            onChange={(e) => set({ propertyKey: e.target.value })}
            error={err.propertyKey}
            hint="Key of the product property to filter on, e.g. material"
          />
        )}
        <TextField
          label="Label"
          value={g.label}
          maxLength={80}
          onChange={(e) => {
            setLabelTouched(true);
            set({ label: e.target.value });
          }}
          error={err.label}
        />
        <CheckField
          label="Enabled"
          checked={g.isEnabled}
          onChange={(e) => set({ isEnabled: e.target.checked })}
        />
        <CheckField
          label="Open by default"
          checked={g.defaultOpen}
          onChange={(e) => set({ defaultOpen: e.target.checked })}
        />
        <CheckField
          label="Allow selecting multiple values"
          checked={g.multiSelect}
          onChange={(e) => set({ multiSelect: e.target.checked })}
        />
        <CheckField
          label="Show on desktop"
          checked={g.showDesktop}
          onChange={(e) => set({ showDesktop: e.target.checked })}
        />
        <CheckField
          label="Show on mobile"
          checked={g.showMobile}
          onChange={(e) => set({ showMobile: e.target.checked })}
        />
        <CheckField
          label="Inherit to subcategories"
          checked={g.inheritToChildren}
          onChange={(e) => set({ inheritToChildren: e.target.checked })}
        />
      </div>
    </Modal>
  );
}
