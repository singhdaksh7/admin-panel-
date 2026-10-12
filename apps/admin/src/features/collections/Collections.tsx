import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import { MediaPicker, MediaThumb } from "../../components/MediaPicker";
import {
  Badge,
  Button,
  CheckField,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Modal,
  PageHeader,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  useDebounced,
  useToast,
  SearchBox,
} from "../../components/ui";
import { DECIMAL, ErrorSummary, ListState, applyApiError, flattenTree } from "../products/kit";
import { useCategoryTree, useCollectionsList, type ProductListItem } from "../products/types";

type Collection = NonNullable<ReturnType<typeof useCollectionsList>["data"]>["items"][number];

interface Cond {
  field: "category" | "tag" | "brand" | "featured" | "price" | "attribute";
  op: "gte" | "lte" | "eq";
  value: string;
  attribute: string;
}

const FIELD_LABEL: Record<Cond["field"], string> = {
  category: "Category",
  tag: "Tag",
  brand: "Brand",
  featured: "Featured",
  price: "Price",
  attribute: "Attribute",
};

function condsFromRules(rules: unknown): { match: "all" | "any"; conds: Cond[] } {
  const r = rules as { match?: "all" | "any"; conditions?: Record<string, unknown>[] } | null;
  if (!r?.conditions)
    return { match: "all", conds: [{ field: "category", op: "eq", value: "", attribute: "" }] };
  return {
    match: r.match ?? "all",
    conds: r.conditions.map((c) => ({
      field: c.field as Cond["field"],
      op: (c.op as Cond["op"]) ?? "eq",
      value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? ""),
      attribute: (c.attribute as string) ?? "",
    })),
  };
}

const asList = (v: string) => {
  const l = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return l.length === 1 ? l[0]! : l;
};

function condPayload(c: Cond) {
  switch (c.field) {
    case "featured":
      return { field: "featured", value: c.value === "true" };
    case "price":
      return { field: "price", op: c.op, value: c.value.trim() };
    case "attribute":
      return { field: "attribute", attribute: c.attribute.trim(), value: asList(c.value) };
    default:
      return { field: c.field, value: asList(c.value) };
  }
}

function RuleBuilder({
  match,
  conds,
  onChange,
  errors,
}: {
  match: "all" | "any";
  conds: Cond[];
  onChange: (m: "all" | "any", c: Cond[]) => void;
  errors: Record<string, string>;
}) {
  const cats = useCategoryTree();
  const update = (i: number, patch: Partial<Cond>) =>
    onChange(
      match,
      conds.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    );
  return (
    <div role="group" aria-label="Rules">
      <SelectField
        label="Products must match"
        value={match}
        onChange={(e) => onChange(e.target.value as "all" | "any", conds)}
        options={[
          { value: "all", label: "all of the conditions" },
          { value: "any", label: "any of the conditions" },
        ]}
      />
      {conds.map((c, i) => (
        <div className="ops-cond" key={i}>
          <SelectField
            label="Field"
            value={c.field}
            onChange={(e) => update(i, { field: e.target.value as Cond["field"], value: "" })}
            options={(Object.keys(FIELD_LABEL) as Cond["field"][]).map((k) => ({
              value: k,
              label: FIELD_LABEL[k],
            }))}
          />
          {c.field === "price" ? (
            <SelectField
              label="Operator"
              value={c.op}
              onChange={(e) => update(i, { op: e.target.value as Cond["op"] })}
              options={[
                { value: "gte", label: "at least" },
                { value: "lte", label: "at most" },
                { value: "eq", label: "equals" },
              ]}
            />
          ) : (
            <div />
          )}
          <div>
            {c.field === "attribute" && (
              <TextField
                label="Attribute slug"
                value={c.attribute}
                onChange={(e) => update(i, { attribute: e.target.value })}
                error={errors[`conditions.${i}.attribute`]}
              />
            )}
            {c.field === "featured" ? (
              <SelectField
                label="Value"
                value={c.value || "true"}
                onChange={(e) => update(i, { value: e.target.value })}
                options={[
                  { value: "true", label: "Featured" },
                  { value: "false", label: "Not featured" },
                ]}
              />
            ) : c.field === "category" ? (
              <SelectField
                label="Category"
                value={c.value}
                onChange={(e) => update(i, { value: e.target.value })}
                error={errors[`conditions.${i}.value`]}
                options={[
                  { value: "", label: "— choose —" },
                  ...flattenTree(cats.data?.items ?? []).map((k) => ({
                    value: k.slug,
                    label: `${"— ".repeat(k.depth)}${k.name}`,
                  })),
                ]}
              />
            ) : (
              <TextField
                label={c.field === "price" ? "Amount" : "Value(s), comma separated"}
                value={c.value}
                onChange={(e) => update(i, { value: e.target.value })}
                error={errors[`conditions.${i}.value`]}
              />
            )}
          </div>
          <Button
            aria-label={`Remove condition ${i + 1}`}
            disabled={conds.length <= 1}
            onClick={() =>
              onChange(
                match,
                conds.filter((_, j) => j !== i),
              )
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        onClick={() =>
          onChange(match, [...conds, { field: "tag", op: "eq", value: "", attribute: "" }])
        }
      >
        Add condition
      </Button>
    </div>
  );
}

function CollectionDialog({
  collection,
  onClose,
}: {
  collection: Collection | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const initial = condsFromRules(collection?.rules);
  const [f, setF] = useState({
    name: collection?.name ?? "",
    slug: collection?.slug ?? "",
    description: collection?.description ?? "",
    type: collection?.type ?? ("MANUAL" as "MANUAL" | "RULE"),
    imageMediaId: collection?.imageMediaId ?? "",
    sortOrder: String(collection?.sortOrder ?? 0),
    isActive: collection?.isActive ?? true,
  });
  const [match, setMatch] = useState(initial.match);
  const [conds, setConds] = useState(initial.conds);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pick, setPick] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        ...(f.slug.trim() ? { slug: f.slug.trim() } : {}),
        description: f.description.trim() || null,
        type: f.type,
        imageMediaId: f.imageMediaId || null,
        sortOrder: Number(f.sortOrder || 0),
        isActive: f.isActive,
        rules: f.type === "RULE" ? { match, conditions: conds.map(condPayload) } : null,
      };
      return collection
        ? api.patch(`/collections/${collection.id}`, body)
        : api.post("/collections", body);
    },
    onSuccess: () => {
      toast.success(collection ? "Collection saved" : "Collection created");
      void qc.invalidateQueries({ queryKey: ["collections"] });
      onClose();
    },
    onError: (e) => applyApiError(e, setErrors, toast),
  });

  function submit() {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = "Name is required";
    if (f.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug.trim()))
      e.slug = "Lowercase letters, digits and hyphens only";
    if (!/^-?\d+$/.test(f.sortOrder.trim() || "0")) e.sortOrder = "Whole number";
    if (f.type === "RULE")
      conds.forEach((c, i) => {
        if (c.field === "featured") return;
        if (!c.value.trim()) e[`conditions.${i}.value`] = "Value is required";
        else if (c.field === "price" && !DECIMAL.test(c.value.trim()))
          e[`conditions.${i}.value`] = "Enter an amount like 25.00";
        if (c.field === "attribute" && !c.attribute.trim())
          e[`conditions.${i}.attribute`] = "Attribute slug is required";
      });
    setErrors(e);
    if (!Object.keys(e).length) save.mutate();
  }

  return (
    <Modal
      title={collection ? `Edit ${collection.name}` : "New collection"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save collection
          </Button>
        </>
      }
    >
      <ErrorSummary
        errors={Object.fromEntries(
          Object.entries(errors).filter(([k]) => !(k in f) && !k.startsWith("conditions")),
        )}
      />
      <div className="ops-grid-2">
        <TextField
          label="Name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          error={errors.name}
        />
        <TextField
          label="Slug"
          hint="Generated if blank"
          value={f.slug}
          onChange={(e) => setF({ ...f, slug: e.target.value })}
          error={errors.slug}
        />
        <SelectField
          label="Type"
          value={f.type}
          onChange={(e) => setF({ ...f, type: e.target.value as "MANUAL" | "RULE" })}
          options={[
            { value: "MANUAL", label: "Manual - pick products" },
            { value: "RULE", label: "Rule based - automatic" },
          ]}
        />
        <TextField
          label="Sort order"
          inputMode="numeric"
          value={f.sortOrder}
          onChange={(e) => setF({ ...f, sortOrder: e.target.value })}
          error={errors.sortOrder}
        />
      </div>
      <TextArea
        label="Description"
        rows={3}
        value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })}
      />
      <div className="ops-cell">
        <MediaThumb id={f.imageMediaId} size={56} />
        <Button onClick={() => setPick(true)}>
          {f.imageMediaId ? "Change image" : "Choose image"}
        </Button>
        {f.imageMediaId && (
          <Button variant="ghost" onClick={() => setF({ ...f, imageMediaId: "" })}>
            Remove
          </Button>
        )}
      </div>
      <CheckField
        label="Active"
        checked={f.isActive}
        onChange={(e) => setF({ ...f, isActive: e.target.checked })}
      />
      {f.type === "RULE" && (
        <RuleBuilder
          match={match}
          conds={conds}
          errors={errors}
          onChange={(m, c) => {
            setMatch(m);
            setConds(c);
          }}
        />
      )}
      {f.type === "MANUAL" && collection && collection.type === "RULE" && (
        <p className="ops-hint">Switching to manual removes the rules; add products afterwards.</p>
      )}
      {pick && (
        <MediaPicker
          onClose={() => setPick(false)}
          onSelect={(items) => {
            setF({ ...f, imageMediaId: items[0]!.id });
            setPick(false);
          }}
        />
      )}
    </Modal>
  );
}

interface Member {
  id: string;
  title: string;
  slug: string;
  status: string;
  position?: number;
}

function MembersDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const { can } = useAuth();
  const canWrite = can("collections.write");
  const toast = useToast();
  const qc = useQueryClient();
  const isManual = collection.type === "MANUAL";
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const members = useQuery({
    queryKey: ["collection-products", collection.id],
    queryFn: () =>
      api.get<Paginated<Member>>(`/collections/${collection.id}/products`, { pageSize: 100 }),
  });
  const results = useQuery({
    queryKey: ["product-search", q],
    queryFn: () => api.get<Paginated<ProductListItem>>("/products", { q, pageSize: 8 }),
    enabled: isManual && canWrite && q.trim().length > 1,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["collection-products", collection.id] });
    void qc.invalidateQueries({ queryKey: ["collections"] });
  };
  const add = useMutation({
    mutationFn: (id: string) =>
      api.post(`/collections/${collection.id}/products`, { productIds: [id] }),
    onSuccess: () => {
      toast.success("Product added");
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/collections/${collection.id}/products/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });
  const reorder = useMutation({
    mutationFn: ({ i, dir }: { i: number; dir: -1 | 1 }) => {
      const ids = (members.data?.items ?? []).map((m) => m.id);
      [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
      return api.put(`/collections/${collection.id}/products/order`, { productIds: ids });
    },
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });
  const items = members.data?.items ?? [];
  const memberIds = new Set(items.map((m) => m.id));

  return (
    <Modal
      title={`Products in ${collection.name}`}
      wide
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {!isManual && (
        <p className="ops-hint">
          This is a rule-based collection: the products below are computed from its rules and cannot
          be edited by hand.
        </p>
      )}
      {isManual && canWrite && (
        <div>
          <SearchBox value={search} onChange={setSearch} placeholder="Search products to add" />
          {results.data && (
            <ul className="plain" style={{ listStyle: "none", padding: 0 }}>
              {results.data.items.map((p) => (
                <li key={p.id} className="ops-inline-form" style={{ margin: "4px 0" }}>
                  <span>{p.title}</span>
                  <Button
                    disabled={memberIds.has(p.id)}
                    loading={add.isPending && add.variables === p.id}
                    onClick={() => add.mutate(p.id)}
                    aria-label={`Add ${p.title}`}
                  >
                    {memberIds.has(p.id) ? "Added" : "Add"}
                  </Button>
                </li>
              ))}
              {results.data.items.length === 0 && <li className="muted">No matching products.</li>}
            </ul>
          )}
        </div>
      )}
      <ListState
        isLoading={members.isLoading}
        isError={members.isError}
        error={members.error}
        retry={() => void members.refetch()}
        empty={members.data && items.length === 0 ? <EmptyState title="No products" /> : undefined}
      >
        <DataTable
          caption="Collection products"
          rows={items}
          rowKey={(m) => m.id}
          columns={[
            { key: "t", header: "Product", render: (m) => m.title },
            { key: "s", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
            {
              key: "a",
              header: "",
              render: (m) => {
                const i = items.findIndex((x) => x.id === m.id);
                return (
                  isManual &&
                  canWrite && (
                    <div className="ops-actions">
                      <Button
                        aria-label={`Move ${m.title} up`}
                        disabled={i === 0 || reorder.isPending}
                        onClick={() => reorder.mutate({ i, dir: -1 })}
                      >
                        ↑
                      </Button>
                      <Button
                        aria-label={`Move ${m.title} down`}
                        disabled={i === items.length - 1 || reorder.isPending}
                        onClick={() => reorder.mutate({ i, dir: 1 })}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="danger"
                        aria-label={`Remove ${m.title}`}
                        onClick={() => remove.mutate(m.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  )
                );
              },
            },
          ]}
        />
      </ListState>
    </Modal>
  );
}

export function Collections() {
  const q = useCollectionsList();
  const { can } = useAuth();
  const canWrite = can("collections.write");
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Collection | "new" | null>(null);
  const [members, setMembers] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Collections"
        subtitle="Curated or rule-based product groups"
        actions={
          <Can perm="collections.write">
            <Button variant="primary" onClick={() => setEditing("new")}>
              New collection
            </Button>
          </Can>
        }
      />
      <ListState
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        retry={() => void q.refetch()}
        empty={q.data && items.length === 0 ? <EmptyState title="No collections yet" /> : undefined}
      >
        <DataTable
          caption="Collections"
          rows={items}
          rowKey={(c) => c.id}
          columns={[
            { key: "n", header: "Name", render: (c) => <strong>{c.name}</strong> },
            {
              key: "t",
              header: "Type",
              render: (c) =>
                c.type === "RULE" ? <Badge tone="info">rule</Badge> : <Badge>manual</Badge>,
            },
            {
              key: "p",
              header: "Products",
              render: (c) => (c.type === "MANUAL" ? c.manualProductCount : "auto"),
            },
            {
              key: "s",
              header: "Status",
              render: (c) =>
                c.isActive ? <Badge tone="success">active</Badge> : <Badge>hidden</Badge>,
            },
            {
              key: "a",
              header: "",
              render: (c) => (
                <div className="ops-actions">
                  <Button aria-label={`Products of ${c.name}`} onClick={() => setMembers(c)}>
                    Products
                  </Button>
                  {canWrite && (
                    <>
                      <Button aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => setDeleting(c)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </ListState>
      {editing && (
        <CollectionDialog
          collection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {members && <MembersDialog collection={members} onClose={() => setMembers(null)} />}
      {deleting && (
        <ConfirmDialog
          danger
          title="Delete collection"
          message={`Delete "${deleting.name}"? Products are not deleted.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/collections/${deleting.id}`);
              toast.success("Collection deleted");
              void qc.invalidateQueries({ queryKey: ["collections"] });
            } catch (e) {
              toast.error(e);
            }
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}
