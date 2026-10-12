import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  CheckField,
  EmptyState,
  ErrorState,
  PageHeader,
  Spinner,
  TextArea,
  TextField,
  useToast,
} from "../../components/ui";
import "./integrations.css";

export interface IntegrationItem {
  kind: string;
  provider: string;
  enabled: boolean;
  isActive: boolean;
  config: Record<string, unknown>;
  secretsConfigured?: Record<string, boolean>;
}

const KINDS: { kind: string; label: string; hint: string }[] = [
  { kind: "PAYMENT", label: "Payments", hint: "How customers pay" },
  { kind: "SHIPPING", label: "Shipping", hint: "Rates and carriers" },
  { kind: "NOTIFICATION", label: "Notifications", hint: "Email and messaging" },
  { kind: "STORAGE", label: "Storage", hint: "Where uploaded files live" },
];

export const SECRET_NOTE =
  "Secrets are configured via environment variables on the server — they are never shown or stored here.";
/** Mirrors the server guard: keys that look like secrets cannot be stored in config. */
export const SECRET_KEY_RE = /secret|password|passwd|token|api[_-]?key|private[_-]?key|credential/i;

interface Row {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  value: string;
}
function toRows(config: Record<string, unknown>): Row[] {
  return Object.entries(config ?? {}).map(([key, v]) => {
    if (typeof v === "boolean") return { key, type: "boolean", value: String(v) };
    if (typeof v === "number") return { key, type: "number", value: String(v) };
    if (typeof v === "string") return { key, type: "string", value: v };
    return { key, type: "json", value: JSON.stringify(v ?? null) };
  });
}
export function rowsToConfig(rows: Row[]): {
  config: Record<string, unknown>;
  errors: Record<string, string>;
} {
  const config: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const r of rows) {
    if (r.type === "boolean") config[r.key] = r.value === "true";
    else if (r.type === "number") {
      const n = Number(r.value);
      if (r.value.trim() === "" || Number.isNaN(n)) errors[r.key] = "Enter a number";
      else config[r.key] = n;
    } else if (r.type === "json") {
      try {
        config[r.key] = JSON.parse(r.value);
      } catch {
        errors[r.key] = "Invalid JSON";
      }
    } else config[r.key] = r.value;
  }
  return { config, errors };
}

export function Integrations() {
  const q = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => {
      try {
        const r = await api.get<{ items: IntegrationItem[] } | IntegrationItem[]>("/integrations");
        return Array.isArray(r) ? r : (r.items ?? []);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Payment, shipping, notification and storage providers"
      />
      <div className="alert-box" role="note">
        <strong>About secrets</strong>
        <p style={{ margin: "4px 0 0" }}>{SECRET_NOTE}</p>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data === null ? (
        <EmptyState
          title="Integrations are not available yet"
          hint="The server does not expose the integrations endpoint."
        />
      ) : (
        KINDS.map((k) => {
          const items = (q.data ?? []).filter((i) => i.kind === k.kind);
          return (
            <section key={k.kind} aria-label={k.label} className="int-section">
              <h2>{k.label}</h2>
              <p className="muted">{k.hint}</p>
              {items.length === 0 ? (
                <EmptyState title={`No ${k.label.toLowerCase()} providers`} />
              ) : (
                <div className="int-grid">
                  {items.map((i) => (
                    <ProviderCard key={`${i.kind}:${i.provider}`} item={i} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

function ProviderCard({ item }: { item: IntegrationItem }) {
  const { can } = useAuth();
  const canManage = can("integrations.manage");
  const toast = useToast();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(item.enabled);
  const [rows, setRows] = useState<Row[]>(toRows(item.config));
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const secrets = Object.entries(item.secretsConfigured ?? {});

  function addField() {
    const key = newKey.trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/.test(key)) {
      setErrors({ _new: "Use a field name made of letters, digits, _ . or -" });
      return;
    }
    if (SECRET_KEY_RE.test(key)) {
      setErrors({
        _new: "That name looks like a secret. Secrets must be set as server environment variables.",
      });
      return;
    }
    if (rows.some((r) => r.key === key)) {
      setErrors({ _new: "Field already exists" });
      return;
    }
    setRows([...rows, { key, type: "string", value: newVal }]);
    setNewKey("");
    setNewVal("");
    setErrors({});
  }

  async function save() {
    const { config, errors: errs } = rowsToConfig(rows);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.put(`/integrations/${item.kind}/${item.provider}`, { enabled, config });
      toast.success(`${item.provider} saved`);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        const fe = e.fieldErrors();
        setErrors(
          Object.keys(fe).length ? { _new: Object.values(fe).join("; ") } : { _new: e.message },
        );
      } else toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, value } : r)));

  return (
    <Card title={item.provider}>
      <div className="g-actions" style={{ marginBottom: 8 }}>
        <Badge tone={item.isActive ? "success" : "neutral"}>
          {item.isActive ? "Active (set by environment)" : "Not active"}
        </Badge>
        <Badge tone={enabled ? "info" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
      </div>
      <fieldset
        disabled={!canManage}
        style={{ border: 0, padding: 0, margin: 0 }}
        className="g-stack"
      >
        <CheckField
          label={`Enable ${item.provider}`}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {rows.map((r) =>
          r.type === "boolean" ? (
            <CheckField
              key={r.key}
              label={r.key}
              checked={r.value === "true"}
              onChange={(e) => set(r.key, String(e.target.checked))}
            />
          ) : r.type === "json" ? (
            <TextArea
              key={r.key}
              label={r.key}
              rows={3}
              value={r.value}
              onChange={(e) => set(r.key, e.target.value)}
              error={errors[r.key]}
            />
          ) : (
            <TextField
              key={r.key}
              label={r.key}
              type={r.type === "number" ? "number" : "text"}
              value={r.value}
              onChange={(e) => set(r.key, e.target.value)}
              error={errors[r.key]}
              autoComplete="off"
            />
          ),
        )}
        {canManage && (
          <div className="int-add">
            <TextField
              label="New field name"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoComplete="off"
              error={errors._new}
            />
            <TextField
              label="New field value"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              autoComplete="off"
            />
            <Button type="button" onClick={addField}>
              Add field
            </Button>
          </div>
        )}
      </fieldset>
      <h3 className="int-h3">Secrets</h3>
      {secrets.length === 0 ? (
        <p className="muted">No secrets are required for this provider.</p>
      ) : (
        <ul className="int-secrets" aria-label={`${item.provider} secrets status`}>
          {secrets.map(([name, ok]) => (
            <li key={name}>
              <code>{name}</code>{" "}
              <Badge tone={ok ? "success" : "danger"}>
                {ok ? "configured: yes" : "configured: no"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">{SECRET_NOTE}</p>
      {canManage && (
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {`Save ${item.provider}`}
        </Button>
      )}
    </Card>
  );
}
