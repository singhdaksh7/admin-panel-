import type { RouteObject } from "react-router-dom";
import { Guard } from "../../routes";
import { BlogForm, BlogList } from "./Blog";

export const routes: RouteObject[] = [
  {
    path: "blog",
    element: (
      <Guard perm="content.read">
        <BlogList />
      </Guard>
    ),
  },
  {
    path: "blog/new",
    element: (
      <Guard perm={["content.read", "blog.write"]}>
        <BlogForm />
      </Guard>
    ),
  },
  {
    path: "blog/:id",
    element: (
      <Guard perm="content.read">
        <BlogForm />
      </Guard>
    ),
  },
];
