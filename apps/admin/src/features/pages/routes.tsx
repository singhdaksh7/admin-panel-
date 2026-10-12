import type { RouteObject } from "react-router-dom";
import { Guard } from "../../routes";
import { PageEditor, PagesList } from "./Pages";

export const routes: RouteObject[] = [
  {
    path: "pages",
    element: (
      <Guard perm="content.read">
        <PagesList />
      </Guard>
    ),
  },
  {
    path: "pages/new",
    element: (
      <Guard perm={["content.read", "content.write"]}>
        <PageEditor />
      </Guard>
    ),
  },
  {
    path: "pages/:id",
    element: (
      <Guard perm="content.read">
        <PageEditor />
      </Guard>
    ),
  },
];
