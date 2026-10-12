import type { RouteObject } from "react-router-dom";
import { Guard } from "../products/kit";
import { Categories } from "./Categories";

export const routes: RouteObject[] = [
  {
    path: "categories",
    element: (
      <Guard perm="categories.read">
        <Categories />
      </Guard>
    ),
  },
];
