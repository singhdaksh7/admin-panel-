import { useState } from "react";
import { MediaPicker, MediaThumb } from "../../components/MediaPicker";
import {
  Badge,
  Button,
  CheckField,
  ConfirmDialog,
  DataTable,
  Modal,
  SelectField,
  TextField,
  useToast,
} from "../../components/ui";
import { DECIMAL, ErrorSummary, applyApiError, useMoney } from "./kit";
import type { Attribute, Variant } from "./types";

export interface VariantDraft {
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  cost: string;
  weightGrams: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  imageMediaId: string;
  isActive: boolean;
  /** attributeId -> valueId ("" = none) */
  attrs: Record<string, string>;
  stock: string;
  trackInventory: boolean;
}

export const emptyVariant = (): VariantDraft => ({
  sku: "",
  barcode: "",
  price: "",
  compareAtPrice: "",
  cost: "",
  weightGrams: "",
  lengthMm: "",
  widthMm: "",
  heightMm: "",
  imageMediaId: "",
  isActive: true,
  attrs: {},
  stock: "0",
  trackInventory: true,
});

export function draftFromVariant(v: Variant): VariantDraft {
  return {
    sku: v.sku,
    barcode: v.barcode ?? "",
    price: v.price,
    compareAtPrice: v.compareAtPrice ?? "",
    cost: v.cost ?? "",
    weightGrams: v.weightGrams?.toString() ?? "",
    lengthMm: v.lengthMm?.toString() ?? "",
    widthMm: v.widthMm?.toString() ?? "",
    heightMm: v.heightMm?.toString() ?? "",
    imageMediaId: v.imageMediaId ?? "",
    isActive: v.isActive,
    attrs: Object.fromEntries(v.attributes.map((a) => [a.attributeId, a.valueId])),
    stock: v.inventory?.onHand.toString() ?? "0",
    trackInventory: v.inventory?.trackInventory ?? true,
  };
}

const intOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

/** Request body for POST/PATCH variant endpoints (`stock` fields only for creates). */
export function variantPayload(d: VariantDraft, withStock: boolean) {
  const base = {
    sku: d.sku.trim(),
    barcode: d.barcode.trim() || null,
    price: d.price.trim(),
    compareAtPrice: d.compareAtPrice.trim() || null,
    cost: d.cost.trim() || null,
    weightGrams: intOrNull(d.weightGrams),
    lengthMm: intOrNull(d.lengthMm),
    widthMm: intOrNull(d.widthMm),
    heightMm: intOrNull(d.heightMm),
    imageMediaId: d.imageMediaId || null,
    isActive: d.isActive,
    attributeValueIds: Object.values(d.attrs).filter(Boolean),
  };
  return withStock
    ? { ...base, stock: Number(d.stock || 0), trackInventory: d.trackInventory }
    : base;
}

export function validateVariant(d: VariantDraft, withStock: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.sku.trim()) e.sku = "SKU is required";
  else if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(d.sku.trim()))
    e.sku = "Letters, digits and . _ - / only";
  if (!DECIMAL.test(d.price.trim())) e.price = "Enter a price like 12.50";
  if (d.compareAtPrice.trim()) {
    if (!DECIMAL.test(d.compareAtPrice.trim())) e.compareAtPrice = "Enter a price like 12.50";
    else if (DECIMAL.test(d.price.trim()) && Number(d.compareAtPrice) < Number(d.price))
      e.compareAtPrice = "Must be at least the price";
  }
  if (d.cost.trim() && !DECIMAL.test(d.cost.trim())) e.cost = "Enter an amount like 8.00";
  for (const k of ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const)
    if (d[k].trim() && !/^\d+$/.test(d[k].trim())) e[k] = "Whole number";
  if (withStock && !/^\d+$/.test(d.stock.trim() || "0")) e.stock = "Whole number";
  return e;
}

export function comboOf(d: VariantDraft): string {
  return Object.values(d.attrs).filter(Boolean).sort().join("|");
}

function VariantDialog({
  title,
  initial,
  attributes,
  withStock,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: VariantDraft;
  attributes: Attribute[];
  withStock: boolean;
  onSubmit: (d: VariantDraft) => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const toast = useToast();
  const set = <K extends keyof VariantDraft>(k: K, v: VariantDraft[K]) =>
    setD((x) => ({ ...x, [k]: v }));

  async function save() {
    const errs = validateVariant(d, withStock);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await onSubmit(d);
    } catch (err) {
      applyApiError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }
  const text = (k: keyof VariantDraft, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={d[k] as string}
      onChange={(e) => set(k, e.target.value as never)}
      error={errors[k]}
      {...extra}
    />
  );
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save variant
          </Button>
        </>
      }
    >
      <ErrorSummary
        errors={Object.fromEntries(Object.entries(errors).filter(([k]) => !(k in d)))}
      />
      {attributes.length > 0 && (
        <div className="ops-grid-3">
          {attributes.map((a) => (
            <SelectField
              key={a.id}
              label={a.name}
              value={d.attrs[a.id] ?? ""}
              onChange={(e) => set("attrs", { ...d.attrs, [a.id]: e.target.value })}
              options={[
                { value: "", label: "— none —" },
                ...a.values.map((v) => ({ value: v.id, label: v.value })),
              ]}
            />
          ))}
        </div>
      )}
      <div className="ops-grid-2">
        {text("sku", "SKU")}
        {text("barcode", "Barcode")}
        {text("price", "Price", { inputMode: "decimal" })}
        {text("compareAtPrice", "Compare-at price", { inputMode: "decimal" })}
        {text("cost", "Cost", { inputMode: "decimal" })}
        {withStock && text("stock", "Initial stock", { inputMode: "numeric" })}
      </div>
      <div className="ops-grid-4">
        {text("weightGrams", "Weight (g)", { inputMode: "numeric" })}
        {text("lengthMm", "Length (mm)", { inputMode: "numeric" })}
        {text("widthMm", "Width (mm)", { inputMode: "numeric" })}
        {text("heightMm", "Height (mm)", { inputMode: "numeric" })}
      </div>
      <div className="ops-cell">
        <MediaThumb id={d.imageMediaId} />
        <Button onClick={() => setPick(true)}>
          {d.imageMediaId ? "Change variant image" : "Choose variant image"}
        </Button>
        {d.imageMediaId && (
          <Button variant="ghost" onClick={() => set("imageMediaId", "")}>
            Remove
          </Button>
        )}
      </div>
      <CheckField
        label="Enabled (sellable)"
        checked={d.isActive}
        onChange={(e) => set("isActive", e.target.checked)}
      />
      {withStock && (
        <CheckField
          label="Track inventory"
          checked={d.trackInventory}
          onChange={(e) => set("trackInventory", e.target.checked)}
        />
      )}
      {pick && (
        <MediaPicker
          onClose={() => setPick(false)}
          onSelect={(items) => {
            set("imageMediaId", items[0]!.id);
            setPick(false);
          }}
        />
      )}
    </Modal>
  );
}

export interface VariantRow {
  key: string;
  draft: VariantDraft;
  stock: number | null;
  isDefault?: boolean;
}

/**
 * Variant table + add/edit dialog + delete confirm. Persistence is delegated to the parent so the
 * same UI serves the create form (local state) and the edit page (live API calls).
 */
export function VariantsManager({
  rows,
  attributes,
  canWrite,
  stockOnAdd,
  onSubmit,
  onDelete,
}: {
  rows: VariantRow[];
  attributes: Attribute[];
  canWrite: boolean;
  /** show an initial-stock field when creating a variant */
  stockOnAdd: boolean;
  onSubmit: (draft: VariantDraft, key: string | null) => Promise<unknown> | void;
  onDelete: (key: string) => Promise<unknown>;
}) {
  const fmt = useMoney();
  const [editing, setEditing] = useState<{ key: string | null; draft: VariantDraft } | null>(null);
  const [deleting, setDeleting] = useState<VariantRow | null>(null);
  const variantAttrs = attributes.filter((a) => a.usedForVariants);
  const label = (r: VariantRow) =>
    variantAttrs
      .map((a) => a.values.find((v) => v.id === r.draft.attrs[a.id])?.value)
      .filter(Boolean)
      .join(" / ") || "Default";

  return (
    <div>
      <p className="ops-hint">
        When a product has more than one variant, every variant must be given at least one attribute
        value (for example Size or Colour) and each combination must be unique. Mark attributes as
        &quot;used for variants&quot; in the Attributes screen to make them available here.
      </p>
      {variantAttrs.length === 0 && (
        <p className="muted">No variant attributes exist yet. Create one under Attributes.</p>
      )}
      {rows.length > 0 && (
        <DataTable
          caption="Variants"
          rows={rows}
          rowKey={(r) => r.key}
          columns={[
            { key: "v", header: "Variant", render: (r) => label(r) },
            { key: "sku", header: "SKU", render: (r) => r.draft.sku },
            { key: "price", header: "Price", render: (r) => fmt(r.draft.price) },
            {
              key: "stock",
              header: "Stock",
              render: (r) => (r.stock === null ? "—" : r.stock),
            },
            {
              key: "on",
              header: "Status",
              render: (r) =>
                r.draft.isActive ? <Badge tone="success">enabled</Badge> : <Badge>disabled</Badge>,
            },
            {
              key: "act",
              header: "",
              render: (r) =>
                canWrite && (
                  <div className="ops-actions">
                    <Button
                      aria-label={`Edit variant ${r.draft.sku}`}
                      onClick={() => setEditing({ key: r.key, draft: r.draft })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={`Delete variant ${r.draft.sku}`}
                      disabled={rows.length <= 1}
                      onClick={() => setDeleting(r)}
                    >
                      Delete
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      )}
      {canWrite && (
        <p>
          <Button onClick={() => setEditing({ key: null, draft: emptyVariant() })}>
            Add variant
          </Button>
        </p>
      )}
      {editing && (
        <VariantDialog
          title={editing.key ? "Edit variant" : "Add variant"}
          initial={editing.draft}
          attributes={variantAttrs}
          withStock={stockOnAdd && !editing.key}
          onClose={() => setEditing(null)}
          onSubmit={async (d) => {
            await onSubmit(d, editing.key);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title="Delete variant"
          message={`Delete variant ${deleting.draft.sku}? Variants with order history cannot be deleted; disable them instead.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await onDelete(deleting.key);
              setDeleting(null);
            } catch {
              /* parent toasts */
            }
          }}
        />
      )}
    </div>
  );
}
