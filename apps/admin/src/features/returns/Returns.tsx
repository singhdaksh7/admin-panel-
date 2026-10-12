import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Paginated } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Button,
  Card,
  CheckField,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  Spinner,
  StatusBadge,
  TextField,
  formatDate,
  useToast,
} from "../../components/ui";
import {
  ListState,
  NoteDialog,
  applyApiError,
  pretty,
  useMoney,
  useUrlParams,
  useUrlSearch,
} from "../products/kit";

const RETURN_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "RECEIVED", "REFUNDED", "CLOSED"];

interface ReturnRow {
  id: string;
  status: string;
  reason: string;
  createdAt: string;
  orderId?: string;
  orderNumber?: string;
  order?: { id: string; orderNumber: string; email?: string; currency?: string } | null;
  refundAmount?: string | null;
  email?: string;
}
interface ReturnDetailDto extends ReturnRow {
  details?: string | null;
  decisionNote?: string | null;
  items: {
    id: string;
    orderItemId: string;
    quantity: number;
    restock: boolean;
    productTitle?: string;
    title?: string;
    sku?: string;
  }[];
  history?: { id?: string; status: string; note: string | null; createdAt: string }[];
}

const orderOf = (r: ReturnRow) => ({
  id: r.order?.id ?? r.orderId,
  number: r.order?.orderNumber ?? r.orderNumber,
});

function NotAvailable({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404)
    return (
      <EmptyState
        title="Returns are not available"
        hint="This server does not expose the returns API yet."
      />
    );
  return null;
}

const DEFAULTS = { q: "", status: "", page: "1" };

export function Returns() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const [text, setText] = useUrlSearch(p.q, (q) => setP({ q }));
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ["returns", p],
    queryFn: () =>
      api.get<Paginated<ReturnRow>>("/returns", {
        q: p.q,
        status: p.status,
        page: p.page,
        pageSize: 20,
      }),
    retry: false,
  });
  const items = list.data?.items ?? [];
  const missing = list.error instanceof ApiError && list.error.status === 404;
  return (
    <>
      <PageHeader title="Returns" subtitle="Review and process return requests" />
      <div className="toolbar">
        <SearchBox value={text} onChange={setText} placeholder="Search order # or email" />
        <select
          aria-label="Filter by status"
          value={p.status}
          onChange={(e) => setP({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          {RETURN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {pretty(s)}
            </option>
          ))}
        </select>
      </div>
      {missing ? (
        <NotAvailable error={list.error} />
      ) : (
        <ListState
          isLoading={list.isLoading}
          isError={list.isError}
          error={list.error}
          retry={() => void list.refetch()}
          empty={
            list.data && items.length === 0 ? <EmptyState title="No return requests" /> : undefined
          }
        >
          <DataTable
            caption="Returns"
            rows={items}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/returns/${r.id}`)}
            columns={[
              {
                key: "o",
                header: "Order",
                render: (r) => <Link to={`/returns/${r.id}`}>{orderOf(r).number ?? r.id}</Link>,
              },
              { key: "s", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
              { key: "r", header: "Reason", render: (r) => r.reason },
              { key: "d", header: "Requested", render: (r) => formatDate(r.createdAt) },
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
      )}
    </>
  );
}

function ReceiveDialog({
  ret,
  onClose,
  onDone,
}: {
  ret: ReturnDetailDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [restock, setRestock] = useState<Record<string, boolean>>(
    Object.fromEntries(ret.items.map((i) => [i.id, i.restock])),
  );
  const m = useMutation({
    mutationFn: () =>
      api.post(`/returns/${ret.id}/receive`, {
        items: ret.items.map((i) => ({ returnItemId: i.id, restock: !!restock[i.id] })),
      }),
    onSuccess: () => {
      toast.success("Return marked as received");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Modal
      title="Receive returned items"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Mark received
          </Button>
        </>
      }
    >
      <p className="muted">Choose which items go back into sellable stock.</p>
      {ret.items.map((i) => (
        <CheckField
          key={i.id}
          label={`Restock ${i.quantity} × ${i.productTitle ?? i.title ?? i.sku ?? i.orderItemId}`}
          checked={!!restock[i.id]}
          onChange={(e) => setRestock({ ...restock, [i.id]: e.target.checked })}
        />
      ))}
    </Modal>
  );
}

function ReturnRefundDialog({
  ret,
  onClose,
  onDone,
}: {
  ret: ReturnDetailDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(ret.refundAmount ?? "");
  const [err, setErr] = useState<string>();
  const m = useMutation({
    mutationFn: () =>
      api.post(
        `/returns/${ret.id}/refund`,
        amount.trim() ? { amount: Number(amount).toFixed(2) } : {},
      ),
    onSuccess: () => {
      toast.success("Refund issued");
      onDone();
      onClose();
    },
    onError: (e) => applyApiError(e, (fe) => setErr(Object.values(fe)[0]), toast),
  });
  return (
    <Modal
      title="Refund return"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={m.isPending}
            onClick={() => {
              if (
                amount.trim() &&
                (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0)
              )
                return setErr("Enter a positive amount");
              m.mutate();
            }}
          >
            Issue refund
          </Button>
        </>
      }
    >
      <TextField
        label="Refund amount (optional)"
        hint="Leave blank to refund the calculated value of the returned items"
        inputMode="decimal"
        value={amount}
        error={err}
        onChange={(e) => {
          setAmount(e.target.value);
          setErr(undefined);
        }}
      />
    </Modal>
  );
}

export function ReturnDetail() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const canManage = can("returns.manage");
  const toast = useToast();
  const qc = useQueryClient();
  const fmt = useMoney();
  const q = useQuery({
    queryKey: ["return", id],
    queryFn: () => api.get<ReturnDetailDto>(`/returns/${id}`),
    retry: false,
  });
  const [dialog, setDialog] = useState<null | "approve" | "reject" | "receive" | "refund">(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["return", id] });
    void qc.invalidateQueries({ queryKey: ["returns"] });
  };
  if (q.isLoading) return <Spinner label="Loading return" />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <EmptyState
          title="Return not found"
          hint="It may not exist, or returns are not available on this server."
        />
      );
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  }
  const r = q.data!;
  const { id: orderId, number } = orderOf(r);

  const decide = (kind: "approve" | "reject") => async (note: string) => {
    try {
      await api.post(`/returns/${r.id}/${kind}`, { note: note || undefined });
      toast.success(kind === "approve" ? "Return approved" : "Return rejected");
      refresh();
      setDialog(null);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHeader
        title={`Return ${number ?? r.id}`}
        subtitle={`Requested ${formatDate(r.createdAt)}`}
        actions={
          <Link to="/returns" className="btn btn-secondary">
            Back to returns
          </Link>
        }
      />
      <div className="ops-two-col">
        <div className="ops-sections">
          <Card title="Request" actions={<StatusBadge status={r.status} />}>
            <dl className="ops-kv">
              <dt>Order</dt>
              <dd>
                {orderId ? (
                  <Link to={`/orders/${orderId}`}>{number ?? orderId}</Link>
                ) : (
                  (number ?? "—")
                )}
              </dd>
              <dt>Reason</dt>
              <dd>{r.reason}</dd>
              {r.details && (
                <>
                  <dt>Details</dt>
                  <dd className="ops-pre">{r.details}</dd>
                </>
              )}
              {r.decisionNote && (
                <>
                  <dt>Decision note</dt>
                  <dd className="ops-pre">{r.decisionNote}</dd>
                </>
              )}
              {r.refundAmount && (
                <>
                  <dt>Refund amount</dt>
                  <dd>{fmt(r.refundAmount, r.order?.currency)}</dd>
                </>
              )}
            </dl>
          </Card>
          <Card title="Items">
            <DataTable
              caption="Returned items"
              rows={r.items ?? []}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: "t",
                  header: "Item",
                  render: (i) => i.productTitle ?? i.title ?? i.sku ?? i.orderItemId,
                },
                { key: "q", header: "Qty", render: (i) => i.quantity },
                { key: "r", header: "Restock", render: (i) => (i.restock ? "yes" : "no") },
              ]}
            />
          </Card>
        </div>
        <div className="ops-sections">
          {canManage && (
            <Card title="Actions">
              <div className="ops-actions">
                {r.status === "REQUESTED" && (
                  <>
                    <Button variant="primary" onClick={() => setDialog("approve")}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => setDialog("reject")}>
                      Reject
                    </Button>
                  </>
                )}
                {r.status === "APPROVED" && (
                  <Button variant="primary" onClick={() => setDialog("receive")}>
                    Receive items
                  </Button>
                )}
                {r.status === "RECEIVED" && (
                  <Button variant="primary" onClick={() => setDialog("refund")}>
                    Issue refund
                  </Button>
                )}
                {["REJECTED", "REFUNDED", "CLOSED"].includes(r.status) && (
                  <span className="muted">
                    This return is {pretty(r.status)}; no further actions.
                  </span>
                )}
              </div>
            </Card>
          )}
          <Card title="History">
            <ol className="ops-timeline">
              {[...(r.history ?? [])].reverse().map((h, i) => (
                <li key={h.id ?? i}>
                  <strong>{pretty(h.status)}</strong>
                  {h.note && <div>{h.note}</div>}
                  <small className="muted">{formatDate(h.createdAt)}</small>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      {dialog === "approve" && (
        <NoteDialog
          title="Approve return"
          message="Approve this return request?"
          confirmLabel="Approve"
          onCancel={() => setDialog(null)}
          onSubmit={decide("approve")}
        />
      )}
      {dialog === "reject" && (
        <NoteDialog
          danger
          required
          label="Reason for rejection"
          title="Reject return"
          confirmLabel="Reject"
          onCancel={() => setDialog(null)}
          onSubmit={decide("reject")}
        />
      )}
      {dialog === "receive" && (
        <ReceiveDialog ret={r} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog === "refund" && (
        <ReturnRefundDialog ret={r} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </>
  );
}
