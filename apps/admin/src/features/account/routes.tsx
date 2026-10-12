import { useState, type FormEvent } from "react";
import type { RouteObject } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import { Button, Card, PageHeader, TextField, useToast } from "../../components/ui";

function MyAccount() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (next.length < 10) errs.newPassword = "Use at least 10 characters";
    if (next !== confirm) errs.confirm = "Passwords do not match";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      toast.success("Password changed. Other sessions were signed out.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError)
        setErrors({
          ...err.fieldErrors(),
          ...(err.code === "VALIDATION_ERROR" && !Object.keys(err.fieldErrors()).length
            ? { currentPassword: err.message }
            : {}),
        });
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="My account" subtitle={`${user?.name} · ${user?.email}`} />
      <Card title="Change password">
        <form onSubmit={submit} className="form narrow" noValidate>
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            error={errors.currentPassword}
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={errors.newPassword}
            hint="At least 10 characters"
          />
          <TextField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors.confirm}
          />
          <Button variant="primary" type="submit" loading={busy}>
            Update password
          </Button>
        </form>
      </Card>
    </>
  );
}

export const routes: RouteObject[] = [{ path: "account", element: <MyAccount /> }];
