import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, type Paginated } from "../../lib/api";
import { Can } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  CheckField,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  StatusBadge,
  useToast,
} from "../../components/ui";
import { ListState, Thumb, useMoney, useUrlParams, useUrlSearch, flattenTree } from "./kit";
import { useCategoryTree, type ProductListItem, type ProductStatus } from "./types";

const DEFAULTS = { q: "", status: "", category: "", sort: "newest", page: "1" };

export function StockBadge({ n }: { n: number }) {
  if (n <= 0) return <Badge tone="danger">Out of stock</Badge>;
  if (n <= 5) return <Badge tone="warning">{n} low</Badge>;
  return <Badge tone="success">{n} in stock</Badge>;
}

export function ProductList() {
  const [p, setP] = useUrlParams(DEFAULTS);
  const [text, setText] = useUrlSearch(p.q, (q) => setP({ q }));
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<ProductStatus>("ACTIVE");
  const fmt = useMoney();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const cats = useCategoryTree();

  const list = useQuery({
    queryKey: ["products", p],
    queryFn: () =>
      api.get<Paginated<ProductListItem>>("/products", {
        q: p.q,
        status: p.status,
        category: p.category,
        sort: p.sort,
        page: p.page,
        pageSize: 20,
      }),
  });
  const bulkMut = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>("/products/bulk-status", { ids: selected, status: bulk }),
    onSuccess: (r) => {
      toast.success(`${r.updated} product(s) set to ${bulk.toLowerCase()}`);
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e) => toast.error(e),
  });

  const items = list.data?.items ?? [];
  const allOn = items.length > 0 && items.every((i) => selected.includes(i.id));
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Manage your catalog"
        actions={
          <Can perm="products.write">
            <Button variant="primary" onClick={() => nav("/products/new")}>
              New product
            </Button>
          </Can>
        }
      />
      <div className="toolbar">
        <SearchBox value={text} onChange={setText} placeholder="Search title, SKU, brand" />
        <select
          aria-label="Filter by status"
          value={p.status}
          onChange={(e) => setP({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="DRAFT">Draft</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <select
          aria-label="Filter by category"
          value={p.category}
          onChange={(e) => setP({ category: e.target.value })}
        >
          <option value="">All categories</option>
          {flattenTree(cats.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {"— ".repeat(c.depth)}
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Sort" value={p.sort} onChange={(e) => setP({ sort: e.target.value })}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="updated">Recently updated</option>
          <option value="title">Title A-Z</option>
          <option value="price_asc">Price low to high</option>
          <option value="price_desc">Price high to low</option>
        </select>
      </div>
      <Can perm="products.write">
        {items.length > 0 && (
          <div className="toolbar">
            <CheckField
              label="Select all on page"
              checked={allOn}
              onChange={() => setSelected(allOn ? [] : items.map((i) => i.id))}
            />
            {selected.length > 0 && (
              <>
                <span>{selected.length} selected</span>
                <SelectField
                  label="Bulk status"
                  value={bulk}
                  onChange={(e) => setBulk(e.target.value as ProductStatus)}
                  options={[
                    { value: "ACTIVE", label: "Active" },
                    { value: "DRAFT", label: "Draft" },
                    { value: "ARCHIVED", label: "Archived" },
                  ]}
                />
                <Button loading={bulkMut.isPending} onClick={() => bulkMut.mutate()}>
                  Apply status
                </Button>
              </>
            )}
          </div>
        )}
      </Can>
      <ListState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        retry={() => void list.refetch()}
        empty={
          list.data && items.length === 0 ? (
            <EmptyState
              title="No products found"
              hint={
                p.q || p.status || p.category
                  ? "Try clearing the filters."
                  : "Create your first product."
              }
            />
          ) : undefined
        }
      >
        <DataTable
          caption="Products"
          rows={items}
          rowKey={(r) => r.id}
          loading={list.isFetching}
          columns={[
            {
              key: "sel",
              header: "",
              width: "36px",
              render: (r) => (
                <Can perm="products.write">
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.title}`}
                    checked={selected.includes(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </Can>
              ),
            },
            {
              key: "title",
              header: "Product",
              render: (r) => (
                <div className="ops-cell">
                  <Thumb src={r.image} />
                  <div>
                    <Link to={`/products/${r.id}`}>{r.title}</Link>
                    <small className="muted">
                      {r.variantCount} variant{r.variantCount === 1 ? "" : "s"}
                      {r.brand ? ` · ${r.brand}` : ""}
                    </small>
                  </div>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (r) => (
                <>
                  <StatusBadge status={r.status} />
                  {r.status === "ACTIVE" && r.visibility !== "live" && (
                    <small className="muted"> {r.visibility}</small>
                  )}
                </>
              ),
            },
            { key: "cat", header: "Category", render: (r) => r.category?.name ?? "—" },
            {
              key: "price",
              header: "Price",
              render: (r) =>
                r.priceMin === null
                  ? "—"
                  : r.priceMin === r.priceMax
                    ? fmt(r.priceMin)
                    : `${fmt(r.priceMin)} – ${fmt(r.priceMax)}`,
            },
            { key: "stock", header: "Stock", render: (r) => <StockBadge n={r.totalAvailable} /> },
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
