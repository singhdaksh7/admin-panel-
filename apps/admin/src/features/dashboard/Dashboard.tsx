import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Spinner,
  StatusBadge,
  formatDate,
  money,
} from "../../components/ui";

interface Summary {
  currency: string;
  revenue: Record<"today" | "last7Days" | "last30Days", { revenue: string; orders: number }>;
  ordersByStatus: Record<string, number>;
  lowStock: {
    variantId: string;
    sku: string;
    productTitle: string;
    available: number;
    lowStockThreshold: number;
  }[];
  topProducts: { productId: string | null; title: string; quantity: number; revenue: string }[];
  recentOrders: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    total: string;
    currency: string;
    email: string;
    createdAt: string;
  }[];
  alerts: { pendingUnpaidOrders: number; lowStockVariants: number; outOfStockVariants: number };
}

export function Dashboard() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<Summary>("/dashboard/summary"),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <Spinner label="Loading dashboard" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data!;
  const cur = d.currency;
  const alerts = [
    d.alerts.pendingUnpaidOrders > 0 &&
      `${d.alerts.pendingUnpaidOrders} order(s) pending payment for over 30 minutes`,
    d.alerts.outOfStockVariants > 0 && `${d.alerts.outOfStockVariants} variant(s) out of stock`,
    d.alerts.lowStockVariants - d.alerts.outOfStockVariants > 0 &&
      `${d.alerts.lowStockVariants - d.alerts.outOfStockVariants} variant(s) running low`,
  ].filter(Boolean) as string[];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Paid revenue and operational overview" />
      {alerts.length > 0 && (
        <div className="alert-box" role="status">
          <strong>Needs attention</strong>
          <ul>
            {alerts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="stat-grid">
        {(
          [
            ["Today", d.revenue.today],
            ["Last 7 days", d.revenue.last7Days],
            ["Last 30 days", d.revenue.last30Days],
          ] as const
        ).map(([label, v]) => (
          <div className="stat" key={label}>
            <span className="muted">{label}</span>
            <strong>{money(v.revenue, cur)}</strong>
            <small>
              {v.orders} paid order{v.orders === 1 ? "" : "s"}
            </small>
          </div>
        ))}
      </div>
      <div className="grid-2">
        <Card title="Orders by status">
          <div className="chips">
            {Object.entries(d.ordersByStatus).map(([s, n]) => (
              <Link key={s} to={`/orders?status=${s}`} className="chip">
                <StatusBadge status={s} /> <b>{n}</b>
              </Link>
            ))}
          </div>
        </Card>
        <Card title="Low stock">
          {d.lowStock.length === 0 ? (
            <EmptyState title="Stock levels look healthy" />
          ) : (
            <ul className="plain">
              {d.lowStock.slice(0, 8).map((l) => (
                <li key={l.variantId}>
                  <Link to={`/inventory?q=${encodeURIComponent(l.sku)}`}>{l.productTitle}</Link>{" "}
                  <small className="muted">{l.sku}</small>{" "}
                  <Badge tone={l.available <= 0 ? "danger" : "warning"}>{l.available} left</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid-2">
        <Card title="Top products (30 days)">
          {d.topProducts.length === 0 ? (
            <EmptyState title="No sales yet" hint="Top sellers appear once orders are confirmed." />
          ) : (
            <DataTable
              caption="Top products"
              rows={d.topProducts}
              rowKey={(r) => r.productId ?? r.title}
              columns={[
                { key: "t", header: "Product", render: (r) => r.title },
                { key: "q", header: "Units", render: (r) => r.quantity },
                { key: "r", header: "Revenue", render: (r) => money(r.revenue, cur) },
              ]}
            />
          )}
        </Card>
        <Card title="Recent orders" actions={<Link to="/orders">View all</Link>}>
          {d.recentOrders.length === 0 ? (
            <EmptyState title="No orders yet" />
          ) : (
            <DataTable
              caption="Recent orders"
              rows={d.recentOrders}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: "n",
                  header: "Order",
                  render: (r) => <Link to={`/orders/${r.id}`}>{r.orderNumber}</Link>,
                },
                { key: "s", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
                { key: "t", header: "Total", render: (r) => money(r.total, r.currency) },
                { key: "d", header: "Placed", render: (r) => formatDate(r.createdAt) },
              ]}
            />
          )}
        </Card>
      </div>
    </>
  );
}
