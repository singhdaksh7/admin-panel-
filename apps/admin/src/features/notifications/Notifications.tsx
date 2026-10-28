import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
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
import { Tabs } from "../media/shared";

type SubTab = "templates" | "alerts" | "logs";

interface TemplateItem {
  event: string;
  channel: string;
  subject: string;
  body: string;
  html: string | null;
  isEnabled: boolean;
  isCustomized: boolean;
  description: string;
  defaultSubject: string;
  defaultBody: string;
  updatedAt: string | null;
}

interface AlertSettings {
  recipients: string[];
  events: Record<string, boolean>;
}

interface NotificationLogItem {
  id: string;
  event: string;
  channel: string;
  recipient: string;
  status: string;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  lastAttemptAt: string | null;
  createdAt: string;
}

const ALERT_EVENT_KEYS = [
  { key: "new_order", label: "New order placed" },
  { key: "payment_failed", label: "Payment failed" },
  { key: "cancelled", label: "Order cancelled" },
  { key: "shipped", label: "Shipment dispatched" },
  { key: "delivered", label: "Order delivered" },
  { key: "return_requested", label: "Return requested" },
  { key: "refund_initiated", label: "Refund initiated" },
  { key: "refund_completed", label: "Refund completed" },
];

export function Notifications() {
  const { can } = useAuth();
  const canWrite = can("settings.write");
  const toast = useToast();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<SubTab>("templates");

  // Selected template state
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [subjectInput, setSubjectInput] = useState("");
  const [bodyInput, setBodyInput] = useState("");
  const [htmlInput, setHtmlInput] = useState("");
  const [isEnabledInput, setIsEnabledInput] = useState(true);
  const [testEmailRecipient, setTestEmailRecipient] = useState("");
  const [previewData, setPreviewData] = useState<{ subject: string; body: string; html: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Queries
  const templatesQuery = useQuery({
    queryKey: ["notifications-templates"],
    queryFn: () => api.get<{ items: TemplateItem[] }>("/notifications/templates"),
  });

  const alertsQuery = useQuery({
    queryKey: ["notifications-alerts"],
    queryFn: () => api.get<AlertSettings>("/notifications/alerts"),
  });

  const [alertsState, setAlertsState] = useState<AlertSettings | null>(null);
  const [newRecipientInput, setNewRecipientInput] = useState("");

  const logsQuery = useQuery({
    queryKey: ["notifications-logs"],
    queryFn: () => api.get<{ items: NotificationLogItem[]; total: number }>("/notifications/logs"),
  });

  // Load template into editor
  function selectTemplate(t: TemplateItem) {
    setSelectedEvent(t.event);
    setSubjectInput(t.subject);
    setBodyInput(t.body);
    setHtmlInput(t.html || "");
    setIsEnabledInput(t.isEnabled);
    setPreviewData(null);
  }

  // Save template
  async function handleSaveTemplate() {
    if (!selectedEvent) return;
    setSaving(true);
    try {
      await api.put(`/notifications/templates/${selectedEvent}`, {
        subject: subjectInput,
        body: bodyInput,
        html: htmlInput.trim() ? htmlInput : null,
        isEnabled: isEnabledInput,
      });
      toast.success("Template saved");
      void qc.invalidateQueries({ queryKey: ["notifications-templates"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  // Preview template
  async function handlePreviewTemplate() {
    if (!selectedEvent) return;
    try {
      const res = await api.post<{ subject: string; body: string; html: string }>(
        `/notifications/templates/${selectedEvent}/preview`,
        {
          subject: subjectInput,
          body: bodyInput,
          html: htmlInput.trim() ? htmlInput : undefined,
        },
      );
      setPreviewData(res);
    } catch (e) {
      toast.error(e);
    }
  }

  // Send test email
  async function handleSendTestEmail() {
    if (!selectedEvent || !testEmailRecipient) return;
    setTesting(true);
    try {
      await api.post(`/notifications/templates/${selectedEvent}/test`, {
        recipient: testEmailRecipient,
        subject: subjectInput,
        body: bodyInput,
      });
      toast.success(`Test email sent to ${testEmailRecipient}`);
      void qc.invalidateQueries({ queryKey: ["notifications-logs"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(false);
    }
  }

  // Reset template
  async function handleResetTemplate() {
    if (!selectedEvent) return;
    try {
      await api.post(`/notifications/templates/${selectedEvent}/reset`);
      toast.success("Template restored to system default");
      void qc.invalidateQueries({ queryKey: ["notifications-templates"] });
      setSelectedEvent(null);
    } catch (e) {
      toast.error(e);
    }
  }

  // Alerts state syncing
  const currentAlerts = alertsState ?? alertsQuery.data ?? { recipients: [], events: {} };

  async function handleSaveAlerts() {
    setSaving(true);
    try {
      await api.put("/notifications/alerts", currentAlerts);
      toast.success("Alert settings saved");
      void qc.invalidateQueries({ queryKey: ["notifications-alerts"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  // Retry log
  async function handleRetryLog(id: string) {
    try {
      await api.post(`/notifications/logs/${id}/retry`);
      toast.success("Notification retried successfully");
      void qc.invalidateQueries({ queryKey: ["notifications-logs"] });
    } catch (e) {
      toast.error(e);
    }
  }

  return (
    <>
      <PageHeader
        title="Transactional notifications"
        subtitle="Customer email templates, internal admin alerts, and delivery audit logs"
      />

      <Tabs
        label="Notification sections"
        tabs={[
          { key: "templates", label: "Email templates" },
          { key: "alerts", label: "Internal admin alerts" },
          { key: "logs", label: "Delivery logs" },
        ]}
        value={activeTab}
        onChange={(k) => setActiveTab(k as SubTab)}
      />

      {/* ───────── Templates Tab ───────── */}
      {activeTab === "templates" && (
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 24, marginTop: 16 }}>
          <Card title="Event templates">
            {templatesQuery.isLoading && <Spinner />}
            {templatesQuery.isError && <ErrorState error={templatesQuery.error} />}
            {templatesQuery.data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {templatesQuery.data.items.map((t) => (
                  <button
                    key={t.event}
                    type="button"
                    onClick={() => selectTemplate(t)}
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 6,
                      border: selectedEvent === t.event ? "1px solid var(--color-primary, #2563eb)" : "1px solid #e5e7eb",
                      background: selectedEvent === t.event ? "#eff6ff" : "#ffffff",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{t.event}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{t.description}</div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      {t.isCustomized ? <Badge tone="info">Customized</Badge> : <Badge tone="neutral">Default</Badge>}
                      {!t.isEnabled && <Badge tone="danger">Disabled</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <div>
            {!selectedEvent ? (
              <Card>
                <EmptyState title="Select a template" hint="Choose an event on the left to edit, preview, or send a test email." />
              </Card>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Card title={`Edit Template: ${selectedEvent}`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <CheckField
                      label="Template enabled"
                      checked={isEnabledInput}
                      onChange={(e) => setIsEnabledInput(e.target.checked)}
                    />
                    <TextField
                      label="Subject line"
                      value={subjectInput}
                      onChange={(e) => setSubjectInput(e.target.value)}
                      hint="Supports {{storeName}}, {{orderNumber}}, {{customerName}}, etc."
                    />
                    <TextArea
                      label="Plain text message"
                      value={bodyInput}
                      rows={5}
                      onChange={(e) => setBodyInput(e.target.value)}
                      hint="Fallback text message sent to email clients without HTML support."
                    />
                    <TextArea
                      label="Custom HTML template (optional)"
                      value={htmlInput}
                      rows={8}
                      onChange={(e) => setHtmlInput(e.target.value)}
                      hint="Leave empty to automatically use the responsive, brand-styled default HTML layout."
                    />

                    <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                      {canWrite && (
                        <Button variant="primary" loading={saving} onClick={handleSaveTemplate}>
                          Save template
                        </Button>
                      )}
                      <Button variant="secondary" onClick={handlePreviewTemplate}>
                        Preview email
                      </Button>
                      {canWrite && (
                        <Button variant="danger" onClick={handleResetTemplate}>
                          Restore default
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>

                {previewData && (
                  <Card title={`Live Preview: ${previewData.subject}`}>
                    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, background: "#f9fafb" }}>
                      <iframe
                        title="Email Preview"
                        srcDoc={previewData.html}
                        style={{ width: "100%", height: 420, border: "none", background: "#ffffff", borderRadius: 6 }}
                      />
                    </div>
                  </Card>
                )}

                <Card title="Send test email">
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Recipient email"
                        placeholder="admin@example.com"
                        value={testEmailRecipient}
                        onChange={(e) => setTestEmailRecipient(e.target.value)}
                      />
                    </div>
                    <Button variant="secondary" loading={testing} onClick={handleSendTestEmail} disabled={!testEmailRecipient}>
                      Send test
                    </Button>
                  </div>
                </Card>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ───────── Internal Alerts Tab ───────── */}
      {activeTab === "alerts" && (
        <div style={{ maxWidth: 680, marginTop: 16 }}>
          <Card title="Internal store alert settings">
            {alertsQuery.isLoading && <Spinner />}
            {alertsQuery.isError && <ErrorState error={alertsQuery.error} />}
            {alertsQuery.data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>
                    Alert recipients (Admin notification emails)
                  </label>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="New recipient"
                        placeholder="alerts@yourstore.com"
                        value={newRecipientInput}
                        onChange={(e) => setNewRecipientInput(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        const email = newRecipientInput.trim().toLowerCase();
                        if (email && !currentAlerts.recipients.includes(email)) {
                          setAlertsState({
                            ...currentAlerts,
                            recipients: [...currentAlerts.recipients, email],
                          });
                          setNewRecipientInput("");
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {currentAlerts.recipients.length === 0 ? (
                      <span style={{ fontSize: 12, color: "#6b7280" }}>No recipient emails configured yet.</span>
                    ) : (
                      currentAlerts.recipients.map((email) => (
                        <span
                          key={email}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "4px 10px",
                            borderRadius: 16,
                            background: "#e5e7eb",
                            fontSize: 12,
                          }}
                        >
                          {email}
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() => {
                                setAlertsState({
                                  ...currentAlerts,
                                  recipients: currentAlerts.recipients.filter((r) => r !== email),
                                });
                              }}
                              style={{ border: "none", background: "none", cursor: "pointer", fontWeight: 700 }}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 10 }}>
                    Event notification triggers
                  </label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {ALERT_EVENT_KEYS.map((evt) => (
                      <CheckField
                        key={evt.key}
                        label={evt.label}
                        checked={currentAlerts.events[evt.key] !== false}
                        onChange={(e) => {
                          setAlertsState({
                            ...currentAlerts,
                            events: { ...currentAlerts.events, [evt.key]: e.target.checked },
                          });
                        }}
                      />
                    ))}
                  </div>
                </div>

                {canWrite && (
                  <div style={{ marginTop: 12 }}>
                    <Button variant="primary" loading={saving} onClick={handleSaveAlerts}>
                      Save alert settings
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ───────── Delivery Logs Tab ───────── */}
      {activeTab === "logs" && (
        <div style={{ marginTop: 16 }}>
          <Card title="Notification delivery logs">
            {logsQuery.isLoading && <Spinner />}
            {logsQuery.isError && <ErrorState error={logsQuery.error} />}
            {logsQuery.data && (
              <div>
                {logsQuery.data.items.length === 0 ? (
                  <EmptyState title="No logs yet" hint="Transactional emails will be recorded here with delivery statuses." />
                ) : (
                  <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e5e7eb", textAlign: "left", color: "#6b7280" }}>
                        <th style={{ padding: "8px 12px" }}>Event</th>
                        <th style={{ padding: "8px 12px" }}>Recipient</th>
                        <th style={{ padding: "8px 12px" }}>Status</th>
                        <th style={{ padding: "8px 12px" }}>Retries</th>
                        <th style={{ padding: "8px 12px" }}>Date</th>
                        <th style={{ padding: "8px 12px", textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logsQuery.data.items.map((log) => (
                        <tr key={log.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "10px 12px", fontWeight: 600 }}>{log.event}</td>
                          <td style={{ padding: "10px 12px" }}>{log.recipient}</td>
                          <td style={{ padding: "10px 12px" }}>
                            {log.status === "SENT" ? (
                              <Badge tone="success">SENT</Badge>
                            ) : log.status === "FAILED" ? (
                              <Badge tone="danger">FAILED</Badge>
                            ) : (
                              <Badge tone="neutral">{log.status}</Badge>
                            )}
                            {log.error && (
                              <div style={{ fontSize: 11, color: "#dc2626", marginTop: 2 }}>{log.error}</div>
                            )}
                          </td>
                          <td style={{ padding: "10px 12px" }}>
                            {log.retryCount} / {log.maxRetries}
                          </td>
                          <td style={{ padding: "10px 12px", color: "#6b7280", fontSize: 12 }}>
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          <td style={{ padding: "10px 12px", textAlign: "right" }}>
                            {log.status === "FAILED" && canWrite && (
                              <Button variant="secondary" onClick={() => handleRetryLog(log.id)}>
                                Retry
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
