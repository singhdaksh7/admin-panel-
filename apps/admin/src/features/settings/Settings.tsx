import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../auth/AuthContext";
import {
  Button,
  Card,
  CheckField,
  ErrorState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from "../../components/ui";
import { ImageField, Tabs, handleSaveError, type FieldErrors } from "../media/shared";
import {
  FEATURE_FLAGS,
  SOCIAL_KEYS,
  TAX_MODES,
  buildPayload,
  isTabDirty,
  toState,
  validateTab,
  type SettingsState,
  type TabKey,
} from "./model";

const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "General" },
  { key: "locale", label: "Locale & currency" },
  { key: "tax", label: "Tax" },
  { key: "checkout", label: "Checkout" },
  { key: "features", label: "Feature flags" },
  { key: "social", label: "Social links" },
];

export function Settings() {
  const { can } = useAuth();
  const canWrite = can("settings.write");
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("general");
  const [base, setBase] = useState<SettingsState | null>(null);
  const [cur, setCur] = useState<SettingsState | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["settings-full"],
    queryFn: () => api.get<Record<string, unknown>>("/settings"),
  });
  useEffect(() => {
    if (q.data) {
      const s = toState(q.data);
      setBase(s);
      setCur(s);
    }
  }, [q.data]);

  if (q.isLoading || !base || !cur) {
    return q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : <Spinner />;
  }

  const set = (p: Partial<SettingsState>) => setCur({ ...cur, ...p });
  const dirty = isTabDirty(tab, base, cur);

  async function save() {
    if (!base || !cur) return;
    const errs = validateTab(tab, cur);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const payload = buildPayload(tab, base, cur);
    if (!Object.keys(payload).length) return;
    setBusy(true);
    try {
      const res = await api.put<Record<string, unknown>>("/settings", payload);
      const next = toState(res);
      // only adopt the saved tab; keep unsaved edits on other tabs
      setBase((b) => ({ ...(b as SettingsState), ...pick(tab, next) }));
      setCur((c) => ({ ...(c as SettingsState), ...pick(tab, next) }));
      toast.success("Settings saved");
      void qc.invalidateQueries({ queryKey: ["store-settings"] });
      void qc.invalidateQueries({ queryKey: ["settings-full"] });
    } catch (e) {
      handleSaveError(e, setErrors, toast);
    } finally {
      setBusy(false);
    }
  }

  const ro = !canWrite;
  return (
    <>
      <PageHeader
        title="Store settings"
        subtitle="Identity, locale, tax, checkout and feature flags"
      />
      <Tabs
        label="Settings sections"
        tabs={TABS.map((t) => ({
          ...t,
          badge: isTabDirty(t.key, base, cur) ? (
            <span aria-label="unsaved changes">•</span>
          ) : undefined,
        }))}
        value={tab}
        onChange={(k) => {
          setTab(k);
          setErrors({});
        }}
      />
      <Card>
        <form
          className="g-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="g-stack">
            {tab === "general" && (
              <>
                <div className="form-grid">
                  <TextField
                    label="Store name"
                    value={cur.name}
                    onChange={(e) => set({ name: e.target.value })}
                    error={errors.name}
                  />
                  <TextField
                    label="Legal name"
                    value={cur.legalName}
                    onChange={(e) => set({ legalName: e.target.value })}
                    error={errors.legalName}
                  />
                  <TextField
                    label="Support email"
                    type="email"
                    value={cur.supportEmail}
                    onChange={(e) => set({ supportEmail: e.target.value })}
                    error={errors.supportEmail}
                  />
                  <TextField
                    label="Phone"
                    value={cur.phone}
                    onChange={(e) => set({ phone: e.target.value })}
                    error={errors.phone}
                  />
                </div>
                <div className="form-grid">
                  <ImageField
                    label="Logo"
                    value={cur.logoMediaId}
                    onChange={(id) => set({ logoMediaId: id })}
                    error={errors.logoMediaId}
                  />
                  <ImageField
                    label="Favicon"
                    value={cur.faviconMediaId}
                    onChange={(id) => set({ faviconMediaId: id })}
                    error={errors.faviconMediaId}
                  />
                </div>
                <h2>Business address</h2>
                <div className="form-grid">
                  {(
                    [
                      ["line1", "Address line 1"],
                      ["line2", "Address line 2"],
                      ["city", "City"],
                      ["state", "State / region"],
                      ["postalCode", "Postal code"],
                      ["country", "Country (2-letter code)"],
                    ] as const
                  ).map(([k, label]) => (
                    <TextField
                      key={k}
                      label={label}
                      value={cur.address[k]}
                      maxLength={k === "country" ? 2 : undefined}
                      onChange={(e) =>
                        set({
                          address: {
                            ...cur.address,
                            [k]: k === "country" ? e.target.value.toUpperCase() : e.target.value,
                          },
                        })
                      }
                      error={errors[`address.${k}`]}
                    />
                  ))}
                </div>
              </>
            )}
            {tab === "locale" && (
              <div className="form-grid">
                <TextField
                  label="Currency (ISO 4217)"
                  value={cur.currency}
                  maxLength={3}
                  onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
                  error={errors.currency}
                  hint="Changing currency does not convert existing prices"
                />
                <TextField
                  label="Locale"
                  value={cur.locale}
                  onChange={(e) => set({ locale: e.target.value })}
                  error={errors.locale}
                  hint="e.g. en-US, en-IN"
                />
                <TextField
                  label="Timezone"
                  value={cur.timezone}
                  onChange={(e) => set({ timezone: e.target.value })}
                  error={errors.timezone}
                  list="tz-list"
                  hint="IANA name, e.g. Asia/Kolkata"
                />
                <datalist id="tz-list">
                  {timezones().map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </div>
            )}
            {tab === "tax" && (
              <div className="form-grid">
                <SelectField
                  label="Tax mode"
                  value={cur.tax.mode}
                  onChange={(e) => set({ tax: { ...cur.tax, mode: e.target.value } })}
                  options={TAX_MODES.map((m) => ({
                    value: m,
                    label: {
                      NONE: "No tax",
                      EXCLUSIVE: "Tax added to prices",
                      INCLUSIVE: "Prices include tax",
                      INDIA_GST: "India GST",
                    }[m],
                  }))}
                />
                <TextField
                  label="Default tax rate (%)"
                  inputMode="decimal"
                  value={cur.tax.defaultRate}
                  onChange={(e) => set({ tax: { ...cur.tax, defaultRate: e.target.value } })}
                  error={errors["tax.defaultRate"]}
                />
                <TextField
                  label="GSTIN"
                  value={cur.tax.gstin}
                  onChange={(e) =>
                    set({ tax: { ...cur.tax, gstin: e.target.value.toUpperCase() } })
                  }
                  error={errors["tax.gstin"]}
                />
                <TextField
                  label="Home state"
                  value={cur.tax.homeState}
                  onChange={(e) => set({ tax: { ...cur.tax, homeState: e.target.value } })}
                  error={errors["tax.homeState"]}
                  hint="Used to split CGST/SGST vs IGST"
                />
              </div>
            )}
            {tab === "checkout" && (
              <>
                <CheckField
                  label="Allow guest checkout"
                  checked={cur.checkout.guestCheckout}
                  onChange={(e) =>
                    set({ checkout: { ...cur.checkout, guestCheckout: e.target.checked } })
                  }
                />
                <CheckField
                  label="Require phone number"
                  checked={cur.checkout.requirePhone}
                  onChange={(e) =>
                    set({ checkout: { ...cur.checkout, requirePhone: e.target.checked } })
                  }
                />
                <div className="form-grid">
                  <TextField
                    label="Minimum order amount"
                    inputMode="decimal"
                    value={cur.checkout.minOrderAmount}
                    onChange={(e) =>
                      set({ checkout: { ...cur.checkout, minOrderAmount: e.target.value } })
                    }
                    error={errors["checkout.minOrderAmount"]}
                  />
                  <TextField
                    label="Order number prefix"
                    value={cur.checkout.orderPrefix}
                    maxLength={10}
                    onChange={(e) =>
                      set({ checkout: { ...cur.checkout, orderPrefix: e.target.value } })
                    }
                    error={errors["checkout.orderPrefix"]}
                  />
                  <TextField
                    label="Invoice prefix"
                    value={cur.checkout.invoicePrefix}
                    maxLength={10}
                    onChange={(e) =>
                      set({ checkout: { ...cur.checkout, invoicePrefix: e.target.value } })
                    }
                    error={errors["checkout.invoicePrefix"]}
                  />
                  <TextField
                    label="Return window (days)"
                    inputMode="numeric"
                    value={cur.checkout.returnWindowDays}
                    onChange={(e) =>
                      set({ checkout: { ...cur.checkout, returnWindowDays: e.target.value } })
                    }
                    error={errors["checkout.returnWindowDays"]}
                  />
                </div>
              </>
            )}
            {tab === "features" && (
              <>
                <p className="muted">Turn storefront capabilities on or off.</p>
                {FEATURE_FLAGS.map(([k, label]) => (
                  <CheckField
                    key={k}
                    label={label}
                    checked={cur.features[k]}
                    onChange={(e) => set({ features: { ...cur.features, [k]: e.target.checked } })}
                  />
                ))}
              </>
            )}
            {tab === "social" && (
              <div className="form-grid">
                {Array.from(new Set([...SOCIAL_KEYS, ...Object.keys(cur.social)])).map((k) => (
                  <TextField
                    key={k}
                    label={k[0]!.toUpperCase() + k.slice(1)}
                    type="url"
                    placeholder="https://"
                    value={cur.social[k] ?? ""}
                    onChange={(e) => set({ social: { ...cur.social, [k]: e.target.value } })}
                    error={errors[`social.${k}`]}
                  />
                ))}
              </div>
            )}
          </fieldset>
          {canWrite ? (
            <div className="g-actions">
              <Button variant="primary" type="submit" loading={busy} disabled={!dirty}>
                Save changes
              </Button>
              {dirty && (
                <Button type="button" onClick={() => setCur({ ...cur, ...pick(tab, base) })}>
                  Discard
                </Button>
              )}
            </div>
          ) : (
            <p className="muted">You have read-only access to settings.</p>
          )}
        </form>
      </Card>
    </>
  );
}

function pick(tab: TabKey, s: SettingsState): Partial<SettingsState> {
  switch (tab) {
    case "general":
      return {
        name: s.name,
        legalName: s.legalName,
        logoMediaId: s.logoMediaId,
        faviconMediaId: s.faviconMediaId,
        supportEmail: s.supportEmail,
        phone: s.phone,
        address: s.address,
      };
    case "locale":
      return { currency: s.currency, locale: s.locale, timezone: s.timezone };
    case "tax":
      return { tax: s.tax };
    case "checkout":
      return { checkout: s.checkout };
    case "features":
      return { features: s.features };
    case "social":
      return { social: s.social };
  }
}

function timezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    return fn ? fn("timeZone") : ["UTC"];
  } catch {
    return ["UTC"];
  }
}
