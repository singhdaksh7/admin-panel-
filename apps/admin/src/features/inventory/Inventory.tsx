import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Paginated } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  CheckField,
  DataTable,
  EmptyState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  TextField,
  formatDate,
  useToast,
} from "../../components/ui";
import { ListState, applyApiError, pretty, useUrlParams, useUrlSearch } from "../products/kit";

interface InvItem {
  id: string;
  variantId: string;
  sku: string;
  variantTitle: string | null;
  productId: string;
  productTitle: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  allowBackorder: boolean;
  isLow: boolean;
}
interface Movement {
  id: string;
  type: string;
  quantity: number;
  reason: string | null;
  orderId: string | null;
  onHandAfter: number;
  reservedAfter: number;
  createdAt: string;
}

const DEFAULTS = { q: "", low: "", page: "1" };

function AdjustDialog({ item, onClose }: { item: InvItem; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"delta" | "set">("delta");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [threshold, setThreshold] = useState(String(item.lowStockThreshold));
  const [track, setTrack] = useState(item.trackInventory);
  const [backorder, setBackorder] = useState(item.allowBackorder);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { reason: reason.trim() };
      if (amount.trim() !== "") body[mode] = Number(amount);
      if (Number(threshold) !== item.lowStockThreshold) body.lowStockThreshold = Number(threshold);
      if (track !== item.trackInventory) body.trackInventory = track;
      if (backorder !== item.allowBackorder) body.allowBackorder = backorder;
      return api.patch(`/inventory/${item.variantId}`, body);
    },
    onSuccess: () => {
      toast.success("Inventory updated");
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["inventory-movements", item.variantId] });
      onClose();
    },
    onError: (e) => applyApiError(e, setErrors, toast),
  });

  function submit() {
    const e: Record<string, string> = {};
    const changedSettings =
      Number(threshold) !== item.lowStockThreshold ||
      track !== item.trackInventory ||
      backorder !== item.allowBackorder;
    if (amount.trim() === "" && !changedSettings) e.amount = "Enter a quantity or change a setting";
    if (amount.trim() !== "") {
      if (!/^-?\d+$/.test(amount.trim())) e.amount = "Whole number";
      else if (mode === "set" && Number(amount) < 0) e.amount = "Cannot be negative";
    }
    if (!/^\d+$/.test(threshold.trim())) e.lowStockThreshold = "Whole number";
    if (!reason.trim()) e.reason = "A reason is required";
    setErrors(e);
    if (!Object.keys(e).length) save.mutate();
  }

  const preview =
    amount.trim() !== "" && /^-?\d+$/.test(amount.trim())
      ? mode === "set"
        ? Number(amount)
        : item.onHand + Number(amount)
      : null;

  return (
    <Modal
      title={`Adjust stock: ${item.sku}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save adjustment
          </Button>
        </>
      }
    >
      <p className="muted">
        {item.productTitle} · on hand {item.onHand}, reserved {item.reserved}, available{" "}
        {item.available}
      </p>
      <div className="ops-grid-2">
        <SelectField
          label="Adjustment type"
          value={mode}
          onChange={(e) => setMode(e.target.value as "delta" | "set")}
          options={[
            { value: "delta", label: "Add / remove (change by)" },
            { value: "set", label: "Set on-hand to" },
          ]}
        />
        <TextField
          label={mode === "delta" ? "Change by (use - to remove)" : "New on-hand quantity"}
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={errors.amount ?? errors.delta ?? errors.set}
          hint={preview !== null ? `On hand after: ${preview}` : undefined}
        />
      </div>
      <TextField
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
      />
      <div className="ops-grid-2">
        <TextField
          label="Low stock threshold"
          inputMode="numeric"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          error={errors.lowStockThreshold}
        />
      </div>
      <CheckField
        label="Track inventory"
        checked={track}
        onChange={(e) => setTrack(e.target.checked)}
      />
      <CheckField
        label="Allow backorders"
        checked={backorder}
        onChange={(e) => setBackorder(e.target.checked)}
      />
    </Modal>
  );
}

function MovementsDialog({ item, onClose }: { item: InvItem; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["inventory-movements", item.variantId, page],
    queryFn: () =>
      api.get<Paginated<Movement>>(`/inventory/${item.variantId}/movements`, {
        page,
        pageSize: 20,
      }),
  });
  return (
    <Modal
      title={`Stock history: ${item.sku}`}
      wide
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <ListState
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        retry={() => void q.refetch()}
        empty={
          q.data && q.data.items.length === 0 ? (
            <EmptyState title="No stock movements yet" />
          ) : undefined
        }
      >
        <DataTable
          caption="Stock movements"
          rows={q.data?.items ?? []}
          rowKey={(m) => m.id}
          columns={[
            { key: "d", header: "When", render: (m) => formatDate(m.createdAt) },
            { key: "t", header: "Type", render: (m) => pretty(m.type) },
            {
              key: "q",
              header: "Qty",
              render: (m) => (m.quantity > 0 ? `+${m.quantity}` : m.quantity),
            },
            { key: "o", header: "On hand after", render: (m) => m.onHandAfter },
            {
              key: "r",
              header: "Reason",
              render: (m) => m.reason ?? (m.orderId ? `Order ${m.orderId}` : "—"),
            },
          ]}
        />
        {q.data && (
          <Pagination
            page={q.data.page}
            totalPages={q.data.totalPages}
            total={q.data.total}
            onPage={setPage}
          />
        )}
      </ListState>
    </Modal>
  );
}

export function Inventory() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const [text, setText] = useUrlSearch(p.q, (q) => setP({ q }));
  const { can } = useAuth();
  const canWrite = can("inventory.write");
  const [adjust, setAdjust] = useState<InvItem | null>(null);
  const [history, setHistory] = useState<InvItem | null>(null);
  const list = useQuery({
    queryKey: ["inventory", p],
    queryFn: () =>
      api.get<Paginated<InvItem>>("/inventory", {
        q: p.q,
        lowStock: p.low === "1" ? "true" : undefined,
        page: p.page,
        pageSize: 25,
      }),
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Inventory" subtitle="Stock levels by variant" />
      <div className="toolbar">
        <SearchBox value={text} onChange={setText} placeholder="Search SKU or product" />
        <CheckField
          label="Low stock only"
          checked={p.low === "1"}
          onChange={(e) => setP({ low: e.target.checked ? "1" : "" })}
        />
      </div>
      <ListState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        retry={() => void list.refetch()}
        empty={
          list.data && items.length === 0 ? (
            <EmptyState
              title="No inventory items found"
              hint={p.low ? "Nothing is running low." : undefined}
            />
          ) : undefined
        }
      >
        <DataTable
          caption="Inventory"
          rows={items}
          rowKey={(i) => i.id}
          loading={list.isFetching}
          columns={[
            {
              key: "p",
              header: "Product",
              render: (i) => (
                <div>
                  <Link to={`/products/${i.productId}`}>{i.productTitle}</Link>
                  {i.variantTitle && <small className="muted"> {i.variantTitle}</small>}
                </div>
              ),
            },
            { key: "sku", header: "SKU", render: (i) => i.sku },
            { key: "h", header: "On hand", render: (i) => i.onHand },
            { key: "r", header: "Reserved", render: (i) => i.reserved },
            {
              key: "a",
              header: "Available",
              render: (i) =>
                !i.trackInventory ? (
                  <Badge>untracked</Badge>
                ) : i.available <= 0 ? (
                  <Badge tone="danger">{i.available}</Badge>
                ) : i.isLow ? (
                  <Badge tone="warning">{i.available} low</Badge>
                ) : (
                  i.available
                ),
            },
            { key: "t", header: "Threshold", render: (i) => i.lowStockThreshold },
            {
              key: "act",
              header: "",
              render: (i) => (
                <div className="ops-actions">
                  {canWrite && (
                    <Button aria-label={`Adjust ${i.sku}`} onClick={() => setAdjust(i)}>
                      Adjust
                    </Button>
                  )}
                  <Button aria-label={`History ${i.sku}`} onClick={() => setHistory(i)}>
                    History
                  </Button>
                </div>
              ),
            },
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
      {adjust && <AdjustDialog item={adjust} onClose={() => setAdjust(null)} />}
      {history && <MovementsDialog item={history} onClose={() => setHistory(null)} />}
    </>
  );
}
