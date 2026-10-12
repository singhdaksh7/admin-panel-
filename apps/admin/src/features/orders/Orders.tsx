import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, type Paginated } from "../../lib/api";
import {
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  SearchBox,
  StatusBadge,
  formatDate,
} from "../../components/ui";
import { ListState, pretty, useMoney, useUrlParams, useUrlSearch } from "../products/kit";

export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "RETURN_REQUESTED",
  "RETURNED",
  "REFUNDED",
];
export const PAYMENT_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  email: string;
  customer: string | null;
  total: string;
  currency: string;
  itemCount: number;
  createdAt: string;
}

const DEFAULTS = {
  q: "",
  status: "",
  paymentStatus: "",
  from: "",
  to: "",
  sort: "createdAt",
  dir: "desc",
  page: "1",
};

export function Orders() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const [text, setText] = useUrlSearch(p.q, (q) => setP({ q }));
  const fmt = useMoney();
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ["orders", p],
    queryFn: () =>
      api.get<Paginated<OrderRow>>("/orders", {
        q: p.q,
        status: p.status,
        paymentStatus: p.paymentStatus,
        from: p.from ? new Date(`${p.from}T00:00:00`).toISOString() : undefined,
        to: p.to ? new Date(`${p.to}T23:59:59.999`).toISOString() : undefined,
        sort: p.sort,
        dir: p.dir,
        page: p.page,
        pageSize: 20,
      }),
  });
  const items = list.data?.items ?? [];
  const filtered = !!(p.q || p.status || p.paymentStatus || p.from || p.to);
  const onSort = (key: string) =>
    setP(p.sort === key ? { dir: p.dir === "asc" ? "desc" : "asc" } : { sort: key, dir: "desc" });

  return (
    <>
      <PageHeader title="Orders" subtitle="Track and fulfil customer orders" />
      <div className="toolbar">
        <SearchBox value={text} onChange={setText} placeholder="Search order #, email or name" />
        <select
          aria-label="Filter by status"
          value={p.status}
          onChange={(e) => setP({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {pretty(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by payment status"
          value={p.paymentStatus}
          onChange={(e) => setP({ paymentStatus: e.target.value })}
        >
          <option value="">All payments</option>
          {PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {pretty(s)}
            </option>
          ))}
        </select>
        <label>
          From{" "}
          <input
            type="date"
            aria-label="From date"
            value={p.from}
            onChange={(e) => setP({ from: e.target.value })}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            aria-label="To date"
            value={p.to}
            onChange={(e) => setP({ to: e.target.value })}
          />
        </label>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setP({ q: "", status: "", paymentStatus: "", from: "", to: "" });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <ListState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        retry={() => void list.refetch()}
        empty={
          list.data && items.length === 0 ? (
            <EmptyState
              title="No orders found"
              hint={filtered ? "Try adjusting the filters." : "Orders will appear here."}
            />
          ) : undefined
        }
      >
        <DataTable
          caption="Orders"
          rows={items}
          rowKey={(o) => o.id}
          loading={list.isFetching}
          sort={{ key: p.sort, dir: p.dir === "asc" ? "asc" : "desc" }}
          onSort={onSort}
          onRowClick={(o) => nav(`/orders/${o.id}`)}
          columns={[
            {
              key: "orderNumber",
              header: "Order",
              sortable: true,
              render: (o) => <Link to={`/orders/${o.id}`}>{o.orderNumber}</Link>,
            },
            {
              key: "createdAt",
              header: "Placed",
              sortable: true,
              render: (o) => formatDate(o.createdAt),
            },
            {
              key: "c",
              header: "Customer",
              render: (o) => (
                <div>
                  {o.customer ?? "Guest"}
                  <small className="muted"> {o.email}</small>
                </div>
              ),
            },
            { key: "s", header: "Status", render: (o) => <StatusBadge status={o.status} /> },
            {
              key: "p",
              header: "Payment",
              render: (o) => <StatusBadge status={o.paymentStatus} />,
            },
            { key: "i", header: "Items", render: (o) => o.itemCount },
            {
              key: "total",
              header: "Total",
              sortable: true,
              render: (o) => fmt(o.total, o.currency),
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
    </>
  );
}
