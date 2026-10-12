import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Paginated } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import {
  Button,
  EmptyState,
  ErrorState,
  Modal,
  Pagination,
  SearchBox,
  Spinner,
  useDebounced,
  useToast,
} from "./ui";

export interface MediaItem {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  createdAt: string;
}

/** Resolve a media id to its image (cached). Renders a placeholder when id is empty. */
export function MediaThumb({ id, size = 56 }: { id?: string | null; size?: number }) {
  const q = useQuery({
    queryKey: ["media", id],
    queryFn: () => api.get<MediaItem>(`/media/${id}`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
  const style = {
    width: size,
    height: size,
    objectFit: "cover" as const,
    borderRadius: 6,
    background: "var(--border)",
  };
  if (!id || q.isError) return <div style={style} aria-hidden="true" />;
  if (!q.data) return <div style={style} aria-hidden="true" />;
  return <img src={q.data.url} alt={q.data.altText ?? ""} style={style} loading="lazy" />;
}

/**
 * Modal media browser. `multiple` returns several ids. Upload happens inline (needs media.write).
 * onSelect receives the chosen MediaItem(s); the caller stores ids.
 */
export function MediaPicker({
  multiple = false,
  onSelect,
  onClose,
}: {
  multiple?: boolean;
  onSelect: (items: MediaItem[]) => void;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<MediaItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(search);

  const list = useQuery({
    queryKey: ["media-list", q, page],
    queryFn: () => api.get<Paginated<MediaItem>>("/media", { q, page, pageSize: 24 }),
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.upload<MediaItem>("/media", fd);
    },
    onSuccess: (m) => {
      toast.success(`Uploaded ${m.filename}`);
      void qc.invalidateQueries({ queryKey: ["media-list"] });
      setPicked((p) => (multiple ? [...p, m] : [m]));
    },
    onError: (e) => toast.error(e),
  });

  function toggle(m: MediaItem) {
    setPicked((p) => {
      const has = p.some((x) => x.id === m.id);
      if (!multiple) return has ? [] : [m];
      return has ? p.filter((x) => x.id !== m.id) : [...p, m];
    });
  }

  return (
    <Modal
      title={multiple ? "Choose images" : "Choose an image"}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">{picked.length} selected</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked.length} onClick={() => onSelect(picked)}>
            Use selected
          </Button>
        </>
      }
    >
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search media"
        />
        {can("media.write") && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              hidden
              aria-label="Upload image file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
            <Button loading={upload.isPending} onClick={() => fileRef.current?.click()}>
              Upload image
            </Button>
          </>
        )}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState title="No images yet" hint="Upload an image to get started." />
      ) : (
        <>
          <ul className="media-grid" aria-label="Media library">
            {list.data!.items.map((m) => {
              const on = picked.some((x) => x.id === m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className={`media-tile${on ? " selected" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggle(m)}
                    onDoubleClick={() => !multiple && onSelect([m])}
                    title={m.filename}
                  >
                    <img src={m.url} alt={m.altText ?? m.filename} loading="lazy" />
                    <span>{m.filename}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Pagination
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            total={list.data!.total}
            onPage={setPage}
          />
        </>
      )}
    </Modal>
  );
}
