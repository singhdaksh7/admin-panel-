import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Paginated } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  Spinner,
  StatusBadge,
  TextArea,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import { Tabs } from "../media/shared";

type Status = "PENDING" | "APPROVED" | "REJECTED";
interface Review {
  id: string;
  authorName: string;
  authorEmail: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  status: Status;
  verifiedPurchase: boolean;
  moderationNote: string | null;
  createdAt: string;
  product: { id: string; title: string; slug: string };
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="g-stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {"★".repeat(rating)}
      {"☆".repeat(Math.max(0, 5 - rating))}
    </span>
  );
}

type Pending =
  | { kind: "single"; review: Review; status: "APPROVED" | "REJECTED" }
  | { kind: "bulk"; action: "approve" | "reject" };

export function Reviews() {
  const { can } = useAuth();
  const canMod = can("reviews.moderate");
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("PENDING");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");
  const [toDelete, setToDelete] = useState<Review | { bulk: true } | null>(null);
  const q = useDebounced(search);

  const list = useQuery({
    queryKey: ["reviews", status, q, page],
    queryFn: () => api.get<Paginated<Review>>("/reviews", { status, q, page, pageSize: 20 }),
  });
  const refresh = () => {
    setSelected([]);
    void qc.invalidateQueries({ queryKey: ["reviews"] });
  };

  async function moderate() {
    if (!pending) return;
    try {
      if (pending.kind === "single") {
        await api.patch(`/reviews/${pending.review.id}/moderate`, {
          status: pending.status,
          ...(note.trim() ? { moderationNote: note.trim() } : {}),
        });
        toast.success(pending.status === "APPROVED" ? "Review approved" : "Review rejected");
      } else {
        const r = await api.post<{ affected: number }>("/reviews/bulk", {
          ids: selected,
          action: pending.action,
          ...(note.trim() ? { moderationNote: note.trim() } : {}),
        });
        toast.success(`${r.affected} review(s) updated`);
      }
      setPending(null);
      setNote("");
      refresh();
    } catch (e) {
      toast.error(e);
    }
  }

  const del = useMutation({
    mutationFn: async (t: Review | { bulk: true }) => {
      if ("bulk" in t) await api.post("/reviews/bulk", { ids: selected, action: "delete" });
      else await api.delete(`/reviews/${t.id}`);
    },
    onSuccess: () => {
      toast.success("Deleted");
      setToDelete(null);
      refresh();
    },
    onError: (e) => {
      toast.error(e);
      setToDelete(null);
    },
  });

  const items = list.data?.items ?? [];
  const allOn = items.length > 0 && items.every((r) => selected.includes(r.id));

  return (
    <>
      <PageHeader title="Reviews" subtitle="Moderate customer reviews before they appear" />
      <Tabs
        label="Review status"
        value={status}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
          setSelected([]);
        }}
        tabs={[
          { key: "PENDING", label: "Pending" },
          { key: "APPROVED", label: "Approved" },
          { key: "REJECTED", label: "Rejected" },
        ]}
      />
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search reviews"
        />
        {canMod && selected.length > 0 && (
          <span className="g-actions">
            <span className="muted">{selected.length} selected</span>
            <Button onClick={() => setPending({ kind: "bulk", action: "approve" })}>
              Approve selected
            </Button>
            <Button onClick={() => setPending({ kind: "bulk", action: "reject" })}>
              Reject selected
            </Button>
            <Button variant="danger" onClick={() => setToDelete({ bulk: true })}>
              Delete selected
            </Button>
          </span>
        )}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={`No ${status.toLowerCase()} reviews`} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Reviews</caption>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    {canMod && (
                      <input
                        type="checkbox"
                        aria-label="Select all reviews"
                        checked={allOn}
                        onChange={(e) =>
                          setSelected(e.target.checked ? items.map((r) => r.id) : [])
                        }
                      />
                    )}
                  </th>
                  <th>Review</th>
                  <th>Product</th>
                  <th>Rating</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {canMod && (
                        <input
                          type="checkbox"
                          aria-label={`Select review by ${r.authorName}`}
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id),
                            )
                          }
                        />
                      )}
                    </td>
                    <td>
                      <strong>{r.title || "(no title)"}</strong>
                      <div>{r.body}</div>
                      <small className="muted">
                        {r.authorName}
                        {r.authorEmail ? ` · ${r.authorEmail}` : ""}{" "}
                        {r.verifiedPurchase && <Badge tone="success">verified purchase</Badge>}
                      </small>
                      {r.moderationNote && (
                        <div>
                          <small className="muted">Note: {r.moderationNote}</small>
                        </div>
                      )}
                    </td>
                    <td>{r.product.title}</td>
                    <td>
                      <Stars rating={r.rating} />
                    </td>
                    <td>{formatDate(r.createdAt)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      {canMod && (
                        <span className="g-actions">
                          {r.status !== "APPROVED" && (
                            <Button
                              onClick={() =>
                                setPending({ kind: "single", review: r, status: "APPROVED" })
                              }
                              aria-label={`Approve review by ${r.authorName}`}
                            >
                              Approve
                            </Button>
                          )}
                          {r.status !== "REJECTED" && (
                            <Button
                              onClick={() =>
                                setPending({ kind: "single", review: r, status: "REJECTED" })
                              }
                              aria-label={`Reject review by ${r.authorName}`}
                            >
                              Reject
                            </Button>
                          )}
                          <Button
                            variant="danger"
                            onClick={() => setToDelete(r)}
                            aria-label={`Delete review by ${r.authorName}`}
                          >
                            Delete
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            total={list.data!.total}
            onPage={setPage}
          />
        </>
      )}
      {pending && (
        <Modal
          title={
            pending.kind === "single"
              ? pending.status === "APPROVED"
                ? "Approve review"
                : "Reject review"
              : pending.action === "approve"
                ? `Approve ${selected.length} reviews`
                : `Reject ${selected.length} reviews`
          }
          onClose={() => setPending(null)}
          footer={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void moderate()}>
                Confirm
              </Button>
            </>
          }
        >
          <TextArea
            label="Moderation note (optional)"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            hint="Internal only - not shown to customers"
          />
        </Modal>
      )}
      {toDelete && (
        <ConfirmDialog
          danger
          title="Delete review"
          message={
            "bulk" in toDelete
              ? `Permanently delete ${selected.length} selected reviews?`
              : "Permanently delete this review?"
          }
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={() => del.mutateAsync(toDelete)}
        />
      )}
    </>
  );
}
