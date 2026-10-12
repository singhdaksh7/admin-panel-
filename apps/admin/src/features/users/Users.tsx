import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  CheckField,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  Spinner,
  TextField,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import { handleSaveError, type FieldErrors } from "../media/shared";

interface AdminRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roleId: string;
  role: { id: string; key: string; name: string };
}
interface RoleLite {
  id: string;
  key: string;
  name: string;
}

export function useRoles() {
  return useQuery({
    queryKey: ["roles"],
    queryFn: () =>
      api.get<{
        items: (RoleLite & {
          description: string | null;
          isSystem: boolean;
          userCount: number;
          permissions: string[];
        })[];
        allPermissions: string[];
      }>("/roles"),
  });
}

export function Users() {
  const { can, user: me } = useAuth();
  const canManage = can("users.manage");
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ user?: AdminRow } | null>(null);
  const [toggle, setToggle] = useState<AdminRow | null>(null);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["admin-users", q, page],
    queryFn: () => api.get<Paginated<AdminRow>>("/users", { q, page, pageSize: 20 }),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-users"] });

  return (
    <>
      <PageHeader
        title="Admin users"
        subtitle="People who can sign in to this admin panel"
        actions={
          <Can perm="users.manage">
            <Button variant="primary" onClick={() => setDialog({})}>
              New admin user
            </Button>
          </Can>
        }
      />
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search by name or email"
        />
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState title="No users found" />
      ) : (
        <>
          <DataTable
            caption="Admin users"
            rows={list.data!.items}
            rowKey={(u) => u.id}
            columns={[
              {
                key: "name",
                header: "Name",
                render: (u) => (
                  <>
                    <strong>{u.name}</strong>
                    {u.id === me?.id && (
                      <>
                        {" "}
                        <Badge tone="info">you</Badge>
                      </>
                    )}
                    <div className="muted">{u.email}</div>
                  </>
                ),
              },
              { key: "role", header: "Role", render: (u) => u.role.name },
              {
                key: "status",
                header: "Status",
                render: (u) => (
                  <Badge tone={u.isActive ? "success" : "neutral"}>
                    {u.isActive ? "active" : "inactive"}
                  </Badge>
                ),
              },
              { key: "login", header: "Last sign-in", render: (u) => formatDate(u.lastLoginAt) },
              {
                key: "actions",
                header: "",
                render: (u) =>
                  canManage ? (
                    <span className="g-actions">
                      <Button onClick={() => setDialog({ user: u })} aria-label={`Edit ${u.name}`}>
                        Edit
                      </Button>
                      <Button
                        variant={u.isActive ? "danger" : "secondary"}
                        onClick={() => setToggle(u)}
                        aria-label={`${u.isActive ? "Deactivate" : "Activate"} ${u.name}`}
                      >
                        {u.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <Pagination
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            total={list.data!.total}
            onPage={setPage}
          />
        </>
      )}
      {dialog && (
        <UserDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {toggle && (
        <ConfirmDialog
          danger={toggle.isActive}
          title={toggle.isActive ? "Deactivate user" : "Activate user"}
          message={
            toggle.isActive
              ? `Deactivate ${toggle.name}? They will be signed out and unable to sign in.`
              : `Activate ${toggle.name}?`
          }
          confirmLabel={toggle.isActive ? "Deactivate" : "Activate"}
          onCancel={() => setToggle(null)}
          onConfirm={async () => {
            try {
              await api.patch(`/users/${toggle.id}`, { isActive: !toggle.isActive });
              toast.success(toggle.isActive ? "User deactivated" : "User activated");
              refresh();
            } catch (e) {
              toast.error(e); // includes the 409 "last Super Admin" message
            }
            setToggle(null);
          }}
        />
      )}
    </>
  );
}

function UserDialog({
  user,
  onClose,
  onSaved,
}: {
  user?: AdminRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const roles = useRoles();
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [roleId, setRoleId] = useState(user?.roleId ?? "");
  const [password, setPassword] = useState("");
  const [must, setMust] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = "Name is required";
    if (!roleId) errs.roleId = "Choose a role";
    if (!user) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        errs.email = "Enter a valid email address";
      if (password.length < 10) errs.password = "Use at least 10 characters";
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (user) {
        await api.patch(`/users/${user.id}`, { name: name.trim(), roleId });
        toast.success("User updated");
      } else {
        await api.post("/users", {
          email: email.trim(),
          name: name.trim(),
          roleId,
          password,
          mustChangePassword: must,
        });
        toast.success("User created");
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        if (user) toast.error(err);
        else setErrors({ email: err.message });
      } else handleSaveError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={user ? `Edit ${user.name}` : "New admin user"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" loading={busy}>
            {user ? "Save" : "Create user"}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate className="form">
        <TextField
          label="Email"
          type="email"
          value={email}
          disabled={!!user}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextField
          label="Name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />
        <SelectField
          label="Role"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          options={[
            { value: "", label: roles.isLoading ? "Loading roles…" : "Choose a role…" },
            ...(roles.data?.items ?? []).map((r) => ({ value: r.id, label: r.name })),
          ]}
          error={errors.roleId}
        />
        {!user && (
          <>
            <TextField
              label="Temporary password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              hint="At least 10 characters. Share it securely."
            />
            <CheckField
              label="Require password change at first sign-in"
              checked={must}
              onChange={(e) => setMust(e.target.checked)}
            />
          </>
        )}
      </form>
    </Modal>
  );
}
