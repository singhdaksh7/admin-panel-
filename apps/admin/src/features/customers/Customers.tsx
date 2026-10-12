import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Paginated } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SearchBox,
  Spinner,
  StatusBadge,
  formatDate,
  useToast,
} from "../../components/ui";
import { ListState, useMoney, useUrlParams, useUrlSearch } from "../products/kit";

interface CustomerRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  isActive: boolean;
  isGuest: boolean;
  orderCount: number;
  createdAt: string;
}
interface CustomerDetailDto extends Omit<CustomerRow, "orderCount"> {
  emailVerified: boolean;
  addresses: {
    id: string;
    fullName?: string;
    line1?: string;
    line2?: string | null;
    city?: string;
    state?: string | null;
    postalCode?: string;
    country?: string;
    isDefault?: boolean;
  }[];
  ordersSummary: {
    count: number;
    totalSpent: string;
    recent: {
      id: string;
      orderNumber: string;
      status: string;
      paymentStatus: string;
      total: string;
      currency: string;
      placedAt: string;
    }[];
  };
}

const name = (c: { firstName: string | null; lastName: string | null; email: string }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;

const DEFAULTS = { q: "", active: "", page: "1" };

export function Customers() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const [text, setText] = useUrlSearch(p.q, (q) => setP({ q }));
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ["customers", p],
    queryFn: () =>
      api.get<Paginated<CustomerRow>>("/customers", {
        q: p.q,
        active: p.active,
        page: p.page,
        pageSize: 20,
      }),
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Customers" subtitle="People who have shopped with you" />
      <div className="toolbar">
        <SearchBox value={text} onChange={setText} placeholder="Search name, email or phone" />
        <select
          aria-label="Filter by status"
          value={p.active}
          onChange={(e) => setP({ active: e.target.value })}
        >
          <option value="">All customers</option>
          <option value="true">Active</option>
          <option value="false">Deactivated</option>
        </select>
      </div>
      <ListState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        retry={() => void list.refetch()}
        empty={
          list.data && items.length === 0 ? <EmptyState title="No customers found" /> : undefined
        }
      >
        <DataTable
          caption="Customers"
          rows={items}
          rowKey={(c) => c.id}
          loading={list.isFetching}
          onRowClick={(c) => nav(`/customers/${c.id}`)}
          columns={[
            {
              key: "n",
              header: "Customer",
              render: (c) => (
                <div>
                  <Link to={`/customers/${c.id}`}>{name(c)}</Link>
                  <small className="muted">{c.email}</small>
                </div>
              ),
            },
            { key: "o", header: "Orders", render: (c) => c.orderCount },
            {
              key: "s",
              header: "Status",
              render: (c) => (
                <>
                  {c.isActive ? (
                    <Badge tone="success">active</Badge>
                  ) : (
                    <Badge tone="danger">deactivated</Badge>
                  )}{" "}
                  {c.isGuest && <Badge>guest</Badge>}
                </>
              ),
            },
            { key: "d", header: "Joined", render: (c) => formatDate(c.createdAt) },
          ]}
        />
        {list.data && (
          <Pagination
            page={list.data.page}
            totalPages={list.data.totalPages}
            total={list.data.total}
            onPage={(pg) => setP({ page: String(pg) })}
          />
        )}
      </ListState>
    </>
  );
}

export function CustomerDetail() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const fmt = useMoney();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ["customer", id],
    queryFn: () => api.get<CustomerDetailDto>(`/customers/${id}`),
  });
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => api.patch(`/customers/${id}`, { isActive }),
    onSuccess: (_r, isActive) => {
      toast.success(isActive ? "Customer reactivated" : "Customer deactivated");
      void qc.invalidateQueries({ queryKey: ["customer", id] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <Spinner label="Loading customer" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const c = q.data!;
  const canWrite = can("customers.write");
  return (
    <>
      <PageHeader
        title={name(c)}
        subtitle={c.email}
        actions={
          <>
            <Link to="/customers" className="btn btn-secondary">
              Back to customers
            </Link>
            {canWrite &&
              (c.isActive ? (
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  Deactivate
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={toggle.isPending}
                  onClick={() => toggle.mutate(true)}
                >
                  Reactivate
                </Button>
              ))}
          </>
        }
      />
      <div className="ops-two-col">
        <div className="ops-sections">
          <Card
            title="Orders"
            actions={
              <span className="muted">
                {c.ordersSummary.count} orders · {fmt(c.ordersSummary.totalSpent)} spent
              </span>
            }
          >
            {c.ordersSummary.recent.length === 0 ? (
              <EmptyState title="No orders yet" />
            ) : (
              <DataTable
                caption="Recent orders"
                rows={c.ordersSummary.recent}
                rowKey={(o) => o.id}
                columns={[
                  {
                    key: "n",
                    header: "Order",
                    render: (o) => <Link to={`/orders/${o.id}`}>{o.orderNumber}</Link>,
                  },
                  { key: "s", header: "Status", render: (o) => <StatusBadge status={o.status} /> },
                  { key: "t", header: "Total", render: (o) => fmt(o.total, o.currency) },
                  { key: "d", header: "Placed", render: (o) => formatDate(o.placedAt) },
                ]}
              />
            )}
          </Card>
        </div>
        <div className="ops-sections">
          <Card title="Profile">
            <dl className="ops-kv">
              <dt>Status</dt>
              <dd>
                {c.isActive ? (
                  <Badge tone="success">active</Badge>
                ) : (
                  <Badge tone="danger">deactivated</Badge>
                )}
              </dd>
              <dt>Email</dt>
              <dd>
                {c.email}{" "}
                {c.emailVerified ? (
                  <Badge tone="success">verified</Badge>
                ) : (
                  <Badge>unverified</Badge>
                )}
              </dd>
              <dt>Phone</dt>
              <dd>{c.phone ?? "—"}</dd>
              <dt>Type</dt>
              <dd>{c.isGuest ? "Guest checkout" : "Registered"}</dd>
              <dt>Joined</dt>
              <dd>{formatDate(c.createdAt)}</dd>
            </dl>
          </Card>
          <Card title="Addresses">
            {c.addresses.length === 0 ? (
              <p className="muted">No saved addresses.</p>
            ) : (
              c.addresses.map((a) => (
                <address key={a.id} style={{ fontStyle: "normal", marginBottom: 10 }}>
                  <strong>{a.fullName}</strong> {a.isDefault && <Badge>default</Badge>}
                  <br />
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {[a.city, a.state, a.postalCode].filter(Boolean).join(", ")} {a.country}
                </address>
              ))
            )}
          </Card>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          danger
          title="Deactivate customer"
          message={`Deactivate ${name(c)}? They will be signed out and unable to log in until reactivated.`}
          confirmLabel="Deactivate"
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            try {
              await toggle.mutateAsync(false);
            } catch {
              /* toasted */
            }
            setConfirm(false);
          }}
        />
      )}
    </>
  );
}
