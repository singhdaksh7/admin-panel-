import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Spinner,
  TextArea,
  TextField,
  useToast,
} from "../../components/ui";
import { handleSaveError, type FieldErrors } from "../media/shared";
import { useRoles } from "../users/Users";
import "./roles.css";

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
}

/** Group "area.action" permission keys by area, preserving first-seen order. */
export function groupPermissions(all: string[]): { area: string; perms: string[] }[] {
  const map = new Map<string, string[]>();
  for (const p of all) {
    const area = p.split(".")[0]!;
    map.set(area, [...(map.get(area) ?? []), p]);
  }
  return [...map.entries()].map(([area, perms]) => ({ area, perms }));
}

export function Roles() {
  const { can } = useAuth();
  const canManage = can("roles.manage");
  const toast = useToast();
  const qc = useQueryClient();
  const q = useRoles();
  const [dialog, setDialog] = useState<{ role?: Role } | null>(null);
  const [toDelete, setToDelete] = useState<Role | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["roles"] });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const { items, allPermissions } = q.data!;

  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="Control what each kind of admin can see and do"
        actions={
          <Can perm="roles.manage">
            <Button variant="primary" onClick={() => setDialog({})}>
              New custom role
            </Button>
          </Can>
        }
      />
      {items.length === 0 ? (
        <EmptyState title="No roles" />
      ) : (
        <DataTable
          caption="Roles"
          rows={items as Role[]}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "name",
              header: "Role",
              render: (r) => (
                <>
                  <strong>{r.name}</strong> {r.isSystem && <Badge tone="info">system</Badge>}
                  <div className="muted">{r.description}</div>
                </>
              ),
            },
            { key: "users", header: "Users", render: (r) => r.userCount },
            { key: "perms", header: "Permissions", render: (r) => r.permissions.length },
            {
              key: "actions",
              header: "",
              render: (r) => (
                <span className="g-actions">
                  <Button
                    onClick={() => setDialog({ role: r })}
                    aria-label={`${r.isSystem || !canManage ? "View" : "Edit"} ${r.name}`}
                  >
                    {r.isSystem || !canManage ? "View" : "Edit"}
                  </Button>
                  {canManage && !r.isSystem && (
                    <Button
                      variant="danger"
                      onClick={() => setToDelete(r)}
                      aria-label={`Delete ${r.name}`}
                    >
                      Delete
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
      {dialog && (
        <RoleDialog
          role={dialog.role}
          all={allPermissions}
          readOnly={!canManage || !!dialog.role?.isSystem}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {toDelete && (
        <ConfirmDialog
          danger
          title="Delete role"
          message={`Delete the custom role "${toDelete.name}"? Roles assigned to users cannot be deleted.`}
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            try {
              await api.delete(`/roles/${toDelete.id}`);
              toast.success("Role deleted");
              refresh();
            } catch (e) {
              toast.error(e);
            }
            setToDelete(null);
          }}
        />
      )}
    </>
  );
}

function RoleDialog({
  role,
  all,
  readOnly,
  onClose,
  onSaved,
}: {
  role?: Role;
  all: string[];
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const groups = groupPermissions(all);

  const toggle = (p: string, on: boolean) =>
    setPerms((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = "Role name is required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        permissions: all.filter((p) => perms.includes(p)),
      };
      if (role) await api.put(`/roles/${role.id}`, body);
      else await api.post("/roles", body);
      toast.success(role ? "Role updated" : "Role created");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setErrors({ name: err.message });
      else handleSaveError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={
        role ? (readOnly ? `${role.name} (read-only)` : `Edit ${role.name}`) : "New custom role"
      }
      onClose={onClose}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="role-form" loading={busy}>
              {role ? "Save role" : "Create role"}
            </Button>
          </>
        )
      }
    >
      {role?.isSystem && (
        <p className="muted">System roles are managed by the platform and cannot be edited.</p>
      )}
      <form id="role-form" onSubmit={submit} noValidate className="g-stack">
        <fieldset
          disabled={readOnly}
          style={{ border: 0, padding: 0, margin: 0 }}
          className="g-stack"
        >
          <TextField
            label="Role name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
          />
          <TextArea
            label="Description"
            rows={2}
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errors.description}
          />
          <Card title={`Permissions (${perms.length} selected)`}>
            <div className="perm-matrix">
              {groups.map((g) => (
                <fieldset key={g.area} className="perm-group">
                  <legend>{g.area}</legend>
                  {g.perms.map((p) => (
                    <label key={p}>
                      <input
                        type="checkbox"
                        checked={perms.includes(p)}
                        onChange={(e) => toggle(p, e.target.checked)}
                      />{" "}
                      {p.slice(g.area.length + 1)}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </Card>
        </fieldset>
      </form>
    </Modal>
  );
}
