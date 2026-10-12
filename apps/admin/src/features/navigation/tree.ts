/** Pure helpers for the navigation tree editor (client-side model). */

export const MAX_DEPTH = 4;
export type NavType = "LINK" | "CATEGORY" | "COLLECTION" | "PAGE" | "MEGA";

export interface Promo {
  title: string;
  subtitle: string;
  mediaId: string | null;
  url: string;
  ctaLabel: string;
}
export interface NavNode {
  uid: string;
  id?: string;
  label: string;
  type: NavType;
  url: string;
  categoryId: string;
  collectionId: string;
  pageSlug: string;
  badge: string;
  promo: Promo | null;
  autoChildren: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  openInNewTab: boolean;
  active: boolean;
  children: NavNode[];
}

let counter = 0;
export const newUid = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

export function blankNode(over: Partial<NavNode> = {}): NavNode {
  return {
    uid: newUid(),
    label: "",
    type: "LINK",
    url: "",
    categoryId: "",
    collectionId: "",
    pageSlug: "",
    badge: "",
    promo: null,
    autoChildren: false,
    showDesktop: true,
    showMobile: true,
    openInNewTab: false,
    active: true,
    children: [],
    ...over,
  };
}
export const blankPromo = (): Promo => ({
  title: "",
  subtitle: "",
  mediaId: null,
  url: "",
  ctaLabel: "",
});

/* ───────── API <-> model ───────── */

export interface ApiNavItem {
  id?: string;
  label: string;
  type: NavType;
  url?: string | null;
  categoryId?: string | null;
  collectionId?: string | null;
  pageSlug?: string | null;
  badge?: string | null;
  promo?: {
    title: string;
    subtitle?: string;
    mediaId?: string;
    url: string;
    ctaLabel?: string;
  } | null;
  autoChildren?: boolean;
  showDesktop: boolean;
  showMobile: boolean;
  openInNewTab: boolean;
  active: boolean;
  children?: ApiNavItem[];
}

export function fromApi(items: ApiNavItem[]): NavNode[] {
  return items.map((i) =>
    blankNode({
      id: i.id,
      label: i.label,
      type: i.type,
      url: i.url ?? "",
      categoryId: i.categoryId ?? "",
      collectionId: i.collectionId ?? "",
      pageSlug: i.pageSlug ?? "",
      badge: i.badge ?? "",
      promo: i.promo
        ? {
            title: i.promo.title ?? "",
            subtitle: i.promo.subtitle ?? "",
            mediaId: i.promo.mediaId ?? null,
            url: i.promo.url ?? "",
            ctaLabel: i.promo.ctaLabel ?? "",
          }
        : null,
      autoChildren: !!i.autoChildren,
      showDesktop: i.showDesktop,
      showMobile: i.showMobile,
      openInNewTab: i.openInNewTab,
      active: i.active,
      children: fromApi(i.children ?? []),
    }),
  );
}

export function toApi(nodes: NavNode[]): ApiNavItem[] {
  return nodes.map((n) => {
    const out: ApiNavItem = {
      ...(n.id ? { id: n.id } : {}),
      label: n.label.trim(),
      type: n.type,
      showDesktop: n.showDesktop,
      showMobile: n.showMobile,
      openInNewTab: n.openInNewTab,
      active: n.active,
    };
    if (n.type === "LINK" || (n.type === "MEGA" && n.url.trim())) out.url = n.url.trim();
    if (n.type === "CATEGORY") {
      out.categoryId = n.categoryId;
      if (n.autoChildren) out.autoChildren = true;
    }
    if (n.type === "COLLECTION") out.collectionId = n.collectionId;
    if (n.type === "PAGE") out.pageSlug = n.pageSlug;
    if (n.badge.trim()) out.badge = n.badge.trim();
    if (n.type === "MEGA" && n.promo && (n.promo.title.trim() || n.promo.url.trim())) {
      out.promo = {
        title: n.promo.title.trim(),
        url: n.promo.url.trim(),
        ...(n.promo.subtitle.trim() ? { subtitle: n.promo.subtitle.trim() } : {}),
        ...(n.promo.mediaId ? { mediaId: n.promo.mediaId } : {}),
        ...(n.promo.ctaLabel.trim() ? { ctaLabel: n.promo.ctaLabel.trim() } : {}),
      };
    }
    if (n.children.length) out.children = toApi(n.children);
    return out;
  });
}

/* ───────── queries ───────── */

export function treeDepth(nodes: NavNode[]): number {
  return nodes.length ? 1 + Math.max(...nodes.map((n) => treeDepth(n.children))) : 0;
}
/** Depth (1-based) of a node subtree height; used to check an indent would still fit. */
export const subtreeDepth = (n: NavNode) => treeDepth([n]);

export function find(nodes: NavNode[], uid: string): NavNode | undefined {
  for (const n of nodes) {
    if (n.uid === uid) return n;
    const c = find(n.children, uid);
    if (c) return c;
  }
  return undefined;
}

export function flatten(
  nodes: NavNode[],
  depth = 1,
): { node: NavNode; depth: number; index: number; siblings: number }[] {
  return nodes.flatMap((n, index) => [
    { node: n, depth, index, siblings: nodes.length },
    ...flatten(n.children, depth + 1),
  ]);
}

/* ───────── immutable edits ───────── */

export function updateNode(tree: NavNode[], uid: string, patch: Partial<NavNode>): NavNode[] {
  return tree.map((n) =>
    n.uid === uid ? { ...n, ...patch } : { ...n, children: updateNode(n.children, uid, patch) },
  );
}

export function removeNode(tree: NavNode[], uid: string): NavNode[] {
  return tree
    .filter((n) => n.uid !== uid)
    .map((n) => ({ ...n, children: removeNode(n.children, uid) }));
}

export function addChild(tree: NavNode[], parentUid: string | null, node: NavNode): NavNode[] {
  if (parentUid === null) return [...tree, node];
  return tree.map((n) =>
    n.uid === parentUid
      ? { ...n, children: [...n.children, node] }
      : { ...n, children: addChild(n.children, parentUid, node) },
  );
}

export function moveNode(tree: NavNode[], uid: string, dir: -1 | 1): NavNode[] {
  const swap = (list: NavNode[]): NavNode[] => {
    const i = list.findIndex((n) => n.uid === uid);
    if (i === -1) return list.map((n) => ({ ...n, children: swap(n.children) }));
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  return swap(tree);
}

/** Make the node the last child of its previous sibling. Returns null when impossible (depth/first). */
export function indentNode(tree: NavNode[], uid: string): NavNode[] | null {
  let ok = false;
  const walk = (list: NavNode[]): NavNode[] => {
    const i = list.findIndex((n) => n.uid === uid);
    if (i === -1) return list.map((n) => ({ ...n, children: walk(n.children) }));
    if (i === 0) return list;
    ok = true;
    const prev = list[i - 1]!;
    const moved = list[i]!;
    const next = list.filter((_, k) => k !== i);
    next[i - 1] = { ...prev, children: [...prev.children, moved] };
    return next;
  };
  const result = walk(tree);
  if (!ok || treeDepth(result) > MAX_DEPTH) return null;
  return result;
}

/** Make the node the next sibling of its parent. Returns null at the root level. */
export function outdentNode(tree: NavNode[], uid: string): NavNode[] | null {
  let ok = false;
  const walk = (list: NavNode[]): NavNode[] => {
    const out: NavNode[] = [];
    for (const n of list) {
      const idx = n.children.findIndex((c) => c.uid === uid);
      if (idx !== -1) {
        ok = true;
        const moved = n.children[idx]!;
        out.push({ ...n, children: n.children.filter((_, k) => k !== idx) }, moved);
      } else {
        out.push({ ...n, children: walk(n.children) });
      }
    }
    return out;
  };
  const result = walk(tree);
  return ok ? result : null;
}

/** Client-side checks mirroring the API. Returns messages keyed by node uid ("_tree" for tree-level). */
export function validateTree(tree: NavNode[]): Record<string, string> {
  const errs: Record<string, string> = {};
  if (treeDepth(tree) > MAX_DEPTH)
    errs._tree = `Menus can be nested at most ${MAX_DEPTH} levels deep`;
  for (const { node: n } of flatten(tree)) {
    const label = n.label.trim() || "(unnamed)";
    if (!n.label.trim()) errs[n.uid] = "Label is required";
    else if (n.type === "LINK" && !n.url.trim()) errs[n.uid] = `${label}: URL is required`;
    else if (n.type === "LINK" && !/^(\/(?!\/)|https?:\/\/|mailto:|tel:|#)/i.test(n.url.trim()))
      errs[n.uid] = `${label}: URL must start with /, http(s)://, mailto:, tel: or #`;
    else if (n.type === "CATEGORY" && !n.categoryId) errs[n.uid] = `${label}: choose a category`;
    else if (n.type === "COLLECTION" && !n.collectionId)
      errs[n.uid] = `${label}: choose a collection`;
    else if (n.type === "PAGE" && !n.pageSlug) errs[n.uid] = `${label}: choose a page`;
    else if (n.type === "MEGA" && n.promo && (n.promo.title.trim() || n.promo.url.trim())) {
      if (!n.promo.title.trim() || !n.promo.url.trim())
        errs[n.uid] = `${label}: promo card needs a title and a URL`;
    }
  }
  return errs;
}
