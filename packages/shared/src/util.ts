export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "item"
  );
}

export interface PageParams {
  page: number;
  pageSize: number;
}
export const MAX_PAGE_SIZE = 100;

export function clampPage(page: unknown, pageSize: unknown, defaultSize = 20): PageParams {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const s = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize) || defaultSize)));
  return { page: p, pageSize: s };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export function paginated<T>(
  items: T[],
  total: number,
  { page, pageSize }: PageParams,
): Paginated<T> {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
