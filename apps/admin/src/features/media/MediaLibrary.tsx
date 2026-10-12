import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import type { MediaItem } from "../../components/MediaPicker";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SearchBox,
  Spinner,
  TextField,
  formatDate,
  useDebounced,
  useToast,
} from "../../components/ui";
import "./media.css";

interface Ref {
  entity: string;
  field: string;
  count: number;
}
type MediaDetail = MediaItem & { references?: Ref[] };

function size(b: number) {
  return b > 1_048_576
    ? `${(b / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;
}

export function MediaLibrary() {
  const { can } = useAuth();
  const canWrite = can("media.write");
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["media-list", q, page, "library"],
    queryFn: () => api.get<Paginated<MediaItem>>("/media", { q, page, pageSize: 24 }),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        await api.upload<MediaItem>("/media", fd);
      }
      return files.length;
    },
    onSuccess: (n) => {
      toast.success(`Uploaded ${n} file${n === 1 ? "" : "s"}`);
      void qc.invalidateQueries({ queryKey: ["media-list"] });
    },
    onError: (e) => {
      toast.error(e);
      void qc.invalidateQueries({ queryKey: ["media-list"] });
    },
  });

  return (
    <>
      <PageHeader
        title="Media library"
        subtitle="Images used across the storefront"
        actions={
          canWrite && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                aria-label="Upload image files"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) upload.mutate(files);
                  e.target.value = "";
                }}
              />
              <Button
                variant="primary"
                loading={upload.isPending}
                onClick={() => fileRef.current?.click()}
              >
                Upload images
              </Button>
            </>
          )
        }
      />
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search by filename or alt text"
        />
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState
          title="No images found"
          hint={canWrite ? "Upload an image to get started." : undefined}
        />
      ) : (
        <>
          <ul className="media-grid" aria-label="Media library">
            {list.data!.items.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="media-tile"
                  onClick={() => setOpenId(m.id)}
                  title={m.filename}
                >
                  <img src={m.url} alt={m.altText ?? m.filename} loading="lazy" />
                  <span>{m.filename}</span>
                </button>
              </li>
            ))}
          </ul>
          <Pagination
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            total={list.data!.total}
            onPage={setPage}
          />
        </>
      )}
      {openId && (
        <MediaDetailDialog id={openId} canWrite={canWrite} onClose={() => setOpenId(null)} />
      )}
    </>
  );
}

function MediaDetailDialog({
  id,
  canWrite,
  onClose,
}: {
  id: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [alt, setAlt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [blocked, setBlocked] = useState<{ message: string; refs: Ref[] } | null>(null);
  const q = useQuery({
    queryKey: ["media-detail", id],
    queryFn: () => api.get<MediaDetail>(`/media/${id}`),
  });
  const m = q.data;
  const altValue = alt ?? m?.altText ?? "";

  const saveAlt = useMutation({
    mutationFn: () => api.patch<MediaItem>(`/media/${id}`, { altText: altValue.trim() || null }),
    onSuccess: () => {
      toast.success("Alt text saved");
      void qc.invalidateQueries({ queryKey: ["media-list"] });
      void qc.invalidateQueries({ queryKey: ["media-detail", id] });
      void qc.invalidateQueries({ queryKey: ["media", id] });
    },
    onError: (e) => toast.error(e),
  });

  async function remove() {
    try {
      await api.delete(`/media/${id}`);
      toast.success("Image deleted");
      void qc.invalidateQueries({ queryKey: ["media-list"] });
      onClose();
    } catch (e) {
      setConfirm(false);
      if (e instanceof ApiError && e.status === 409) {
        setBlocked({
          message: e.message,
          refs: Array.isArray(e.details) ? (e.details as Ref[]) : [],
        });
      } else toast.error(e);
    }
  }

  return (
    <Modal
      wide
      title="Image details"
      onClose={onClose}
      footer={
        <>
          {canWrite && (
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : q.isError || !m ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="media-detail">
          <img src={m.url} alt={m.altText ?? m.filename} />
          <div className="g-stack">
            <dl className="media-meta">
              <dt>File</dt>
              <dd>{m.filename}</dd>
              <dt>Type</dt>
              <dd>
                {m.mimeType}
                {m.width && m.height ? ` · ${m.width}×${m.height}` : ""} · {size(m.sizeBytes)}
              </dd>
              <dt>Uploaded</dt>
              <dd>{formatDate(m.createdAt)}</dd>
              <dt>Used in</dt>
              <dd>
                {m.references?.length
                  ? m.references.map((r) => `${r.entity}.${r.field} (${r.count})`).join(", ")
                  : "Not used anywhere"}
              </dd>
            </dl>
            <TextField
              label="Alt text"
              value={altValue}
              maxLength={300}
              disabled={!canWrite}
              onChange={(e) => setAlt(e.target.value)}
              hint="Describe the image for screen readers and SEO"
            />
            {canWrite && (
              <div>
                <Button
                  variant="primary"
                  loading={saveAlt.isPending}
                  onClick={() => saveAlt.mutate()}
                >
                  Save alt text
                </Button>
              </div>
            )}
            {blocked && (
              <div className="alert-box" role="alert">
                <strong>{blocked.message}</strong>
                {blocked.refs.length > 0 && (
                  <ul>
                    {blocked.refs.map((r) => (
                      <li key={`${r.entity}.${r.field}`}>
                        {r.entity}.{r.field}: {r.count} reference{r.count === 1 ? "" : "s"}
                      </li>
                    ))}
                  </ul>
                )}
                <p>Remove the image from these places first, then delete it.</p>
              </div>
            )}
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          danger
          title="Delete image"
          message="Permanently delete this image? This cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirm(false)}
          onConfirm={remove}
        />
      )}
    </Modal>
  );
}
