import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  CheckField,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SearchBox,
  SelectField,
  Spinner,
  TextArea,
  TextField,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import {
  CategoryMultiPicker,
  ProductMultiPicker,
  fromLocalInput,
  handleSaveError,
  toLocalInput,
  type FieldErrors,
} from "../media/shared";

export interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discountType: "FIXED" | "PERCENTAGE";
  value: string;
  minOrderAmount: string | null;
  maxDiscount: string | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  isActive: boolean;
  productIds: string[];
  categoryIds: string[];
}

/* ───────── List ───────── */

export function CouponList() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("");
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<Coupon | null>(null);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["coupons", q, active, page],
    queryFn: () => api.get<Paginated<Coupon>>("/coupons", { q, active, page, pageSize: 20 }),
  });
  const toggle = useMutation({
    mutationFn: (c: Coupon) => api.patch(`/coupons/${c.id}`, { isActive: !c.isActive }),
    onSuccess: () => {
      toast.success("Coupon updated");
      void qc.invalidateQueries({ queryKey: ["coupons"] });
    },
    onError: (e) => toast.error(e),
  });

  async function doDelete(c: Coupon) {
    try {
      await api.delete(`/coupons/${c.id}`);
      toast.success(`Deleted ${c.code}`);
      void qc.invalidateQueries({ queryKey: ["coupons"] });
      setToDelete(null);
    } catch (e) {
      toast.error(e);
      setToDelete(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Coupons"
        subtitle="Discount codes for checkout"
        actions={
          <Can perm="coupons.write">
            <Link className="btn btn-primary" to="/coupons/new">
              New coupon
            </Link>
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
          placeholder="Search coupon code"
        />
        <select
          aria-label="Filter by status"
          value={active}
          onChange={(e) => {
            setActive(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState title="No coupons found" hint="Create a coupon to offer discounts." />
      ) : (
        <>
          <DataTable
            caption="Coupons"
            rows={list.data!.items}
            rowKey={(c) => c.id}
            onRowClick={(c) => nav(`/coupons/${c.id}`)}
            columns={[
              { key: "code", header: "Code", render: (c) => <strong>{c.code}</strong> },
              {
                key: "discount",
                header: "Discount",
                render: (c) =>
                  c.discountType === "PERCENTAGE" ? `${Number(c.value)}%` : `${c.value} off`,
              },
              {
                key: "window",
                header: "Valid",
                render: (c) =>
                  c.startsAt || c.endsAt
                    ? `${formatDate(c.startsAt)} → ${formatDate(c.endsAt)}`
                    : "Always",
              },
              {
                key: "used",
                header: "Used",
                render: (c) => `${c.usedCount}${c.usageLimit ? ` / ${c.usageLimit}` : ""}`,
              },
              {
                key: "status",
                header: "Status",
                render: (c) => (
                  <Badge tone={c.isActive ? "success" : "neutral"}>
                    {c.isActive ? "active" : "inactive"}
                  </Badge>
                ),
              },
              {
                key: "actions",
                header: "",
                render: (c) =>
                  can("coupons.write") ? (
                    <span className="g-actions" onClick={(e) => e.stopPropagation()}>
                      <Button onClick={() => toggle.mutate(c)}>
                        {c.isActive ? "Deactivate" : "Activate"}
                      </Button>
                      <Button variant="danger" onClick={() => setToDelete(c)}>
                        Delete
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
      {toDelete && (
        <ConfirmDialog
          danger
          title="Delete coupon"
          message={`Delete coupon ${toDelete.code}? Redeemed coupons cannot be deleted - deactivate them instead.`}
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={() => doDelete(toDelete)}
        />
      )}
    </>
  );
}

/* ───────── Form ───────── */

interface FormState {
  code: string;
  description: string;
  discountType: "FIXED" | "PERCENTAGE";
  value: string;
  minOrderAmount: string;
  maxDiscount: string;
  startsAt: string;
  endsAt: string;
  usageLimit: string;
  perCustomerLimit: string;
  isActive: boolean;
  productIds: string[];
  categoryIds: string[];
}
const EMPTY: FormState = {
  code: "",
  description: "",
  discountType: "PERCENTAGE",
  value: "",
  minOrderAmount: "",
  maxDiscount: "",
  startsAt: "",
  endsAt: "",
  usageLimit: "",
  perCustomerLimit: "",
  isActive: true,
  productIds: [],
  categoryIds: [],
};
const DEC = /^\d+(\.\d{1,2})?$/;

function fromCoupon(c: Coupon): FormState {
  return {
    code: c.code,
    description: c.description ?? "",
    discountType: c.discountType,
    value: c.value,
    minOrderAmount: c.minOrderAmount ?? "",
    maxDiscount: c.maxDiscount ?? "",
    startsAt: toLocalInput(c.startsAt),
    endsAt: toLocalInput(c.endsAt),
    usageLimit: c.usageLimit?.toString() ?? "",
    perCustomerLimit: c.perCustomerLimit?.toString() ?? "",
    isActive: c.isActive,
    productIds: c.productIds,
    categoryIds: c.categoryIds,
  };
}

export function validateCoupon(f: FormState): FieldErrors {
  const e: FieldErrors = {};
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(f.code.trim()))
    e.code = "3-40 characters: letters, digits, - and _";
  if (!DEC.test(f.value) || Number(f.value) <= 0) e.value = "Enter an amount greater than 0";
  else if (f.discountType === "PERCENTAGE" && Number(f.value) > 100)
    e.value = "Percentage must be between 0 and 100";
  if (f.minOrderAmount && !DEC.test(f.minOrderAmount))
    e.minOrderAmount = "Use a decimal like 10.00";
  if (f.maxDiscount && !DEC.test(f.maxDiscount)) e.maxDiscount = "Use a decimal like 10.00";
  for (const k of ["usageLimit", "perCustomerLimit"] as const)
    if (f[k] && !(Number.isInteger(Number(f[k])) && Number(f[k]) >= 1))
      e[k] = "Whole number, 1 or more";
  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt))
    e.endsAt = "Must be after the start date";
  return e;
}

export function couponPayload(f: FormState) {
  return {
    code: f.code.trim().toUpperCase(),
    description: f.description.trim() || null,
    discountType: f.discountType,
    value: f.value,
    minOrderAmount: f.minOrderAmount || null,
    maxDiscount: f.maxDiscount || null,
    startsAt: fromLocalInput(f.startsAt),
    endsAt: fromLocalInput(f.endsAt),
    usageLimit: f.usageLimit ? Number(f.usageLimit) : null,
    perCustomerLimit: f.perCustomerLimit ? Number(f.perCustomerLimit) : null,
    isActive: f.isActive,
    productIds: f.productIds,
    categoryIds: f.categoryIds,
  };
}

export function CouponForm() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWrite = can("coupons.write");
  const [f, setF] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const existing = useQuery({
    queryKey: ["coupon", id],
    queryFn: () => api.get<Coupon>(`/coupons/${id}`),
    enabled: !isNew,
  });
  useEffect(() => {
    if (existing.data) setF(fromCoupon(existing.data));
  }, [existing.data]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateCoupon(f);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const body = couponPayload(f);
      if (isNew) await api.post("/coupons", body);
      else await api.patch(`/coupons/${id}`, body);
      toast.success(isNew ? "Coupon created" : "Coupon saved");
      void qc.invalidateQueries({ queryKey: ["coupons"] });
      void qc.invalidateQueries({ queryKey: ["coupon", id] });
      nav("/coupons");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setErrors({ code: err.message });
      else handleSaveError(err, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && existing.isLoading) return <Spinner />;
  if (!isNew && existing.isError)
    return <ErrorState error={existing.error} retry={() => void existing.refetch()} />;

  const pct = f.discountType === "PERCENTAGE";
  return (
    <>
      <PageHeader
        title={isNew ? "New coupon" : `Coupon ${existing.data?.code ?? ""}`}
        actions={<Link to="/coupons">Back to coupons</Link>}
      />
      <form onSubmit={submit} noValidate className="g-stack">
        <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0 }}>
          <Card title="Discount">
            <div className="form-grid">
              <TextField
                label="Code"
                value={f.code}
                onChange={(e) => set("code", e.target.value)}
                error={errors.code}
                hint="Stored upper-case"
              />
              <SelectField
                label="Discount type"
                value={f.discountType}
                onChange={(e) => set("discountType", e.target.value as FormState["discountType"])}
                options={[
                  { value: "PERCENTAGE", label: "Percentage" },
                  { value: "FIXED", label: "Fixed amount" },
                ]}
                error={errors.discountType}
              />
              <TextField
                label={pct ? "Value (%)" : "Value (amount)"}
                inputMode="decimal"
                value={f.value}
                onChange={(e) => set("value", e.target.value)}
                error={errors.value}
              />
              <TextField
                label="Minimum order amount"
                inputMode="decimal"
                value={f.minOrderAmount}
                onChange={(e) => set("minOrderAmount", e.target.value)}
                error={errors.minOrderAmount}
              />
              <TextField
                label="Maximum discount"
                inputMode="decimal"
                value={f.maxDiscount}
                onChange={(e) => set("maxDiscount", e.target.value)}
                error={errors.maxDiscount}
                hint="Cap for percentage coupons"
              />
            </div>
            <TextArea
              label="Description"
              value={f.description}
              onChange={(e) => set("description", e.target.value)}
              error={errors.description}
              maxLength={300}
            />
          </Card>
          <Card title="Validity and limits">
            <div className="form-grid">
              <TextField
                label="Starts at"
                type="datetime-local"
                value={f.startsAt}
                onChange={(e) => set("startsAt", e.target.value)}
                error={errors.startsAt}
              />
              <TextField
                label="Ends at"
                type="datetime-local"
                value={f.endsAt}
                onChange={(e) => set("endsAt", e.target.value)}
                error={errors.endsAt}
              />
              <TextField
                label="Total usage limit"
                inputMode="numeric"
                value={f.usageLimit}
                onChange={(e) => set("usageLimit", e.target.value)}
                error={errors.usageLimit}
              />
              <TextField
                label="Per-customer limit"
                inputMode="numeric"
                value={f.perCustomerLimit}
                onChange={(e) => set("perCustomerLimit", e.target.value)}
                error={errors.perCustomerLimit}
              />
            </div>
            <CheckField
              label="Active"
              checked={f.isActive}
              onChange={(e) => set("isActive", e.target.checked)}
            />
          </Card>
          <Card title="Applies to">
            <p className="muted">Leave both empty to apply to the whole cart.</p>
            <div className="form-grid">
              <ProductMultiPicker
                label="Products"
                value={f.productIds}
                onChange={(v) => set("productIds", v)}
              />
              <CategoryMultiPicker
                label="Categories"
                value={f.categoryIds}
                onChange={(v) => set("categoryIds", v)}
              />
            </div>
          </Card>
        </fieldset>
        {canWrite && (
          <div className="g-actions">
            <Button variant="primary" type="submit" loading={busy}>
              {isNew ? "Create coupon" : "Save changes"}
            </Button>
            <Button type="button" onClick={() => nav("/coupons")}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
