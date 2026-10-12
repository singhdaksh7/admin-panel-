import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Paginated } from "../../lib/api";
import { Can, useAuth } from "../../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  CheckField,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from "../../components/ui";
import { ImageField, categoryOptions, useCategories, useCollections } from "../media/shared";
import {
  MAX_DEPTH,
  addChild,
  blankNode,
  blankPromo,
  find,
  flatten,
  fromApi,
  indentNode,
  moveNode,
  outdentNode,
  removeNode,
  toApi,
  updateNode,
  validateTree,
  type ApiNavItem,
  type NavNode,
  type NavType,
} from "./tree";
import "./navigation.css";

interface MenuSummary {
  id: string;
  key: string;
  name: string;
  itemCount: number;
}
interface MenuFull {
  key: string;
  name: string;
  items: ApiNavItem[];
}

const TYPE_OPTIONS: { value: NavType; label: string }[] = [
  { value: "LINK", label: "Custom link" },
  { value: "CATEGORY", label: "Category" },
  { value: "COLLECTION", label: "Collection" },
  { value: "PAGE", label: "Page" },
  { value: "MEGA", label: "Mega menu" },
];
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function Navigation() {
  const { can } = useAuth();
  const canWrite = can("navigation.write");
  const toast = useToast();
  const qc = useQueryClient();
  const [menuKey, setMenuKey] = useState("header");
  const [name, setName] = useState("");
  const [tree, setTree] = useState<NavNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiErrors, setApiErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const menus = useQuery({
    queryKey: ["nav-menus"],
    queryFn: () => api.get<{ items: MenuSummary[] }>("/navigation"),
  });
  const menu = useQuery({
    queryKey: ["nav-menu", menuKey],
    queryFn: async (): Promise<MenuFull> => {
      try {
        return await api.get<MenuFull>(`/navigation/${menuKey}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404)
          return { key: menuKey, name: menuKey, items: [] };
        throw e;
      }
    },
  });
  useEffect(() => {
    if (!menu.data) return;
    setTree(fromApi(menu.data.items));
    setName(menu.data.name);
    setSelected(null);
    setErrors({});
    setApiErrors([]);
    setDirty(false);
  }, [menu.data]);

  const keys = Array.from(
    new Set(["header", "footer", ...(menus.data?.items.map((m) => m.key) ?? [])]),
  );

  function change(next: NavNode[] | null) {
    if (!next) return;
    setTree(next);
    setDirty(true);
  }
  function switchMenu(k: string) {
    if (dirty && !window.confirm("Discard unsaved changes to this menu?")) return;
    setMenuKey(k);
  }
  function addMenu() {
    const k = newKey.trim().toLowerCase();
    if (!KEY_RE.test(k)) {
      toast.error(new Error("Menu key must be lowercase letters, digits, - or _"));
      return;
    }
    setNewKey("");
    switchMenu(k);
  }

  async function save() {
    const errs = validateTree(tree);
    setErrors(errs);
    setApiErrors([]);
    if (Object.keys(errs).length) {
      toast.error(new Error("Fix the highlighted menu items before saving"));
      return;
    }
    setBusy(true);
    try {
      const saved = await api.put<MenuFull>(`/navigation/${menuKey}`, {
        name: name.trim() || undefined,
        items: toApi(tree),
      });
      toast.success("Menu saved");
      setTree(fromApi(saved.items));
      setSelected(null);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["nav-menus"] });
      void qc.invalidateQueries({ queryKey: ["nav-menu", menuKey] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        setApiErrors(
          Array.isArray(e.details)
            ? (e.details as { path: string; message: string }[]).map(
                (d) => `${d.path}: ${d.message}`,
              )
            : [e.message],
        );
      } else toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const rows = flatten(tree);
  const sel = selected ? find(tree, selected) : undefined;
  const isBuiltIn = menuKey === "header" || menuKey === "footer";

  return (
    <>
      <PageHeader
        title="Navigation"
        subtitle="Build the storefront menus"
        actions={
          <Can perm="navigation.write">
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
              Save menu
            </Button>
          </Can>
        }
      />
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Menus" style={{ margin: 0, border: 0 }}>
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              className="tab"
              aria-selected={menuKey === k}
              onClick={() => switchMenu(k)}
            >
              {k}
            </button>
          ))}
        </div>
        {canWrite && (
          <span className="g-actions">
            <input
              aria-label="New menu key"
              className="search"
              placeholder="new-menu-key"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Button onClick={addMenu}>Add menu</Button>
          </span>
        )}
      </div>

      {menu.isLoading ? (
        <Spinner />
      ) : menu.isError ? (
        <ErrorState error={menu.error} retry={() => void menu.refetch()} />
      ) : (
        <div className="nav-layout">
          <Card
            title={`Menu structure (${rows.length} items)`}
            actions={
              canWrite && (
                <Button
                  onClick={() => {
                    const n = blankNode({ label: "New item" });
                    change(addChild(tree, null, n));
                    setSelected(n.uid);
                  }}
                >
                  Add item
                </Button>
              )
            }
          >
            {canWrite && (
              <TextField
                label="Menu name"
                value={name}
                maxLength={80}
                onChange={(e) => {
                  setName(e.target.value);
                  setDirty(true);
                }}
              />
            )}
            {errors._tree && (
              <div className="alert-box" role="alert">
                {errors._tree}
              </div>
            )}
            {apiErrors.length > 0 && (
              <div className="alert-box" role="alert" aria-label="Server validation errors">
                <strong>The server rejected this menu</strong>
                <ul>
                  {apiErrors.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
            {rows.length === 0 ? (
              <EmptyState title="This menu is empty" hint="Add an item to get started." />
            ) : (
              <ul className="nav-tree" aria-label="Menu items">
                {rows.map(({ node, depth, index, siblings }) => (
                  <li
                    key={node.uid}
                    className={`nav-row${selected === node.uid ? " selected" : ""}${errors[node.uid] ? " invalid" : ""}`}
                    style={{ marginLeft: (depth - 1) * 22 }}
                  >
                    <button
                      type="button"
                      className="nav-label"
                      onClick={() => setSelected(node.uid)}
                      aria-label={`Edit ${node.label || "unnamed item"}`}
                    >
                      <strong>{node.label || "(unnamed)"}</strong>{" "}
                      <Badge tone="info">{node.type.toLowerCase()}</Badge>{" "}
                      {!node.active && <Badge tone="neutral">hidden</Badge>}
                      {errors[node.uid] && <div className="field-error">{errors[node.uid]}</div>}
                    </button>
                    {canWrite && (
                      <span className="nav-tools">
                        <Button
                          aria-label={`Move ${node.label} up`}
                          disabled={index === 0}
                          onClick={() => change(moveNode(tree, node.uid, -1))}
                        >
                          ↑
                        </Button>
                        <Button
                          aria-label={`Move ${node.label} down`}
                          disabled={index === siblings - 1}
                          onClick={() => change(moveNode(tree, node.uid, 1))}
                        >
                          ↓
                        </Button>
                        <Button
                          aria-label={`Indent ${node.label}`}
                          disabled={index === 0}
                          onClick={() => {
                            const r = indentNode(tree, node.uid);
                            if (!r)
                              toast.error(
                                new Error(`Menus can be nested at most ${MAX_DEPTH} levels deep`),
                              );
                            else change(r);
                          }}
                        >
                          →
                        </Button>
                        <Button
                          aria-label={`Outdent ${node.label}`}
                          disabled={depth === 1}
                          onClick={() => change(outdentNode(tree, node.uid))}
                        >
                          ←
                        </Button>
                        <Button
                          aria-label={`Add child to ${node.label}`}
                          disabled={depth >= MAX_DEPTH}
                          onClick={() => {
                            const n = blankNode({ label: "New item" });
                            change(addChild(tree, node.uid, n));
                            setSelected(n.uid);
                          }}
                        >
                          +
                        </Button>
                        <Button
                          variant="danger"
                          aria-label={`Remove ${node.label}`}
                          onClick={() => {
                            change(removeNode(tree, node.uid));
                            if (selected === node.uid) setSelected(null);
                          }}
                        >
                          ✕
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <div className="g-actions" style={{ marginTop: 12 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  {isBuiltIn ? "Clear menu" : "Delete menu"}
                </Button>
              </div>
            )}
          </Card>
          <Card title={sel ? "Edit item" : "Item settings"}>
            {sel ? (
              <ItemForm
                node={sel}
                readOnly={!canWrite}
                onChange={(patch) => change(updateNode(tree, sel.uid, patch))}
              />
            ) : (
              <p className="muted">Select a menu item to edit its settings.</p>
            )}
          </Card>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          danger
          title={isBuiltIn ? "Clear menu" : "Delete menu"}
          message={
            isBuiltIn
              ? `Remove all items from the "${menuKey}" menu?`
              : `Delete the "${menuKey}" menu permanently?`
          }
          confirmLabel={isBuiltIn ? "Clear" : "Delete"}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await api.delete(`/navigation/${menuKey}`);
              toast.success(isBuiltIn ? "Menu cleared" : "Menu deleted");
              void qc.invalidateQueries({ queryKey: ["nav-menus"] });
              await qc.invalidateQueries({ queryKey: ["nav-menu", menuKey] });
              if (!isBuiltIn) setMenuKey("header");
              setDirty(false);
            } catch (e) {
              toast.error(e);
            }
            setConfirmDelete(false);
          }}
        />
      )}
    </>
  );
}

function ItemForm({
  node,
  onChange,
  readOnly,
}: {
  node: NavNode;
  onChange: (patch: Partial<NavNode>) => void;
  readOnly: boolean;
}) {
  const cats = useCategories();
  const cols = useCollections();
  const pages = useQuery({
    queryKey: ["nav-pages"],
    queryFn: () =>
      api.get<Paginated<{ id: string; slug: string; title: string }>>("/pages", { pageSize: 100 }),
    staleTime: 60_000,
  });
  const promo = node.promo ?? blankPromo();
  const setPromo = (p: Partial<typeof promo>) => onChange({ promo: { ...promo, ...p } });

  return (
    <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="g-stack">
      <TextField
        label="Label"
        value={node.label}
        maxLength={120}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <SelectField
        label="Type"
        value={node.type}
        onChange={(e) => {
          const type = e.target.value as NavType;
          onChange({ type, autoChildren: type === "CATEGORY" ? node.autoChildren : false });
        }}
        options={TYPE_OPTIONS}
      />
      {node.type === "LINK" && (
        <TextField
          label="URL"
          value={node.url}
          placeholder="/shop or https://…"
          onChange={(e) => onChange({ url: e.target.value })}
        />
      )}
      {node.type === "CATEGORY" && (
        <>
          <SelectField
            label="Category"
            value={node.categoryId}
            onChange={(e) => onChange({ categoryId: e.target.value })}
            options={[
              { value: "", label: "Choose a category…" },
              ...categoryOptions(cats.data?.items ?? []),
            ]}
          />
          <CheckField
            label="Automatically list its subcategories"
            checked={node.autoChildren}
            onChange={(e) => onChange({ autoChildren: e.target.checked })}
          />
        </>
      )}
      {node.type === "COLLECTION" && (
        <SelectField
          label="Collection"
          value={node.collectionId}
          onChange={(e) => onChange({ collectionId: e.target.value })}
          options={[
            { value: "", label: "Choose a collection…" },
            ...(cols.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      )}
      {node.type === "PAGE" && (
        <SelectField
          label="Page"
          value={node.pageSlug}
          onChange={(e) => onChange({ pageSlug: e.target.value })}
          options={[
            { value: "", label: "Choose a page…" },
            ...(pages.data?.items ?? []).map((p) => ({ value: p.slug, label: p.title })),
          ]}
        />
      )}
      {node.type === "MEGA" && (
        <>
          <TextField
            label="Link URL (optional)"
            value={node.url}
            onChange={(e) => onChange({ url: e.target.value })}
          />
          <fieldset className="g-checklist" style={{ maxHeight: "none" }}>
            <legend>Promo card</legend>
            <TextField
              label="Promo title"
              value={promo.title}
              maxLength={120}
              onChange={(e) => setPromo({ title: e.target.value })}
            />
            <TextField
              label="Promo subtitle"
              value={promo.subtitle}
              maxLength={200}
              onChange={(e) => setPromo({ subtitle: e.target.value })}
            />
            <ImageField
              label="Promo image"
              value={promo.mediaId}
              onChange={(id) => setPromo({ mediaId: id })}
            />
            <TextField
              label="Promo URL"
              value={promo.url}
              onChange={(e) => setPromo({ url: e.target.value })}
            />
            <TextField
              label="Promo button label"
              value={promo.ctaLabel}
              maxLength={60}
              onChange={(e) => setPromo({ ctaLabel: e.target.value })}
            />
          </fieldset>
        </>
      )}
      <TextField
        label="Badge"
        value={node.badge}
        maxLength={30}
        hint="Small tag such as New or Sale"
        onChange={(e) => onChange({ badge: e.target.value })}
      />
      <CheckField
        label="Show on desktop"
        checked={node.showDesktop}
        onChange={(e) => onChange({ showDesktop: e.target.checked })}
      />
      <CheckField
        label="Show on mobile"
        checked={node.showMobile}
        onChange={(e) => onChange({ showMobile: e.target.checked })}
      />
      <CheckField
        label="Open in new tab"
        checked={node.openInNewTab}
        onChange={(e) => onChange({ openInNewTab: e.target.checked })}
      />
      <CheckField
        label="Active"
        checked={node.active}
        onChange={(e) => onChange({ active: e.target.checked })}
      />
    </fieldset>
  );
}
