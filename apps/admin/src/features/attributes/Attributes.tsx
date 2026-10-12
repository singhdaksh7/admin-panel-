import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
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
  TextField,
  useToast,
} from "../../components/ui";
import { ErrorSummary, ListState, applyApiError } from "../products/kit";
import { useAttributes, type Attribute } from "../products/types";

function ValuesManager({ attributeId, canWrite }: { attributeId: string; canWrite: boolean }) {
  const q = useAttributes();
  const qc = useQueryClient();
  const toast = useToast();
  const attr = q.data?.items.find((a) => a.id === attributeId);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newValue, setNewValue] = useState("");
  const [err, setErr] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: ["attributes"] });

  const add = useMutation({
    mutationFn: () => api.post(`/attributes/${attributeId}/values`, { value: newValue.trim() }),
    onSuccess: () => {
      setNewValue("");
      void refresh();
    },
    onError: (e) => applyApiError(e, (fe) => setErr(Object.values(fe)[0]), toast),
  });
  const rename = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api.patch(`/attribute-values/${id}`, { value }),
    onSuccess: (_r, v) => {
      setDraft((d) => {
        const n = { ...d };
        delete n[v.id];
        return n;
      });
      toast.success("Value renamed");
      void refresh();
    },
    onError: (e) => toast.error(e),
  });
  const [removing, setRemoving] = useState<{ id: string; value: string } | null>(null);

  if (!attr) return null;
  return (
    <div>
      <h3>Values</h3>
      {attr.values.length === 0 && <p className="muted">No values yet.</p>}
      <ul className="plain" style={{ listStyle: "none", padding: 0 }}>
        {attr.values.map((v) => {
          const cur = draft[v.id] ?? v.value;
          return (
            <li key={v.id} className="ops-inline-form" style={{ marginBottom: 6 }}>
              <input
                aria-label={`Value ${v.value}`}
                value={cur}
                disabled={!canWrite}
                onChange={(e) => setDraft((d) => ({ ...d, [v.id]: e.target.value }))}
              />
              {canWrite && (
                <>
                  <Button
                    disabled={cur.trim() === v.value || !cur.trim()}
                    loading={rename.isPending && rename.variables?.id === v.id}
                    onClick={() => rename.mutate({ id: v.id, value: cur.trim() })}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Delete value ${v.value}`}
                    onClick={() => setRemoving({ id: v.id, value: v.value })}
                  >
                    Delete
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {canWrite && (
        <div className="ops-inline-form">
          <TextField
            label="New value"
            value={newValue}
            error={err}
            onChange={(e) => {
              setNewValue(e.target.value);
              setErr(undefined);
            }}
          />
          <Button
            variant="primary"
            loading={add.isPending}
            onClick={() => {
              if (!newValue.trim()) return setErr("Value is required");
              add.mutate();
            }}
          >
            Add value
          </Button>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          danger
          title="Delete value"
          message={`Delete value "${removing.value}"? Values used by products cannot be deleted.`}
          confirmLabel="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/attribute-values/${removing.id}`);
              toast.success("Value deleted");
              await refresh();
            } catch (e) {
              toast.error(e);
            }
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function AttributeDialog({
  attribute,
  onClose,
}: {
  attribute: Attribute | null;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const canWrite = can("attributes.write");
  const toast = useToast();
  const qc = useQueryClient();
  const [created, setCreated] = useState<Attribute | null>(null);
  const current = attribute ?? created;
  const [f, setF] = useState({
    name: attribute?.name ?? "",
    slug: attribute?.slug ?? "",
    type: attribute?.type ?? "TEXT",
    usedForVariants: attribute?.usedForVariants ?? false,
    isFilterable: attribute?.isFilterable ?? true,
    values: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        ...(f.slug.trim() ? { slug: f.slug.trim() } : {}),
        type: f.type,
        usedForVariants: f.usedForVariants,
        isFilterable: f.isFilterable,
      };
      if (current) return api.patch<Attribute>(`/attributes/${current.id}`, body);
      const values = f.values
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((value) => ({ value }));
      return api.post<Attribute>("/attributes", { ...body, ...(values.length ? { values } : {}) });
    },
    onSuccess: (a) => {
      toast.success(current ? "Attribute saved" : "Attribute created");
      void qc.invalidateQueries({ queryKey: ["attributes"] });
      if (!current) setCreated(a);
      else onClose();
    },
    onError: (e) => applyApiError(e, setErrors, toast),
  });

  function submit() {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = "Name is required";
    if (f.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug.trim()))
      e.slug = "Lowercase letters, digits and hyphens only";
    setErrors(e);
    if (!Object.keys(e).length) save.mutate();
  }

  return (
    <Modal
      title={current ? `Attribute: ${current.name}` : "New attribute"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{current && !attribute ? "Done" : "Close"}</Button>
          {canWrite && (
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              {current ? "Save attribute" : "Create attribute"}
            </Button>
          )}
        </>
      }
    >
      <ErrorSummary
        errors={Object.fromEntries(Object.entries(errors).filter(([k]) => !(k in f)))}
      />
      <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0 }}>
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
            onChange={(e) => setF({ ...f, type: e.target.value as Attribute["type"] })}
            options={[
              { value: "TEXT", label: "Text" },
              { value: "COLOR", label: "Colour" },
              { value: "NUMBER", label: "Number" },
            ]}
          />
        </div>
        <CheckField
          label="Used for variants (e.g. size, colour)"
          checked={f.usedForVariants}
          onChange={(e) => setF({ ...f, usedForVariants: e.target.checked })}
        />
        <CheckField
          label="Show as a storefront filter"
          checked={f.isFilterable}
          onChange={(e) => setF({ ...f, isFilterable: e.target.checked })}
        />
        {!current && (
          <TextField
            label="Initial values"
            hint="Comma separated, e.g. Small, Medium, Large"
            value={f.values}
            onChange={(e) => setF({ ...f, values: e.target.value })}
          />
        )}
      </fieldset>
      {current && <ValuesManager attributeId={current.id} canWrite={canWrite} />}
    </Modal>
  );
}

export function Attributes() {
  const q = useAttributes();
  const [editing, setEditing] = useState<Attribute | "new" | null>(null);
  const [deleting, setDeleting] = useState<Attribute | null>(null);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Attributes"
        subtitle="Product options and filterable properties"
        actions={
          <Can perm="attributes.write">
            <Button variant="primary" onClick={() => setEditing("new")}>
              New attribute
            </Button>
          </Can>
        }
      />
      <ListState
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        retry={() => void q.refetch()}
        empty={
          q.data && items.length === 0 ? (
            <EmptyState title="No attributes yet" hint="Create one, such as Size or Colour." />
          ) : undefined
        }
      >
        <DataTable
          caption="Attributes"
          rows={items}
          rowKey={(a) => a.id}
          columns={[
            { key: "n", header: "Name", render: (a) => <strong>{a.name}</strong> },
            { key: "t", header: "Type", render: (a) => a.type.toLowerCase() },
            {
              key: "f",
              header: "Flags",
              render: (a) => (
                <>
                  {a.usedForVariants && <Badge tone="info">variants</Badge>}{" "}
                  {a.isFilterable && <Badge>filter</Badge>}
                </>
              ),
            },
            {
              key: "v",
              header: "Values",
              render: (a) =>
                a.values
                  .slice(0, 6)
                  .map((v) => v.value)
                  .join(", ") + (a.values.length > 6 ? "…" : ""),
            },
            {
              key: "a",
              header: "",
              render: (a) => (
                <div className="ops-actions">
                  <Button aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                    {can("attributes.write") ? "Edit" : "View"}
                  </Button>
                  {can("attributes.write") && (
                    <Button
                      variant="danger"
                      aria-label={`Delete ${a.name}`}
                      onClick={() => setDeleting(a)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </ListState>
      {editing && (
        <AttributeDialog
          attribute={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title="Delete attribute"
          message={`Delete "${deleting.name}" and all of its values? Attributes used by products cannot be deleted.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/attributes/${deleting.id}`);
              toast.success("Attribute deleted");
              void qc.invalidateQueries({ queryKey: ["attributes"] });
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
