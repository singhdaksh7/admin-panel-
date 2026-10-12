import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
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
  SelectField,
  Spinner,
  StatusBadge,
  TextArea,
  TextField,
  formatDate,
  useToast,
} from "../../components/ui";
import { NoteDialog, applyApiError, pretty, useMoney } from "../products/kit";

/** Mirror of the API transition table (apps/api/src/modules/orders/service.ts). */
export const TRANSITIONS: Record<string, string[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURN_REQUESTED"],
  DELIVERED: ["RETURN_REQUESTED"],
  RETURN_REQUESTED: ["RETURNED", "DELIVERED"],
  RETURNED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

interface Address {
  fullName?: string;
  phone?: string | null;
  line1?: string;
  line2?: string | null;
  city?: string;
  state?: string | null;
  postalCode?: string;
  country?: string;
}
interface Payment {
  id: string;
  provider: string;
  status: string;
  amount: string;
  refundedAmount: string;
  currency: string;
  providerPaymentId: string | null;
  createdAt: string;
}
interface Shipment {
  id: string;
  provider: string;
  awb: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}
interface OrderDto {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  email: string;
  currency: string;
  customerSnapshot: { name?: string; email?: string; phone?: string } | null;
  customer: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  taxBreakdown: {
    mode?: string;
    inclusive?: boolean;
    lines?: { name: string; rate: string | number; amount: string }[];
  } | null;
  couponCode: string | null;
  shippingMethodName: string | null;
  shippingAddress: Address;
  billingAddress: Address;
  paymentProvider: string | null;
  placedAt: string;
  items: {
    id: string;
    productTitle: string;
    variantTitle: string | null;
    sku: string;
    imageUrl: string | null;
    unitPrice: string;
    quantity: number;
    discount: string;
    taxRate: string;
    taxAmount: string;
    lineTotal: string;
  }[];
  events: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    message: string | null;
    actorType: string | null;
    createdAt: string;
  }[];
  notes: { id: string; body: string; createdAt: string }[];
  payments: Payment[];
  shipments: Shipment[];
  invoice: { status?: string; invoiceNumber?: string; issuedAt?: string };
}

function AddressBlock({ a }: { a: Address | null }) {
  if (!a) return <p className="muted">—</p>;
  return (
    <address style={{ fontStyle: "normal" }}>
      <strong>{a.fullName}</strong>
      <br />
      {a.line1}
      {a.line2 && (
        <>
          <br />
          {a.line2}
        </>
      )}
      <br />
      {[a.city, a.state, a.postalCode].filter(Boolean).join(", ")}
      <br />
      {a.country}
      {a.phone && (
        <>
          <br />
          {a.phone}
        </>
      )}
    </address>
  );
}

/** Run an API call; a 404 means the endpoint is not deployed on this server. */
function unavailable(e: unknown, toast: { error(e: unknown): void }, what: string) {
  if (e instanceof ApiError && e.status === 404)
    toast.error(new Error(`${what} is not available on this server`));
  else toast.error(e);
}

function RefundDialog({
  order,
  payment,
  onClose,
  onDone,
}: {
  order: OrderDto;
  payment: Payment;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const fmt = useMoney();
  const remaining = Number(payment.amount) - Number(payment.refundedAmount);
  const [amount, setAmount] = useState(remaining.toFixed(2));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refund = useMutation({
    mutationFn: () =>
      api.post(`/payments/${payment.id}/refund`, {
        amount: Number(amount).toFixed(2),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success("Refund issued");
      onDone();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 404) unavailable(e, toast, "Refunds");
      else applyApiError(e, setErrors, toast);
    },
  });
  function submit() {
    const e: Record<string, string> = {};
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0)
      e.amount = "Enter a positive amount";
    else if (Number(amount) > remaining + 0.0001)
      e.amount = `Cannot exceed ${fmt(remaining.toFixed(2), order.currency)}`;
    if (!reason.trim()) e.reason = "A reason is required";
    setErrors(e);
    if (!Object.keys(e).length) refund.mutate();
  }
  return (
    <Modal
      title={`Refund ${order.orderNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={refund.isPending} onClick={submit}>
            Issue refund
          </Button>
        </>
      }
    >
      <p className="muted">
        Paid {fmt(payment.amount, order.currency)} via {payment.provider}; refundable{" "}
        {fmt(remaining.toFixed(2), order.currency)}.
      </p>
      <TextField
        label="Amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
      />
      <TextArea
        label="Reason"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
      />
    </Modal>
  );
}

function ShipmentDialog({
  orderId,
  onClose,
  onDone,
}: {
  orderId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"provider" | "manual">("provider");
  const [provider, setProvider] = useState("");
  const [carrier, setCarrier] = useState("");
  const [awb, setAwb] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () =>
      api.post(
        `/orders/${orderId}/shipments`,
        mode === "provider"
          ? { ...(provider.trim() ? { provider: provider.trim() } : {}) }
          : {
              provider: "manual",
              carrier: carrier.trim() || undefined,
              awb: awb.trim(),
              trackingUrl: trackingUrl.trim() || undefined,
            },
      ),
    onSuccess: () => {
      toast.success("Shipment created");
      onDone();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 404) unavailable(e, toast, "Shipments");
      else applyApiError(e, setErrors, toast);
    },
  });
  function submit() {
    const e: Record<string, string> = {};
    if (mode === "manual") {
      if (!awb.trim()) e.awb = "AWB / tracking number is required";
      if (trackingUrl.trim() && !/^https?:\/\//i.test(trackingUrl.trim()))
        e.trackingUrl = "Must start with http(s)://";
    }
    setErrors(e);
    if (!Object.keys(e).length) create.mutate();
  }
  return (
    <Modal
      title="Create shipment"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create shipment
          </Button>
        </>
      }
    >
      <SelectField
        label="Method"
        value={mode}
        onChange={(e) => setMode(e.target.value as "provider" | "manual")}
        options={[
          { value: "provider", label: "Book with shipping provider" },
          { value: "manual", label: "Enter AWB manually" },
        ]}
      />
      {mode === "provider" ? (
        <TextField
          label="Provider (optional)"
          hint="Leave blank to use the default configured provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
      ) : (
        <>
          <TextField label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          <TextField
            label="AWB / tracking number"
            value={awb}
            onChange={(e) => setAwb(e.target.value)}
            error={errors.awb}
          />
          <TextField
            label="Tracking URL"
            value={trackingUrl}
            onChange={(e) => setTrackingUrl(e.target.value)}
            error={errors.trackingUrl}
          />
        </>
      )}
      {errors._ && <p className="field-error">{errors._}</p>}
    </Modal>
  );
}

export function OrderDetail() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const canUpdate = can("orders.update");
  const toast = useToast();
  const qc = useQueryClient();
  const fmtBase = useMoney();
  const q = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.get<OrderDto>(`/orders/${id}`),
  });
  const [dialog, setDialog] = useState<
    | null
    | { kind: "status"; to: string }
    | { kind: "cancel" }
    | { kind: "markPaid" }
    | { kind: "refund"; payment: Payment }
    | { kind: "shipment" }
    | { kind: "cancelShipment"; shipment: Shipment }
  >(null);
  const [note, setNote] = useState("");
  const [noteErr, setNoteErr] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["order", id] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
  };

  const addNote = useMutation({
    mutationFn: () => api.post(`/orders/${id}/notes`, { body: note.trim() }),
    onSuccess: () => {
      setNote("");
      toast.success("Note added");
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const refreshTracking = useMutation({
    mutationFn: (sid: string) => api.post(`/shipments/${sid}/refresh-tracking`),
    onSuccess: () => {
      toast.success("Tracking refreshed");
      refresh();
    },
    onError: (e) => unavailable(e, toast, "Tracking refresh"),
  });

  async function downloadInvoice(o: OrderDto) {
    setDownloading(true);
    try {
      const url = await api.blobUrl(`/orders/${o.id}/invoice.pdf`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${o.orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      unavailable(e, toast, "The invoice");
    } finally {
      setDownloading(false);
    }
  }

  if (q.isLoading) return <Spinner label="Loading order" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const o = q.data!;
  const fmt = (v: string | number | null | undefined) => fmtBase(v, o.currency);
  const next = (TRANSITIONS[o.status] ?? []).filter((s) => s !== "CANCELLED");
  const canCancel = (TRANSITIONS[o.status] ?? []).includes("CANCELLED");
  const isCod = /cod|cash/i.test(o.paymentProvider ?? "");
  const canMarkPaid =
    canUpdate &&
    isCod &&
    ["PENDING", "AUTHORIZED"].includes(o.paymentStatus) &&
    !["CANCELLED", "REFUNDED"].includes(o.status);
  const refundable = o.payments.filter(
    (p) =>
      ["PAID", "PARTIALLY_REFUNDED"].includes(p.status) &&
      Number(p.amount) > Number(p.refundedAmount),
  );
  const customerName = o.customerSnapshot?.name ?? o.shippingAddress?.fullName ?? "Guest";

  return (
    <>
      <PageHeader
        title={`Order ${o.orderNumber}`}
        subtitle={`Placed ${formatDate(o.placedAt)}`}
        actions={
          <>
            <Link to="/orders" className="btn btn-secondary">
              Back to orders
            </Link>
            <Button loading={downloading} onClick={() => void downloadInvoice(o)}>
              Download invoice
            </Button>
          </>
        }
      />

      <Card
        title="Status"
        actions={
          <span className="ops-actions">
            <StatusBadge status={o.status} />
            <StatusBadge status={o.paymentStatus} />
          </span>
        }
      >
        {canUpdate ? (
          <div className="ops-actions" aria-label="Order actions">
            {next.map((s) => (
              <Button
                key={s}
                variant="primary"
                onClick={() => setDialog({ kind: "status", to: s })}
              >
                Mark as {pretty(s)}
              </Button>
            ))}
            {canCancel && (
              <Button variant="danger" onClick={() => setDialog({ kind: "cancel" })}>
                Cancel order
              </Button>
            )}
            {canMarkPaid && (
              <Button onClick={() => setDialog({ kind: "markPaid" })}>Mark as paid (COD)</Button>
            )}
            {next.length === 0 && !canCancel && !canMarkPaid && (
              <span className="muted">No further actions: this order is {pretty(o.status)}.</span>
            )}
          </div>
        ) : (
          <p className="muted">You have read-only access to orders.</p>
        )}
      </Card>

      <div className="ops-two-col" style={{ marginTop: 16 }}>
        <div className="ops-sections">
          <Card title="Items">
            <DataTable
              caption="Order items"
              rows={o.items}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: "p",
                  header: "Product",
                  render: (i) => (
                    <div>
                      <strong>{i.productTitle}</strong>
                      {i.variantTitle && <small className="muted"> {i.variantTitle}</small>}
                      <small className="muted">SKU {i.sku}</small>
                    </div>
                  ),
                },
                { key: "u", header: "Price", render: (i) => fmt(i.unitPrice) },
                { key: "q", header: "Qty", render: (i) => i.quantity },
                {
                  key: "t",
                  header: "Tax",
                  render: (i) => `${fmt(i.taxAmount)} (${Number(i.taxRate)}%)`,
                },
                { key: "l", header: "Total", render: (i) => fmt(i.lineTotal) },
              ]}
            />
            <div className="ops-totals" aria-label="Order totals">
              <div>
                <span>Subtotal</span>
                <span>{fmt(o.subtotal)}</span>
              </div>
              {Number(o.discountTotal) > 0 && (
                <div>
                  <span>Discount{o.couponCode ? ` (${o.couponCode})` : ""}</span>
                  <span>-{fmt(o.discountTotal)}</span>
                </div>
              )}
              <div>
                <span>Shipping{o.shippingMethodName ? ` (${o.shippingMethodName})` : ""}</span>
                <span>{fmt(o.shippingTotal)}</span>
              </div>
              {(o.taxBreakdown?.lines ?? []).map((l, i) => (
                <div key={i}>
                  <span className="muted">
                    {l.name} {Number(l.rate)}%
                  </span>
                  <span>{fmt(l.amount)}</span>
                </div>
              ))}
              <div>
                <span>Tax{o.taxBreakdown?.inclusive ? " (included)" : ""}</span>
                <span>{fmt(o.taxTotal)}</span>
              </div>
              <div className="grand">
                <span>Total</span>
                <span>{fmt(o.total)}</span>
              </div>
            </div>
          </Card>

          <Card title="Payments">
            {o.payments.length === 0 ? (
              <EmptyState title="No payment attempts" />
            ) : (
              <DataTable
                caption="Payments"
                rows={o.payments}
                rowKey={(p) => p.id}
                columns={[
                  { key: "pr", header: "Provider", render: (p) => p.provider },
                  { key: "s", header: "Status", render: (p) => <StatusBadge status={p.status} /> },
                  { key: "a", header: "Amount", render: (p) => fmt(p.amount) },
                  { key: "r", header: "Refunded", render: (p) => fmt(p.refundedAmount) },
                  { key: "d", header: "Date", render: (p) => formatDate(p.createdAt) },
                  {
                    key: "act",
                    header: "",
                    render: (p) =>
                      canUpdate &&
                      refundable.some((r) => r.id === p.id) && (
                        <Button
                          variant="danger"
                          aria-label={`Refund payment ${p.id}`}
                          onClick={() => setDialog({ kind: "refund", payment: p })}
                        >
                          Refund
                        </Button>
                      ),
                  },
                ]}
              />
            )}
          </Card>

          <Card
            title="Shipments"
            actions={
              canUpdate && !["CANCELLED", "REFUNDED", "PENDING"].includes(o.status) ? (
                <Button onClick={() => setDialog({ kind: "shipment" })}>Create shipment</Button>
              ) : undefined
            }
          >
            {o.shipments.length === 0 ? (
              <EmptyState title="Not shipped yet" />
            ) : (
              <DataTable
                caption="Shipments"
                rows={o.shipments}
                rowKey={(s) => s.id}
                columns={[
                  { key: "c", header: "Carrier", render: (s) => s.carrier ?? s.provider },
                  {
                    key: "awb",
                    header: "AWB",
                    render: (s) =>
                      s.trackingUrl ? (
                        <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
                          {s.awb ?? "Track"}
                        </a>
                      ) : (
                        (s.awb ?? "—")
                      ),
                  },
                  {
                    key: "s",
                    header: "Status",
                    render: (s) => (
                      <>
                        <StatusBadge status={s.status} />
                        {s.error && <small className="field-error"> {s.error}</small>}
                      </>
                    ),
                  },
                  {
                    key: "act",
                    header: "",
                    render: (s) =>
                      canUpdate &&
                      s.status !== "CANCELLED" && (
                        <div className="ops-actions">
                          <Button
                            loading={
                              refreshTracking.isPending && refreshTracking.variables === s.id
                            }
                            onClick={() => refreshTracking.mutate(s.id)}
                          >
                            Refresh tracking
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => setDialog({ kind: "cancelShipment", shipment: s })}
                          >
                            Cancel shipment
                          </Button>
                        </div>
                      ),
                  },
                ]}
              />
            )}
          </Card>

          <Card title="Internal notes">
            {o.notes.length === 0 && <p className="muted">No notes yet.</p>}
            <ul className="plain" style={{ listStyle: "none", padding: 0 }}>
              {o.notes.map((n) => (
                <li key={n.id} style={{ marginBottom: 8 }}>
                  <p className="ops-pre">{n.body}</p>
                  <small className="muted">{formatDate(n.createdAt)}</small>
                </li>
              ))}
            </ul>
            {canUpdate && (
              <>
                <TextArea
                  label="Add a note"
                  rows={2}
                  value={note}
                  error={noteErr}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setNoteErr(undefined);
                  }}
                />
                <Button
                  loading={addNote.isPending}
                  onClick={() => {
                    if (!note.trim()) return setNoteErr("Write something first");
                    addNote.mutate();
                  }}
                >
                  Add note
                </Button>
              </>
            )}
          </Card>
        </div>

        <div className="ops-sections">
          <Card title="Customer">
            <p>
              {o.customer ? (
                <Link to={`/customers/${o.customer.id}`}>{customerName}</Link>
              ) : (
                customerName
              )}
              <br />
              <a href={`mailto:${o.email}`}>{o.email}</a>
              {o.customerSnapshot?.phone && (
                <>
                  <br />
                  {o.customerSnapshot.phone}
                </>
              )}
            </p>
          </Card>
          <Card title="Shipping address">
            <AddressBlock a={o.shippingAddress} />
          </Card>
          <Card title="Billing address">
            <AddressBlock a={o.billingAddress} />
          </Card>
          <Card title="Invoice">
            {o.invoice?.invoiceNumber ? (
              <p>
                {o.invoice.invoiceNumber} <Badge tone="success">issued</Badge>
              </p>
            ) : (
              <p className="muted">Not generated yet. Downloading generates it.</p>
            )}
          </Card>
          <Card title="Timeline">
            <ol className="ops-timeline" aria-label="Order timeline">
              {[...o.events]
                .filter((e) => e.type !== "NOTE")
                .reverse()
                .map((e) => (
                  <li key={e.id}>
                    <strong>{e.toStatus ? pretty(e.toStatus) : pretty(e.type)}</strong>
                    {e.message && <div>{e.message}</div>}
                    <small className="muted">
                      {formatDate(e.createdAt)}
                      {e.actorType ? ` · ${pretty(e.actorType)}` : ""}
                    </small>
                  </li>
                ))}
            </ol>
          </Card>
        </div>
      </div>

      {dialog?.kind === "status" && (
        <NoteDialog
          title={`Mark order as ${pretty(dialog.to)}`}
          message={`Move ${o.orderNumber} from ${pretty(o.status)} to ${pretty(dialog.to)}?`}
          confirmLabel="Confirm"
          onCancel={() => setDialog(null)}
          onSubmit={async (text) => {
            try {
              await api.post(`/orders/${o.id}/status`, {
                status: dialog.to,
                ...(text ? { note: text } : {}),
              });
              toast.success(`Order marked as ${pretty(dialog.to)}`);
              refresh();
              setDialog(null);
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <NoteDialog
          danger
          title="Cancel order"
          label="Reason"
          message="Cancelling releases or restocks the items. This cannot be undone."
          confirmLabel="Cancel order"
          onCancel={() => setDialog(null)}
          onSubmit={async (text) => {
            try {
              await api.post(`/orders/${o.id}/cancel`, text ? { reason: text } : {});
              toast.success("Order cancelled");
              refresh();
              setDialog(null);
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      )}
      {dialog?.kind === "markPaid" && (
        <NoteDialog
          title="Mark as paid"
          message="Record that the cash on delivery payment has been collected."
          confirmLabel="Mark as paid"
          onCancel={() => setDialog(null)}
          onSubmit={async (text) => {
            try {
              await api.post(`/orders/${o.id}/payments/mark-paid`, { note: text || undefined });
              toast.success("Payment recorded");
              refresh();
              setDialog(null);
            } catch (e) {
              unavailable(e, toast, "Marking payments as paid");
            }
          }}
        />
      )}
      {dialog?.kind === "refund" && (
        <RefundDialog
          order={o}
          payment={dialog.payment}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {dialog?.kind === "shipment" && (
        <ShipmentDialog orderId={o.id} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog?.kind === "cancelShipment" && (
        <ConfirmDialog
          danger
          title="Cancel shipment"
          message={`Cancel shipment ${dialog.shipment.awb ?? ""}?`}
          confirmLabel="Cancel shipment"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api.post(`/shipments/${dialog.shipment.id}/cancel`);
              toast.success("Shipment cancelled");
              refresh();
            } catch (e) {
              unavailable(e, toast, "Shipment cancellation");
            }
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
