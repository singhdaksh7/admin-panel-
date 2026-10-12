import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Paginated } from "../../lib/api";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Spinner,
  formatDate,
  useDebounced,
} from "../../components/ui";

interface AuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: unknown;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
}

const ENTITY_TYPES = [
  "AdminUser",
  "BlogPost",
  "Category",
  "Collection",
  "Coupon",
  "FilterGroup",
  "IntegrationSetting",
  "Media",
  "NavigationMenu",
  "Order",
  "Page",
  "PageSection",
  "Product",
  "Review",
  "Role",
  "StoreSettings",
];

export function AuditLogs() {
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actorId, setActorId] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const a = useDebounced(action);
  const actor = useDebounced(actorId);
  const list = useQuery({
    queryKey: ["audit", a, entityType, actor, page],
    queryFn: () =>
      api.get<Paginated<AuditEntry>>("/audit-logs", {
        action: a,
        entityType,
        actorId: actor,
        page,
        pageSize: 50,
      }),
  });
  return (
    <>
      <PageHeader title="Audit logs" subtitle="Who changed what, and when" />
      <div className="toolbar">
        <input
          className="search"
          aria-label="Filter by action"
          placeholder="Action contains… (e.g. coupon.)"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Filter by entity type"
          value={entityType}
          onChange={(e) => {
            setEntityType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All entity types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="search"
          aria-label="Filter by actor ID"
          placeholder="Actor ID"
          value={actorId}
          onChange={(e) => {
            setActorId(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        <EmptyState title="No audit entries match" />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Audit log entries</caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data!.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td>{formatDate(e.createdAt)}</td>
                      <td>{e.actorEmail ?? e.actorId ?? "system"}</td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td>
                        {e.entityType}
                        {e.entityId ? <span className="muted"> · {e.entityId}</span> : null}
                      </td>
                      <td>
                        <Button
                          aria-expanded={open === e.id}
                          onClick={() => setOpen(open === e.id ? null : e.id)}
                        >
                          {open === e.id ? "Hide" : "Details"}
                        </Button>
                      </td>
                    </tr>
                    {open === e.id && (
                      <tr>
                        <td colSpan={5}>
                          <pre className="g-pre" aria-label="Audit summary">
                            {JSON.stringify(e.summary ?? {}, null, 2)}
                          </pre>
                          <small className="muted">
                            {e.ip ? `IP ${e.ip}` : ""}{" "}
                            {e.requestId ? `· request ${e.requestId}` : ""}
                          </small>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
    </>
  );
}
